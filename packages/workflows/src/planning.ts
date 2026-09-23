/**
 * Planning steps of the vertical slice: intake validation → `requirement_interpreter` → versioned Story Spec
 * (hard / soft / assumption kept distinct, assumptions explained) → Story Bible (entities, propositions,
 * promises and the bible canon commit) → initial arc plan → Chapter Contract → contract validation + lock.
 *
 * The bible and the plans are PLANNED artifacts: they live in workflow_artifacts and in the bible commit
 * (`source='bible'`, no story events), never as realized canon (ADR-0038: planned ≠ happened).
 */
import {
  commitDelta,
  checkpointControl,
  createChapter,
  createEntity,
  createPromise,
  getProject,
  JobControlCommitBlockedError,
  chapterByNumber,
} from '@yeonjae/db';
import { type Generated, recordNormalization, validatorFor } from '@yeonjae/domain';
import { compileActiveConstraintSet } from '@yeonjae/context';
import { compileBlock } from '@yeonjae/narrative';
import { type LengthTarget } from '@yeonjae/prose';
import { WorkflowError } from './errors.js';
import { normalizeContractOutput } from './plan-normalize.js';
import {
  bind,
  existingArtifact,
  modelCall,
  runStep,
  saveArtifact,
  substitute,
  type WorkflowContext,
} from './runtime.js';

export type StoryIntake = Generated.StoryIntakeSchema.StoryIntake;
export type StorySpec = Generated.StorySpecSchema.StorySpec;
export type Requirement = Generated.StorySpecSchema.Requirement;
export type ArcPlan = Generated.ArcPlanSchema.ArcPlan;
export type ChapterContract = Generated.ChapterContractSchema.ChapterContract;

/** The Story Bible as the slice needs it: registry entities, propositions, promises, seed facts/relations. */
export interface StoryBible {
  readonly version: number;
  readonly design?:
    | {
        readonly characters: Readonly<Record<string, unknown>>;
        readonly world: Readonly<Record<string, unknown>>;
        readonly progression: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly entities: readonly {
    readonly id: string;
    readonly type: string;
    readonly display_name: string;
    readonly short_forms?: readonly string[] | undefined;
    readonly aliases?: readonly string[] | undefined;
    readonly description?: string | undefined;
    readonly design?: Readonly<Record<string, unknown>> | undefined;
  }[];
  readonly propositions: readonly {
    readonly local_id: string;
    readonly statement: string;
    readonly kind: string;
    readonly entity_ids: readonly string[];
    readonly secret?: Record<string, unknown> | undefined;
    readonly truth: 'true' | 'false' | 'unknown';
  }[];
  readonly promises: readonly {
    readonly id: string;
    readonly type: string;
    readonly statement: string;
    readonly importance: 'core' | 'major' | 'minor';
    readonly due_min_chapter?: number | undefined;
    readonly due_max_chapter?: number | undefined;
    readonly related_entity_ids: readonly string[];
  }[];
  /**
   * Seed facts / relationships / knowledge committed as `bible` commits (payloads per canon-delta-payloads).
   * Items may reference ids created earlier in the run as `{{proposition.P1}}`, `{{bible.<local_id>}}`,
   * `{{chapter.1}}`; commits run in order so later ones can cite earlier ones.
   */
  readonly commits: readonly (readonly Record<string, unknown>[])[];
}

export interface PlanningResult {
  readonly spec: StorySpec;
  readonly specArtifactId: string;
  readonly bible: StoryBible;
  readonly bibleCanonVersion: number;
  readonly propositionIds: Readonly<Record<string, string>>;
  readonly arcPlan: ArcPlan;
  readonly contract: ChapterContract;
  readonly contractArtifactId: string;
}

export function validateIntake(intake: unknown): StoryIntake {
  const v = validatorFor<StoryIntake>('story-intake.schema.json')(intake);
  if (!v.ok)
    throw new WorkflowError(
      'INTAKE_INVALID',
      v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      { step: 'intake', recommendedActions: ['edit_manually'] },
    );
  return v.value;
}

/** The chapter row exists from the start of the run so bible knowledge sources and bindings can cite it. */
export async function ensureChapter(ctx: WorkflowContext, chapterNo: number): Promise<string> {
  const existing = await chapterByNumber(ctx.pool, ctx.projectId, chapterNo);
  const id =
    existing?.id ??
    (await createChapter(ctx.pool, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      number: chapterNo,
    }));
  await bind(ctx, { [`chapter.${chapterNo}`]: id });
  return id;
}

export async function interpretRequirements(
  ctx: WorkflowContext,
  intake: StoryIntake,
  specVersion: number,
): Promise<{ spec: StorySpec; artifactId: string }> {
  return runStep(ctx, 'story_spec', async () => {
    await bind(ctx, { spec_version: String(specVersion) });
    // The spec is a PROJECT artifact: the story plan (or chapter 1) interpreted it once and every later
    // chapter job pins that same version rather than asking the model again.
    const stored = await existingArtifact(ctx, {
      step: 'story_spec',
      kind: 'story_spec',
      key: `v${specVersion}`,
    });
    if (stored) return { spec: stored.payload as StorySpec, artifactId: stored.artifact_id };
    const call = await modelCall<{ items?: unknown; conflicts?: unknown }>(ctx, {
      step: 'story_spec',
      family: 'requirement_interpreter',
      activityId: `story_spec:v${specVersion}`,
      variables: {
        intake_json: JSON.stringify(intake),
        spelling_locale: intake.spelling_locale ?? 'en-US',
      },
    });
    const raw = call.output;
    const items = Array.isArray(raw.items) ? (raw.items as Requirement[]) : [];
    const candidate: StorySpec = {
      project_id: ctx.projectId,
      version: specVersion,
      items,
      ...(Array.isArray(raw.conflicts)
        ? { conflicts: raw.conflicts as NonNullable<StorySpec['conflicts']> }
        : {}),
    };
    const v = validatorFor<StorySpec>('story-spec.schema.json')(candidate);
    if (!v.ok)
      throw new WorkflowError(
        'SPEC_INVALID',
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        { step: 'story_spec', recommendedActions: ['regenerate'] },
      );
    const spec = v.value;
    // Hard / soft / assumption are distinct by construction; every assumption must carry a rationale.
    const assumptions = spec.items.filter((i) => i.kind === 'assumption');
    const unexplained = assumptions.filter((a) => !a.rationale);
    let explained = spec;
    if (unexplained.length > 0) {
      const expl = await modelCall<{
        explanations?: { assumption_id: string; rationale: string }[];
      }>(ctx, {
        step: 'story_spec',
        family: 'assumption_explainer',
        activityId: `assumptions:v${specVersion}`,
        variables: { assumptions_json: JSON.stringify(unexplained) },
      });
      const byId = new Map(
        (expl.output.explanations ?? []).map((e) => [e.assumption_id, e.rationale]),
      );
      explained = {
        ...spec,
        items: spec.items.map((i) =>
          i.kind === 'assumption' && !i.rationale && byId.get(i.id)
            ? { ...i, rationale: byId.get(i.id) ?? '' }
            : i,
        ),
      };
      const still = explained.items.filter((i) => i.kind === 'assumption' && !i.rationale);
      if (still.length > 0)
        throw new WorkflowError(
          'SPEC_INVALID',
          `assumptions without a recorded rationale: ${still.map((s) => s.id).join(', ')}`,
          { step: 'story_spec', recommendedActions: ['regenerate'] },
        );
    }
    for (const item of explained.items) {
      if (item.kind === 'assumption' && item.confirmed_by_user)
        throw new WorkflowError(
          'SPEC_INVALID',
          `${item.id}: an assumption cannot be marked confirmed_by_user; promote it to hard/soft instead`,
          { step: 'story_spec' },
        );
    }
    const ref = await saveArtifact(ctx, {
      step: 'story_spec',
      kind: 'story_spec',
      key: `v${specVersion}`,
      schema: 'story-spec.schema.json',
      payload: explained,
    });
    return { spec: explained, artifactId: ref.artifact_id };
  });
}

/**
 * The bible is authored data in this slice (no `character_designer`/`world_builder` calls are needed to prove
 * the loop); it is validated structurally, its entities/promises are created with their fixture ids, and its
 * seed items are committed as the `bible` canon commit (version 0 → 1) exactly once.
 */
export async function buildStoryBible(
  ctx: WorkflowContext,
  bible: StoryBible,
  mainTimelineId: string,
): Promise<{ canonVersion: number; propositionIds: Record<string, string>; artifactId: string }> {
  return runStep(ctx, 'story_bible', async () => {
    if (bible.entities.length === 0)
      throw new WorkflowError('INTERNAL', 'story bible has no entities', { step: 'story_bible' });
    // `runStep` checks control before entering this callback, but the seed writes are a multi-statement
    // boundary. Re-check immediately before touching planned registry/canon state so a mid-step cancel
    // cannot proceed merely because the step itself is already marked running.
    await checkpointStoryBibleControl(ctx, 'story_bible_seed');
    const seen = new Set<string>();
    for (const e of bible.entities) {
      if (seen.has(e.display_name))
        throw new WorkflowError('INTERNAL', `duplicate bible entity ${e.display_name}`, {
          step: 'story_bible',
        });
      seen.add(e.display_name);
      const exists = await ctx.pool.query('SELECT 1 FROM entities WHERE id = $1', [e.id]);
      if (exists.rowCount === 0)
        await createEntity(ctx.pool, {
          id: e.id,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          type: e.type,
          displayName: e.display_name,
          shortForms: [...(e.short_forms ?? [])],
          aliases: [...(e.aliases ?? [])],
          fields: {
            ...(e.description ? { description: e.description } : {}),
            ...(e.design ? { planned_design: e.design } : {}),
          },
        });
    }
    for (const p of bible.promises) {
      const exists = await ctx.pool.query('SELECT 1 FROM promises WHERE id = $1', [p.id]);
      if (exists.rowCount === 0)
        await createPromise(ctx.pool, {
          id: p.id,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          type: p.type,
          statement: p.statement,
          importance: p.importance,
          status: 'planned',
          dueMinChapter: p.due_min_chapter,
          dueMaxChapter: p.due_max_chapter,
          relatedEntityIds: p.related_entity_ids,
        });
    }
    const propositionItems: Record<string, unknown>[] = bible.propositions.map((p) => ({
      local_id: p.local_id,
      type: 'proposition',
      op: 'create',
      frame: 'canonical',
      confidence: 1,
      importance: 'core',
      evidence: [],
      payload: {
        statement: p.statement,
        kind: p.kind,
        entity_ids: p.entity_ids,
        ...(p.secret ? { secret: p.secret } : {}),
        truth: [{ timeline_id: mainTimelineId, value: p.truth }],
      },
    }));
    const commits = [[...propositionItems, ...(bible.commits[0] ?? [])], ...bible.commits.slice(1)];
    const propositionIds: Record<string, string> = {};
    const bibleIds: Record<string, string> = {};
    const project = await getProject(ctx.pool, ctx.projectId);
    if (project.canon_version === 0) {
      let parent = 0;
      for (const items of commits) {
        await checkpointStoryBibleControl(ctx, 'story_bible_commit');
        let commit;
        try {
          commit = await commitDelta(ctx.pool, {
            projectId: ctx.projectId,
            parentVersion: parent,
            source: 'bible',
            delta: substitute({ items }, ctx.bindings),
            actor: { kind: 'workflow', workflow_id: ctx.workflowId },
            ...(ctx.lease ? { lease: ctx.lease } : {}),
            jobControl: { jobId: ctx.job.id },
          });
        } catch (err) {
          if (err instanceof JobControlCommitBlockedError)
            await checkpointStoryBibleControl(ctx, 'story_bible_commit');
          throw err;
        }
        parent = commit.version;
        for (const [local, id] of Object.entries(commit.item_ids)) {
          bibleIds[local] = id;
          if (bible.propositions.some((p) => p.local_id === local)) propositionIds[local] = id;
        }
        await bind(ctx, {
          ...Object.fromEntries(Object.entries(commit.item_ids).map(([k, v]) => [`bible.${k}`, v])),
          ...Object.fromEntries(
            Object.entries(propositionIds).map(([k, v]) => [`proposition.${k}`, v]),
          ),
        });
      }
    } else {
      // Resume after a crash between commit and checkpoint: recover ids from the bible commits.
      const rows = await ctx.pool.query<{ id: string }>(
        `SELECT id FROM canon_commits WHERE project_id = $1 AND source = 'bible' ORDER BY version`,
        [ctx.projectId],
      );
      if (rows.rows.length === 0)
        throw new WorkflowError('CANON_STALE', 'canon is past version 0 but has no bible commit', {
          step: 'story_bible',
        });
      const props = await ctx.pool.query<{ id: string; statement: string }>(
        'SELECT id, statement FROM propositions WHERE project_id = $1',
        [ctx.projectId],
      );
      for (const p of bible.propositions) {
        const found = props.rows.find((x) => x.statement === p.statement);
        if (found) propositionIds[p.local_id] = found.id;
      }
      const stored = ctx.bindings;
      for (const [k, v] of Object.entries(stored))
        if (k.startsWith('bible.')) bibleIds[k.slice(6)] = v;
    }
    const after = await getProject(ctx.pool, ctx.projectId);
    const ref = await saveArtifact(ctx, {
      step: 'story_bible',
      kind: 'story_bible',
      key: `v${bible.version}`,
      payload: { ...bible, proposition_ids: propositionIds, bible_ids: bibleIds },
    });
    return { canonVersion: after.canon_version, propositionIds, artifactId: ref.artifact_id };
  });
}

async function checkpointStoryBibleControl(ctx: WorkflowContext, step: string): Promise<void> {
  await checkpointControl(ctx.pool, { jobId: ctx.job.id, step });
}

export async function planArc(
  ctx: WorkflowContext,
  input: {
    spec: StorySpec;
    bible: StoryBible;
    arcId: string;
    seasonId: string;
    targetChapters: number;
  },
): Promise<{ arcPlan: ArcPlan; artifactId: string }> {
  return runStep(ctx, 'arc_plan', async () => {
    const block = compilePlannerBlock(ctx);
    const call = await modelCall<ArcPlan>(ctx, {
      step: 'arc_plan',
      family: 'arc_planner',
      activityId: 'arc_plan:1',
      variables: {
        blueprint: `Series of ${input.targetChapters} chapters; season 1 opens on the awakening measurement.`,
        season: `Season 1 (id ${input.seasonId})`,
        arc_brief: `Arc 1 (id ${input.arcId}): the second awakening — the protagonist wakes on measurement morning with future knowledge and no proof.`,
        canon_state: renderBibleState(input.bible),
        open_promises: input.bible.promises
          .map((p) => `- ${p.statement} (${p.type}, ${p.importance})`)
          .join('\n'),
      },
      block,
    });
    const candidate = {
      ...call.output,
      project_id: ctx.projectId,
      id: input.arcId,
      season_id: input.seasonId,
    };
    const v = validatorFor<ArcPlan>('arc-plan.schema.json')(candidate);
    if (!v.ok)
      throw new WorkflowError(
        'ARC_PLAN_INVALID',
        v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        { step: 'arc_plan', recommendedActions: ['regenerate'] },
      );
    const ref = await saveArtifact(ctx, {
      step: 'arc_plan',
      kind: 'arc_plan',
      key: input.arcId,
      schema: 'arc-plan.schema.json',
      payload: v.value,
    });
    return { arcPlan: v.value, artifactId: ref.artifact_id };
  });
}

export interface ContractInput {
  readonly chapterNo: number;
  readonly spec: StorySpec;
  readonly arcPlan: ArcPlan;
  readonly mainTimelineId: string;
  readonly previousSummary: string;
  /** Unit-aware per-chapter target: words for en, characters for ko (ADR-0054). */
  readonly lengthTarget: LengthTarget;
  readonly contractId: string;
  /** Registry and promises rendered for the planner; absent falls back to the pinned-state notes. */
  readonly bible?: StoryBible | undefined;
}

/**
 * Generate, validate and lock the Chapter Contract. Validation is deterministic: schema, chapter number,
 * project/timeline pins, active-constraint-set hash recomputed from the pinned spec, no must_happen that a
 * hard forbidden-development requirement rules out for this chapter, and every guarded proposition known.
 */
export async function generateContract(
  ctx: WorkflowContext,
  input: ContractInput,
  knownPropositionIds: ReadonlySet<string>,
  knownEntityIds: ReadonlySet<string>,
): Promise<{ contract: ChapterContract; artifactId: string; chapterId: string }> {
  return runStep(
    ctx,
    'chapter_contract',
    async () => {
      const project = await getProject(ctx.pool, ctx.projectId);
      const block = compilePlannerBlock(ctx);
      const lang = langOf(ctx);
      const acsHard = compileActiveConstraintSet(
        input.spec,
        {
          chapterNo: input.chapterNo,
          arcId: input.arcPlan.id,
          seasonId: input.arcPlan.season_id,
          participantIds: [],
          specVersion: input.spec.version,
        },
        {
          capTokens: ctx.policy.context.active_constraints_cap_tokens,
          workingLanguage: ctx.identity.outputLanguage.language ?? 'en',
        },
      );
      await bind(ctx, {
        canon_version: String(project.canon_version),
        [`acs.${input.chapterNo}.id`]: acsHard.id,
        [`acs.${input.chapterNo}.hash`]: acsHard.contentHash,
        [`acs.${input.chapterNo}.tokens`]: String(acsHard.tokenCount),
      });
      const call = await modelCall<ChapterContract>(ctx, {
        step: 'chapter_contract',
        family: 'chapter_planner',
        activityId: `chapter_contract:${input.chapterNo}`,
        variables: {
          arc_plan: JSON.stringify(input.arcPlan),
          chapter_number: String(input.chapterNo),
          previous_chapter_summary: input.previousSummary,
          canon_state: input.bible
            ? `${renderBibleState(input.bible, ctx.bindings, lang)}\n\n${
                lang === 'ko'
                  ? 'participants, locations, pov.character_id에는 위의 엔티티 id만, knowledge_guards와 knowledge_deltas에는 위의 명제 id만 쓴다.'
                  : 'Use ONLY the entity ids above for participants, locations and pov.character_id, and ONLY the proposition ids above in knowledge_guards and knowledge_deltas.'
              } ${await renderCanonFacts(ctx, input.chapterNo)}`
            : lang === 'ko'
              ? '(구조화된 정사는 계약 검증 때 워크플로가 고정한다)'
              : '(structured canon is pinned by the workflow at contract validation)',
          knowledge_state: input.bible
            ? renderKnowledge(input.bible, lang)
            : lang === 'ko'
              ? '(지식 상태는 계약 검증 때 워크플로가 고정한다)'
              : '(knowledge is pinned by the workflow at contract validation)',
          open_promises: input.bible
            ? renderPromiseLines(input.bible, lang)
            : lang === 'ko'
              ? '(약속은 계약 검증 때 워크플로가 고정한다)'
              : '(promises are pinned by the workflow at contract validation)',
          active_constraints: acsHard.hardText,
          length_target_words: String(input.lengthTarget.value),
        },
        block,
      });
      const acs = compileActiveConstraintSet(
        input.spec,
        {
          chapterNo: input.chapterNo,
          arcId: input.arcPlan.id,
          seasonId: input.arcPlan.season_id,
          participantIds: (Array.isArray(call.output.participants)
            ? (call.output.participants as unknown[])
            : []
          )
            .map((p) =>
              typeof p === 'object' && p !== null
                ? (p as { character_id?: unknown }).character_id
                : p,
            )
            .filter((id): id is string => typeof id === 'string' && knownEntityIds.has(id)),
          specVersion: input.spec.version,
        },
        {
          capTokens: ctx.policy.context.active_constraints_cap_tokens,
          workingLanguage: ctx.identity.outputLanguage.language ?? 'en',
        },
      );
      const envelope = (content: Partial<ChapterContract>): ChapterContract => ({
        ...(content as ChapterContract),
        // The prompt tells the model the workflow fills the version; a fresh contract is version 1.
        version: typeof content.version === 'number' ? content.version : 1,
        id: input.contractId,
        project_id: ctx.projectId,
        chapter_number: input.chapterNo,
        arc_id: input.arcPlan.id,
        season_id: input.arcPlan.season_id,
        timeline_id: input.mainTimelineId,
        status: 'draft',
        pinned: {
          spec_version: input.spec.version,
          bible_version: 1,
          narrative_identity_version_id: ctx.pins.narrativeIdentityVersionId,
          canon_version: project.canon_version,
          template_version: 'pack.chapter_planner@1.0.0',
        },
        narrative_identity_version_id: ctx.pins.narrativeIdentityVersionId,
        active_constraints_ref: {
          id: acs.id,
          content_hash: acs.contentHash,
          token_count: acs.tokenCount,
        },
      });
      let candidate = envelope(call.output);
      let issues = validateContract(candidate, input, knownPropositionIds, knownEntityIds);
      // A live model's near-miss shape is coerced only when the raw output does not validate, so a
      // schema-valid (recorded) contract keeps its exact bytes.
      if (issues.some((i) => i.startsWith('schema '))) {
        const normalized = envelope(
          normalizeContractOutput(call.output, {
            chapterNo: input.chapterNo,
            lengthTarget: input.lengthTarget,
            knownEntityIds,
            knownPropositionIds,
            knownPromiseIds: new Set((input.bible?.promises ?? []).map((p) => p.id)),
          }),
        );
        const retry = validateContract(normalized, input, knownPropositionIds, knownEntityIds);
        if (retry.length < issues.length) {
          candidate = normalized;
          issues = retry;
          recordNormalization('contract_output');
        }
      }
      if (issues.length > 0)
        throw new WorkflowError('CONTRACT_INVALID', issues.join('; '), {
          step: 'chapter_contract',
          data: { chapter_no: input.chapterNo, issues },
          recommendedActions: ['regenerate', 'revalidate_contract'],
        });
      const locked: ChapterContract = {
        ...candidate,
        status: 'locked',
        validation: {
          canon_ok: true,
          plan_ok: true,
          narrative_ok: true,
          issues: [],
          validated_at_canon_version: project.canon_version,
        },
      };
      const chapterId = await ensureChapter(ctx, input.chapterNo);
      await ctx.pool.query('UPDATE chapters SET title = coalesce(title, $2) WHERE id = $1', [
        chapterId,
        locked.purpose.slice(0, 80),
      ]);
      const ref = await saveArtifact(ctx, {
        step: 'chapter_contract',
        kind: 'chapter_contract',
        key: `${input.chapterNo}:v${locked.version}`,
        schema: 'chapter-contract.schema.json',
        payload: locked,
      });
      return { contract: locked, artifactId: ref.artifact_id, chapterId };
    },
    String(input.chapterNo),
  );
}

export function validateContract(
  c: ChapterContract,
  input: Pick<ContractInput, 'chapterNo' | 'spec' | 'mainTimelineId' | 'lengthTarget'>,
  knownPropositionIds: ReadonlySet<string>,
  knownEntityIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const v = validatorFor<ChapterContract>('chapter-contract.schema.json')(c);
  if (!v.ok) {
    for (const e of v.errors) issues.push(`schema ${e.path}: ${e.message}`);
    return issues;
  }
  if (c.chapter_number !== input.chapterNo) issues.push('chapter_number mismatch');
  if (c.length_target.unit !== input.lengthTarget.unit)
    issues.push(
      `length_target unit ${c.length_target.unit} does not match the project target unit ${input.lengthTarget.unit}`,
    );
  if (c.timeline_id !== input.mainTimelineId)
    issues.push('contract timeline is not the main timeline');
  if (c.pinned.spec_version !== input.spec.version) issues.push('pinned spec_version mismatch');
  const onPage = c.participants.filter((p) => p.on_page);
  if (onPage.length === 0) issues.push('no on-page participant');
  if (!c.participants.some((p) => p.character_id === c.pov.character_id))
    issues.push('POV character is not a participant');
  for (const p of c.participants)
    if (!knownEntityIds.has(p.character_id)) issues.push(`unknown participant ${p.character_id}`);
  for (const l of c.locations) if (!knownEntityIds.has(l)) issues.push(`unknown location ${l}`);
  for (const g of c.knowledge_guards)
    for (const pid of g.must_not_know_proposition_ids)
      if (!knownPropositionIds.has(pid)) issues.push(`guard cites unknown proposition ${pid}`);
  for (const d of c.knowledge_deltas)
    if (d.proposition_id && !knownPropositionIds.has(d.proposition_id))
      issues.push(`knowledge delta cites unknown proposition ${d.proposition_id}`);
  if (c.scene_count < 1) issues.push('scene_count must be ≥ 1');
  if (c.story_time.start.chapter_no !== input.chapterNo)
    issues.push('story_time.start is not in this chapter');
  // Forbidden developments scoped to a later chapter must not be planned now.
  const forbidden = input.spec.items.filter(
    (i) => i.kind === 'hard' && i.category === 'forbidden_development',
  );
  for (const f of forbidden) {
    const notBefore = /before ch\.?\s*(\d+)/i.exec(f.text);
    if (notBefore?.[1] && input.chapterNo < Number(notBefore[1])) {
      const subject = f.text.split(/before ch/i)[0]?.toLowerCase() ?? '';
      const key = subject.includes('regression')
        ? 'regression'
        : subject.includes('confession')
          ? 'confession'
          : subject.includes('watcher')
            ? "watcher's identity"
            : undefined;
      if (key && c.must_happen.some((m) => m.description.toLowerCase().includes(`reveal ${key}`)))
        issues.push(`must_happen plans a forbidden development (${f.id}) before its chapter`);
    }
  }
  return issues;
}

export function compilePlannerBlock(ctx: WorkflowContext) {
  return compileFor(ctx, 'planner_compact');
}

export function compileFor(
  ctx: WorkflowContext,
  role:
    | 'planner_compact'
    | 'editor_full'
    | 'judge_rubric_prose'
    | 'judge_rubric_structure'
    | 'judge_rubric_genre'
    | 'judge_rubric_voice'
    | 'summarizer_min'
    | 'writer_full',
  budget = 6000,
) {
  const b = compileBlock(ctx.identity, { role, budgetTokens: budget });
  return {
    text: b.text,
    hash: b.hash,
    identityTail: b.identityTail,
    outputLanguage: b.outputLanguage,
    outputLanguageContractHash: b.outputLanguageContractHash,
    traditionContractHash: b.traditionContractHash,
    roleVariant: role,
  };
}

/** Prompt-facing language of the workflow (ADR-0055): the project's manuscript language. */
export function langOf(ctx: Pick<WorkflowContext, 'identity'>): 'en' | 'ko' {
  return ctx.identity.outputLanguage.language === 'ko' ? 'ko' : 'en';
}

export function renderBibleState(
  b: StoryBible,
  bindings?: Readonly<Record<string, string>>,
  lang: 'en' | 'ko' = 'en',
): string {
  const ko = lang === 'ko';
  return [
    renderBibleDesign(b, lang),
    ...b.entities.map(
      (e) =>
        `- [${e.id}] ${e.display_name} (${e.type})${e.description ? `: ${e.description}` : ''}`,
    ),
    ...b.propositions.map((p) => {
      const id = bindings?.[`proposition.${p.local_id}`];
      return `- ${ko ? '명제' : 'proposition'} ${id ? `[${id}] ` : ''}${p.local_id}: ${p.statement} [${p.truth}${p.secret ? (ko ? ', 비밀' : ', secret') : ''}]`;
    }),
  ].join('\n');
}

export function renderBibleDesign(b: StoryBible, lang: 'en' | 'ko' = 'en'): string {
  if (!b.design) return '';
  return lang === 'ko'
    ? `[PLANNED — 완성된 스토리 설계, 아직 일어난 사건이 아님]\n${JSON.stringify(b.design)}\n아래 등록부 id를 쓴다. 정사로 확정된 내용이 계획된 전개보다 우선하고, 비밀은 공개된 지식이 아니다.`
    : `[PLANNED — COMPLETE STORY DESIGN, NOT REALIZED EVENTS]\n${JSON.stringify(b.design)}\nUse registry IDs below. Accepted canon takes precedence over intended developments; secrets are not public knowledge.`;
}

function renderKnowledge(b: StoryBible, lang: 'en' | 'ko' = 'en'): string {
  const ko = lang === 'ko';
  const byId = new Map(b.entities.map((e) => [e.id, e.display_name]));
  const lines = b.propositions
    .filter((p) => p.secret)
    .map((p) => {
      const s = p.secret as { owner_ids?: string[]; allowed_knower_ids?: string[] };
      const knowers = (s.allowed_knower_ids ?? []).map((id) => byId.get(id) ?? id);
      return ko
        ? `- ${p.local_id} (${p.statement})를 아는 인물: ${knowers.join(', ') || '아직 없음'}. 그 외의 인물은 절대 몰라야 한다.`
        : `- ${p.local_id} (${p.statement}) is known only by: ${knowers.join(', ') || 'nobody yet'}. Everyone else must NOT know it.`;
    });
  return (
    lines.join('\n') || (ko ? '(설정에 기록된 비밀 없음)' : '(no secrets recorded in the bible)')
  );
}

/** Accepted facts so far, rendered compactly for the planner; empty before chapter 1. */
async function renderCanonFacts(ctx: WorkflowContext, chapterNo: number): Promise<string> {
  if (chapterNo === 1) return '';
  const r = await ctx.pool.query<{
    display_name: string;
    attribute: string;
    value_text: string | null;
  }>(
    `SELECT e.display_name, f.attribute, f.value_text FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.project_id = $1 AND f.retracted_at_version IS NULL AND f.valid_to IS NULL
      ORDER BY f.id DESC LIMIT 120`,
    [ctx.projectId],
  );
  if (r.rows.length === 0) return '';
  return `\n\n${langOf(ctx) === 'ko' ? '확정된 사실 (이미 일어난 일)' : 'Accepted facts (what has happened)'}:\n${r.rows
    .map((f) => `- ${f.display_name}: ${f.attribute} = ${f.value_text ?? ''}`)
    .join('\n')}`;
}

export function renderPromiseLines(b: StoryBible, lang: 'en' | 'ko' = 'en'): string {
  const ko = lang === 'ko';
  return (
    b.promises
      .map(
        (p) =>
          `- [${p.id}] ${p.statement} (${p.type}, ${p.importance}${
            p.due_min_chapter !== undefined
              ? ko
                ? `, 회수 창 ${p.due_min_chapter}~${p.due_max_chapter ?? '?'}화`
                : `, due ch.${p.due_min_chapter}–${p.due_max_chapter ?? '?'}`
              : ''
          })`,
      )
      .join('\n') || (ko ? '(없음)' : '(none)')
  );
}
