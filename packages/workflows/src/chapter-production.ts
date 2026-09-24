/**
 * ChapterProductionWorkflow (Checkpoint 5, ADR-0046): the deterministic, Postgres-checkpointed core loop.
 *
 *   intake → requirement_interpreter → Story Spec vN → assumptions explained → Story Bible (bible commit)
 *   → arc plan → Chapter k Contract (validated, locked) → scene_writer pack → scene plan → sequential scenes
 *   → assembled working version → deterministic checks + replayed evaluators (prose ≠ structure)
 *   → [one bounded targeted revision → re-evaluate] → approval lock → extraction from the approved version
 *   → verification → atomic acceptance commit → L1 summary → accepted-only index → dependency edges.
 *
 * `workflowId` is deterministic (`chapter:<project>:<chapter>`), so re-running resumes the same job and every
 * completed step is replayed from `job_steps`. Chapter k > 1 refuses to start until chapter k−1 is accepted:
 * the pack builder raises PREVIOUS_CHAPTER_NOT_ACCEPTED and no draft is ever substituted.
 */
import { createHash } from 'node:crypto';
import {
  acceptedChapter,
  finishJob,
  JobControlStop,
  ensureJob,
  ensurePromptSet,
  getJobByWorkflowId,
  getManuscriptVersion,
  getProject,
  l1SummaryFor,
  listJobSteps,
  timelinesOf,
  updateJob,
  upsertPromptVersions,
  type ManuscriptVersionRow,
  type JobRow,
  type Pool,
} from '@yeonjae/db';
import { canonicalPolicyHash, requirePolicy, type PolicyRef } from '@yeonjae/domain';
import { type Gateway } from '@yeonjae/gateway';
import { composeIdentity, ProfileStore, type ComposedIdentity } from '@yeonjae/narrative';
import { PromptRegistry } from '@yeonjae/prompts';
import { resolveWorkflowPins } from './workflow-pins.js';
import {
  acceptDelta,
  approveVersion,
  extractCanon,
  persistDependencyEdges,
  summarizeAndIndex,
} from './acceptance.js';
import {
  assembleChapter,
  checkpointPack,
  draftScenes,
  planScenes,
  type PackRef,
  type SceneDraftRef,
  type StoredPack,
} from './drafting.js';
import { evaluateVersion, revisionTargets, type Scorecard } from './evaluation.js';
import { WorkflowError } from './errors.js';
import { composedRefFor, loadIntoStore } from './identity-from-intake.js';
import {
  buildStoryBible,
  ensureChapter,
  generateContract,
  interpretRequirements,
  planArc,
  validateIntake,
  type ArcPlan,
  type ChapterContract,
  type StoryBible,
  type StoryIntake,
  type StorySpec,
} from './planning.js';
import { patchRegression, regressionArtifact, regressionReportId } from './comparison.js';
import { pickRevisionDimension, reviseVersion } from './revision.js';
import {
  arcForChapter,
  planArcFromBlueprint,
  previousArcOf,
  scheduleFromBlueprint,
  type SeriesBlueprint,
} from './story-plan.js';
import {
  saveArtifact,
  type HeldLease,
  type RunCancellation,
  type StepTrace,
  type WorkflowContext,
  type WorkflowPins,
} from './runtime.js';

export interface ChapterProductionInput {
  readonly projectId: string;
  readonly chapterNo: number;
  readonly intake: unknown;
  readonly bible: StoryBible;
  /** Deterministic ids for the plan objects so replay fixtures can reference them. */
  readonly ids: { readonly arcId: string; readonly seasonId: string; readonly contractId: string };
  readonly specVersion?: number | undefined;
  readonly approvedBy?: string | undefined;
  /** Test hook: fail after this step completes (resume proofs). */
  readonly failAfterStep?: string | undefined;
  /** `contract_and_pack` stops after the locked contract and the scene_writer pack (the Chapter 2 proof). */
  readonly stage?: 'full' | 'contract_and_pack' | undefined;
  /**
   * The target lease this run holds, when it runs under the durable orchestrator. Passed through to the
   * workflow context so every `runStep` boundary re-verifies ownership and a fenced-out worker stops
   * before its next durable side effect. Absent for the single-operator CLI path, which has no rival.
   */
  readonly lease?: HeldLease | undefined;
  /**
   * Active-request cancellation wiring (Phase 4). Carried into the workflow context so a durable cancel,
   * a Temporal activity cancellation, a worker shutdown or a lost lease aborts a provider call that is
   * already in flight rather than waiting for the next step boundary. Absent for the CLI path.
   */
  readonly cancellation?: RunCancellation | undefined;
  /**
   * The Series Blueprint the project's story plan produced. When present, the arc for this chapter is
   * planned from the blueprint's season (checkpointed per arc id) instead of the fixture arc brief, and
   * `ids.arcId` / `ids.seasonId` are taken from the schedule.
   */
  readonly blueprint?: SeriesBlueprint | undefined;
}

export interface ChapterProductionDeps {
  readonly pool: Pool;
  readonly gateway: Gateway;
  readonly registry?: PromptRegistry | undefined;
  readonly profiles?: ProfileStore | undefined;
  readonly bindings?: Record<string, string> | undefined;
}

export interface ChapterProductionResult {
  readonly workflow_id: string;
  readonly job_id: string;
  readonly chapter_no: number;
  readonly chapter_id: string;
  readonly pins: WorkflowPins;
  readonly spec: {
    version: number;
    artifact_id: string;
    hard: number;
    soft: number;
    assumptions: number;
  };
  readonly bible_canon_version: number;
  readonly arc_plan_id: string;
  readonly contract: {
    id: string;
    version: number;
    status: string;
    artifact_id: string;
    acs_hash: string;
  };
  readonly packs: {
    writer: PackRef;
    checker?: { pack_id: string; pack_hash: string } | undefined;
    extractor?: { pack_id: string; pack_hash: string } | undefined;
  };
  readonly scenes: readonly SceneDraftRef[];
  readonly versions: readonly {
    id: string;
    version_no: number;
    origin: string;
    status: string;
    content_hash: string;
    parent_version_id: string | null;
  }[];
  readonly scorecards: readonly {
    manuscript_version_id: string;
    artifact_id: string;
    auto_approvable: boolean;
    blocking: number;
    major: number;
    prose: number;
    structure: number;
  }[];
  readonly revision:
    | {
        rounds: number;
        dimension?: string | undefined;
        patch_artifact_id?: string | undefined;
        regression?:
          | {
              artifact_id: string;
              passed: boolean;
              failures: readonly string[];
              targeted_resolved: boolean;
            }
          | undefined;
      }
    | undefined;
  readonly accepted:
    | {
        manuscript_version_id: string;
        commit_id: string;
        canon_version: number;
        item_counts: Record<string, number>;
        summary_hash: string;
        indexed_documents: number;
        dependency_edges: number;
      }
    | undefined;
  readonly steps: readonly StepTrace[];
  readonly status: 'completed' | 'planned' | 'needs_attention' | 'failed';
  readonly error?: Record<string, unknown> | undefined;
  /** Present for `stage: 'contract_and_pack'` — the manifest and rendered variables of the writer pack. */
  readonly pack_manifest?: StoredPack['manifest'] | undefined;
  readonly pack_variables?: Readonly<Record<string, string>> | undefined;
}

export function workflowIdFor(projectId: string, chapterNo: number): string {
  return `chapter:${projectId}:${chapterNo}`;
}

export const ROUTING_FAMILY_NOTE =
  'Routing for the slice is supplied by the caller (ReplayProvider in tests and the CLI); no live provider is configured.';

/**
 * Build (or rejoin) the checkpointed workflow context for one chapter: pins, policy, identity, job row and
 * the project-scoped replay bindings. Exported so callers that drive a single stage — the comparison and
 * regression suites of Checkpoint 6 — run against the same pinned context the full loop uses, rather than a
 * hand-built stub that could drift from it.
 */
export async function makeContext(
  deps: ChapterProductionDeps,
  projectId: string,
  chapterNo: number,
  lease?: HeldLease,
  cancellation?: RunCancellation,
): Promise<{ ctx: WorkflowContext; mainTimelineId: string; identity: ComposedIdentity }> {
  const project = await getProject(deps.pool, projectId);
  const registry = deps.registry ?? PromptRegistry.fromDirectory();
  const policies = requirePolicy(project.production_policy_version as PolicyRef);
  const policyHash = canonicalPolicyHash(policies);
  const settings = project.settings;
  const identityRef =
    typeof settings.narrative_identity_ref === 'string'
      ? settings.narrative_identity_ref
      : undefined;
  const identityVersionId =
    typeof settings.narrative_identity_version_id === 'string'
      ? settings.narrative_identity_version_id
      : undefined;
  if (!identityRef || !identityVersionId)
    throw new WorkflowError(
      'IDENTITY_UNPINNED',
      `project ${projectId} pins no composed Narrative Identity (settings.narrative_identity_ref / narrative_identity_version_id)`,
      { step: 'init', recommendedActions: ['edit_manually'] },
    );
  const store = deps.profiles ?? ProfileStore.fromDirectory();
  // A project-owned composed identity (derived from the intake) lives in identity_documents, not on disk.
  if (identityRef === composedRefFor(projectId)) await loadIntoStore(deps.pool, projectId, store);
  const timelines = await timelinesOf(deps.pool, projectId);
  const main = timelines.find((t) => t.kind === 'main');
  if (!main) throw new WorkflowError('INTERNAL', 'project has no main timeline', { step: 'init' });
  const workflowId = workflowIdFor(projectId, chapterNo);
  const pinRequest = {
    workflowId,
    step: 'init',
    policyVersion: project.production_policy_version,
    policyHash,
    identityRef,
    identityVersionId,
    canonVersionRead: project.canon_version,
  };
  const existingJob = await getJobByWorkflowId(deps.pool, workflowId);
  let job: JobRow;
  let resolved: Awaited<ReturnType<typeof resolveWorkflowPins>>;
  let identity: ComposedIdentity | undefined;
  if (existingJob) {
    job = existingJob;
    resolved = await resolveWorkflowPins(deps.pool, registry, job, pinRequest);
  } else {
    // Validate identity before any prompt or job row is persisted for a new workflow.
    identity = composeIdentity(store, identityRef, identityVersionId);
    const activePromptSet = registry.activeSet();
    const pins: WorkflowPins = {
      promptSetId: activePromptSet.id,
      promptSet: activePromptSet.mapping,
      productionPolicyVersion: project.production_policy_version,
      productionPolicyHash: policyHash,
      narrativeIdentityVersionId: identityVersionId,
      narrativeIdentityRef: identityRef,
      canonVersionRead: project.canon_version,
    };
    await upsertPromptVersions(
      deps.pool,
      registry
        .list()
        .filter((v) => Object.values(activePromptSet.mapping).includes(v.id))
        .map((v) => ({
          id: v.id,
          family: v.family,
          version: v.version,
          content_hash: v.content_hash,
          role: v.role,
          style_sensitive: v.style_sensitive,
          manuscript_producing: v.manuscript_producing,
          identity_variant: v.identity_variant,
          model_class: v.model_class,
          output_schema: v.output_schema,
          status: v.status,
          meta: { purpose: v.purpose, params: v.params },
        })),
    );
    await ensurePromptSet(deps.pool, activePromptSet);
    const ensured = await ensureJob(deps.pool, {
      workspaceId: project.workspace_id,
      projectId,
      kind: 'chapter_production',
      workflowId,
      idempotencyKey: `${workflowId}:${createHash('sha256')
        .update(
          JSON.stringify({
            promptSet: activePromptSet.id,
            policy: pins.productionPolicyHash,
            identity: identityVersionId,
          }),
        )
        .digest('hex')
        .slice(0, 16)}`,
      targetKind: 'chapter',
      canonVersionRead: project.canon_version,
      productionPolicyVersion: project.production_policy_version,
      promptSetId: activePromptSet.id,
      narrativeIdentityVersionId: identityVersionId,
      pins: {
        prompt_set_id: pins.promptSetId,
        prompt_set: pins.promptSet,
        production_policy_version: pins.productionPolicyVersion,
        production_policy_hash: pins.productionPolicyHash,
        narrative_identity_ref: pins.narrativeIdentityRef,
        narrative_identity_version_id: pins.narrativeIdentityVersionId,
        canon_version_read: pins.canonVersionRead,
      },
    });
    job = ensured.job;
    resolved = await resolveWorkflowPins(deps.pool, registry, job, pinRequest);
  }
  // Bindings are project-scoped names for run-created ids (chapter.1, version.1.approved, canon.f-rank …);
  // merge every job of the project so chapter k can reference what chapter k−1 created, then the caller's.
  const bindings = deps.bindings ?? {};
  const priorJobs = await deps.pool.query<{ progress: { bindings?: Record<string, string> } }>(
    'SELECT progress FROM jobs WHERE project_id = $1 ORDER BY created_at, id',
    [projectId],
  );
  const callerBindings = { ...bindings };
  for (const j of priorJobs.rows) Object.assign(bindings, j.progress.bindings ?? {});
  Object.assign(bindings, callerBindings, { project: projectId, main_timeline: main.id });
  // Resolve persisted pins before loading the identity so an old job with changed project inputs fails
  // with the actionable nondeterminism diagnostic rather than an incidental profile lookup error.
  const resolvedIdentity =
    identity ??
    composeIdentity(
      store,
      resolved.pins.narrativeIdentityRef,
      resolved.pins.narrativeIdentityVersionId,
    );
  const ctx: WorkflowContext = {
    pool: deps.pool,
    gateway: deps.gateway,
    registry,
    promptSet: resolved.promptSet,
    policy: policies,
    identity: resolvedIdentity,
    workspaceId: project.workspace_id,
    projectId,
    job,
    workflowId,
    pins: resolved.pins,
    trace: [],
    bindings,
    ...(lease ? { lease } : {}),
    ...(cancellation ? { cancellation } : {}),
  };
  return { ctx, mainTimelineId: main.id, identity: resolvedIdentity };
}

/** Run (or resume) chapter production. Throws WorkflowError with the failed step after persisting job state. */
export async function produceChapter(
  deps: ChapterProductionDeps,
  input: ChapterProductionInput,
): Promise<ChapterProductionResult> {
  const intake = validateIntake(input.intake);
  const { ctx, mainTimelineId } = await makeContext(
    deps,
    input.projectId,
    input.chapterNo,
    input.lease,
    input.cancellation,
  );
  const specVersion = input.specVersion ?? 1;
  const chapterNo = input.chapterNo;
  const versions: ManuscriptVersionRow[] = [];
  const scorecards: ChapterProductionResult['scorecards'][number][] = [];
  const guard = (step: string) => {
    if (input.failAfterStep === step)
      throw new WorkflowError('INTERNAL', `injected failure after ${step}`, {
        step,
        recommendedActions: ['retry_step'],
      });
  };
  try {
    // ---- planning
    await ensureChapter(ctx, chapterNo);
    // Chapter k > 1 must fail before any canon writes or model spend: the bible step
    // substitutes {{chapter.k-1}} bindings created only when chapter k-1 was produced.
    const previousSummary = await previousChapterSummary(ctx, chapterNo);
    const spec = await interpretRequirements(ctx, intake, specVersion);
    guard('story_spec');
    const bible = await buildStoryBible(ctx, input.bible, mainTimelineId);
    guard('story_bible');
    const arc = input.blueprint
      ? await planFromBlueprint(ctx, input.blueprint, input.bible, chapterNo)
      : await planArc(ctx, {
          spec: spec.spec,
          bible: input.bible,
          arcId: input.ids.arcId,
          seasonId: input.ids.seasonId,
          targetChapters: intake.target_chapters,
        });
    const knownProps = new Set(Object.values(bible.propositionIds));
    const knownEntities = new Set(input.bible.entities.map((e) => e.id));
    const contract = await generateContract(
      ctx,
      {
        chapterNo,
        spec: spec.spec,
        arcPlan: arc.arcPlan,
        mainTimelineId,
        previousSummary,
        lengthTarget:
          intake.manuscript_language === 'ko'
            ? {
                unit: 'characters',
                value: intake.target_characters_per_chapter ?? 5500,
                tolerance_ratio: 0.12,
              }
            : { unit: 'words', value: intake.target_words_per_chapter ?? 2500 },
        contractId: input.ids.contractId,
        // Only the model-driven path renders the registry into the planner prompt; the fixture path keeps
        // its recorded prompt text byte-identical.
        ...(input.blueprint ? { bible: input.bible } : {}),
      },
      knownProps,
      knownEntities,
    );
    guard('chapter_contract');

    // ---- drafting
    const writerPack = await checkpointPack(ctx, {
      label: 'scene_writer',
      role: 'scene_writer',
      contract: contract.contract,
      spec: spec.spec,
    });
    const writer = writerPack.ref;
    const writerBuilt = writerPack.stored;
    if (input.stage === 'contract_and_pack') {
      await updateJob(ctx.pool, ctx.job.id, {
        status: 'waiting_review',
        currentStep: 'writer_pack',
        progress: { chapter_no: chapterNo, stage: 'contract_and_pack' },
      });
      return {
        workflow_id: ctx.workflowId,
        job_id: ctx.job.id,
        chapter_no: chapterNo,
        chapter_id: contract.chapterId,
        pins: ctx.pins,
        spec: specSummary(spec.spec, spec.artifactId),
        bible_canon_version: bible.canonVersion,
        arc_plan_id: arc.arcPlan.id,
        contract: contractSummary(contract.contract, contract.artifactId),
        packs: { writer },
        pack_manifest: writerBuilt.manifest,
        pack_variables: writerBuilt.variables,
        scenes: [],
        versions: [],
        scorecards: [],
        revision: undefined,
        accepted: undefined,
        steps: ctx.trace,
        status: 'planned',
      };
    }
    const usedPacks: StoredPack[] = [writerBuilt];
    const plan = await planScenes(ctx, { contract: contract.contract, pack: writerBuilt });
    guard('scene_plan');
    const drafted = await draftScenes(ctx, {
      contract: contract.contract,
      pack: writerBuilt,
      scenes: plan.scenes,
    });
    guard('scene_draft');
    const assembled = await assembleChapter(ctx, {
      chapterId: contract.chapterId,
      chapterNo,
      texts: drafted.texts,
      drafts: drafted.drafts,
    });
    versions.push(assembled.version);
    guard('assemble');

    // ---- checks, evaluation, one bounded revision path
    const allowlist = input.bible.entities.flatMap((e) => [
      e.display_name,
      ...(e.short_forms ?? []),
      ...(e.aliases ?? []),
    ]);
    let current = assembled.version;
    let round = 0;
    let evaluation = await evaluateVersion(ctx, {
      version: current,
      contract: contract.contract,
      spec: spec.spec,
      canonVersion: bible.canonVersion,
      allowlist,
      round,
      bible: input.bible,
    });
    scorecards.push(summarizeScorecard(evaluation.scorecard, evaluation.scorecardArtifactId));
    guard('evaluate');
    let revision: ChapterProductionResult['revision'];
    const maxRounds = ctx.policy.revision.max_rounds;
    // ADR-0060: patches applied since every evaluator last ran on the whole chapter.
    let patchesSinceFull = 0;
    while (!evaluation.approvable && round < maxRounds) {
      const targets = revisionTargets(evaluation.scorecard);
      const dimension = pickRevisionDimension(targets);
      if (!dimension) break;
      round++;
      const beforeScorecard = evaluation.scorecard;
      const targetedIssueIds = targets.filter((i) => i.dimension === dimension).map((i) => i.id);
      const revised = await reviseVersion(ctx, {
        version: current,
        chapterId: contract.chapterId,
        chapterNo,
        issues: targets,
        dimension,
        round,
        registerDigests: writerBuilt.variables.register_digests ?? '(none)',
      });
      versions.push(revised.version);
      revision = { rounds: round, dimension, patch_artifact_id: revised.patchArtifactId };
      const parentText = current.text;
      current = revised.version;
      guard('revise');
      patchesSinceFull++;
      evaluation = await evaluateVersion(ctx, {
        version: current,
        contract: contract.contract,
        spec: spec.spec,
        canonVersion: bible.canonVersion,
        allowlist,
        round,
        bible: input.bible,
        carry: {
          scorecard: beforeScorecard,
          versionText: parentText,
          targetedDimension: dimension,
          changedClaims: revised.patch.changed_claims.length > 0 || revised.patch.scope === 'scene',
          patchesSinceFull,
        },
      });
      if (evaluation.mode !== 'targeted') patchesSinceFull = 0;
      scorecards.push(summarizeScorecard(evaluation.scorecard, evaluation.scorecardArtifactId));

      // ---- ADR-0014 patch regression: the patch must earn its place before it can reach approval.
      // The report is persisted whether it passes or fails, so the decision is auditable either way.
      const report = patchRegression(ctx.policy, {
        before: beforeScorecard,
        after: evaluation.scorecard,
        dimension,
        targetedIssueIds,
      });
      const regressionRef = await saveArtifact(ctx, {
        step: 'revise',
        kind: 'regression_report',
        key: `${current.id}:r${round}`,
        schema: 'regression-report.schema.json',
        payload: regressionArtifact(report, {
          id: regressionReportId(ctx.workflowId, current.id, round),
          manuscriptVersionId: current.id,
          parentVersionId: revised.patch.from_version_id,
          patchId: revised.patch.id,
          round,
          productionPolicyVersion: ctx.pins.productionPolicyVersion,
        }),
      });
      revision = {
        rounds: round,
        dimension,
        patch_artifact_id: revised.patchArtifactId,
        regression: {
          artifact_id: regressionRef.artifact_id,
          passed: report.passed,
          failures: report.failures,
          targeted_resolved: report.targeted.resolved,
        },
      };
      // A failed regression stops the run before the approval lock, so it can never reach canon acceptance.
      if (!report.passed)
        throw new WorkflowError(
          'PATCH_REGRESSED',
          `the round-${round} ${dimension} patch failed the regression check: ${report.failures.join(', ')}`,
          {
            step: 'revise',
            data: {
              targeted_dimension: dimension,
              failures: report.failures,
              regressions: report.regressions,
              targeted: report.targeted,
              failed_protections: report.protections
                .filter((p) => p.applicable && !p.passed)
                .map((p) => p.protection),
              new_issue_kinds: report.newIssueKinds,
              regression_artifact_id: regressionRef.artifact_id,
            },
            recommendedActions: ['regenerate', 'edit_manually'],
          },
        );
      // The English lineage keeps the Checkpoint-5 single representative revision (its recorded fixtures
      // replay byte-identically). A Korean craft-engine run (ADR-0056) may take further rounds, each on
      // the dimension with the most open blocking/major issues and each regression-checked, up to the
      // pinned policy's max_rounds.
      if (ctx.identity.outputLanguage.language !== 'ko') break;
    }
    revision ??= { rounds: 0 };

    // ---- approval lock (blocks on any remaining blocking/major issue or failed gate)
    await approveVersion(ctx, {
      version: current,
      chapterId: contract.chapterId,
      chapterNo,
      scorecard: evaluation.scorecard,
      approvedBy: input.approvedBy ?? 'workflow:auto',
    });
    guard('approve');

    // ---- extraction → verification → atomic acceptance
    const extraction = await extractCanon(ctx, {
      versionId: current.id,
      chapterId: contract.chapterId,
      contract: contract.contract,
      spec: spec.spec,
    });
    guard('extract');
    const accepted = await acceptDelta(ctx, {
      versionId: current.id,
      chapterId: contract.chapterId,
      delta: extraction.delta,
      contract: contract.contract,
      mainTimelineId,
    });
    guard('accept');
    const registry = input.bible.entities.map((e) => `${e.display_name} (${e.type})`).join('; ');
    const summary = await summarizeAndIndex(ctx, {
      versionId: current.id,
      chapterNo,
      commitId: accepted.commit_id,
      canonVersion: accepted.canon_version,
      registry,
    });
    guard('summarize');
    // Checker/extractor packs were checkpointed by their steps; reload them (replayed) for the edges.
    for (const label of [`continuity_checker:r${round}`, 'canon_extractor']) {
      const p = await checkpointPack(ctx, {
        label,
        role: label.startsWith('continuity') ? 'continuity_checker' : 'canon_extractor',
        contract: contract.contract,
        spec: spec.spec,
        chapterText: { versionId: current.id },
        lexical: false,
      });
      usedPacks.push(p.stored);
    }
    const edges = await persistDependencyEdges(ctx, { versionId: current.id, packs: usedPacks });

    // A terminal job event, emitted exactly once (finishJob is idempotent about it). Without this a
    // completed run left an SSE stream open forever: the client had no terminal frame and could not
    // distinguish "finished" from "idle", and the job's own history had no closing record.
    await finishJob(ctx.pool, {
      jobId: ctx.job.id,
      status: 'completed',
      payload: { chapter_no: chapterNo, canon_version: accepted.canon_version },
    });
    await updateJob(ctx.pool, ctx.job.id, {
      status: 'completed',
      currentStep: null,
      finished: true,
      pins: { canon_version_written: accepted.canon_version },
      progress: {
        chapter_no: chapterNo,
        accepted_version_id: current.id,
        commit_id: accepted.commit_id,
      },
    });
    const finalVersions = await Promise.all(
      versions.map((v) => getManuscriptVersion(ctx.pool, v.id)),
    );
    return {
      workflow_id: ctx.workflowId,
      job_id: ctx.job.id,
      chapter_no: chapterNo,
      chapter_id: contract.chapterId,
      pins: ctx.pins,
      spec: specSummary(spec.spec, spec.artifactId),
      bible_canon_version: bible.canonVersion,
      arc_plan_id: arc.arcPlan.id,
      contract: contractSummary(contract.contract, contract.artifactId),
      packs: {
        writer,
        checker: { pack_id: evaluation.packs.checker, pack_hash: evaluation.packs.checker_hash },
        extractor: extraction.extractorPack,
      },
      scenes: drafted.drafts,
      versions: finalVersions
        .filter((v): v is ManuscriptVersionRow => v !== undefined)
        .map(versionSummary),
      scorecards,
      revision,
      accepted: {
        manuscript_version_id: current.id,
        commit_id: accepted.commit_id,
        canon_version: accepted.canon_version,
        item_counts: accepted.item_counts,
        summary_hash: summary.content_hash,
        indexed_documents: summary.indexed_documents,
        dependency_edges: edges.edges,
      },
      steps: ctx.trace,
      status: 'completed',
    };
  } catch (err) {
    // A control stop is not a failure. `checkpointControl` has already settled the job as paused or
    // cancelled and emitted its event; overwriting that with `failed` here would make the persisted job,
    // its terminal event and the operator's own request disagree.
    if (err instanceof JobControlStop) throw err;
    const wf =
      err instanceof WorkflowError
        ? err
        : new WorkflowError('INTERNAL', err instanceof Error ? err.message : String(err), {
            cause: err,
          });
    if (!(err instanceof WorkflowError) || !ctx.trace.some((t) => t.status === 'failed')) {
      // A quality gate — a blocked approval or a patch that failed its regression check — is an attention
      // state for a human, not an engineering failure.
      const qualityGate = wf.code === 'APPROVAL_BLOCKED' || wf.code === 'PATCH_REGRESSED';
      await updateJob(ctx.pool, ctx.job.id, {
        status: qualityGate ? 'needs_attention' : 'failed',
        error: wf.toJSON(),
      });
    }
    throw wf;
  }
}

function specSummary(spec: StorySpec, artifactId: string): ChapterProductionResult['spec'] {
  return specSummaryOf(spec, artifactId);
}

/**
 * Rolling-horizon arc planning from the blueprint (ADR-0012): the chapter's season decides the arc, the
 * arc plan is checkpointed once per arc id, and the previous arc's exit state (when planned) is carried
 * into the brief so arcs chain instead of restarting.
 */
async function planFromBlueprint(
  ctx: WorkflowContext,
  blueprint: SeriesBlueprint,
  bible: StoryBible,
  chapterNo: number,
): Promise<{ arcPlan: ArcPlan; artifactId: string }> {
  const schedule = scheduleFromBlueprint(ctx.projectId, blueprint);
  const arc = arcForChapter(schedule, chapterNo);
  if (!arc)
    throw new WorkflowError('ARC_PLAN_INVALID', 'the blueprint schedules no arc for this chapter', {
      step: 'arc_plan',
      data: { chapter_no: chapterNo },
    });
  const previous = previousArcOf(schedule, arc);
  let previousArcExit: string | undefined;
  if (previous) {
    const prior = await ctx.pool.query<{ payload: ArcPlan }>(
      `SELECT payload FROM workflow_artifacts WHERE project_id = $1 AND kind = 'arc_plan' AND key = $2`,
      [ctx.projectId, previous.id],
    );
    const exits = prior.rows[0]?.payload.exit_state_assertions;
    if (exits?.length) previousArcExit = exits.join('; ');
  }
  // ADR-0061: the next arc starts from what the accepted text established, not only from what the previous
  // arc planned. The last accepted chapter's summary and ending travel with the planned exit, and the brief
  // says which one wins.
  const actual = await acceptedArcEnding(ctx, arc.from);
  if (actual) {
    const ko = ctx.identity.outputLanguage.language === 'ko';
    const planned = previousArcExit;
    previousArcExit = ko
      ? `${planned ? `(계획) ${planned}. ` : ''}(승인된 원고, ${actual.chapterNo}화에서 실제로 끝난 상태 — 계획과 다르면 이쪽이 우선한다) ${actual.summary}${actual.hook ? ` 마지막 장면: “${actual.hook}”` : ''}`
      : `${planned ? `(planned) ${planned}. ` : ''}(accepted text: how chapter ${actual.chapterNo} actually ended — this wins over the plan) ${actual.summary}${actual.hook ? ` Last scene: “${actual.hook}”` : ''}`;
  }
  return planArcFromBlueprint(ctx, { blueprint, bible, arc, previousArcExit });
}

/** The accepted chapter just before an arc starts: its L1 summary and ending hook (never a draft). */
async function acceptedArcEnding(
  ctx: WorkflowContext,
  arcFrom: number,
): Promise<{ chapterNo: number; summary: string; hook: string | undefined } | undefined> {
  if (arcFrom <= 1) return undefined;
  const found = await acceptedChapter(ctx.pool, ctx.projectId, arcFrom - 1);
  if (found.state !== 'accepted') return undefined;
  const summary = await l1SummaryFor(ctx.pool, found.chapter.version.id);
  if (!summary) return undefined;
  return {
    chapterNo: arcFrom - 1,
    summary: summary.text,
    hook: summary.ending_hook ?? undefined,
  };
}

function specSummaryOf(spec: StorySpec, artifactId: string): ChapterProductionResult['spec'] {
  return {
    version: spec.version,
    artifact_id: artifactId,
    hard: spec.items.filter((i) => i.kind === 'hard').length,
    soft: spec.items.filter((i) => i.kind === 'soft').length,
    assumptions: spec.items.filter((i) => i.kind === 'assumption').length,
  };
}

function contractSummary(
  c: ChapterContract,
  artifactId: string,
): ChapterProductionResult['contract'] {
  return {
    id: c.id,
    version: c.version,
    status: c.status,
    artifact_id: artifactId,
    acs_hash: c.active_constraints_ref.content_hash,
  };
}

function summarizeScorecard(
  s: Scorecard,
  artifactId: string,
): ChapterProductionResult['scorecards'][number] {
  return {
    manuscript_version_id: s.manuscript_version_id,
    artifact_id: artifactId,
    auto_approvable: s.acceptance.auto_approvable,
    blocking: s.overall.blocking_count,
    major: s.overall.major_count,
    prose: s.sections.prose.score,
    structure: s.sections.structure.score,
  };
}

function versionSummary(v: ManuscriptVersionRow) {
  return {
    id: v.id,
    version_no: v.version_no,
    origin: v.origin,
    status: v.status,
    content_hash: v.content_hash,
    parent_version_id: v.parent_version_id,
  };
}

async function previousChapterSummary(ctx: WorkflowContext, chapterNo: number): Promise<string> {
  const ko = ctx.identity.outputLanguage.language === 'ko';
  if (chapterNo === 1)
    return ko
      ? '(1화는 연재의 시작이다. 직전 회차가 없다.)'
      : '(Chapter 1 opens the series; there is no previous chapter.)';
  const prev = await acceptedChapter(ctx.pool, ctx.projectId, chapterNo - 1);
  if (prev.state !== 'accepted')
    throw new WorkflowError(
      'PREVIOUS_CHAPTER_NOT_ACCEPTED',
      prev.state === 'missing'
        ? `chapter ${chapterNo - 1} does not exist yet; chapter ${chapterNo} cannot be planned until chapter ${chapterNo - 1} is accepted (a draft is never substituted)`
        : `chapter ${chapterNo - 1} is ${prev.chapterStatus}${prev.latestVersionStatus ? ` (latest version ${prev.latestVersionStatus})` : ''}; chapter ${chapterNo} waits for its acceptance — a draft is never substituted`,
      {
        step: 'chapter_contract',
        data: { chapter_no: chapterNo - 1, ...prev },
        recommendedActions: ['retry_step'],
      },
    );
  const r = await ctx.pool.query<{ text: string; ending_hook: string | null }>(
    `SELECT text, ending_hook FROM summaries WHERE manuscript_version_id = $1 AND tier = 'L1'`,
    [prev.chapter.version.id],
  );
  const s = r.rows[0];
  if (ko)
    return s
      ? `${chapterNo - 1}화 (승인 v${prev.chapter.version.version_no}, 정사 v${prev.chapter.acceptedCanonVersion}): ${s.text}${s.ending_hook ? ` 절단: “${s.ending_hook}”` : ''}`
      : `${chapterNo - 1}화 승인됨 (v${prev.chapter.version.version_no}, 정사 v${prev.chapter.acceptedCanonVersion}); 저장된 요약 없음.`;
  return s
    ? `Chapter ${chapterNo - 1} (accepted v${prev.chapter.version.version_no}, canon v${prev.chapter.acceptedCanonVersion}): ${s.text}${s.ending_hook ? ` Ending hook: “${s.ending_hook}”` : ''}`
    : `Chapter ${chapterNo - 1} accepted (v${prev.chapter.version.version_no}, canon v${prev.chapter.acceptedCanonVersion}); no L1 summary stored.`;
}

// ---------------------------------------------------------------------------------------------------------
// status / resume / export
// ---------------------------------------------------------------------------------------------------------

export interface WorkflowStatus {
  readonly workflow_id: string;
  readonly job_id: string;
  readonly status: string;
  readonly current_step: string | null;
  readonly pins: Record<string, unknown>;
  readonly progress: Record<string, unknown>;
  readonly error: Record<string, unknown> | null;
  readonly steps: readonly {
    step: string;
    key: string;
    status: string;
    attempt: number;
    completed_at: string | null;
  }[];
  readonly llm_calls: number;
}

export async function workflowStatus(pool: Pool, workflowId: string): Promise<WorkflowStatus> {
  const job = await getJobByWorkflowId(pool, workflowId);
  if (!job) throw new WorkflowError('WORKFLOW_NOT_FOUND', `no job for workflow ${workflowId}`);
  const steps = await listJobSteps(pool, job.id);
  const calls = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM llm_calls WHERE project_id = $1 AND idempotency_key LIKE $2`,
    [job.project_id, `${workflowId}:llm:%`],
  );
  return {
    workflow_id: workflowId,
    job_id: job.id,
    status: job.status,
    current_step: job.current_step,
    pins: job.pins,
    progress: job.progress,
    error: job.error,
    steps: steps.map((s) => ({
      step: s.step,
      key: s.idempotency_key,
      status: s.status,
      attempt: s.attempt,
      completed_at: s.completed_at?.toISOString() ?? null,
    })),
    llm_calls: Number(calls.rows[0]?.n ?? '0'),
  };
}

export interface ExportResult {
  readonly project_id: string;
  readonly chapters: readonly {
    chapter_no: number;
    manuscript_version_id: string;
    version_no: number;
    content_hash: string;
    canon_version: number;
    words: number;
  }[];
  readonly format: 'markdown' | 'text';
  readonly text: string;
  readonly content_hash: string;
}

/** Accepted manuscripts only (through `acceptedChapter`); working/approved/quarantined text never exports. */
export async function exportAccepted(
  pool: Pool,
  input: {
    projectId: string;
    chapters?: readonly number[] | undefined;
    format?: 'markdown' | 'text' | undefined;
    title?: string | undefined;
  },
): Promise<ExportResult> {
  const format = input.format ?? 'markdown';
  const numbers =
    input.chapters ??
    (
      await pool.query<{ number: number }>(
        `SELECT number FROM chapters WHERE project_id = $1 AND status = 'accepted' ORDER BY number`,
        [input.projectId],
      )
    ).rows.map((r) => r.number);
  const parts: string[] = [];
  const chapters: ExportResult['chapters'][number][] = [];
  for (const n of numbers) {
    const lookup = await acceptedChapter(pool, input.projectId, n);
    if (lookup.state !== 'accepted')
      throw new WorkflowError(
        'CHAPTER_NOT_ACCEPTED',
        `chapter ${n} is ${lookup.state === 'missing' ? 'missing' : lookup.chapterStatus}; only accepted manuscripts export`,
        {
          step: 'export',
          data: { chapter_no: n, ...lookup },
        },
      );
    const v = lookup.chapter.version;
    const words = v.text.split(/\s+/).filter(Boolean).length;
    chapters.push({
      chapter_no: n,
      manuscript_version_id: v.id,
      version_no: v.version_no,
      content_hash: v.content_hash,
      canon_version: lookup.chapter.acceptedCanonVersion,
      words,
    });
    parts.push(
      format === 'markdown'
        ? `## Chapter ${n}\n\n${v.text.trim()}\n`
        : `Chapter ${n}\n\n${v.text.trim()}\n`,
    );
  }
  const head = input.title
    ? format === 'markdown'
      ? `# ${input.title}\n\n`
      : `${input.title}\n\n`
    : '';
  const text = head + parts.join('\n');
  return {
    project_id: input.projectId,
    chapters,
    format,
    text,
    content_hash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  };
}

export type { ArcPlan, ChapterContract, StoryBible, StoryIntake, StorySpec, HeldLease };
