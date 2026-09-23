/**
 * Approval lock → canon extraction from the approved version only → deterministic verification of every
 * claim and evidence span → atomic acceptance commit (the manuscript becomes `accepted` inside
 * `canon.commit_delta`) → L1 factual summary → accepted-only indexing → dependency edges from the packs used.
 *
 * Idempotency: each step is keyed by the approved manuscript version id. A retry after the commit finds the
 * version already `accepted` with the same commit and does not commit again; a failure before the commit
 * leaves canon untouched (the commit is one SQL transaction).
 */
import { acceptChapter, DeltaRejectedError } from '@yeonjae/canon';
import {
  approveManuscriptVersion,
  getManuscriptVersion,
  getProject,
  indexAcceptedVersion,
  insertDependencyEdges,
  l1SummaryFor,
  setChapterStatus,
  timelinesOf,
  upsertL1Summary,
  withFencedTransaction,
  type DependencyEdgeInput,
  type ManuscriptVersionRow,
} from '@yeonjae/db';
import { type Generated, validatorFor } from '@yeonjae/domain';
import { checkOutputLanguage, segmentParagraphs, toNfcText } from '@yeonjae/prose';
import { anchorEvidence } from './anchoring.js';
import { checkpointPack, packCallInput, type StoredPack } from './drafting.js';
import { type Scorecard } from './evaluation.js';
import { WorkflowError } from './errors.js';
import { type ChapterContract, type StorySpec, compileFor } from './planning.js';
import { requireSelectedWinner } from './selection.js';
import { bind, modelCall, runStep, saveArtifact, type WorkflowContext } from './runtime.js';

export type CanonDelta = Generated.CanonDeltaSchema.CanonDelta;

export async function approveVersion(
  ctx: WorkflowContext,
  input: {
    version: ManuscriptVersionRow;
    chapterId: string;
    chapterNo: number;
    scorecard: Scorecard;
    approvedBy: string;
  },
): Promise<{ manuscript_version_id: string; status: string }> {
  return runStep(
    ctx,
    'approve',
    async () => {
      // Winner-only propagation, enforced HERE rather than by an optional helper the caller may skip.
      // Whether a selection is required is decided from the pinned policy and durable candidate state, so a
      // direct call to approveVersion with a loser cannot bypass it.
      await requireSelectedWinner(ctx, {
        chapterNo: input.chapterNo,
        chapterId: input.chapterId,
        manuscriptVersionId: input.version.id,
        step: 'approve',
      });
      if (!input.scorecard.acceptance.auto_approvable) {
        const blocking = input.scorecard.issues.filter(
          (i) => i.severity === 'blocking' || i.severity === 'major',
        );
        throw new WorkflowError(
          'APPROVAL_BLOCKED',
          `version ${input.version.id} has ${input.scorecard.overall.blocking_count} blocking and ${input.scorecard.overall.major_count} major issues; dimensions: ${input.scorecard.acceptance.dimension_results
            .map((d) => `${d.dimension} ${d.score}/${d.threshold} ${d.passed ? 'ok' : 'FAIL'}`)
            .join(', ')}`,
          {
            step: 'approve',
            data: {
              manuscript_version_id: input.version.id,
              issues: blocking.map((i) => ({
                id: i.id,
                kind: i.kind,
                severity: i.severity,
                dimension: i.dimension,
                claim: i.claim,
              })),
            },
            recommendedActions: ['regenerate', 'edit_manually', 'accept_with_override'],
          },
        );
      }
      const current = await getManuscriptVersion(ctx.pool, input.version.id);
      if (!current) throw new WorkflowError('INTERNAL', 'version not found', { step: 'approve' });
      if (current.status === 'working') {
        // Approval locking is a durable, lease-protected mutation: once a version is `approved` it is the
        // only thing extraction will read, so a fenced-out worker approving its own draft would hand a
        // zombie's text to whoever holds the chapter next. The fence is asserted inside this transaction,
        // so the two status writes and the ownership check commit or roll back as one unit.
        await withFencedTransaction(ctx.pool, ctx.lease, async (c) => {
          await setChapterStatus(c, input.chapterId, 'review_pending');
          await approveManuscriptVersion(c, input.version.id, input.approvedBy);
        });
      } else if (current.status !== 'approved' && current.status !== 'accepted') {
        throw new WorkflowError('NOT_EXTRACTABLE', `version is ${current.status}; cannot approve`, {
          step: 'approve',
        });
      }
      await bind(ctx, { [`version.${input.chapterNo}.approved`]: input.version.id });
      return {
        manuscript_version_id: input.version.id,
        status: current.status === 'working' ? 'approved' : current.status,
      };
    },
    input.version.id,
  );
}

export interface ExtractionResult {
  readonly delta: CanonDelta;
  readonly deltaArtifactId: string;
  readonly extractorPack: { pack_id: string; pack_hash: string };
  readonly hypotheses: number;
}

/** Extract from the APPROVED version only; the pack template refuses working text and the DB refuses non-approved. */
export async function extractCanon(
  ctx: WorkflowContext,
  input: { versionId: string; chapterId: string; contract: ChapterContract; spec: StorySpec },
): Promise<ExtractionResult> {
  return runStep(
    ctx,
    'extract',
    async () => {
      const version = await getManuscriptVersion(ctx.pool, input.versionId);
      if (!version) throw new WorkflowError('INTERNAL', 'version not found', { step: 'extract' });
      if (version.status !== 'approved' && version.status !== 'accepted')
        throw new WorkflowError(
          'NOT_EXTRACTABLE',
          `extraction reads only approval-locked versions; ${version.id} is ${version.status}`,
          { step: 'extract', data: { manuscript_version_id: version.id, status: version.status } },
        );
      await setChapterStatus(ctx.pool, input.chapterId, 'extracting').catch(() => undefined);
      const pack = await checkpointPack(ctx, {
        label: 'canon_extractor',
        role: 'canon_extractor',
        contract: input.contract,
        spec: input.spec,
        chapterText: { versionId: version.id },
        lexical: false,
      });
      const project = await getProject(ctx.pool, ctx.projectId);
      await bind(ctx, { canon_version: String(project.canon_version) });
      const paragraphs = segmentParagraphs(toNfcText(version.text));
      const call = await modelCall<Partial<CanonDelta>>(ctx, {
        step: 'extract',
        family: 'canon_extractor',
        activityId: `extract:${input.contract.chapter_number}`,
        variables: {
          // `event-first` names the extraction sweep (an identifier the prompt defines).
          sweep: 'event-first',
          pre_pass:
            ctx.identity.outputLanguage.language === 'ko'
              ? `문단 ${paragraphs.length}개; 등록부 언급은 팩에서 해소됨.`
              : `${paragraphs.length} paragraphs; registry mentions resolved by the pack.`,
        },
        pack: packCallInput(pack.stored),
      });
      // Live extractors quote text reliably and count code points unreliably; each span is re-anchored
      // to where its quote actually is before verification (policy fuzzy_anchor_min_ratio governs the
      // verifier; anchoring never changes a quote that is not in the text). The extractor is shown ONE
      // version and never its id, so a missing or non-UUID id is filled with that version; a different
      // real id is left alone and rejected below as an envelope mismatch.
      const nfcVersion = toNfcText(version.text);
      const rawItems = Array.isArray(call.output.items) ? call.output.items : [];
      const knownVersionIds = new Set(
        (
          await ctx.pool.query<{ id: string }>(
            'SELECT id FROM manuscript_versions WHERE project_id = $1',
            [ctx.projectId],
          )
        ).rows.map((r) => r.id),
      );
      const anchoredItems = anchorEvidence(
        nfcVersion,
        version.id,
        rawItems.map((item) => ({
          ...item,
          evidence: Array.isArray(item.evidence)
            ? item.evidence.map((ev) => ({
                ...ev,
                manuscript_version_id:
                  typeof ev.manuscript_version_id === 'string' &&
                  knownVersionIds.has(ev.manuscript_version_id)
                    ? ev.manuscript_version_id
                    : version.id,
              }))
            : [],
        })),
      );
      const envelope: CanonDelta = {
        ...(call.output as CanonDelta),
        items: anchoredItems as CanonDelta['items'],
        project_id: ctx.projectId,
        chapter_id: input.chapterId,
        manuscript_version_id: version.id,
        base_canon_version: project.canon_version,
        stage: 'extracted_a',
        extractor_call_id: call.llmCallId,
      };
      // The extractor may only cite the version it was given: any other manuscript_version_id is rejected.
      for (const item of anchoredItems) {
        for (const ev of item.evidence) {
          if (ev.manuscript_version_id !== version.id)
            throw new WorkflowError(
              'EXTRACTION_ENVELOPE_MISMATCH',
              `item ${item.local_id} cites manuscript ${ev.manuscript_version_id}; only the approved ${version.id} may be cited`,
              { step: 'extract', recommendedActions: ['regenerate'] },
            );
        }
      }
      const v = validatorFor<CanonDelta>('canon-delta.schema.json')(envelope);
      if (!v.ok)
        throw new WorkflowError(
          'EXTRACTION_REJECTED',
          `extractor output does not validate: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
          { step: 'extract', recommendedActions: ['regenerate'] },
        );
      const ref = await saveArtifact(ctx, {
        step: 'extract',
        kind: 'canon_delta',
        key: version.id,
        schema: 'canon-delta.schema.json',
        payload: v.value,
      });
      return {
        delta: v.value,
        deltaArtifactId: ref.artifact_id,
        extractorPack: { pack_id: pack.ref.pack_id, pack_hash: pack.ref.pack_hash },
        hypotheses: (v.value.hypothesis_results ?? []).length,
      };
    },
    input.versionId,
  );
}

export interface AcceptanceResult {
  readonly commit_id: string;
  readonly canon_version: number;
  readonly item_counts: Record<string, number>;
  readonly already_accepted: boolean;
}

/**
 * Verify (deterministic verifier: schema, evidence spans against NFC code points, frame × timeline, future
 * validity, unknown entities, planned-frame rejection) and commit atomically. `acceptChapter` reads the
 * approved version itself and rejects any other status.
 *
 * Canon acceptance verifies the selected winner INDEPENDENTLY of approval (it does not assume approval ran
 * or ran correctly), so a direct call with a loser commits nothing.
 */
export async function acceptDelta(
  ctx: WorkflowContext,
  input: {
    versionId: string;
    chapterId: string;
    delta: CanonDelta;
    contract: ChapterContract;
    mainTimelineId: string;
  },
): Promise<AcceptanceResult> {
  return runStep(
    ctx,
    'accept',
    async () => {
      await requireSelectedWinner(ctx, {
        chapterNo: input.contract.chapter_number,
        chapterId: input.chapterId,
        manuscriptVersionId: input.versionId,
        step: 'accept',
      });
      const version = await getManuscriptVersion(ctx.pool, input.versionId);
      if (!version) throw new WorkflowError('INTERNAL', 'version not found', { step: 'accept' });
      if (version.status === 'accepted' && version.accepted_commit_id) {
        const c = await ctx.pool.query<{ version: number; item_counts: Record<string, number> }>(
          'SELECT version, item_counts FROM canon_commits WHERE id = $1',
          [version.accepted_commit_id],
        );
        const row = c.rows[0];
        if (!row)
          throw new WorkflowError('INTERNAL', 'accepted commit missing', { step: 'accept' });
        return {
          commit_id: version.accepted_commit_id,
          canon_version: row.version,
          item_counts: row.item_counts,
          already_accepted: true,
        };
      }
      const timelines = new Map(
        (await timelinesOf(ctx.pool, ctx.projectId)).map((t) => [t.id, t.kind]),
      );
      const entities = await ctx.pool.query<{ id: string }>(
        'SELECT id FROM entities WHERE project_id = $1',
        [ctx.projectId],
      );
      for (const s of ['reconciling', 'verifying', 'committing'])
        await setChapterStatus(ctx.pool, input.chapterId, s).catch(() => undefined);
      try {
        const result = await acceptChapter(ctx.pool, {
          projectId: ctx.projectId,
          chapterId: input.chapterId,
          manuscriptVersionId: input.versionId,
          delta: input.delta,
          actor: { kind: 'workflow', workflow_id: ctx.workflowId, job_id: ctx.job.id },
          clockMax: input.contract.story_time.end,
          timelines,
          mainTimelineId: input.mainTimelineId,
          knownEntityIds: new Set(entities.rows.map((e) => e.id)),
          ...(ctx.lease ? { lease: ctx.lease } : {}),
        });
        await bind(
          ctx,
          Object.fromEntries(Object.entries(result.item_ids).map(([k, v]) => [`canon.${k}`, v])),
        );
        return {
          commit_id: result.commit_id,
          canon_version: result.version,
          item_counts: result.item_counts,
          already_accepted: false,
        };
      } catch (err) {
        await setChapterStatus(ctx.pool, input.chapterId, 'approved').catch(() => undefined);
        if (err instanceof DeltaRejectedError)
          throw new WorkflowError('EXTRACTION_REJECTED', err.message, {
            step: 'accept',
            data: { issues: err.issues },
            recommendedActions: ['regenerate', 'review_conflicts'],
            cause: err,
          });
        const e = err as { code?: string; message?: string };
        if (e.code === 'STALE_CANON')
          throw new WorkflowError('CANON_STALE', e.message ?? 'stale canon', {
            step: 'accept',
            recommendedActions: ['revalidate_contract', 'retry_step'],
            cause: err,
          });
        throw new WorkflowError('ACCEPTANCE_FAILED', e.message ?? String(err), {
          step: 'accept',
          recommendedActions: ['retry_step'],
          cause: err,
        });
      }
    },
    input.versionId,
  );
}

export interface SummaryResult {
  readonly summary_l1: string;
  readonly ending_hook: string;
  readonly content_hash: string;
  readonly indexed_documents: number;
}

/** L1 summary from the accepted text + committed delta (never from plans), stored and indexed accepted-only. */
export async function summarizeAndIndex(
  ctx: WorkflowContext,
  input: {
    versionId: string;
    chapterNo: number;
    commitId: string;
    canonVersion: number;
    registry: string;
  },
): Promise<SummaryResult> {
  return runStep(
    ctx,
    'summarize',
    async () => {
      const version = await getManuscriptVersion(ctx.pool, input.versionId);
      if (version?.status !== 'accepted')
        throw new WorkflowError(
          'CHAPTER_NOT_ACCEPTED',
          `summaries are generated for accepted versions only; ${input.versionId} is ${version?.status ?? 'missing'}`,
          { step: 'summarize' },
        );
      const commit = await ctx.pool.query<{ delta: CanonDelta }>(
        'SELECT delta FROM canon_commits WHERE id = $1',
        [input.commitId],
      );
      const delta = commit.rows[0]?.delta;
      if (!delta) throw new WorkflowError('INTERNAL', 'commit not found', { step: 'summarize' });
      const committedLines = delta.items
        .map((i) => `- ${i.type}/${i.op}: ${describeItem(i)}`)
        .join('\n');
      const call = await modelCall<{
        summary_l1?: string;
        ending_hook?: string;
        state_changes?: unknown;
        knowledge_changes?: unknown;
      }>(ctx, {
        step: 'summarize',
        family: 'factual_summarizer',
        activityId: `summarize:${input.chapterNo}`,
        variables: {
          chapter_text: version.text,
          registry: input.registry,
          committed_delta: committedLines,
        },
        block: compileFor(ctx, 'summarizer_min', 3000),
      });
      const summary = toNfcText(call.output.summary_l1 ?? '').text.trim();
      const nfcText = toNfcText(version.text).text;
      // The hook must be verbatim from the accepted text. A live model paraphrases; when neither the
      // summarizer's nor the extractor's hook is a literal excerpt, the manuscript's own last paragraph
      // is the hook — it IS the ending, and it is verbatim by construction.
      const proposed = [call.output.ending_hook, delta.ending_hook]
        .filter((h): h is string => typeof h === 'string')
        .map((h) => toNfcText(h).text.trim())
        .filter((h) => h.length > 0);
      const literal = proposed.find((h) => nfcText.includes(h));
      const lastParagraph = segmentParagraphs(toNfcText(version.text)).at(-1)?.text.trim() ?? '';
      const hook = literal ?? (proposed.length > 0 ? lastParagraph : '');
      const maxWords = ctx.policy.context.l1_summary_max_words ?? 120;
      const words = summary.split(/\s+/).filter(Boolean).length;
      if (!summary || words > maxWords)
        throw new WorkflowError(
          'SUMMARY_INVALID',
          `L1 summary has ${words} words (max ${maxWords})`,
          { step: 'summarize', recommendedActions: ['regenerate'] },
        );
      const language: 'en' | 'ko' = ctx.identity.outputLanguage.language ?? 'en';
      if (!checkOutputLanguage(toNfcText(summary), { language }).passed)
        throw new WorkflowError('OUTPUT_LANGUAGE_FAILED', 'L1 summary failed the language check', {
          step: 'summarize',
        });
      if (hook && !nfcText.includes(hook))
        throw new WorkflowError(
          'SUMMARY_INVALID',
          'ending hook is not a verbatim excerpt of the accepted text',
          { step: 'summarize', recommendedActions: ['regenerate'] },
        );
      // Summaries and the accepted-only lexical index are what the NEXT chapter reads as established
      // fact, so they are lease-protected too: a fenced-out worker writing them would feed a rival's run
      // stale continuity. One fenced transaction covers the summary row and the indexing together.
      const stored = await withFencedTransaction(ctx.pool, ctx.lease, async (c) => {
        const row = await upsertL1Summary(c, {
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          manuscriptVersionId: version.id,
          chapterNo: input.chapterNo,
          text: summary,
          endingHook: hook || undefined,
          canonVersion: input.canonVersion,
          promptVersionId: call.promptVersionId,
        });
        const n = await indexAcceptedVersion(c, version.id);
        return { row, n };
      });
      const check = await l1SummaryFor(ctx.pool, version.id);
      if (!check)
        throw new WorkflowError('INTERNAL', 'summary not readable after store', {
          step: 'summarize',
        });
      return {
        summary_l1: summary,
        ending_hook: hook,
        content_hash: stored.row.content_hash,
        indexed_documents: stored.n,
      };
    },
    input.versionId,
  );
}

function describeItem(i: CanonDelta['items'][number]): string {
  const p = i.payload as unknown as Record<string, unknown>;
  const s =
    typeof p.summary === 'string'
      ? p.summary
      : typeof p.value_text === 'string'
        ? `${String(p.attribute)} = ${p.value_text}`
        : typeof p.statement === 'string'
          ? p.statement
          : JSON.stringify(p).slice(0, 120);
  return s;
}

/** Dependency edges from the packs the accepted version was drafted/checked/extracted with (ADR-0032). */
export async function persistDependencyEdges(
  ctx: WorkflowContext,
  input: { versionId: string; packs: readonly StoredPack[] },
): Promise<{ edges: number; inserted: number }> {
  return runStep(
    ctx,
    'dependency_edges',
    async () => {
      const edges: DependencyEdgeInput[] = [];
      const seen = new Set<string>();
      for (const pack of input.packs) {
        for (const item of pack.manifest.items) {
          if (!item.included || !item.source) continue;
          const src = item.source;
          if (
            ![
              'canon',
              'accepted_manuscript',
              'summary',
              'active_constraint_set',
              'chapter_contract',
            ].includes(src.kind)
          )
            continue;
          const key = `${item.kind}|${src.ref}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const basis: DependencyEdgeInput['basis'] =
            item.tier === 'T0' ? 't0' : item.tier === 'T1' ? 't1_state' : 'retrieved_t2';
          edges.push({
            dependentKind: 'manuscript_version',
            dependentId: input.versionId,
            canonItemKind: item.kind,
            canonItemRef: src.ref,
            sourceKind: src.kind,
            canonVersionRead: pack.manifest.pinned.canon_version ?? 0,
            materiality:
              item.materiality === 'material' || item.tier === 'T0' || item.tier === 'T1'
                ? 'material'
                : 'contextual',
            basis,
            packId: pack.id,
          });
        }
      }
      // Dependency edges record what the accepted version depended on, and the impact reports that drive
      // correction/retcon read them. A fenced-out worker adding edges would misattribute another run's
      // manuscript, so this write is fenced like the rest of the acceptance tail.
      const inserted = await withFencedTransaction(ctx.pool, ctx.lease, (c) =>
        insertDependencyEdges(c, { workspaceId: ctx.workspaceId, projectId: ctx.projectId }, edges),
      );
      return { edges: edges.length, inserted };
    },
    input.versionId,
  );
}
