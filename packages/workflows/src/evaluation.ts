/**
 * Checks and evaluation for the vertical slice (the minimum set; the full EP, ST and RG lint catalogs are
 * Checkpoint 6). Deterministic checks run first (schema validity was enforced at draft time; here: English
 * output language, word length, truncation, contract shape). Model evaluators run through the gateway with
 * replayed responses: contract compliance, continuity, knowledge leakage, and — as two separate dimensions
 * with separate gates (EVAL-SEPARATION-001) — English prose quality and Korean-webnovel structure.
 *
 * The scorecard is the single gate input: approval requires blocking_count ≤ policy.gates.blocking_max,
 * major_count ≤ major_max, every deterministic criterion passed and every gated dimension at or above its
 * pinned threshold. Numbers come from the pinned Production Policy only.
 */
import { createHash } from 'node:crypto';
import { type ManuscriptVersionRow } from '@yeonjae/db';
import {
  type Generated,
  loadSchemas,
  overrideClassFor,
  recordNormalization,
  validatorFor,
} from '@yeonjae/domain';
import { exemplarsOf } from '@yeonjae/narrative';
import {
  checkDialogueRegister,
  checkOutputLanguage,
  compileModelPattern,
  dialogueRegisterDigestKo,
  judgeLength,
  koStyleDigest,
  lintKoreanWebnovel,
  measure,
  repetitionDigestKo,
  repetitionReport,
  segmentParagraphs,
  targetCount,
  toNfcText,
  type NfcText,
  type Paragraph,
  type KoStyleReport,
} from '@yeonjae/prose';
import { WorkflowError } from './errors.js';
import { checkpointPack, packCallInput, packSections } from './drafting.js';
import {
  composeDimensionScore,
  CORE_EVALUATORS,
  EVALUATOR_DIMENSION,
  lintComposite,
  planReevaluation,
  reanchorIssues,
  rubricScore,
  runBounded,
  type EvaluationCarry,
  type EvaluatorName,
  type GatedDimension,
} from './evaluation-plan.js';
import {
  addressMatrix,
  chapterObligations,
  priorAcceptedChapters,
  priorChapterEdges,
  readerSecrets,
  terminologyChecks,
  voiceCards,
} from './evaluator-inputs.js';
import {
  anchorIssueQuote,
  normalizeDimensionScores,
  normalizeDriftFlags,
  normalizeRepair,
} from './judge-normalize.js';
import { type ChapterContract, type StoryBible, type StorySpec, compileFor } from './planning.js';
import { modelCall, runStep, saveArtifact, type WorkflowContext } from './runtime.js';

export type Scorecard = Generated.ScorecardSchema.Scorecard;
export type Issue = Generated.IssueSchema.Issue;
type Severity = Issue['severity'];

interface RawIssue {
  kind?: string;
  severity?: string;
  confidence?: number;
  claim?: string;
  chapter_span?: Issue['chapter_span'];
  /** Live judges quote the manuscript instead of counting offsets; anchored into `chapter_span`. */
  quote?: unknown;
  repair?: unknown;
  conflicting_canon?: Issue['conflicting_canon'];
  canon_evidence?: Issue['canon_evidence'];
  metric?: Issue['metric'];
}

const ISSUE_KINDS: ReadonlySet<string> = new Set(
  (
    loadSchemas().schemas.get('issue.schema.json')?.schema as
      { properties?: { kind?: { enum?: string[] } } } | undefined
  )?.properties?.kind?.enum ?? [],
);

function issueIdFor(
  ctx: WorkflowContext,
  versionId: string,
  source: string,
  index: number,
): string {
  // Stable issue ids: sha256(workflow, version, source, index) → v8 UUID, so a replayed evaluation yields the same ids.
  const hex = createHash('sha256')
    .update(`${ctx.workflowId}|${versionId}|${source}|${index}`)
    .digest('hex')
    .slice(0, 32);
  const b = Buffer.from(hex, 'hex');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function toIssue(
  ctx: WorkflowContext,
  versionId: string,
  source: string,
  dimension: Issue['dimension'],
  raw: RawIssue,
  index: number,
  anchor?: { readonly text: NfcText; readonly paragraphs: readonly Paragraph[] },
): Issue {
  const kind = raw.kind && isIssueKind(raw.kind) ? raw.kind : 'other';
  const severity = (['blocking', 'major', 'minor', 'note'] as const).includes(
    raw.severity as Severity,
  )
    ? (raw.severity as Severity)
    : 'minor';
  const repair = normalizeRepair(raw.repair);
  if (typeof raw.repair === 'string' && repair) recordNormalization('judge_repair');
  const quoted =
    !raw.chapter_span && anchor
      ? anchorIssueQuote(anchor.text, anchor.paragraphs, raw.quote)
      : undefined;
  if (quoted) recordNormalization('judge_quote_anchor');
  return {
    id: issueIdFor(ctx, versionId, source, index),
    source,
    dimension,
    kind,
    severity,
    override_class: overrideClassFor(ctx.policy, kind, severity),
    confidence: Math.max(0, Math.min(1, raw.confidence ?? 0.5)),
    claim: raw.claim ?? `${kind} reported by ${source}`,
    status: 'open',
    ...(raw.chapter_span
      ? { chapter_span: { ...raw.chapter_span, manuscript_version_id: versionId } }
      : quoted
        ? { chapter_span: { manuscript_version_id: versionId, ...quoted } }
        : {}),
    ...(repair ? { repair } : {}),
    ...(raw.conflicting_canon ? { conflicting_canon: raw.conflicting_canon } : {}),
    ...(raw.canon_evidence ? { canon_evidence: raw.canon_evidence } : {}),
    ...(raw.metric ? { metric: raw.metric } : {}),
  };
}

function isIssueKind(k: string): k is Issue['kind'] {
  return ISSUE_KINDS.has(k);
}

export interface DeterministicChecks {
  readonly output_language: {
    passed: boolean;
    english_confidence: number;
    non_english_segments: number;
  };
  readonly length: {
    passed: boolean;
    unit: 'words' | 'characters';
    count: number;
    characters: number;
    words: number;
    target: number;
    ratio: number;
    warn: boolean;
  };
  readonly truncation: { passed: boolean; reason?: string | undefined };
  readonly contract_shape: { passed: boolean; notes: string[] };
  /** Korean webnovel style lint (ADR-0056); absent for English manuscripts. */
  readonly ko_style?: KoStyleReport | undefined;
  readonly issues: Issue[];
}

const TRUNCATION_TAIL = /[.!?…”"’')\]]\s*$/u;

export function runDeterministicChecks(
  ctx: WorkflowContext,
  version: ManuscriptVersionRow,
  contract: ChapterContract,
  allowlist: readonly string[],
): DeterministicChecks {
  const nfc = toNfcText(version.text);
  const issues: Issue[] = [];
  let n = 0;
  const language: 'en' | 'ko' = ctx.identity.outputLanguage.language ?? 'en';
  const lang = checkOutputLanguage(nfc, {
    minConfidence: ctx.policy.output_language.min_english_confidence,
    allowlist,
    language,
  });
  if (!lang.passed)
    issues.push(
      toIssue(
        ctx,
        version.id,
        'lint',
        'output_language',
        {
          kind: 'non_english_output',
          severity: 'blocking',
          confidence: 1,
          claim: `English confidence ${lang.english_confidence}; offending paragraphs ${lang.offending_segments.map((s) => s.paragraph_id).join(', ')}`,
          chapter_span: { paragraph_ids: lang.offending_segments.map((s) => s.paragraph_id) },
        },
        n++,
      ),
    );
  // ADR-0056: the Korean style lint measures the language layer's own 번역투 / AI-상투구 lists plus the
  // mobile-serial rhythm. Rate breaches and format drift gate (major); single hits are minor evidence that
  // the prose judge and the targeted reviser receive with their spans.
  let koStyle: KoStyleReport | undefined;
  if (language === 'ko') {
    const ol = ctx.identity.outputLanguage;
    koStyle = lintKoreanWebnovel(nfc.text, {
      translationMarkers: ol.translation_markers,
      forbiddenPatterns: ol.forbidden_patterns,
      thresholds: ol.lint_thresholds,
      allowlist,
      exemplarTexts: exemplarsOf(ctx.identity).map((e) => e.text),
    });
    for (const f of koStyle.findings)
      issues.push(
        toIssue(
          ctx,
          version.id,
          'lint:ko_style',
          f.kind === 'weak_ending' ? 'structure' : 'prose',
          {
            kind: f.kind,
            severity: f.severity,
            confidence: 1,
            claim: f.message,
            chapter_span: {
              paragraph_ids: [...f.paragraph_ids],
              ...(f.start !== undefined ? { start: f.start } : {}),
              ...(f.end !== undefined ? { end: f.end } : {}),
              ...(f.quote !== undefined ? { quote: f.quote } : {}),
            },
            ...(f.value !== undefined
              ? {
                  metric: {
                    rule_id: f.rule_id,
                    value: f.value,
                    ...(f.threshold !== undefined ? { threshold: f.threshold } : {}),
                  },
                }
              : { metric: { rule_id: f.rule_id } }),
          },
          n++,
        ),
      );
  }
  const m = measure(nfc);
  const count = targetCount(m, contract.length_target.unit);
  const len = judgeLength(count, contract.length_target, ctx.policy.length.fail_tolerance_ratio);
  if (len.fail)
    issues.push(
      toIssue(
        ctx,
        version.id,
        'lint',
        'length',
        {
          kind: 'length_out_of_range',
          severity: 'major',
          confidence: 1,
          claim: `${count} ${contract.length_target.unit} vs target ${contract.length_target.value} (${(len.ratio * 100).toFixed(0)}%)`,
          metric: { rule_id: 'LEN-01', value: count, threshold: contract.length_target.value },
        },
        n++,
      ),
    );
  else if (len.warn)
    issues.push(
      toIssue(
        ctx,
        version.id,
        'lint',
        'length',
        {
          kind: 'length_out_of_range',
          severity: 'minor',
          confidence: 1,
          claim: `${count} ${contract.length_target.unit} vs target ${contract.length_target.value} (${(len.ratio * 100).toFixed(0)}%, within fail tolerance)`,
          metric: { rule_id: 'LEN-01', value: count, threshold: contract.length_target.value },
        },
        n++,
      ),
    );
  const paragraphs = segmentParagraphs(nfc);
  const last = paragraphs[paragraphs.length - 1]?.text.trim() ?? '';
  const truncated =
    last.length === 0 ||
    !TRUNCATION_TAIL.test(last) ||
    /\b(and|the|of|to|a|an|with|but)$/i.test(last);
  if (truncated)
    issues.push(
      toIssue(
        ctx,
        version.id,
        'lint',
        'structure',
        {
          kind: 'truncated_output',
          severity: 'blocking',
          confidence: 0.9,
          claim: `final paragraph does not end a sentence: “${last.slice(-60)}”`,
          chapter_span: { paragraph_ids: [paragraphs[paragraphs.length - 1]?.id ?? 'p?'] },
        },
        n++,
      ),
    );
  const notes: string[] = [];
  let shapeOk = true;
  if (paragraphs.length < contract.scene_count) {
    shapeOk = false;
    notes.push(`only ${paragraphs.length} paragraphs for ${contract.scene_count} scenes`);
  }
  if (/^\s*(#|\*\*|Chapter \d+|Scene \d+)/m.test(nfc.text)) {
    shapeOk = false;
    notes.push('headings or scene labels inside the prose');
    issues.push(
      toIssue(
        ctx,
        version.id,
        'lint',
        'structure',
        {
          kind: 'format_drift',
          severity: 'blocking',
          confidence: 1,
          claim: 'headings/labels inside the manuscript',
        },
        n++,
      ),
    );
  }
  for (const mn of contract.must_not_happen) {
    for (const pat of mn.lexical_patterns ?? []) {
      // The pattern is model-written contract text (ADR-0057): an unusable one is recorded and matched
      // literally, so the guard still runs and the deterministic checks never throw.
      const compiled = compileModelPattern(pat, 'i');
      if (!compiled.valid)
        issues.push(
          toIssue(
            ctx,
            version.id,
            'lint',
            'contract',
            {
              kind: 'other',
              severity: 'minor',
              confidence: 1,
              claim:
                language === 'ko'
                  ? `금지 조건 ${mn.id}의 어휘 패턴 /${pat}/을 정규식으로 쓸 수 없어(${compiled.reason === 'too_long' ? '너무 김' : '문법 오류'}) 글자 그대로 대조했다`
                  : `must-not ${mn.id} lexical pattern /${pat}/ is not a usable regex (${compiled.reason ?? 'invalid'}); matched literally`,
              metric: { rule_id: 'CONTRACT-PATTERN-INVALID' },
            },
            n++,
          ),
        );
      if (compiled.re.test(nfc.text)) {
        shapeOk = false;
        issues.push(
          toIssue(
            ctx,
            version.id,
            'lint',
            'contract',
            {
              kind:
                mn.source === 'content_restriction'
                  ? 'content_restriction'
                  : 'forbidden_development',
              severity: 'blocking',
              confidence: 1,
              claim: `must-not ${mn.id} matched lexical pattern /${pat}/`,
            },
            n++,
          ),
        );
      }
    }
  }
  return {
    output_language: {
      passed: lang.passed,
      english_confidence: lang.english_confidence,
      non_english_segments: lang.offending_segments.length,
    },
    length: {
      passed: !len.fail,
      unit: contract.length_target.unit,
      count,
      characters: m.characters,
      words: m.words,
      target: contract.length_target.value,
      ratio: len.ratio,
      warn: len.warn,
    },
    truncation: {
      passed: !truncated,
      ...(truncated ? { reason: 'final paragraph incomplete' } : {}),
    },
    contract_shape: { passed: shapeOk, notes },
    ...(koStyle ? { ko_style: koStyle } : {}),
    issues,
  };
}

interface JudgeOutput {
  judge_score?: number;
  dimension_scores?: Record<string, number>;
  drift_flags?: string[];
  issues?: RawIssue[];
  hook_sentence_index?: number;
  local_payoff_present?: boolean;
  ending_type_detected?: string;
}

interface ContractOutput {
  criteria?: {
    criterion_id: string;
    passed: boolean;
    evidence_paragraph_ids?: string[];
    note?: string;
  }[];
}

interface PromiseOutput {
  touches?: { promise_id?: unknown; planned?: unknown; found?: unknown; quote?: unknown }[];
}

type EvaluatorOutput = JudgeOutput & ContractOutput & PromiseOutput;

export interface EvaluationResult {
  readonly scorecard: Scorecard;
  readonly scorecardArtifactId: string;
  readonly blocking: readonly Issue[];
  readonly approvable: boolean;
  readonly packs: { checker: string; checker_hash: string };
  /**
   * ADR-0060, under a policy with an evaluation block: `targeted` when some evaluators' findings were
   * carried from the parent version, and which evaluators ran. Absent otherwise (every evaluator ran).
   */
  readonly mode?: 'full' | 'targeted' | undefined;
  readonly rerun?: readonly EvaluatorName[] | undefined;
}

const SOURCE: Readonly<Record<EvaluatorName, string>> = {
  contract_checker: 'judge:contract_checker',
  continuity_checker: 'judge:continuity_checker',
  knowledge_leak_checker: 'judge:knowledge_leak_checker',
  prose_judge: 'judge:prose_judge',
  structure_judge: 'judge:structure_judge',
  genre_judge: 'judge:genre_judge',
  voice_judge: 'judge:voice_judge',
  promise_checker: 'judge:promise_checker',
  repetition_judge: 'judge:repetition_judge',
};

/** Evaluate one manuscript version (idempotent per version). */
export async function evaluateVersion(
  ctx: WorkflowContext,
  input: {
    version: ManuscriptVersionRow;
    contract: ChapterContract;
    spec: StorySpec;
    canonVersion: number;
    allowlist: readonly string[];
    round: number;
    /** Voice cards, address terms, reader secrets and promise statements (ADR-0060). */
    bible?: StoryBible | undefined;
    /** The parent version's evaluation, for a targeted re-evaluation after a patch (ADR-0060). */
    carry?: EvaluationCarry | undefined;
  },
): Promise<EvaluationResult> {
  const v = input.version;
  return runStep(
    ctx,
    'evaluate',
    async () => {
      const det = runDeterministicChecks(ctx, v, input.contract, input.allowlist);
      const nfc = toNfcText(v.text);
      const paragraphs = segmentParagraphs(nfc);
      const anchor = { text: nfc, paragraphs };
      const chapterText = paragraphs.map((p) => `[${p.id}] ${p.text}`).join('\n\n');
      const evaluatorCalls: string[] = [];
      const issues: Issue[] = [...det.issues];
      const lang: 'en' | 'ko' = ctx.identity.outputLanguage.language === 'ko' ? 'ko' : 'en';
      const ko = lang === 'ko';
      const none = ko ? '(없음)' : '(none)';
      const orNone = (s: string | undefined) => (s?.trim() ? s : none);
      // ADR-0060: a policy without an evaluation block keeps the ADR-0056 behaviour exactly.
      const policyEval = ctx.policy.evaluation;

      // Checker pack: the working version enters only as job-scoped chapter_text (status recorded in the manifest).
      const checker = await checkpointPack(ctx, {
        label: `continuity_checker:r${input.round}`,
        role: 'continuity_checker',
        contract: input.contract,
        spec: input.spec,
        chapterText: { versionId: v.id },
        lexical: false,
      });
      const packIn = packCallInput(checker.stored);
      const packVars = checker.stored.variables;
      const packSection = (names: readonly string[]) => packSections(checker.stored, names);
      const act = (name: string) => `${name}:${input.contract.chapter_number}:r${input.round}`;

      const optional = policyEval?.optional_evaluators ?? [];
      for (const name of optional)
        if (!ctx.promptSet.mapping[name])
          throw new WorkflowError(
            'EVALUATION_FAILED',
            `policy ${ctx.pins.productionPolicyVersion} runs ${name}, but the pinned prompt set ${ctx.promptSet.id} has no ${name}`,
            { step: 'evaluate' },
          );
      const evaluators: EvaluatorName[] = [...CORE_EVALUATORS, ...optional];

      // ---- targeted re-evaluation: carried findings must still anchor in the patched text.
      const carry = policyEval?.reevaluation === 'targeted' ? input.carry : undefined;
      const carriedSpans = new Map<EvaluatorName, Issue['chapter_span'][]>();
      const unanchored = new Set<EvaluatorName>();
      if (carry) {
        const before = { paragraphs: segmentParagraphs(toNfcText(carry.versionText)) };
        for (const e of evaluators) {
          const prior = carry.scorecard.issues.filter((i) => i.source === SOURCE[e]);
          const spans = reanchorIssues(prior, before, anchor);
          if (spans) carriedSpans.set(e, spans);
          else unanchored.add(e);
        }
      }
      const plan = planReevaluation({
        evaluators,
        reevaluation: policyEval?.reevaluation ?? 'full',
        carry,
        smokeAfterPatches: ctx.policy.revision.smoke_after_patches,
        unanchored,
      });
      const runs = new Set(plan.rerun);

      // ---- inputs: older pinned prompt versions keep receiving exactly what they received.
      const versionOf = (family: EvaluatorName) => {
        const id = ctx.promptSet.mapping[family];
        return id ? ctx.registry.get(id) : undefined;
      };
      const voicePv = versionOf('voice_judge');
      const voiceV2 = voicePv?.input_variables.includes('voice_cards') ?? false;
      const register = ko && voiceV2 ? checkDialogueRegister(nfc) : undefined;
      const primaryGenre = input.spec.items.find((i) => i.category === 'genre')?.text;
      const terminology =
        versionOf('genre_judge')?.input_variables.includes('terminology_checks') === true
          ? terminologyChecks({
              text: nfc,
              paragraphs,
              allowlist: input.allowlist,
              identity: ctx.identity,
              primaryGenre,
              lang,
            })
          : undefined;
      const repetitionEvidence = runs.has('repetition_judge')
        ? await (async () => {
            const prior = await priorAcceptedChapters(
              ctx.pool,
              ctx.projectId,
              input.contract.chapter_number,
            );
            return { prior, report: repetitionReport(nfc, prior) };
          })()
        : undefined;

      const call = (e: EvaluatorName): Promise<{ llmCallId: string; output: EvaluatorOutput }> => {
        switch (e) {
          case 'contract_checker':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'contract_checker',
              activityId: act('contract_check'),
              variables: {
                chapter_text: chapterText,
                chapter_contract: packVars.chapter_contract ?? JSON.stringify(input.contract),
              },
              pack: packIn,
            });
          case 'continuity_checker':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'continuity_checker',
              activityId: act('continuity'),
              variables: {
                chapter_text: chapterText,
                locked_facts: packVars.timeline_position ?? '(none)',
                story_position: orNone(
                  packSection(['active_constraints', 'timeline', 'contract']) ??
                    packVars.timeline_position,
                ),
                locked_canon: orNone(packSection(['locked_facts'])),
              },
              pack: packIn,
            });
          case 'knowledge_leak_checker':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'knowledge_leak_checker',
              activityId: act('knowledge_leak'),
              variables: {
                chapter_text: chapterText,
                knowledge_table: packVars.canon_state ?? '(none)',
                knowledge_guards: packVars.timeline_position ?? '(none)',
                secrets: packVars.canon_state ?? '(none)',
                knowledge_stances: orNone(packSection(['knowledge'])),
                knowledge_guard_list: orNone(packSection(['knowledge_guards'])),
                reader_secrets: orNone(
                  readerSecrets(input.contract.chapter_number, input.bible, lang),
                ),
              },
              pack: packIn,
            });
          case 'prose_judge':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'prose_judge',
              activityId: act('prose_judge'),
              variables: {
                chapter_text: chapterText,
                prose_lint_report: ko
                  ? `한국어 출력 언어 검사: 신뢰도 ${det.output_language.english_confidence}; 분량 ${det.length.count}${det.length.unit === 'characters' ? '자' : ` ${det.length.unit}`}.${det.ko_style ? `\n[결정적 문체 검사 — 번역투·AI 상투구·모바일 호흡]\n${koStyleDigest(det.ko_style)}` : ''}`
                  : `English output-language check: confidence ${det.output_language.english_confidence}; length ${det.length.count} ${det.length.unit}.`,
              },
              block: compileFor(ctx, 'judge_rubric_prose'),
            });
          case 'structure_judge':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'structure_judge',
              activityId: act('structure_judge'),
              variables: {
                chapter_text: chapterText,
                structure_lint_report: ko
                  ? `문단 ${paragraphs.length}개; 잘림 검사 ${det.truncation.passed ? '통과' : '실패'}.${det.ko_style ? ` 대사 비중 ${String(Math.round(det.ko_style.metrics.dialogue_ratio * 100))}%, 긴 서술 문단 ${String(Math.round(det.ko_style.metrics.long_paragraph_ratio * 100))}%, 최장 문단 ${String(det.ko_style.metrics.max_paragraph_chars)}자.${det.ko_style.findings.some((f) => f.rule_id === 'KO-END-01') ? ' 마지막 문단이 요약·관조형으로 판정됨(KO-END-01).' : ''}` : ''}`
                  : `paragraphs ${paragraphs.length}; truncation check ${det.truncation.passed ? 'passed' : 'FAILED'}.`,
                contract_shape: ko
                  ? `도입 ${input.contract.opening.type}; 절단 ${input.contract.hook.type}; 로컬 보상 ${input.contract.local_satisfaction.map((s) => s.type).join(', ')}; 장면 ${input.contract.scene_count}개.`
                  : `opening ${input.contract.opening.type}; hook ${input.contract.hook.type}; local satisfaction ${input.contract.local_satisfaction.map((s) => s.type).join(', ')}; scenes ${input.contract.scene_count}.`,
              },
              block: compileFor(ctx, 'judge_rubric_structure'),
            });
          // Dimensions C and D. `standard.v1` gates genre and voice, so their evidence is required: without
          // them the per-dimension gates and the ADR-0014 regression check have nothing to read and must fail
          // closed. Each is its own immutable family with its own identity variant and its own gate — fluent
          // prose, webnovel structure, genre fit and voice/register are never folded into one score
          // (EVAL-SEPARATION-001).
          case 'genre_judge':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'genre_judge',
              activityId: act('genre_judge'),
              variables: {
                chapter_text: chapterText,
                terminology_report: ko
                  ? `허용 이름 ${input.allowlist.length}개; 주 장르 ${primaryGenre ?? '(미지정)'}.`
                  : `allowlisted names ${input.allowlist.length}; primary genre ${primaryGenre ?? '(unspecified)'}.`,
                terminology_checks: terminology?.text ?? none,
              },
              block: compileFor(ctx, 'judge_rubric_genre'),
            });
          case 'voice_judge':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'voice_judge',
              activityId: act('voice_judge'),
              variables: voiceV2
                ? {
                    chapter_text: chapterText,
                    voice_cards: orNone(voiceCards(input.contract, input.bible, lang)),
                    address_matrix: orNone(addressMatrix(input.contract, input.bible, lang)),
                    register_digests: packVars.register_digests ?? none,
                    register_check_report: register
                      ? dialogueRegisterDigestKo(register)
                      : ko
                        ? '이 원고에는 결정적 말높이 검사가 없다.'
                        : 'No deterministic register check exists for this manuscript language.',
                  }
                : {
                    utterances: chapterText,
                    register_digests: packVars.register_digests ?? '(none)',
                    register_check_report: ko
                      ? `말높이 요약 제공: ${packVars.register_digests ? '예' : '아니오'}.`
                      : `dialogue register digests supplied: ${packVars.register_digests ? 'yes' : 'no'}.`,
                  },
              block: compileFor(
                ctx,
                voicePv?.identity_variant === 'judge_rubric_voice'
                  ? 'judge_rubric_voice'
                  : 'judge_rubric_prose',
              ),
            });
          case 'promise_checker':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'promise_checker',
              activityId: act('promise_check'),
              variables: {
                chapter_text: chapterText,
                chapter_obligations: orNone(chapterObligations(input.contract, input.bible, lang)),
                promise_ledger: orNone(packSection(['promises'])),
              },
              pack: packIn,
            });
          case 'repetition_judge':
            return modelCall<EvaluatorOutput>(ctx, {
              step: 'evaluate',
              family: 'repetition_judge',
              activityId: act('repetition_judge'),
              variables: {
                chapter_text: chapterText,
                repetition_report: repetitionEvidence
                  ? ko
                    ? repetitionDigestKo(repetitionEvidence.report)
                    : JSON.stringify(repetitionEvidence.report)
                  : none,
                recent_chapters: orNone(
                  repetitionEvidence
                    ? priorChapterEdges(repetitionEvidence.prior, lang)
                    : undefined,
                ),
              },
            });
        }
      };

      // ---- run: at most max_parallel_evaluators in flight; findings enter in the fixed order below.
      const results = new Map<EvaluatorName, { llmCallId: string; output: EvaluatorOutput }>();
      const toRun = evaluators.filter((e) => runs.has(e));
      const done = await runBounded(
        toRun.map((e) => () => call(e)),
        policyEval?.max_parallel_evaluators ?? 1,
      );
      toRun.forEach((e, i) => {
        const r = done[i];
        if (r) results.set(e, r);
      });
      const carriedFrom = (e: EvaluatorName) =>
        results.has(e) || !carry ? {} : { carried_from: carry.scorecard.id };
      const carriedIssues = (e: EvaluatorName): Issue[] => {
        const prior = carry?.scorecard.issues.filter((i) => i.source === SOURCE[e]) ?? [];
        const spans = carriedSpans.get(e) ?? [];
        return prior.map((i, idx) => {
          const { chapter_span: _old, ...rest } = i;
          const span = spans[idx];
          return {
            ...rest,
            id: issueIdFor(ctx, v.id, SOURCE[e], idx),
            ...(span ? { chapter_span: { ...span, manuscript_version_id: v.id } } : {}),
          };
        });
      };
      const priorSection = (key: string): Record<string, unknown> | undefined =>
        (
          carry?.scorecard.sections as
            Record<string, Record<string, unknown> | undefined> | undefined
        )?.[key];

      // ---- contract criteria (deterministic criteria always follow the re-run deterministic checks)
      const contractRun = results.get('contract_checker');
      const criteria = contractRun?.output.criteria ?? [];
      const carriedCriteria = contractRun
        ? undefined
        : carry?.scorecard.acceptance.criteria_results;
      const criteriaResults = input.contract.acceptance_criteria.map((c) => {
        const r = criteria.find((x) => x.criterion_id === c.id);
        if (c.kind === 'deterministic') {
          const passed = c.id.includes('LANG')
            ? det.output_language.passed
            : c.id.includes('LEN')
              ? det.length.passed
              : (r?.passed ??
                carriedCriteria?.find((x) => x.criterion_id === c.id)?.passed ??
                false);
          return { criterion_id: c.id, passed, note: 'deterministic' };
        }
        const kept = carriedCriteria?.find((x) => x.criterion_id === c.id);
        if (kept) return { ...kept };
        return {
          criterion_id: c.id,
          passed: r?.passed ?? false,
          ...(r?.evidence_paragraph_ids
            ? { evidence_paragraph_ids: r.evidence_paragraph_ids }
            : {}),
          ...(r?.note ? { note: r.note } : {}),
        };
      });
      if (contractRun) {
        evaluatorCalls.push(contractRun.llmCallId);
        criteriaResults.forEach((cr, i) => {
          if (!cr.passed)
            issues.push(
              toIssue(
                ctx,
                v.id,
                'judge:contract_checker',
                'contract',
                {
                  kind: 'missing_required_event',
                  severity: 'major',
                  confidence: 0.9,
                  claim: `acceptance criterion ${cr.criterion_id} failed${cr.note ? `: ${cr.note}` : ''}`,
                },
                i,
              ),
            );
        });
      } else issues.push(...carriedIssues('contract_checker'));

      // ---- model findings, in the ADR-0056 order; optional evaluators after the core seven
      for (const e of evaluators) {
        if (e === 'contract_checker') continue;
        const r = results.get(e);
        if (!r) {
          issues.push(...carriedIssues(e));
          continue;
        }
        evaluatorCalls.push(r.llmCallId);
        (r.output.issues ?? []).forEach((raw, i) =>
          issues.push(toIssue(ctx, v.id, SOURCE[e], EVALUATOR_DIMENSION[e], raw, i, anchor)),
        );
      }

      const callId = (e: EvaluatorName, key: string): string | undefined =>
        results.get(e)?.llmCallId ?? (priorSection(key)?.evaluator_call_id as string | undefined);
      const judgeOut = (e: EvaluatorName, key: string): JudgeOutput => {
        const r = results.get(e);
        if (r) return r.output;
        const s = priorSection(key) ?? {};
        return {
          ...(typeof s.judge_score === 'number' ? { judge_score: s.judge_score } : {}),
          dimension_scores: (s.dimension_scores ?? {}) as Record<string, number>,
          drift_flags: (s.drift_flags ?? []) as string[],
          ...(typeof s.hook_sentence_index === 'number'
            ? { hook_sentence_index: s.hook_sentence_index }
            : {}),
          ...(typeof s.local_payoff_present === 'boolean'
            ? { local_payoff_present: s.local_payoff_present }
            : {}),
          ...(typeof s.ending_type_detected === 'string'
            ? { ending_type_detected: s.ending_type_detected }
            : {}),
        };
      };
      const prose = judgeOut('prose_judge', 'prose');
      const structure = judgeOut('structure_judge', 'structure');
      const genre = judgeOut('genre_judge', 'genre');
      const voice = judgeOut('voice_judge', 'voice');

      // ---- gated dimension scores: the judge's own number, or rubric sub-scores + composites (ADR-0060)
      const gates = ctx.policy.gates;
      const subscores = policyEval?.score_model === 'rubric_subscores';
      const lintOf = (...dims: Issue['dimension'][]) =>
        policyEval
          ? lintComposite(
              det.issues.filter((i) => dims.includes(i.dimension)),
              policyEval.lint_penalty_points,
            )
          : 100;
      const composites: Record<GatedDimension, number> = {
        prose: lintOf('prose', 'output_language'),
        structure: lintOf('structure'),
        genre: Math.round((terminology?.compliance ?? 1) * 1000) / 10,
        voice: Math.round((1 - (register?.register_violation_rate ?? 0)) * 1000) / 10,
      };
      const rubricOf = (d: GatedDimension, out: JudgeOutput) =>
        rubricScore(d, dimensionScores(out.dimension_scores));
      const scoreOf = (d: GatedDimension, out: JudgeOutput) =>
        subscores
          ? composeDimensionScore(
              gates.dimensions[d]?.judge_weight ?? 1,
              rubricOf(d, out),
              composites[d],
            )
          : clamp(out.judge_score ?? 0);
      const proseScore = scoreOf('prose', prose);
      const structureScore = scoreOf('structure', structure);
      const genreScore = scoreOf('genre', genre);
      const voiceScore = scoreOf('voice', voice);
      // Every gated dimension of the pinned policy gets its own result, from the policy's own thresholds.
      // A dimension the policy does not gate contributes no result — and therefore no silent pass.
      const gateFor = (name: GatedDimension) => gates.dimensions[name]?.min_score;
      const dimensionResult = (dimension: GatedDimension, score: number) => {
        const threshold = gateFor(dimension);
        return threshold === undefined
          ? undefined
          : { dimension, score, threshold, passed: score >= threshold };
      };
      const dimensionResults = [
        dimensionResult('prose', proseScore),
        dimensionResult('structure', structureScore),
        dimensionResult('genre', genreScore),
        dimensionResult('voice', voiceScore),
      ].filter((d): d is NonNullable<typeof d> => d !== undefined);
      const count = (s: Severity) => issues.filter((i) => i.severity === s).length;
      const blockingCount = count('blocking');
      const majorCount = count('major');
      const autoApprovable =
        criteriaResults.every((c) => c.passed) &&
        blockingCount <= gates.blocking_max &&
        majorCount <= gates.major_max &&
        dimensionResults.every((d) => d.passed);
      // Look the gate result up by name: the list only carries dimensions the policy actually gates, so
      // positional access would silently mis-attribute a pass when a gate is absent.
      const dimensionPassed = (name: string) =>
        dimensionResults.find((d) => d.dimension === name)?.passed ?? false;
      const section = (
        dim: Issue['dimension'],
        score: number,
        passed: boolean,
        extra: Record<string, unknown> = {},
      ) => ({
        score,
        passed,
        issue_ids: issues.filter((i) => i.dimension === dim).map((i) => i.id),
        ...extra,
      });
      /** A checker's section: 0/100 from its own findings, passed without blocking or major ones. */
      const findingSection = (
        dim: Issue['dimension'],
        e: EvaluatorName,
        key: string,
        countsNotes: boolean,
        extra: Record<string, unknown> = {},
      ) => {
        const own = issues.filter((i) => i.dimension === dim);
        return section(
          dim,
          own.some((i) => countsNotes || i.severity !== 'note') ? 0 : 100,
          !own.some((i) => i.severity === 'blocking' || i.severity === 'major'),
          { evaluator_call_id: callId(e, key), ...carriedFrom(e), ...extra },
        );
      };
      // ADR-0060 audit fields, only under a policy with an evaluation block (ADR-0056 scorecards unchanged).
      const basis = (d: GatedDimension, out: JudgeOutput, e: EvaluatorName) =>
        policyEval
          ? {
              score_model: policyEval.score_model,
              ...(subscores
                ? {
                    rubric_score: rubricOf(d, out),
                    judge_weight: gates.dimensions[d]?.judge_weight ?? 1,
                  }
                : {}),
              ...(d === 'prose' || d === 'structure' ? { lint_composite: composites[d] } : {}),
              ...(d === 'genre' ? { terminology_compliance: composites.genre / 100 } : {}),
              ...(d === 'voice' && register
                ? { register_violation_rate: register.register_violation_rate }
                : {}),
              ...carriedFrom(e),
            }
          : {};
      const promiseRun = results.get('promise_checker');
      const touches = promiseRun
        ? (promiseRun.output.touches ?? []).map((t) => ({
            promise_id: typeof t.promise_id === 'string' ? t.promise_id : '',
            planned: typeof t.planned === 'string' ? t.planned : '',
            found: t.found === true,
          }))
        : priorSection('promises')?.touches;
      const scorecard: Scorecard = {
        id: issueIdFor(ctx, v.id, 'scorecard', input.round),
        manuscript_version_id: v.id,
        canon_version: input.canonVersion,
        quality_tier: ctx.policy.quality_tier,
        overall: {
          score: Math.round((proseScore + structureScore) / 2),
          blocking_count: blockingCount,
          major_count: majorCount,
          minor_count: count('minor'),
          note_count: count('note'),
        },
        sections: {
          prose: section('prose', proseScore, dimensionPassed('prose'), {
            judge_score: clamp(prose.judge_score ?? 0),
            drift_flags: driftFlags('prose', prose.drift_flags),
            dimension_scores: dimensionScores(prose.dimension_scores),
            evaluator_call_id: callId('prose_judge', 'prose'),
            ...basis('prose', prose, 'prose_judge'),
          }),
          structure: section('structure', structureScore, dimensionPassed('structure'), {
            judge_score: clamp(structure.judge_score ?? 0),
            drift_flags: driftFlags('structure', structure.drift_flags),
            dimension_scores: dimensionScores(structure.dimension_scores),
            ...(structure.hook_sentence_index !== undefined
              ? { hook_sentence_index: structure.hook_sentence_index }
              : {}),
            ...(structure.local_payoff_present !== undefined
              ? { local_payoff_present: structure.local_payoff_present }
              : {}),
            ...(structure.ending_type_detected
              ? { ending_type_detected: structure.ending_type_detected }
              : {}),
            evaluator_call_id: callId('structure_judge', 'structure'),
            ...basis('structure', structure, 'structure_judge'),
          }),
          genre: section('genre', genreScore, dimensionPassed('genre'), {
            judge_score: clamp(genre.judge_score ?? 0),
            drift_flags: driftFlags('genre', genre.drift_flags),
            dimension_scores: dimensionScores(genre.dimension_scores),
            evaluator_call_id: callId('genre_judge', 'genre'),
            ...basis('genre', genre, 'genre_judge'),
          }),
          voice: section('voice', voiceScore, dimensionPassed('voice'), {
            judge_score: clamp(voice.judge_score ?? 0),
            drift_flags: driftFlags('voice', voice.drift_flags),
            dimension_scores: dimensionScores(voice.dimension_scores),
            evaluator_call_id: callId('voice_judge', 'voice'),
            ...basis('voice', voice, 'voice_judge'),
          }),
          output_language: section(
            'output_language',
            det.output_language.passed ? 100 : 0,
            det.output_language.passed,
            {
              english_confidence: det.output_language.english_confidence,
              non_english_segments: det.output_language.non_english_segments,
            },
          ),
          contract_compliance: section(
            'contract',
            criteriaResults.every((c) => c.passed) ? 100 : 0,
            criteriaResults.every((c) => c.passed),
            {
              evaluator_call_id: callId('contract_checker', 'contract_compliance'),
              ...carriedFrom('contract_checker'),
            },
          ),
          continuity: findingSection('continuity', 'continuity_checker', 'continuity', false),
          knowledge: findingSection('knowledge', 'knowledge_leak_checker', 'knowledge', true),
          length: section('length', det.length.passed ? 100 : 0, det.length.passed),
          ...(optional.includes('promise_checker')
            ? {
                promises: findingSection('promise', 'promise_checker', 'promises', false, {
                  ...(touches ? { touches } : {}),
                }),
              }
            : {}),
          ...(optional.includes('repetition_judge')
            ? {
                repetition: findingSection('repetition', 'repetition_judge', 'repetition', false, {
                  ...(repetitionEvidence
                    ? {
                        overlap_ratio: repetitionEvidence.report.overlap_ratio,
                        prior_chapters: repetitionEvidence.report.prior_chapters,
                      }
                    : {}),
                }),
              }
            : {}),
        },
        issues,
        acceptance: {
          criteria_results: criteriaResults,
          dimension_results: dimensionResults,
          auto_approvable: autoApprovable,
          production_policy_version: ctx.pins.productionPolicyVersion,
          gate_outcome: autoApprovable
            ? 'approved'
            : blockingCount > 0 || majorCount > 0
              ? 'rejected'
              : 'needs_attention',
        },
        evaluator_calls: evaluatorCalls,
      };
      const valid = validatorFor<Scorecard>('scorecard.schema.json')(scorecard);
      if (!valid.ok)
        throw new WorkflowError(
          'EVALUATION_FAILED',
          `scorecard does not validate: ${valid.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
          { step: 'evaluate' },
        );
      const ref = await saveArtifact(ctx, {
        step: 'evaluate',
        kind: 'scorecard',
        key: v.id,
        schema: 'scorecard.schema.json',
        payload: scorecard,
      });
      return {
        scorecard,
        scorecardArtifactId: ref.artifact_id,
        blocking: issues.filter((i) => i.severity === 'blocking' || i.severity === 'major'),
        approvable: autoApprovable,
        packs: { checker: checker.ref.pack_id, checker_hash: checker.ref.pack_hash },
        ...(policyEval ? { mode: plan.mode, rerun: plan.rerun } : {}),
      };
    },
    v.id,
  );
}

/** Drift flags / 1–5 sub-scores the scorecard accepts; counts when the judge's answer needed fitting. */
function driftFlags(section: 'prose' | 'structure' | 'genre' | 'voice', raw: unknown): string[] {
  const out = normalizeDriftFlags(section, raw);
  if (JSON.stringify(raw ?? []) !== JSON.stringify(out)) recordNormalization('judge_drift_flags');
  return out;
}

function dimensionScores(raw: unknown): Record<string, number> {
  const out = normalizeDimensionScores(raw);
  if (JSON.stringify(raw ?? {}) !== JSON.stringify(out))
    recordNormalization('judge_dimension_scores');
  return out;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

/** Issues that block approval and are candidates for the one targeted revision (dimension-targeted). */
export function revisionTargets(scorecard: Scorecard): Issue[] {
  return scorecard.issues.filter(
    (i) => (i.severity === 'blocking' || i.severity === 'major') && i.status === 'open',
  );
}
