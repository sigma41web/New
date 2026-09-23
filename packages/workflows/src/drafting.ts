/**
 * Drafting steps: the scene_writer Context Pack (built by @yeonjae/context, persisted with its manifest and
 * hash), a validated Scene Plan, sequential scene drafts through the gateway (Guard + output-language check on
 * every call), and deterministic assembly into one immutable working manuscript version.
 */
import { createHash } from 'node:crypto';
import { buildPack, PgLexicalRetriever, type ContextPack } from '@yeonjae/context';
import {
  createManuscriptVersion,
  manuscriptVersionsOf,
  setChapterStatus,
  type ManuscriptVersionRow,
} from '@yeonjae/db';
import { asUuid, type Generated, validatorFor } from '@yeonjae/domain';
import { codePointLength, segmentParagraphs, toNfcText } from '@yeonjae/prose';
import { WorkflowError } from './errors.js';
import { normalizeScenePlans } from './plan-normalize.js';
import { normalizeSceneDraft } from './anchoring.js';
import { type ChapterContract, type StorySpec, compileFor } from './planning.js';
import {
  bind,
  loadArtifact,
  modelCall,
  runStep,
  saveArtifact,
  type WorkflowContext,
} from './runtime.js';

export type ScenePlan = Generated.ScenePlanSchema.ScenePlan;
export type SceneDraft = Generated.SceneDraftSchema.SceneDraftWriterOutputEnvelope;

export interface PackRef {
  readonly pack_id: string;
  readonly pack_hash: string;
  readonly template: string;
  readonly canon_version: number;
  readonly stored: boolean;
}

export function packRef(pack: ContextPack, stored: boolean): PackRef {
  return {
    pack_id: pack.id,
    pack_hash: pack.hash,
    template: pack.template.name,
    canon_version: pack.manifest.pinned.canon_version ?? 0,
    stored,
  };
}

/**
 * The persisted shape of a pack (data architecture §8: manifest + hashes in `context_packs`, rendered text in
 * the artifact store). A resumed run reads this instead of rebuilding, so canon moving on after acceptance
 * cannot change what the recorded calls were bound to.
 */
export interface StoredPack {
  readonly id: string;
  readonly hash: string;
  readonly template: string;
  readonly role: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly manifest: ContextPack['manifest'];
  readonly narrativeIdentityRef: ContextPack['narrativeIdentityRef'];
  readonly renderedSystem: string;
  readonly renderedUser: string;
}

export function storedPack(pack: ContextPack): StoredPack {
  return {
    id: pack.id,
    hash: pack.hash,
    template: pack.template.name,
    role: pack.manifest.role,
    variables: pack.variables,
    manifest: pack.manifest,
    narrativeIdentityRef: pack.narrativeIdentityRef,
    renderedSystem: pack.renderedSystem,
    renderedUser: pack.renderedUser,
  };
}

export interface BuiltPack {
  readonly pack: ContextPack;
  readonly ref: PackRef;
  readonly stored: StoredPack;
}

/** Build (and persist) a role pack for the chapter. Packs are pure functions of pinned inputs, so rebuilding on resume is safe. */
export async function buildRolePack(
  ctx: WorkflowContext,
  input: {
    role: string;
    contract: ChapterContract;
    spec: StorySpec;
    chapterText?: { versionId: string } | undefined;
    lexical?: boolean | undefined;
  },
): Promise<BuiltPack> {
  try {
    const { pack, stored } = await buildPack(ctx.pool, {
      projectId: ctx.projectId,
      role: input.role,
      contract: input.contract,
      spec: input.spec,
      policy: ctx.policy,
      identity: ctx.identity,
      promptSetId: ctx.pins.promptSetId,
      chapterText: input.chapterText,
      jobId: ctx.job.id,
      lexical:
        input.lexical === false
          ? undefined
          : new PgLexicalRetriever(ctx.pool, ctx.identity.outputLanguage.language ?? 'en'),
      persist: true,
    });
    return { pack, ref: packRef(pack, stored), stored: storedPack(pack) };
  } catch (err) {
    const e = err as { code?: string; detail?: string; data?: Record<string, unknown> };
    if (e.code === 'PREVIOUS_CHAPTER_NOT_ACCEPTED')
      throw new WorkflowError('PREVIOUS_CHAPTER_NOT_ACCEPTED', e.detail ?? String(err), {
        data: e.data,
        recommendedActions: ['retry_step'],
        cause: err,
      });
    if (e.code === 'PROHIBITED_SOURCE')
      throw new WorkflowError('NOT_EXTRACTABLE', e.detail ?? String(err), {
        data: e.data,
        cause: err,
      });
    if (typeof e.code === 'string')
      throw new WorkflowError('PACK_FAILED', e.detail ?? String(err), {
        data: { context_error: e.code, ...(e.data ?? {}) },
        recommendedActions: ['revalidate_contract'],
        cause: err,
      });
    throw err;
  }
}

/**
 * Build a pack once per (chapter, role, label) and checkpoint its rendered form as an artifact. A resumed run
 * loads the checkpointed pack instead of rebuilding, so the calls it replays stay bound to the same bytes even
 * after canon has moved on (e.g. after this very chapter was accepted).
 */
export async function checkpointPack(
  ctx: WorkflowContext,
  input: {
    label: string;
    role: string;
    contract: ChapterContract;
    spec: StorySpec;
    chapterText?: { versionId: string } | undefined;
    lexical?: boolean | undefined;
  },
): Promise<{ stored: StoredPack; ref: PackRef }> {
  const ch = input.contract.chapter_number;
  const r = await runStep(
    ctx,
    'pack',
    async () => {
      const built = await buildRolePack(ctx, input);
      const art = await saveArtifact(ctx, {
        step: 'pack',
        kind: 'context_pack',
        key: `${ch}:${input.label}`,
        payload: built.stored,
      });
      return { ref: built.ref, artifact_id: art.artifact_id };
    },
    `${ch}:${input.label}`,
  );
  const stored = await loadArtifact<StoredPack>(ctx, r.artifact_id);
  return { stored, ref: r.ref };
}

export function packCallInput(pack: StoredPack) {
  return {
    id: pack.id,
    hash: pack.hash,
    tokenEstimate: pack.manifest.token_counts.total,
    narrativeIdentityRef: pack.narrativeIdentityRef
      ? {
          ...pack.narrativeIdentityRef,
          identityVersionId: asUuid(pack.narrativeIdentityRef.identityVersionId),
        }
      : undefined,
    variables: pack.variables,
  };
}

export async function planScenes(
  ctx: WorkflowContext,
  input: { contract: ChapterContract; pack: StoredPack },
): Promise<{ scenes: ScenePlan[]; artifactId: string }> {
  const ch = input.contract.chapter_number;
  return runStep(
    ctx,
    'scene_plan',
    async () => {
      const call = await modelCall<{ scenes?: unknown }>(ctx, {
        step: 'scene_plan',
        family: 'scene_planner',
        activityId: `scene_plan:${ch}`,
        variables: {
          previous_chapter_tail:
            input.pack.variables.previous_text ??
            (ctx.identity.outputLanguage.language === 'ko'
              ? `(${ch}화에는 직전 회차가 없다. 연재를 연다.)`
              : `(Chapter ${ch} has no previous chapter; open the series.)`),
        },
        pack: packCallInput(input.pack),
        block: compileFor(ctx, 'planner_compact'),
      });
      const raw = Array.isArray(call.output.scenes) ? call.output.scenes : undefined;
      if (!raw)
        throw new WorkflowError('SCENE_PLAN_INVALID', 'scene planner returned no scenes array', {
          step: 'scene_plan',
          recommendedActions: ['regenerate'],
        });
      const validate = validatorFor<ScenePlan>('scene-plan.schema.json');
      const check = (candidates: readonly unknown[]) => {
        const scenes: ScenePlan[] = [];
        const issues: string[] = [];
        candidates.forEach((s, i) => {
          const v = validate(s);
          if (!v.ok)
            issues.push(
              `scene ${i + 1}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
            );
          else scenes.push(v.value);
        });
        return { scenes, issues };
      };
      let { scenes, issues } = check(raw);
      const lengthsOff = () => {
        const total = scenes.reduce((a, s) => a + s.length_target.value, 0);
        const tol = input.contract.length_target.tolerance_ratio ?? 0.12;
        return Math.abs(total / input.contract.length_target.value - 1) > tol;
      };
      // A live plan with near-miss shapes or unsummed lengths is grounded in the contract; a plan that
      // already validates (recorded fixtures) keeps its exact bytes.
      if (raw.length > 0 && (issues.length > 0 || lengthsOff())) {
        const retry = check(normalizeScenePlans(raw, { contract: input.contract }));
        if (retry.issues.length === 0) ({ scenes, issues } = retry);
      }
      if (issues.length === 0) {
        // The contract's scene count is a plan, not a gate: 1–5 grounded scenes are accepted.
        if (scenes.length < 1 || scenes.length > 5)
          issues.push(
            `contract wants ${input.contract.scene_count} scenes, plan has ${scenes.length}`,
          );
        scenes.forEach((s, i) => {
          if (s.scene_no !== i + 1) issues.push(`scene ${i + 1} is numbered ${s.scene_no}`);
          if (!input.contract.participants.some((p) => p.character_id === s.pov.character_id))
            issues.push(`scene ${s.scene_no} POV is not a contract participant`);
          for (const p of s.participants)
            if (!input.contract.participants.some((c) => c.character_id === p))
              issues.push(`scene ${s.scene_no} participant ${p} is not in the contract`);
          if (!input.contract.locations.includes(s.location_id))
            issues.push(`scene ${s.scene_no} location is not in the contract`);
        });
        const total = scenes.reduce((a, s) => a + s.length_target.value, 0);
        const target = input.contract.length_target.value;
        const tol = input.contract.length_target.tolerance_ratio ?? 0.12;
        if (Math.abs(total / target - 1) > tol)
          issues.push(
            `scene length targets sum to ${total}, chapter target is ${target} ${input.contract.length_target.unit} (±${tol * 100}%)`,
          );
      }
      if (issues.length > 0)
        throw new WorkflowError('SCENE_PLAN_INVALID', issues.join('; '), {
          step: 'scene_plan',
          data: { issues },
          recommendedActions: ['regenerate'],
        });
      const ref = await saveArtifact(ctx, {
        step: 'scene_plan',
        kind: 'scene_plan',
        key: `${ch}:v${input.contract.version}`,
        payload: { chapter_no: ch, contract_id: input.contract.id, scenes },
      });
      return { scenes, artifactId: ref.artifact_id };
    },
    String(ch),
  );
}

export interface SceneDraftRef {
  readonly scene_no: number;
  readonly artifact_id: string;
  readonly content_hash: string;
  readonly llm_call_id: string;
  readonly words: number;
  readonly english_confidence: number | undefined;
}

/** Sequential drafting: scene k sees the verbatim text of scenes 1..k−1 (job-scoped, never a stored draft). */
export async function draftScenes(
  ctx: WorkflowContext,
  input: { contract: ChapterContract; pack: StoredPack; scenes: readonly ScenePlan[] },
): Promise<{ drafts: SceneDraftRef[]; texts: string[] }> {
  const ch = input.contract.chapter_number;
  const texts: string[] = [];
  const drafts: SceneDraftRef[] = [];
  for (const scene of input.scenes) {
    const previous = texts.length
      ? texts.join('\n\n')
      : (input.pack.variables.previous_text ??
        (ctx.identity.outputLanguage.language === 'ko'
          ? `(${ch}화가 연재를 연다. 앞에 이어지는 원고가 없다.)`
          : `(Chapter ${ch} opens the series; nothing precedes it.)`));
    const ref = await runStep(
      ctx,
      'scene_draft',
      async () => {
        const call = await modelCall<SceneDraft | string>(ctx, {
          step: 'scene_draft',
          family: 'scene_writer',
          activityId: `scene_draft:${ch}:${scene.scene_no}`,
          variables: {
            scene_plan: JSON.stringify(scene),
            scene_no: String(scene.scene_no),
            previous_text: previous,
            length_target_words: String(scene.length_target.value),
            // Where this scene sits in the episode curve (v4 writers close only the LAST scene on the 절단).
            scene_total: String(input.scenes.length),
            scene_role: sceneRole(
              scene.scene_no,
              input.scenes.length,
              ctx.identity.outputLanguage.language ?? 'en',
            ),
          },
          pack: packCallInput(input.pack),
        });
        // A prose-only (text-mode) writer answers with the manuscript itself; the envelope is built here
        // deterministically. A recorded (or well-formed) JSON draft is taken verbatim; a live draft whose
        // offsets or paragraph table disagree with its own prose is normalized from the prose.
        const draft =
          typeof call.output === 'string'
            ? validateSceneDraft(
                normalizeSceneDraft(
                  proseEnvelope(
                    call.output,
                    scene.scene_no,
                    ctx.identity.outputLanguage.language ?? 'en',
                  ),
                ),
                scene.scene_no,
              )
            : validateOrNormalizeSceneDraft(call.output, scene.scene_no);
        const ref = await saveArtifact(ctx, {
          step: 'scene_draft',
          kind: 'scene_draft',
          key: `${ch}:${scene.scene_no}`,
          schema: 'scene-draft.schema.json',
          payload: draft,
        });
        const out: SceneDraftRef = {
          scene_no: scene.scene_no,
          artifact_id: ref.artifact_id,
          content_hash: ref.content_hash,
          llm_call_id: call.llmCallId,
          words: toNfcText(draft.text).text.split(/\s+/).filter(Boolean).length,
          english_confidence: call.outputLanguageCheck?.performed
            ? call.outputLanguageCheck.englishConfidence
            : undefined,
        };
        return out;
      },
      `${ch}:${scene.scene_no}`,
    );
    const draft = await loadArtifact<SceneDraft>(ctx, ref.artifact_id);
    drafts.push(ref);
    texts.push(toNfcText(draft.text).text);
  }
  return { drafts, texts };
}

/**
 * The scene's place in the episode curve, in the manuscript language. A Korean webnovel episode opens on a
 * hook, builds, and closes ONLY at its end on the 절단; a middle scene that wraps itself up with a reflective
 * closing line is the Western/AI habit the tradition contract forbids.
 */
export function sceneRole(sceneNo: number, total: number, language: string): string {
  if (language !== 'ko') {
    if (total <= 1) return 'single scene: open on the hook, close on the chapter-ending hook';
    if (sceneNo === 1)
      return 'first scene: open on the hook; end mid-tension, pushing into the next scene';
    if (sceneNo === total)
      return 'last scene: build to the payoff, then close on the chapter-ending hook';
    return 'middle scene: escalate; end mid-tension, pushing into the next scene';
  }
  if (total <= 1)
    return '단독 장면 — 첫 세 문장 안에 훅을 걸고, 이번 화의 보상을 터뜨린 뒤 절단으로 끝낸다.';
  if (sceneNo === 1)
    return `첫 장면(1/${String(total)}) — 첫 세 문장 안에 훅을 건다. 장면을 정리하거나 교훈으로 닫지 말고, 다음 장면으로 밀어 넣는 긴장 속에서 끊는다.`;
  if (sceneNo === total)
    return `마지막 장면(${String(total)}/${String(total)}) — 이번 화의 보상(사이다·폭로·감정·성장·웃음)을 터뜨리고, 계약의 절단(hook)으로 끝낸다. 마지막 한두 줄은 한 줄 문단으로, 요약·관조·하루 마무리 금지.`;
  return `중간 장면(${String(sceneNo)}/${String(total)}) — 갈등을 한 칸 키운다. 장면을 정리하지 말고, 다음 장면으로 이어지는 긴장 속에서 끊는다.`;
}

const LEAD_CHATTER =
  /^(물론(이죠|입니다)?|네[,.!]|좋습니다|알겠습니다|다음은|아래는|요청하신|여기\s?있습니다|Sure|Here is|Here's)[^\n]*\n+/u;
const TRAIL_CHATTER =
  /\n+(필요하시면|원하시면|수정이 필요하|더 (길게|짧게)|다른 버전|이상입니다|Let me know)[^\n]*$/u;

/** Strip the assistant chatter a chat model wraps around prose (fences, preambles, sign-offs, labels). */
export function stripProseChatter(raw: string): string {
  let t = raw.replace(/\r\n?/g, '\n').trim();
  for (let i = 0; i < 2; i++) t = t.replace(LEAD_CHATTER, '').trim();
  t = t.replace(TRAIL_CHATTER, '').trim();
  // A fenced answer: keep what is inside the fence.
  t = t
    .replace(/^```[a-zA-Z]*\n/u, '')
    .replace(/\n```$/u, '')
    .trim();
  // Scene/chapter labels and horizontal rules at the edges are not manuscript.
  t = t
    // (Only unmistakable labels: a bare "3화. …" first line can be narration, so it stays.)
    .replace(
      /^(\[장면\s*\d+[^\n\]]*\]|장면\s*\d+\s*[:：]|【[^\n】]*】|제\s?\d+\s?화[^\n]*|#{1,6}\s[^\n]*|-{3,}|\*{3,})\n+/u,
      '',
    )
    .replace(/\n+(-{3,}|\*{3,}|〔끝〕|\(끝\)|끝\.?)$/u, '')
    .trim();
  return t;
}

/**
 * Korean manuscripts use “ ” for dialogue and ‘ ’ for inner speech (the writer's output contract), but a
 * live model switches to ASCII quotes between scenes and a reviser retypes them. Pair ASCII marks line by
 * line into the typographic ones; a line with an odd count is ambiguous and left as it is. Korean prose
 * has no apostrophes, and the replacement is one code point for one.
 */
export function koQuoteMarks(text: string): string {
  return text
    .split('\n')
    .map((line) => pairMarks(pairMarks(line, '"', '“', '”'), "'", '‘', '’'))
    .join('\n');
}

function pairMarks(line: string, mark: '"' | "'", open: string, close: string): string {
  const count = line.split(mark).length - 1;
  if (count === 0 || count % 2 !== 0) return line;
  let n = 0;
  return line.replaceAll(mark, () => (n++ % 2 === 0 ? open : close));
}

/**
 * Build the writer-output envelope from bare prose. A model that ignored text mode and answered with the
 * JSON envelope anyway is unwrapped rather than stored as JSON-looking manuscript.
 */
export function proseEnvelope(
  raw: string,
  sceneNo: number,
  language: string,
): {
  scene_no: number;
  language: 'ko' | 'en';
  text: string;
  paragraphs: never[];
  speaker_annotations: never[];
  claims: never[];
} {
  let text = stripProseChatter(raw);
  if (looksStructured(text)) {
    // A structured answer is either a complete envelope carrying the prose, or a fault (truncated or
    // malformed JSON). A fault fails closed: JSON-looking text must never be stored as manuscript.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const inner = (parsed as { text?: unknown } | undefined)?.text;
    if (typeof inner !== 'string')
      throw new WorkflowError(
        'SCENE_DRAFT_INVALID',
        'the prose writer returned malformed or truncated structured output instead of prose',
        { step: 'scene_draft', recommendedActions: ['regenerate'] },
      );
    text = stripProseChatter(inner);
  }
  if (text.trim().length === 0)
    throw new WorkflowError('SCENE_DRAFT_INVALID', 'the prose writer returned no manuscript text', {
      step: 'scene_draft',
      recommendedActions: ['regenerate'],
    });
  if (language === 'ko') text = koQuoteMarks(text);
  return {
    scene_no: sceneNo,
    language: language === 'ko' ? 'ko' : 'en',
    text,
    paragraphs: [],
    speaker_annotations: [],
    claims: [],
  };
}

/**
 * `{` always opens structured output. `[` does only when the text is JSON or its first line is not a closed
 * bracket label: a Korean scene may open on a status window (`[이안 하르트]`, `[생존 카운트: 72시간]`), and
 * the first live v4.1.0 scene did, while a truncated array (`[1, 2`) still fails closed.
 */
function looksStructured(text: string): boolean {
  if (text.startsWith('{')) return true;
  if (!text.startsWith('[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return !/^\[[^\]\n]+\]/.test(text);
  }
}

export function validateSceneDraft(raw: unknown, expectedSceneNo: number): SceneDraft {
  return validateSceneDraftStrict(raw, expectedSceneNo);
}

export function validateOrNormalizeSceneDraft(raw: unknown, expectedSceneNo: number): SceneDraft {
  try {
    return validateSceneDraftStrict(raw, expectedSceneNo);
  } catch (err) {
    if (!(err instanceof WorkflowError) || typeof raw !== 'object' || raw === null) throw err;
    const normalized = normalizeSceneDraft({
      ...(raw as { text: string }),
      scene_no: expectedSceneNo,
    });
    return validateSceneDraftStrict(normalized, expectedSceneNo);
  }
}

function validateSceneDraftStrict(raw: unknown, expectedSceneNo: number): SceneDraft {
  const v = validatorFor<SceneDraft>('scene-draft.schema.json')(raw);
  if (!v.ok)
    throw new WorkflowError(
      'SCENE_DRAFT_INVALID',
      v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      { step: 'scene_draft', recommendedActions: ['regenerate'] },
    );
  const d = v.value;
  const issues: string[] = [];
  if (d.scene_no !== expectedSceneNo) issues.push(`scene_no ${d.scene_no} ≠ ${expectedSceneNo}`);
  const nfc = toNfcText(d.text);
  const len = codePointLength(nfc.text);
  if (nfc.text.trim().length === 0) issues.push('empty text');
  for (const p of d.paragraphs)
    if (p.start >= p.end || p.end > len)
      issues.push(
        `paragraph ${p.id} span ${p.start}–${p.end} is outside the text (${len} code points)`,
      );
  for (const s of d.speaker_annotations)
    if (s.utterance_start >= s.utterance_end || s.utterance_end > len)
      issues.push(`utterance ${s.utterance_start}–${s.utterance_end} is outside the text`);
  const ids = new Set(d.paragraphs.map((p: { id: string }) => p.id));
  for (const c of d.claims)
    if (!ids.has(c.paragraph_id)) issues.push(`claim cites unknown paragraph ${c.paragraph_id}`);
  if (/[#*_]{2}|^#{1,6}\s/m.test(nfc.text)) issues.push('markdown formatting inside prose');
  if (issues.length > 0)
    throw new WorkflowError('SCENE_DRAFT_INVALID', issues.join('; '), {
      step: 'scene_draft',
      data: { issues },
      recommendedActions: ['regenerate'],
    });
  return d;
}

/** Deterministic assembly: scenes joined by a blank line; one immutable working version per assembled text. */
export async function assembleChapter(
  ctx: WorkflowContext,
  input: {
    chapterId: string;
    chapterNo: number;
    texts: readonly string[];
    drafts: readonly SceneDraftRef[];
  },
): Promise<{ version: ManuscriptVersionRow; created: boolean }> {
  return runStep(
    ctx,
    'assemble',
    async () => {
      const text = toNfcText(input.texts.map((t) => t.trim()).join('\n\n')).text;
      const paragraphs = segmentParagraphs(toNfcText(text));
      if (paragraphs.length === 0)
        throw new WorkflowError('SCENE_DRAFT_INVALID', 'assembled chapter is empty', {
          step: 'assemble',
        });
      // Idempotent against a crash between insert and checkpoint: an assembled version with these bytes is reused.
      const existing = (await manuscriptVersionsOf(ctx.pool, input.chapterId)).find(
        (v) => v.origin === 'assembled' && v.content_hash === contentHashOf(text),
      );
      if (existing) {
        const row = await ctx.pool.query<ManuscriptVersionRow>(
          'SELECT * FROM manuscript_versions WHERE id = $1',
          [existing.id],
        );
        const version = row.rows[0];
        if (!version)
          throw new WorkflowError('INTERNAL', 'assembled version vanished', { step: 'assemble' });
        await bind(ctx, { [`version.${input.chapterNo}.round0`]: version.id });
        return { version, created: false };
      }
      await setChapterStatus(ctx.pool, input.chapterId, 'drafting');
      const version = await createManuscriptVersion(ctx.pool, {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        chapterId: input.chapterId,
        origin: 'assembled',
        text,
        createdByJobId: ctx.job.id,
      });
      await setChapterStatus(ctx.pool, input.chapterId, 'drafted');
      await bind(ctx, { [`version.${input.chapterNo}.round0`]: version.id });
      await saveArtifact(ctx, {
        step: 'assemble',
        kind: 'assembly',
        key: `${input.chapterNo}:${version.id}`,
        payload: {
          manuscript_version_id: version.id,
          version_no: version.version_no,
          content_hash: version.content_hash,
          scenes: input.drafts,
          paragraphs: paragraphs.length,
        },
      });
      return { version, created: true };
    },
    String(input.chapterNo),
  );
}

export function contentHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(toNfcText(text).text, 'utf8').digest('hex')}`;
}
