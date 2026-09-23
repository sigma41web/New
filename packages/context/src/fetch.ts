/**
 * Fetch stage (docs/04-memory-canon/04 §2.2): turns a Chapter Contract into the `AssemblyInput` the pure
 * assembler consumes. Structured canon queries are authoritative and run at the pinned canon version on the
 * contract's timeline; their failure blocks the pack (`STRUCTURED_RETRIEVAL_UNAVAILABLE`). Lexical and vector
 * sources only discover T2 candidates and degrade per the ladder. Manuscript text is read exclusively through
 * `acceptedChapter`, so a draft can never stand in for chapter k−1.
 */
import {
  acceptedChapter,
  commitById,
  entitiesById,
  entityStateAt,
  eventsBefore,
  evidenceForFacts,
  getManuscriptVersion,
  getProject,
  knowledgeOfKnowerAt,
  l1SummaryFor,
  promisesForChapter,
  propositionsById,
  propositionsTouching,
  relationshipAt,
  timelinesOf,
  truthOnTimeline,
  worldRulesAt,
  type Client,
  type EntityDigest,
  type EventRow,
  type FactRow,
  type KnowledgeRow,
  type Pool,
  type PromiseRow,
  type PropositionRow,
  type RelationshipRow,
  type TimelineInfo,
} from '@yeonjae/db';
import { narrativeOrd, type Generated, type StoryClock } from '@yeonjae/domain';
import { compileBlock, type ComposedIdentity, type ParticipantDigest } from '@yeonjae/narrative';
import { segmentParagraphs, toNfcText } from '@yeonjae/prose';
import { compileActiveConstraintSet, type ActiveConstraintSet } from './constraints.js';
import { ContextError } from './errors.js';
import { cmp } from './hash.js';
import { buildQueryPlan, type QueryPlan } from './plan.js';
import {
  attributeLabel,
  clockLabel,
  clockLabelKo,
  elapsedLabel,
  elapsedLabelKo,
  registerLabel,
  registerLabelKo,
  renderContract,
  renderContractKo,
  STANCE_KO,
  renderWithParagraphIds,
  topicParticleKo,
  trimQuote,
  valueLabel,
  type RegisterLike,
} from './render.js';
import {
  type LexicalRetriever,
  type RetrievedCandidate,
  type VectorRetriever,
  withTimeout,
} from './retrievers.js';
import { previousTail } from './tail.js';
import { budgetFor, templateFor, type PackTemplate } from './templates.js';
import {
  type AssemblyInput,
  type ChapterContract,
  type Item,
  type ItemKind,
  type PreviousChapterInfo,
  type RetrievalStatus,
  type StorySpec,
  type Tier,
} from './types.js';

type ProductionPolicy = Generated.ProductionPolicySchema.ProductionPolicy;
type Queryable = Pool | Client;

export interface FetchOptions {
  readonly projectId: string;
  readonly role: string;
  readonly contract: ChapterContract;
  readonly spec: StorySpec;
  readonly policy: ProductionPolicy;
  readonly identity: ComposedIdentity | undefined;
  readonly promptSetId?: string | undefined;
  readonly bibleVersion?: number | undefined;
  readonly lexical?: LexicalRetriever | undefined;
  readonly vector?: VectorRetriever | undefined;
  /** Job-scoped chapter text for checker/extractor templates: a version id (status is read) or raw text. */
  readonly chapterText?:
    | { readonly versionId: string }
    | {
        readonly text: string;
        readonly status: 'working' | 'approved';
        readonly label?: string | undefined;
      }
    | undefined;
  readonly jobId?: string | undefined;
  readonly optionalTimeoutMs?: number | undefined;
  readonly identityBlockBudgetTokens?: number | undefined;
  /** Override the input budget (tests); production uses the pinned policy. */
  readonly budgetTokens?: number | undefined;
}

export interface FetchResult {
  readonly input: AssemblyInput;
  readonly plan: QueryPlan;
  readonly constraints: ActiveConstraintSet;
  readonly template: PackTemplate;
}

interface Ctx {
  readonly db: Queryable;
  readonly template: PackTemplate;
  readonly plan: QueryPlan;
  readonly contract: ChapterContract;
  readonly projectId: string;
  readonly canonVersion: number;
  readonly timeline: TimelineInfo;
  readonly timelines: readonly TimelineInfo[];
  readonly names: Map<string, EntityDigest>;
  readonly propositions: Map<string, PropositionRow>;
  /** Manuscript language of the pack (ADR-0055): Korean projects get Korean canon renderings. */
  readonly lang: 'en' | 'ko';
}

const IMPORTANCE: Record<string, number> = { core: 1, major: 0.6, minor: 0.3 };

function sectionFor(
  t: PackTemplate,
  kind: ItemKind,
  preferred: string,
): { name: string; tier: Tier } | undefined {
  const pref = t.sections.find((s) => s.name === preferred && s.kinds.includes(kind));
  const spec = pref ?? t.sections.find((s) => s.kinds.includes(kind));
  return spec ? { name: spec.name, tier: spec.tier } : undefined;
}

function canonSource(ctx: Ctx, ref: string, timelineId?: string): Item['source'] {
  return {
    kind: 'canon',
    ref,
    version: String(ctx.canonVersion),
    project_id: ctx.projectId,
    ...(timelineId ? { timeline_id: timelineId } : {}),
  };
}

function nameOf(ctx: Ctx): (id: string) => string {
  return (id) => ctx.names.get(id)?.display_name ?? id;
}

async function loadNames(ctx: Ctx, ids: Iterable<string>): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => id && !ctx.names.has(id));
  if (missing.length === 0) return;
  for (const e of await entitiesById(ctx.db, ctx.projectId, missing)) ctx.names.set(e.id, e);
}

async function loadPropositions(ctx: Ctx, ids: Iterable<string>): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => id && !ctx.propositions.has(id));
  if (missing.length === 0) return;
  for (const p of await propositionsById(ctx.db, ctx.projectId, missing, ctx.canonVersion))
    ctx.propositions.set(p.id, p);
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (b.length === 0) return 0;
  const set = new Set(b);
  return Math.min(1, a.filter((x) => set.has(x)).length / Math.min(b.length, 4));
}

function recency(chapterNo: number | null | undefined, k: number): number {
  if (chapterNo === null || chapterNo === undefined) return 0.5;
  const d = Math.max(0, k - chapterNo);
  return Math.max(0, 1 - d / Math.max(k, 1));
}

// ---------------------------------------------------------------------------------------------------------

function factLine(
  ctx: Ctx,
  f: FactRow,
  evidence: readonly { chapter_no: number | null; paragraph_id: string | null; quote: string }[],
): { full: string; compact: string } {
  const n = nameOf(ctx);
  const head = `${n(f.entity_id)} · ${attributeLabel(f.attribute, f.key)} = ${valueLabel(f.value, f.value_text)}`;
  const ko = ctx.lang === 'ko';
  const validity = ko
    ? `유효 ${clockLabelKo(f.valid_from)} → ${clockLabelKo(f.valid_to)}`
    : `valid ${clockLabel(f.valid_from)} → ${clockLabel(f.valid_to)}`;
  const meta = ko
    ? `${validity}; 프레임 ${f.frame}; 기록 v${f.asserted_at_version}${f.locked ? '; 잠김' : ''}`
    : `${validity}; frame ${f.frame}; asserted v${f.asserted_at_version}${f.locked ? '; LOCKED' : ''}`;
  const ev = evidence
    .map((e) =>
      `${ko ? `${e.chapter_no ?? '?'}화` : `ch.${e.chapter_no ?? '?'}`} ${e.paragraph_id ?? ''} “${trimQuote(e.quote)}”`.replace(
        /\s+”/,
        '”',
      ),
    )
    .join(' | ');
  return {
    full: `${head} (${meta})${ev ? ` — ${ko ? '근거' : 'evidence'}: ${ev}` : ''}`,
    compact: `${head} (${validity})`,
  };
}

async function fetchStates(ctx: Ctx, out: Item[]): Promise<void> {
  const t = ctx.template;
  const stateSec = sectionFor(t, 'fact', 'states');
  const lockedSec = sectionFor(t, 'locked_fact', 'locked_facts');
  const subjects = [
    ...new Set([...ctx.plan.participantIds, ...ctx.plan.mentionedIds, ...ctx.plan.stateEntityIds]),
  ].sort(cmp);
  const facts: FactRow[] = [];
  for (const entityId of subjects) {
    facts.push(
      ...(await entityStateAt(ctx.db, {
        projectId: ctx.projectId,
        entityId,
        clock: ctx.plan.clockStart,
        timelineId: ctx.timeline.id,
        asOfVersion: ctx.canonVersion,
      })),
    );
  }
  // Continuity anchors and risks may point at facts of entities outside the participant set.
  const anchorIds = [
    ...new Set([...ctx.plan.anchorFactIds, ...ctx.plan.continuityRiskFactIds]),
  ].filter((id) => !facts.some((f) => f.id === id));
  if (anchorIds.length) {
    const r = await ctx.db.query<FactRow>(
      `SELECT * FROM facts WHERE project_id = $1 AND id = ANY($2::uuid[]) AND timeline_id = $3
         AND asserted_at_version <= $4 AND (retracted_at_version IS NULL OR retracted_at_version > $4) ORDER BY id`,
      [ctx.projectId, anchorIds, ctx.timeline.id, ctx.canonVersion],
    );
    facts.push(...r.rows);
  }
  const evidence = await evidenceForFacts(
    ctx.db,
    facts.map((f) => f.id),
  );
  const evByFact = new Map<string, typeof evidence>();
  for (const e of evidence) evByFact.set(e.fact_id, [...(evByFact.get(e.fact_id) ?? []), e]);
  const seen = new Set<string>();
  for (const f of facts.sort(
    (a, b) =>
      cmp(a.entity_id, b.entity_id) ||
      cmp(a.attribute, b.attribute) ||
      cmp(a.key ?? '', b.key ?? '') ||
      cmp(a.id, b.id),
  )) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const line = factLine(ctx, f, evByFact.get(f.id) ?? []);
    const risk =
      ctx.plan.continuityRiskFactIds.includes(f.id) || ctx.plan.anchorFactIds.includes(f.id);
    const sec = f.locked && lockedSec ? lockedSec : stateSec;
    if (!sec) continue;
    out.push({
      kind: f.locked && lockedSec ? 'locked_fact' : 'fact',
      id: `fact:${f.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'canon_fact',
      source: canonSource(ctx, f.id, f.timeline_id),
      text: risk ? `${line.full}${anchorTag(ctx)}` : line.full,
      compressed: {
        method: 'table',
        text: risk ? `${line.compact}${anchorTag(ctx)}` : line.compact,
      },
      materiality: 'material',
      entityIds: [f.entity_id],
      dedupeKey: `fact:${f.entity_id}:${f.attribute}#${f.key ?? ''}`,
      signals: { continuity_risk: risk ? 1 : 0, evidence_strength: evByFact.has(f.id) ? 1 : 0 },
    });
  }
}

function propositionLine(ctx: Ctx, p: PropositionRow, truth: string): string {
  const n = nameOf(ctx);
  const secret = p.secret
    ? ` — SECRET (owners: ${(p.secret.owner_ids ?? []).map(n).join(', ') || '—'}; allowed knowers: ${(p.secret.allowed_knower_ids ?? []).map(n).join(', ') || 'none'}${
        p.secret.reveal_not_before_chapter
          ? `; reveal not before ch.${p.secret.reveal_not_before_chapter}`
          : ''
      })`
    : '';
  if (ctx.lang === 'ko') {
    const secretKo = p.secret
      ? ` — 비밀 (소유자: ${(p.secret.owner_ids ?? []).map(n).join(', ') || '—'}; 알아도 되는 인물: ${(p.secret.allowed_knower_ids ?? []).map(n).join(', ') || '없음'}${
          p.secret.reveal_not_before_chapter
            ? `; ${p.secret.reveal_not_before_chapter}화 이전 공개 금지`
            : ''
        })`
      : '';
    return `명제 ${p.id}: “${p.statement}” (${p.kind}) — ${clockLabelKo(ctx.plan.clockStart)} 기준 이 타임라인에서 객관적으로 ${truthKo(truth)}${secretKo}`;
  }
  return `Proposition ${p.id}: “${p.statement}” (${p.kind}) — objectively ${truth.toUpperCase()} on this timeline as of ${clockLabel(ctx.plan.clockStart)}${secret}`;
}

async function fetchKnowledge(ctx: Ctx, out: Item[]): Promise<void> {
  const t = ctx.template;
  const kSec = sectionFor(t, 'knowledge_state', 'knowledge');
  const pSec =
    sectionFor(t, 'proposition', 'knowledge') ?? sectionFor(t, 'proposition', 'registry');
  const knowers = [...new Set([ctx.plan.povCharacterId, ...ctx.plan.onPageIds])].sort(cmp);
  const touching = await propositionsTouching(
    ctx.db,
    ctx.projectId,
    [...ctx.plan.participantIds, ...ctx.plan.mentionedIds],
    ctx.canonVersion,
  );
  for (const p of touching) ctx.propositions.set(p.id, p);
  await loadPropositions(ctx, ctx.plan.contractPropositionIds);
  const rows: { knower: string; row: KnowledgeRow }[] = [];
  for (const knower of knowers) {
    const ks = await knowledgeOfKnowerAt(ctx.db, {
      projectId: ctx.projectId,
      knowerKind: 'character',
      knowerEntityId: knower,
      clock: ctx.plan.clockStart,
      timelineId: ctx.timeline.id,
      asOfVersion: ctx.canonVersion,
    });
    for (const row of ks) rows.push({ knower, row });
  }
  await loadPropositions(
    ctx,
    rows.map((r) => r.row.proposition_id),
  );
  const relevant = new Set([
    ...ctx.plan.contractPropositionIds,
    ...[...ctx.propositions.values()].filter((p) => p.secret).map((p) => p.id),
    ...rows.map((r) => r.row.proposition_id),
  ]);
  const memoryTimelines = ctx.timelines.filter(
    (tl) => tl.kind === 'prior_loop' || tl.kind === 'source_story',
  );
  const n = nameOf(ctx);
  if (kSec) {
    for (const { knower, row } of rows.sort(
      (a, b) =>
        cmp(a.knower, b.knower) ||
        cmp(a.row.proposition_id, b.row.proposition_id) ||
        cmp(a.row.id, b.row.id),
    )) {
      const p = ctx.propositions.get(row.proposition_id);
      const statement = p ? `“${p.statement}”` : row.proposition_id;
      const src = row.source;
      const kind = typeof src.kind === 'string' ? src.kind : 'unknown';
      const informer =
        typeof src.informer_id === 'string'
          ? ctx.lang === 'ko'
            ? `, 알려 준 인물 ${n(src.informer_id)}`
            : ` by ${n(src.informer_id)}`
          : '';
      let memory = '';
      if (kind === 'prior_loop_memory' || kind === 'source_story') {
        const wanted = kind === 'prior_loop_memory' ? 'prior_loop' : 'source_story';
        for (const tl of memoryTimelines.filter((x) => x.kind === wanted)) {
          const v = await truthOnTimeline(
            ctx.db,
            row.proposition_id,
            tl.id,
            ctx.plan.clockStart,
            ctx.canonVersion,
          );
          memory +=
            ctx.lang === 'ko'
              ? ` — ${tl.name}(${tl.kind})에서 기억하는 내용, 그곳에서는 ${truthKo(v)}; 이 타임라인의 사실이 아님`
              : ` — remembered from ${tl.name} (${tl.kind}) where it is ${v.toUpperCase()}; NOT a fact of this timeline`;
        }
      }
      const extra = [
        row.believed_value
          ? ctx.lang === 'ko'
            ? `잘못 믿는 내용: ${row.believed_value}`
            : `believes: ${row.believed_value}`
          : undefined,
        typeof (row as { certainty?: unknown }).certainty === 'number' ||
        typeof (row as { certainty?: unknown }).certainty === 'string'
          ? `${ctx.lang === 'ko' ? '확신도' : 'certainty'} ${(row as { certainty?: string }).certainty ?? ''}`
          : undefined,
      ].filter(Boolean);
      const text =
        ctx.lang === 'ko'
          ? `${n(knower)} — ${STANCE_KO[row.stance] ?? row.stance}${extra.length ? ` (${extra.join('; ')})` : ''}: ${statement} [경로: ${kind}${informer}; ${clockLabelKo(row.valid_from)}부터]${memory}`
          : `${n(knower)} — ${row.stance.toUpperCase()}${extra.length ? ` (${extra.join('; ')})` : ''}: ${statement} [channel: ${kind}${informer}; since ${clockLabel(row.valid_from)}]${memory}`;
      const contractRef = relevant.has(row.proposition_id) ? 1 : 0;
      out.push({
        kind: 'knowledge_state',
        id: `knowledge_state:${row.id}`,
        section: kSec.name,
        tier: kSec.tier,
        provenance: 'character_knowledge',
        source: canonSource(ctx, row.id, ctx.timeline.id),
        text,
        materiality: 'material',
        entityIds: [knower],
        dedupeKey: `knowledge:${knower}:${row.proposition_id}`,
        signals: { contract_reference: contractRef },
      });
    }
  }
  if (pSec) {
    const props = [...ctx.propositions.values()]
      .filter((p) => relevant.has(p.id) || ctx.plan.contractPropositionIds.includes(p.id))
      .sort((a, b) => cmp(a.id, b.id));
    for (const p of props) {
      const truth = await truthOnTimeline(
        ctx.db,
        p.id,
        ctx.timeline.id,
        ctx.plan.clockStart,
        ctx.canonVersion,
      );
      out.push({
        kind: 'proposition',
        id: `proposition:${p.id}`,
        section: pSec.name,
        tier: pSec.tier,
        provenance: 'canon_fact',
        source: canonSource(ctx, p.id, ctx.timeline.id),
        text: propositionLine(ctx, p, truth),
        materiality: 'material',
        entityIds: p.entity_ids,
        dedupeKey: `proposition:${p.id}`,
        signals: { contract_reference: 1 },
      });
    }
  }
}

async function fetchRelationships(
  ctx: Ctx,
  out: Item[],
  registerLines: Map<string, string[]>,
): Promise<void> {
  const sec = sectionFor(ctx.template, 'relationship_state', 'relationships');
  const n = nameOf(ctx);
  for (const pair of ctx.plan.speakerPairs) {
    const r: RelationshipRow | undefined = await relationshipAt(ctx.db, {
      projectId: ctx.projectId,
      fromId: pair.from,
      toId: pair.to,
      clock: ctx.plan.clockStart,
      timelineId: ctx.timeline.id,
      asOfVersion: ctx.canonVersion,
    });
    if (!r) continue;
    const axes = r.axes
      ? Object.entries(r.axes)
          .sort(([a], [b]) => cmp(a, b))
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
      : '—';
    const ko = ctx.lang === 'ko';
    const reg = ko ? registerLabelKo(r.register) : registerLabel(r.register);
    const text = ko
      ? `${n(r.from_entity_id)} → ${n(r.to_entity_id)}: ${r.type}${r.power_dynamic ? ` (${r.power_dynamic})` : ''}; 축: ${axes}; 말높이: ${reg}; ${clockLabelKo(r.valid_from)}부터${r.note ? ` — ${r.note}` : ''}`
      : `${n(r.from_entity_id)} → ${n(r.to_entity_id)}: ${r.type}${r.power_dynamic ? ` (${r.power_dynamic})` : ''}; axes: ${axes}; register: ${reg}; since ${clockLabel(r.valid_from)}${r.note ? ` — ${r.note}` : ''}`;
    registerLines.set(r.from_entity_id, [
      ...(registerLines.get(r.from_entity_id) ?? []),
      ko ? `${n(r.to_entity_id)}에게: ${reg}` : `toward ${n(r.to_entity_id)}: ${reg}`,
    ]);
    if (!sec) continue;
    out.push({
      kind: 'relationship_state',
      id: `relationship_state:${r.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'relationship_state',
      source: canonSource(ctx, r.id, ctx.timeline.id),
      text,
      materiality: 'material',
      entityIds: [r.from_entity_id, r.to_entity_id],
      dedupeKey: `relationship:${r.from_entity_id}:${r.to_entity_id}`,
    });
  }
}

async function fetchPromises(ctx: Ctx, out: Item[]): Promise<void> {
  const sec =
    sectionFor(ctx.template, 'promise', 'promises') ??
    sectionFor(ctx.template, 'promise', 'registry');
  if (!sec) return;
  const k = ctx.plan.chapterNo;
  const rows: PromiseRow[] = await promisesForChapter(ctx.db, {
    projectId: ctx.projectId,
    chapterNo: k,
    entityIds: ctx.plan.participantIds,
    explicitIds: ctx.plan.promises.map((p) => p.promiseId),
    window: 3,
  });
  const touches = new Map(ctx.plan.promises.map((p) => [p.promiseId, p.kind]));
  for (const p of rows) {
    const ko = ctx.lang === 'ko';
    const due =
      p.due_min_chapter !== null || p.due_max_chapter !== null
        ? ko
          ? `; 회수 창 ${p.due_min_chapter ?? '?'}~${p.due_max_chapter ?? '∞'}화`
          : `; due ch.${p.due_min_chapter ?? '?'}–${p.due_max_chapter ?? '∞'}`
        : '';
    const last = p.last_event_kind
      ? ko
        ? `; 최근 ${p.last_event_kind}${p.last_event_chapter ? ` (${p.last_event_chapter}화)` : ''}`
        : `; last ${p.last_event_kind}${p.last_event_chapter ? ` in ch.${p.last_event_chapter}` : ''}`
      : '';
    const touch = touches.get(p.id);
    const text = ko
      ? `“${p.statement}” — ${p.type}, ${p.importance}, 상태 ${p.status}${due}${last}${p.resolution_hint ? `; 힌트: ${p.resolution_hint}` : ''}${touch ? ` — 이번 회차 PLANNED: ${touch}` : ''}`
      : `“${p.statement}” — ${p.type}, ${p.importance}, status ${p.status}${due}${last}${p.resolution_hint ? `; hint: ${p.resolution_hint}` : ''}${touch ? ` — PLANNED in this chapter: ${touch}` : ''}`;
    const urgency =
      p.due_max_chapter !== null ? Math.max(0, Math.min(1, 1 - (p.due_max_chapter - k) / 10)) : 0.3;
    out.push({
      kind: 'promise',
      id: `promise:${p.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'promise',
      source: canonSource(ctx, p.id),
      text,
      materiality: touch ? 'material' : 'contextual',
      entityIds: p.related_entity_ids,
      dedupeKey: `promise:${p.id}`,
      signals: {
        promise_urgency: urgency,
        importance: IMPORTANCE[p.importance] ?? 0.3,
        contract_reference: touch ? 1 : 0,
      },
    });
  }
}

function eventLine(ctx: Ctx, e: EventRow): string {
  const n = nameOf(ctx);
  const chapter = e.source_chapter_no ?? e.clock_start.chapter_no;
  if (ctx.lang === 'ko') {
    const whereKo = e.location_id ? `; 장소 ${n(e.location_id)}` : '';
    const whoKo = e.participant_ids.length ? `; 등장 ${e.participant_ids.map(n).join(', ')}` : '';
    return `${chapter}화 ${clockLabelKo(e.clock_start)} [${e.frame}] ${e.type}: ${e.summary}${whereKo}${whoKo}`;
  }
  const where = e.location_id ? ` at ${n(e.location_id)}` : '';
  const who = e.participant_ids.length ? ` (${e.participant_ids.map(n).join(', ')})` : '';
  return `ch.${chapter} ${clockLabel(e.clock_start)} [${e.frame}] ${e.type}: ${e.summary}${where}${who}`;
}

function eventSignals(ctx: Ctx, e: EventRow): Record<string, number> {
  return {
    character_overlap: overlap(e.participant_ids, ctx.plan.participantIds),
    entity_overlap: overlap(
      [...e.participant_ids, ...(e.location_id ? [e.location_id] : [])],
      ctx.plan.allEntityIds,
    ),
    location_overlap: e.location_id && ctx.plan.locationIds.includes(e.location_id) ? 1 : 0,
    timeline_relevance: e.timeline_id === ctx.timeline.id ? 1 : 0,
    recency: recency(e.source_chapter_no ?? e.clock_start.chapter_no, ctx.plan.chapterNo),
    importance: IMPORTANCE[e.importance ?? ''] ?? 0.3,
  };
}

async function fetchEvents(ctx: Ctx, out: Item[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const sec =
    sectionFor(ctx.template, 'event', 'recent_events') ??
    sectionFor(ctx.template, 'event', 'retrieved');
  if (!sec) return seen;
  const firstRecent = ctx.plan.recentChapterNos[0] ?? ctx.plan.chapterNo;
  const events = await eventsBefore(ctx.db, {
    projectId: ctx.projectId,
    timelineId: ctx.timeline.id,
    beforeClock: ctx.plan.clockStart,
    sinceClock: { chapter_no: firstRecent, ordinal: 0, precision: 'exact' },
    entityIds: [...ctx.plan.participantIds, ...ctx.plan.locationIds],
    asOfVersion: ctx.canonVersion,
    limit: 12,
  });
  await loadNames(
    ctx,
    events.flatMap((e) => [...e.participant_ids, ...(e.location_id ? [e.location_id] : [])]),
  );
  for (const e of events) {
    seen.add(e.id);
    out.push({
      kind: 'event',
      id: `event:${e.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'canon_event',
      source: canonSource(ctx, e.id, e.timeline_id),
      text: eventLine(ctx, e),
      materiality: sec.tier === 'T1' ? 'material' : 'contextual',
      entityIds: e.participant_ids,
      dedupeKey: `event:${e.id}`,
      signals: eventSignals(ctx, e),
    });
  }
  return seen;
}

async function fetchWorldRules(ctx: Ctx, out: Item[]): Promise<void> {
  const sec = sectionFor(ctx.template, 'world_rule', 'world_rules');
  if (!sec) return;
  const { facts, propositions } = await worldRulesAt(ctx.db, {
    projectId: ctx.projectId,
    clock: ctx.plan.clockStart,
    timelineId: ctx.timeline.id,
    asOfVersion: ctx.canonVersion,
    entityIds: ctx.plan.allEntityIds,
  });
  for (const f of facts) {
    out.push({
      kind: 'world_rule',
      id: `world_rule:fact:${f.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'canon_fact',
      source: canonSource(ctx, f.id, f.timeline_id),
      text:
        ctx.lang === 'ko'
          ? `${f.entity_name} (${f.entity_type}) · ${attributeLabel(f.attribute, f.key)} = ${valueLabel(f.value, f.value_text)} (유효 ${clockLabelKo(f.valid_from)} → ${clockLabelKo(f.valid_to)})`
          : `${f.entity_name} (${f.entity_type}) · ${attributeLabel(f.attribute, f.key)} = ${valueLabel(f.value, f.value_text)} (valid ${clockLabel(f.valid_from)} → ${clockLabel(f.valid_to)})`,
      materiality: 'contextual',
      entityIds: [f.entity_id],
      dedupeKey: `fact:${f.entity_id}:${f.attribute}#${f.key ?? ''}`,
      signals: {
        entity_overlap: ctx.plan.allEntityIds.includes(f.entity_id) ? 1 : 0.2,
        importance: 0.6,
      },
    });
  }
  for (const p of propositions) {
    const truth = await truthOnTimeline(
      ctx.db,
      p.id,
      ctx.timeline.id,
      ctx.plan.clockStart,
      ctx.canonVersion,
    );
    out.push({
      kind: 'world_rule',
      id: `world_rule:proposition:${p.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'canon_fact',
      source: canonSource(ctx, p.id, ctx.timeline.id),
      text:
        ctx.lang === 'ko'
          ? `세계 규칙: “${p.statement}” — 이 타임라인에서 ${truthKo(truth)}`
          : `World rule: “${p.statement}” — ${truth.toUpperCase()} on this timeline`,
      materiality: 'contextual',
      entityIds: p.entity_ids,
      dedupeKey: `proposition:${p.id}`,
      signals: { entity_overlap: overlap(p.entity_ids, ctx.plan.allEntityIds), importance: 0.6 },
    });
  }
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;

/** A continuity-risk marker in the pack's language. */
function anchorTag(ctx: Ctx): string {
  return ctx.lang === 'ko' ? ' — 연속성 기준점' : ' — CONTINUITY ANCHOR';
}

function committedDeltaLine(ctx: Ctx, item: Record<string, unknown>): string | undefined {
  if (ctx.lang === 'ko') return committedDeltaLineKo(ctx, item);
  const n = nameOf(ctx);
  const type = str(item.type);
  const op = str(item.op);
  const frame = str(item.frame, 'canonical');
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const clock = item.story_clock as StoryClock | undefined;
  const at = clock ? ` @ ${clockLabel(clock)}` : '';
  const frameTag = frame !== 'canonical' ? ` [${frame}]` : '';
  const statement = (id: unknown) =>
    typeof id === 'string' ? (ctx.propositions.get(id)?.statement ?? id) : str(id);
  let body: string;
  switch (type) {
    case 'fact':
      body = `${n(str(payload.entity_id))} · ${attributeLabel(str(payload.attribute), typeof payload.key === 'string' ? payload.key : undefined)} = ${valueLabel(payload.value, typeof payload.value_text === 'string' ? payload.value_text : undefined)}`;
      break;
    case 'event':
      body = `${str(payload.type, 'event')}: ${str(payload.summary)}`;
      break;
    case 'knowledge_state': {
      const knower = payload.knower as { kind?: string; entity_id?: string } | undefined;
      const who =
        knower?.kind === 'character' && knower.entity_id
          ? n(knower.entity_id)
          : (knower?.kind ?? 'knower');
      body = `${who}: ${str(payload.stance)} “${statement(payload.proposition_id)}”`;
      break;
    }
    case 'relationship_state':
      body = `${n(str(payload.from_entity_id))} → ${n(str(payload.to_entity_id))}: ${str(payload.type)}; register: ${registerLabel(payload.register as RegisterLike | undefined)}`;
      break;
    case 'promise_event':
      body = `promise ${str(payload.promise_id)} ${str(payload.kind, op)}${typeof payload.note === 'string' ? ` — ${payload.note}` : ''}`;
      break;
    case 'proposition':
      body = `proposition “${str(payload.statement)}” (${str(payload.kind)})`;
      break;
    case 'proposition_truth':
      body = `“${statement(payload.proposition_id)}” is ${str(payload.value)} on timeline ${str(payload.timeline_id, 'main')}`;
      break;
    case 'entity':
      body = `entity ${str(payload.display_name)} (${str(payload.type)})`;
      break;
    case 'alias':
      body = `alias “${str(payload.alias)}” for ${n(str(payload.entity_id))}`;
      break;
    default:
      return undefined;
  }
  return `${type}/${op}${frameTag}${at}: ${body}`;
}

/**
 * The Korean rendering of a committed delta item (KO-PROMPT-SURFACE-001): labels are Korean; the item
 * type/op, frame and stance values stay schema identifiers.
 */
function committedDeltaLineKo(ctx: Ctx, item: Record<string, unknown>): string | undefined {
  const n = nameOf(ctx);
  const type = str(item.type);
  const op = str(item.op);
  const frame = str(item.frame, 'canonical');
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const clock = item.story_clock as StoryClock | undefined;
  const at = clock ? ` @ ${clockLabelKo(clock)}` : '';
  const frameTag = frame !== 'canonical' ? ` [${frame}]` : '';
  const statement = (id: unknown) =>
    typeof id === 'string' ? (ctx.propositions.get(id)?.statement ?? id) : str(id);
  let body: string;
  switch (type) {
    case 'fact':
      body = `${n(str(payload.entity_id))} · ${attributeLabel(str(payload.attribute), typeof payload.key === 'string' ? payload.key : undefined)} = ${valueLabel(payload.value, typeof payload.value_text === 'string' ? payload.value_text : undefined)}`;
      break;
    case 'event':
      body = `${str(payload.type, 'event')}: ${str(payload.summary)}`;
      break;
    case 'knowledge_state': {
      const knower = payload.knower as { kind?: string; entity_id?: string } | undefined;
      const who =
        knower?.kind === 'character' && knower.entity_id
          ? n(knower.entity_id)
          : (knower?.kind ?? '인물');
      body = `${who}: ${STANCE_KO[str(payload.stance)] ?? str(payload.stance)} “${statement(payload.proposition_id)}”`;
      break;
    }
    case 'relationship_state':
      body = `${n(str(payload.from_entity_id))} → ${n(str(payload.to_entity_id))}: ${str(payload.type)}; 말높이: ${registerLabelKo(payload.register as RegisterLike | undefined)}`;
      break;
    case 'promise_event':
      body = `약속 ${str(payload.promise_id)} ${str(payload.kind, op)}${typeof payload.note === 'string' ? ` — ${payload.note}` : ''}`;
      break;
    case 'proposition':
      body = `명제 “${str(payload.statement)}” (${str(payload.kind)})`;
      break;
    case 'proposition_truth':
      body = `“${statement(payload.proposition_id)}” — 타임라인 ${str(payload.timeline_id, 'main')}에서 ${truthKo(str(payload.value))}`;
      break;
    case 'entity':
      body = `새 엔티티 ${str(payload.display_name)} (${str(payload.type)})`;
      break;
    case 'alias':
      body = `별칭 “${str(payload.alias)}” → ${n(str(payload.entity_id))}`;
      break;
    default:
      return undefined;
  }
  return `${type}/${op}${frameTag}${at}: ${body}`;
}

async function fetchPreviousChapter(
  ctx: Ctx,
  out: Item[],
  policy: ProductionPolicy['context'],
): Promise<PreviousChapterInfo | undefined> {
  const prevNo = ctx.plan.previousChapterNo;
  if (prevNo === undefined) return undefined;
  const lookup = await acceptedChapter(ctx.db, ctx.projectId, prevNo);
  if (lookup.state !== 'accepted') {
    if (ctx.template.validation.requirePreviousChapter) {
      throw new ContextError(
        'PREVIOUS_CHAPTER_NOT_ACCEPTED',
        lookup.state === 'missing'
          ? `chapter ${prevNo} does not exist yet; chapter ${ctx.plan.chapterNo} cannot start until chapter ${prevNo} is accepted (a draft is never substituted)`
          : `chapter ${prevNo} is ${lookup.chapterStatus}${lookup.latestVersionStatus ? ` (latest version ${lookup.latestVersionStatus})` : ''}; chapter ${ctx.plan.chapterNo} waits for its acceptance — a draft is never substituted`,
        { chapterNo: prevNo, ...lookup },
      );
    }
    return undefined;
  }
  const ch = lookup.chapter;
  const text = ch.version.text;
  const tail = previousTail(
    text,
    policy.previous_tail_words,
    policy.previous_tail_extend_to_scene_below_words ?? 0,
  );
  const floor = previousTail(text, policy.previous_tail_floor_words, 0);
  const summary = await l1SummaryFor(ctx.db, ch.version.id);
  const commit = await commitById(ctx.db, ch.acceptedCommitId);
  const deltaItems = (commit?.delta?.items ?? []) as Record<string, unknown>[];
  const source: Item['source'] = {
    kind: 'accepted_manuscript',
    ref: ch.version.id,
    version: `v${ch.version.version_no}@canon${ch.acceptedCanonVersion}`,
    manuscript_version_id: ch.version.id,
    manuscript_status: 'accepted',
    chapter_no: prevNo,
    project_id: ctx.projectId,
  };
  const sumSec = sectionFor(ctx.template, 'summary', 'previous_chapter');
  const tailSec = sectionFor(ctx.template, 'prev_chapter_tail', 'previous_chapter');
  const hookSec = sectionFor(ctx.template, 'prev_chapter_hook', 'previous_chapter');
  const deltaSec = sectionFor(ctx.template, 'committed_delta', 'previous_chapter');
  if (summary && sumSec) {
    out.push({
      kind: 'summary',
      id: `summary:${summary.id}`,
      section: sumSec.name,
      tier: sumSec.tier,
      provenance: 'summary',
      source: {
        kind: 'summary',
        ref: summary.id,
        version: `L1@canon${summary.canon_version}`,
        manuscript_version_id: ch.version.id,
        manuscript_status: 'accepted',
        chapter_no: prevNo,
        project_id: ctx.projectId,
      },
      text:
        ctx.lang === 'ko'
          ? `${prevNo}화 사실 요약 (L1, 승인 버전 v${ch.version.version_no}): ${summary.text}`
          : `Chapter ${prevNo} factual summary (L1, from the accepted version v${ch.version.version_no}): ${summary.text}`,
      materiality: 'material',
      dedupeKey: `summary:${ch.version.id}`,
    });
  }
  if (tailSec) {
    out.push({
      kind: 'prev_chapter_tail',
      id: `prev_chapter_tail:${ch.version.id}`,
      section: tailSec.name,
      tier: tailSec.tier,
      provenance: 'accepted_manuscript_excerpt',
      source,
      text:
        ctx.lang === 'ko'
          ? `${prevNo}화 마지막 부분 원문 그대로 (마지막 ${tail.words}어절, 승인 v${ch.version.version_no}의 코드포인트 ${tail.startCp}–${tail.endCp}):\n${tail.text}`
          : `Chapter ${prevNo} ending, verbatim (last ${tail.words} words, code points ${tail.startCp}–${tail.endCp} of accepted v${ch.version.version_no}):\n${tail.text}`,
      compressed: {
        method: 'degraded',
        text:
          ctx.lang === 'ko'
            ? `${prevNo}화 마지막 부분 원문 그대로 (마지막 ${floor.words}어절, 승인 v${ch.version.version_no}의 코드포인트 ${floor.startCp}–${floor.endCp}):\n${floor.text}`
            : `Chapter ${prevNo} ending, verbatim (last ${floor.words} words, code points ${floor.startCp}–${floor.endCp} of accepted v${ch.version.version_no}):\n${floor.text}`,
      },
      materiality: 'material',
      dedupeKey: `tail:${ch.version.id}`,
    });
  }
  const hook = summary?.ending_hook ?? undefined;
  if (hook && hookSec) {
    out.push({
      kind: 'prev_chapter_hook',
      id: `prev_chapter_hook:${ch.version.id}`,
      section: hookSec.name,
      tier: hookSec.tier,
      provenance: 'accepted_manuscript_excerpt',
      source,
      text:
        ctx.lang === 'ko'
          ? `${prevNo}화 절단(엔딩 훅): “${hook}”`
          : `Chapter ${prevNo} ending hook: “${hook}”`,
      materiality: 'material',
      dedupeKey: `hook:${ch.version.id}`,
    });
  }
  if (deltaSec && commit) {
    await loadPropositions(
      ctx,
      deltaItems.flatMap((it) => {
        const p = (it.payload ?? {}) as Record<string, unknown>;
        return typeof p.proposition_id === 'string' ? [p.proposition_id] : [];
      }),
    );
    await loadNames(
      ctx,
      deltaItems.flatMap((it) => {
        const p = (it.payload ?? {}) as Record<string, unknown>;
        const knower = p.knower as { entity_id?: string } | undefined;
        return [p.entity_id, p.from_entity_id, p.to_entity_id, knower?.entity_id].filter(
          (x): x is string => typeof x === 'string',
        );
      }),
    );
    deltaItems.forEach((it, i) => {
      const line = committedDeltaLine(ctx, it);
      if (!line) return;
      const localId = typeof it.local_id === 'string' ? it.local_id : String(i);
      out.push({
        kind: 'committed_delta',
        id: `committed_delta:${commit.id}#${localId}`,
        section: deltaSec.name,
        tier: deltaSec.tier,
        provenance: 'canon_event',
        source: {
          kind: 'canon',
          ref: `${commit.id}#${localId}`,
          version: String(commit.version),
          manuscript_version_id: ch.version.id,
          manuscript_status: 'accepted',
          chapter_no: prevNo,
          project_id: ctx.projectId,
        },
        text:
          ctx.lang === 'ko'
            ? `${prevNo}화에서 확정 (정사 v${commit.version}): ${line}`
            : `Committed from chapter ${prevNo} (canon v${commit.version}): ${line}`,
        materiality: 'material',
        dedupeKey: `committed:${commit.id}:${localId}`,
      });
    });
  }
  let endClock: StoryClock | undefined;
  for (const it of deltaItems) {
    const c = it.story_clock as StoryClock | undefined;
    if (c && (!endClock || narrativeOrd(c) > narrativeOrd(endClock))) endClock = c;
  }
  return {
    chapterNo: prevNo,
    manuscriptVersionId: ch.version.id,
    versionNo: ch.version.version_no,
    contentHash: ch.version.content_hash,
    acceptedCanonVersion: ch.acceptedCanonVersion,
    tail,
    tailFloor: floor,
    summaryL1: summary?.text,
    endingHook: hook,
    committedItemCount: deltaItems.length,
    endClock,
  };
}

async function fetchRegistry(ctx: Ctx, out: Item[]): Promise<void> {
  const sec =
    sectionFor(ctx.template, 'registry_slice', 'registry') ??
    sectionFor(ctx.template, 'registry_slice', 'states');
  if (!sec) return;
  const ids = [...ctx.plan.allEntityIds].sort(cmp);
  await loadNames(ctx, ids);
  for (const id of ids) {
    const e = ctx.names.get(id);
    if (!e) continue;
    const ko = ctx.lang === 'ko';
    const parts = [`${e.display_name} (${e.type}; id ${e.id})`];
    if (e.short_forms.length) parts.push(`${ko ? '약칭' : 'short'}: ${e.short_forms.join(', ')}`);
    if (e.aliases.length) parts.push(`${ko ? '별칭' : 'aliases'}: ${e.aliases.join(', ')}`);
    const desc = typeof e.fields.description === 'string' ? e.fields.description : undefined;
    const design = e.fields.planned_design;
    const guidance =
      design && typeof design === 'object' && !Array.isArray(design)
        ? Object.fromEntries(
            Object.entries(design).filter(([key]) =>
              ['goals', 'flaws', 'voice_notes', 'costs', 'limits', 'mechanics'].includes(key),
            ),
          )
        : {};
    const planned = Object.keys(guidance).length
      ? ko
        ? `\n[PLANNED 설계 — 실현된 사건이 아님; 지식 가드는 여전히 적용] ${JSON.stringify(guidance)}`
        : `\n[PLANNED DESIGN — not realized events; knowledge guards still apply] ${JSON.stringify(guidance)}`
      : '';
    out.push({
      kind: 'registry_slice',
      id: `registry_slice:${e.id}`,
      section: sec.name,
      tier: sec.tier,
      provenance: 'registry',
      source: {
        kind: 'canon',
        ref: e.id,
        version: String(ctx.canonVersion),
        project_id: ctx.projectId,
      },
      text: `${parts.join('; ')}${desc ? ` — ${desc}` : ''}${planned}`,
      materiality: 'contextual',
      entityIds: [e.id],
      dedupeKey: `entity:${e.id}`,
    });
  }
}

function candidateToItem(
  ctx: Ctx,
  c: RetrievedCandidate,
  sourceKind: 'lexical_index' | 'vector_index',
  seenEvents: Set<string>,
): Item | undefined {
  const t = ctx.template;
  const k = ctx.plan.chapterNo;
  if (c.chapterNo !== null && c.chapterNo >= k) return undefined;
  const base = {
    signals: {
      lexical_relevance: c.relevance,
      character_overlap: overlap(c.entityIds, ctx.plan.participantIds),
      entity_overlap: overlap(c.entityIds, ctx.plan.allEntityIds),
      recency: recency(c.chapterNo, k),
      importance: IMPORTANCE[c.importance ?? ''] ?? 0.3,
      timeline_relevance: c.timelineId === null || c.timelineId === ctx.timeline.id ? 1 : 0,
    },
    materiality: 'contextual' as const,
    entityIds: c.entityIds,
  };
  const ko = ctx.lang === 'ko';
  const chapterTag =
    c.chapterNo !== null ? (ko ? `${c.chapterNo}화` : `ch.${c.chapterNo}`) : ko ? '정사' : 'canon';
  switch (c.kind) {
    case 'chapter_paragraph': {
      const sec = sectionFor(t, 'chapter_text', 'retrieved');
      if (!sec || !c.manuscriptVersionId) return undefined;
      return {
        ...base,
        kind: 'chapter_text',
        id: `chapter_text:${c.manuscriptVersionId}#${c.refKey}`,
        section: sec.name,
        tier: sec.tier,
        provenance: 'accepted_manuscript_excerpt',
        source: {
          kind: sourceKind,
          ref: `${c.manuscriptVersionId}#${c.refKey}`,
          version: String(c.canonVersionAdded),
          manuscript_version_id: c.manuscriptVersionId,
          manuscript_status: 'accepted',
          chapter_no: c.chapterNo ?? 0,
          project_id: ctx.projectId,
        },
        text: `${chapterTag} ${c.refKey} (${ko ? '승인된 원문' : 'accepted text'}): “${c.text}”`,
        dedupeKey: `para:${c.manuscriptVersionId}#${c.refKey}`,
      };
    }
    case 'summary_l1': {
      const sec = sectionFor(t, 'summary', 'retrieved');
      if (!sec) return undefined;
      return {
        ...base,
        kind: 'summary',
        id: `summary:${c.refId}`,
        section: sec.name,
        tier: sec.tier,
        provenance: 'summary',
        source: {
          kind: sourceKind,
          ref: c.refId,
          version: String(c.canonVersionAdded),
          ...(c.manuscriptVersionId
            ? {
                manuscript_version_id: c.manuscriptVersionId,
                manuscript_status: 'accepted' as const,
              }
            : {}),
          chapter_no: c.chapterNo ?? 0,
          project_id: ctx.projectId,
        },
        text: `${chapterTag} ${ko ? '요약' : 'summary'} (L1): ${c.text}`,
        dedupeKey: `summary:${c.manuscriptVersionId ?? c.refId}`,
      };
    }
    case 'event': {
      if (seenEvents.has(c.refId)) return undefined;
      const sec = sectionFor(t, 'event', 'retrieved');
      if (!sec) return undefined;
      return {
        ...base,
        kind: 'event',
        id: `event:${c.refId}`,
        section: sec.name,
        tier: sec.tier,
        provenance: 'canon_event',
        source: {
          kind: sourceKind,
          ref: c.refId,
          version: String(c.canonVersionAdded),
          ...(c.timelineId ? { timeline_id: c.timelineId } : {}),
          chapter_no: c.chapterNo ?? 0,
          project_id: ctx.projectId,
        },
        text: `${chapterTag} ${ko ? '사건' : 'event'}: ${c.text}`,
        dedupeKey: `event:${c.refId}`,
      };
    }
    case 'proposition': {
      const sec = sectionFor(t, 'proposition', 'retrieved');
      if (!sec) return undefined;
      return {
        ...base,
        kind: 'proposition',
        id: `proposition:${c.refId}`,
        section: sec.name,
        tier: sec.tier,
        provenance: 'canon_fact',
        source: {
          kind: sourceKind,
          ref: c.refId,
          version: String(c.canonVersionAdded),
          project_id: ctx.projectId,
        },
        text: ko
          ? `명제 ${c.refId}: “${c.text}” (검색됨; 누가 아는지는 지식 표를 확인)`
          : `Proposition ${c.refId}: “${c.text}” (retrieved; check the knowledge table for who knows it)`,
        dedupeKey: `proposition:${c.refId}`,
      };
    }
    case 'evidence_quote': {
      const sec = sectionFor(t, 'evidence', 'retrieved');
      if (!sec || !c.manuscriptVersionId) return undefined;
      return {
        ...base,
        kind: 'evidence',
        id: `evidence:${c.refId}`,
        section: sec.name,
        tier: sec.tier,
        provenance: 'evidence',
        source: {
          kind: sourceKind,
          ref: c.refId,
          version: String(c.canonVersionAdded),
          manuscript_version_id: c.manuscriptVersionId,
          manuscript_status: 'accepted',
          chapter_no: c.chapterNo ?? 0,
          project_id: ctx.projectId,
        },
        text: `${chapterTag} ${ko ? '근거 인용' : 'evidence quote'}: “${trimQuote(c.text)}”`,
        dedupeKey: `evidence:${c.refId}`,
      };
    }
  }
}

async function fetchOptional(
  ctx: Ctx,
  out: Item[],
  opts: FetchOptions,
  seenEvents: Set<string>,
): Promise<RetrievalStatus> {
  const notes: string[] = [];
  const timeout = opts.optionalTimeoutMs ?? 5000;
  const chapterMax = ctx.plan.chapterNo - 1;
  const run = async (
    name: string,
    r: LexicalRetriever | VectorRetriever,
    sourceKind: 'lexical_index' | 'vector_index',
  ): Promise<RetrievalStatus['lexical']> => {
    try {
      const seen = new Set<string>();
      for (const q of ctx.plan.lexicalQueries) {
        const hits = await withTimeout(
          r.search({
            projectId: ctx.projectId,
            text: q,
            timelineId: ctx.timeline.id,
            entityIds: ctx.plan.allEntityIds,
            chapterMax,
            limit: 20,
          }),
          timeout,
          `${name} retrieval`,
        );
        for (const h of hits) {
          const item = candidateToItem(ctx, h, sourceKind, seenEvents);
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
        }
      }
      return 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('timed out') ? 'timeout' : 'unavailable';
      notes.push(`${name} retrieval ${status}: ${msg}; T2/T3 items from this source were omitted`);
      return status;
    }
  };
  const lexical = opts.lexical
    ? await run(opts.lexical.name, opts.lexical, 'lexical_index')
    : 'not_configured';
  if (!opts.lexical) notes.push('lexical retrieval not configured: structured canon only');
  const vector = opts.vector
    ? await run(opts.vector.name, opts.vector, 'vector_index')
    : 'not_configured';
  if (!opts.vector)
    notes.push('vector retrieval not configured (ADR-0045): structured + lexical only');
  return { lexical, vector, notes };
}

async function chapterTextItem(ctx: Ctx, opts: FetchOptions): Promise<Item | undefined> {
  const sec = sectionFor(ctx.template, 'chapter_text', 'chapter_text');
  if (!sec || !opts.chapterText) return undefined;
  let text: string;
  let status: string;
  let ref: string;
  let versionId: string | undefined;
  if ('versionId' in opts.chapterText) {
    const v = await getManuscriptVersion(ctx.db, opts.chapterText.versionId);
    if (!v)
      throw new ContextError(
        'PROHIBITED_SOURCE',
        `manuscript version ${opts.chapterText.versionId} not found (rejected versions are quarantined and cannot be evaluated)`,
      );
    text = v.text;
    status = v.status;
    ref = v.id;
    versionId = v.id;
  } else {
    text = toNfcText(opts.chapterText.text).text;
    status = opts.chapterText.status;
    ref = opts.chapterText.label ?? 'job-input';
  }
  if (!(ctx.template.chapterTextStatuses as readonly string[]).includes(status)) {
    throw new ContextError(
      'PROHIBITED_SOURCE',
      `${ctx.template.name} accepts chapter text with status ${ctx.template.chapterTextStatuses.join('/')}, got ${status}`,
      { status },
    );
  }
  const paragraphs = segmentParagraphs(toNfcText(text));
  return {
    kind: 'chapter_text',
    id: `chapter_text:${ref}`,
    section: sec.name,
    tier: sec.tier,
    provenance: 'draft_under_evaluation',
    source: {
      kind: 'job_input',
      ref,
      manuscript_status: status as 'working' | 'approved',
      ...(versionId ? { manuscript_version_id: versionId } : {}),
      chapter_no: ctx.plan.chapterNo,
      project_id: ctx.projectId,
    },
    text:
      ctx.lang === 'ko'
        ? `평가 대상 ${ctx.plan.chapterNo}화 원고 (상태 ${status}; 정사 아님):\n${renderWithParagraphIds(paragraphs)}`
        : `Chapter ${ctx.plan.chapterNo} text under evaluation (status ${status}; not canon):\n${renderWithParagraphIds(paragraphs)}`,
    materiality: 'material',
  };
}

export async function fetchContext(db: Queryable, opts: FetchOptions): Promise<FetchResult> {
  const template = templateFor(opts.role);
  if (!template)
    throw new ContextError('TEMPLATE_ROLE_MISMATCH', `no pack template serves role ${opts.role}`, {
      role: opts.role,
    });
  if (opts.contract.project_id !== opts.projectId)
    throw new ContextError(
      'TASK_INVALID',
      `contract ${opts.contract.id} belongs to project ${opts.contract.project_id}, not ${opts.projectId}`,
    );
  const plan = buildQueryPlan(opts.contract);
  const budget = opts.budgetTokens ?? budgetFor(template, opts.policy.context);
  if (budget === undefined)
    throw new ContextError(
      'PACK_VALIDATION_FAILED',
      `policy ${opts.policy.id}@${opts.policy.version} defines no input budget for ${template.name}`,
    );

  // --- authoritative structured retrieval: any failure blocks generation ---
  let ctx: Ctx;
  const items: Item[] = [];
  let previous: PreviousChapterInfo | undefined;
  let workspaceId: string;
  let policyVersion: string;
  const registerLines = new Map<string, string[]>();
  let seenEvents: Set<string>;
  try {
    const project = await getProject(db, opts.projectId);
    workspaceId = project.workspace_id;
    policyVersion = project.production_policy_version;
    const timelines = await timelinesOf(db, opts.projectId);
    const timeline = timelines.find((t) => t.id === opts.contract.timeline_id);
    if (!timeline)
      throw new ContextError(
        'TASK_INVALID',
        `contract timeline ${opts.contract.timeline_id} does not belong to project ${opts.projectId}`,
      );
    ctx = {
      db,
      template,
      plan,
      contract: opts.contract,
      projectId: opts.projectId,
      canonVersion: project.canon_version,
      timeline,
      timelines,
      names: new Map(),
      propositions: new Map(),
      lang: opts.identity?.outputLanguage.language ?? 'en',
    };
    await loadNames(ctx, plan.allEntityIds);
    await fetchRegistry(ctx, items);
    await fetchStates(ctx, items);
    await fetchKnowledge(ctx, items);
    await fetchRelationships(ctx, items, registerLines);
    await fetchPromises(ctx, items);
    seenEvents = await fetchEvents(ctx, items);
    await fetchWorldRules(ctx, items);
    previous = await fetchPreviousChapter(ctx, items, opts.policy.context);
    const chapterText = await chapterTextItem(ctx, opts);
    if (chapterText) items.push(chapterText);
  } catch (err) {
    if (err instanceof ContextError) throw err;
    throw new ContextError(
      'STRUCTURED_RETRIEVAL_UNAVAILABLE',
      `authoritative canon retrieval failed; generation is blocked rather than degraded: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // --- Active Constraint Set (T0) and soft/assumption items (T1) ---
  const constraints = compileActiveConstraintSet(
    opts.spec,
    {
      chapterNo: plan.chapterNo,
      arcId: opts.contract.arc_id,
      minorArcId: opts.contract.minor_arc_id,
      seasonId: opts.contract.season_id,
      participantIds: plan.allEntityIds,
      specVersion: opts.spec.version,
    },
    {
      capTokens: opts.policy.context.active_constraints_cap_tokens,
      workingLanguage: opts.identity?.outputLanguage.language ?? 'en',
    },
  );
  const acsSec = sectionFor(template, 'active_constraint_set', 'active_constraints');
  if (acsSec) {
    items.push({
      kind: 'active_constraint_set',
      id: `active_constraint_set:${constraints.id}`,
      section: acsSec.name,
      tier: acsSec.tier,
      provenance: 'hard_requirement',
      source: {
        kind: 'active_constraint_set',
        ref: constraints.id,
        version: `spec${constraints.specVersion}:${constraints.contentHash.slice(7, 19)}`,
        project_id: opts.projectId,
      },
      text: constraints.hardText,
      materiality: 'material',
    });
  }
  const softSec = sectionFor(template, 'requirement', 'soft_constraints');
  if (softSec) {
    for (const c of [...constraints.soft, ...constraints.assumptions]) {
      items.push({
        kind: 'requirement',
        id: `requirement:${c.id}`,
        section: softSec.name,
        tier: softSec.tier,
        provenance: c.kind === 'soft' ? 'soft_preference' : 'assumption',
        source: {
          kind: 'story_spec',
          ref: c.id,
          version: String(opts.spec.version),
          project_id: opts.projectId,
        },
        text:
          ctx.lang === 'ko'
            ? `[${c.id}] ${c.text}${c.kind === 'assumption' && !c.confirmed ? ' (확인되지 않은 가정)' : ''} {범위: ${c.scopeLabel}}`
            : `[${c.id}] ${c.text}${c.kind === 'assumption' && !c.confirmed ? ' (unconfirmed assumption)' : ''} {scope: ${c.scopeLabel}}`,
        materiality: 'contextual',
      });
    }
  }

  // --- T0: timeline, guards, contract ---
  const n = nameOf(ctx);
  const tlSec = sectionFor(template, 'timeline', 'timeline');
  if (tlSec) {
    const others = ctx.timelines
      .filter((t) => t.id !== ctx.timeline.id)
      .map((t) =>
        ctx.lang === 'ko'
          ? `${t.name} (${t.kind}${t.divergence_clock ? `, ${clockLabelKo(t.divergence_clock)}에서 갈라짐` : ''})`
          : `${t.name} (${t.kind}${t.divergence_clock ? `, diverged at ${clockLabel(t.divergence_clock)}` : ''})`,
      );
    const elapsed =
      ctx.lang === 'ko'
        ? elapsedLabelKo(previous?.endClock, plan.clockStart)
        : elapsedLabel(previous?.endClock, plan.clockStart);
    const lines =
      ctx.lang === 'ko'
        ? [
            `타임라인: ${ctx.timeline.name} (${ctx.timeline.kind}). 서술의 현실 프레임: canonical. 스토리 시계 ${clockLabelKo(plan.clockStart)} → ${clockLabelKo(plan.clockEnd)}. 정사 v${ctx.canonVersion} 고정; 아래의 FACT/KNOWLEDGE/RELATIONSHIP 줄은 모두 이 타임라인의 ${clockLabelKo(plan.clockStart)} 기준이다.`,
            ...(plan.elapsedSincePrevious
              ? [
                  `${plan.chapterNo - 1}화 이후 경과: ${plan.elapsedSincePrevious}${elapsed ? ` (${elapsed})` : ''}.`,
                ]
              : []),
            ...(others.length
              ? [
                  `이 작품의 다른 타임라인: ${others.join('; ')}. 그 사실은 이 타임라인에서 참이 아니며, 인물의 기억으로만 현재에 닿는다(KNOWLEDGE의 기억 표시 줄).`,
                ]
              : []),
          ]
        : [
            `Timeline: ${ctx.timeline.name} (${ctx.timeline.kind}). Reality frame for narration: canonical. Story clock ${clockLabel(plan.clockStart)} → ${clockLabel(plan.clockEnd)}. Canon version ${ctx.canonVersion} pinned; every FACT/KNOWLEDGE/RELATIONSHIP line below is read on this timeline as of ${clockLabel(plan.clockStart)}.`,
            ...(plan.elapsedSincePrevious
              ? [
                  `Elapsed since chapter ${plan.chapterNo - 1}: ${plan.elapsedSincePrevious}${elapsed ? ` (${elapsed})` : ''}.`,
                ]
              : []),
            ...(others.length
              ? [
                  `Other timelines in this project: ${others.join('; ')}. Their facts are NOT true on this timeline; they reach the present only as a character's memory (KNOWLEDGE lines marked "remembered from").`,
                ]
              : []),
          ];
    items.push({
      kind: 'timeline',
      id: `timeline:${ctx.timeline.id}`,
      section: tlSec.name,
      tier: tlSec.tier,
      provenance: 'timeline',
      source: canonSource(ctx, ctx.timeline.id, ctx.timeline.id),
      text: lines.join('\n'),
      materiality: 'material',
    });
  }
  const guardSec = sectionFor(template, 'knowledge_guard', 'knowledge_guards');
  if (guardSec) {
    await loadPropositions(
      ctx,
      plan.guards.flatMap((g) => g.propositionIds),
    );
    for (const g of plan.guards) {
      for (const pid of g.propositionIds) {
        const p = ctx.propositions.get(pid);
        items.push({
          kind: 'knowledge_guard',
          id: `knowledge_guard:${g.characterId}:${pid}`,
          section: guardSec.name,
          tier: guardSec.tier,
          provenance: 'hard_requirement',
          source: {
            kind: 'chapter_contract',
            ref: `${opts.contract.id}#guard`,
            version: String(opts.contract.version),
            project_id: opts.projectId,
          },
          text:
            opts.identity?.outputLanguage.language === 'ko'
              ? `${n(g.characterId)}${topicParticleKo(n(g.characterId))} 다음을 알면 안 된다 (아는 것처럼 말하거나 행동해서도 안 된다): “${p?.statement ?? pid}”. 이 인물이 이것을 언급하게 하지 않는다.`
              : `${n(g.characterId)} must NOT know (or speak/act as if knowing): “${p?.statement ?? pid}”. Do not let this character reference it.`,
          materiality: 'material',
          entityIds: [g.characterId],
        });
      }
    }
  }
  const contractSec =
    sectionFor(template, 'contract', 'contract') ?? sectionFor(template, 'contract', 'hypotheses');
  if (contractSec) {
    items.push({
      kind: 'contract',
      id: `contract:${opts.contract.id}@${opts.contract.version}`,
      section: contractSec.name,
      tier: contractSec.tier,
      provenance: 'contract',
      source: {
        kind: 'chapter_contract',
        ref: opts.contract.id,
        version: String(opts.contract.version),
        project_id: opts.projectId,
      },
      text:
        opts.identity?.outputLanguage.language === 'ko'
          ? renderContractKo(opts.contract, n)
          : renderContract(opts.contract, n),
      materiality: 'material',
    });
  }

  // --- optional sources (degrade, never block) ---
  const retrieval = await fetchOptional(ctx, items, opts, seenEvents);

  // --- Narrative Identity Block (system position) ---
  let narrativeBlock: AssemblyInput['narrativeBlock'];
  if (template.identityVariant) {
    if (!opts.identity)
      throw new ContextError(
        'PACK_VALIDATION_FAILED',
        `${template.name} needs the project's composed Narrative Identity for variant ${template.identityVariant}`,
      );
    const participants: ParticipantDigest[] = plan.onPageIds.map((id) => {
      const e = ctx.names.get(id);
      return {
        displayName: e?.display_name ?? id,
        shortForms: e?.short_forms,
        registerLines: registerLines.get(id),
      };
    });
    const restrictions = constraints.hard
      .filter((c) => c.category === 'content_restriction')
      .map((c) => `[${c.id}] ${c.text}`);
    const block = compileBlock(opts.identity, {
      role: template.identityVariant,
      budgetTokens: opts.identityBlockBudgetTokens ?? Math.max(1500, Math.floor(budget * 0.25)),
      participants,
      contentRestrictions: restrictions,
    });
    narrativeBlock = {
      text: block.text,
      hash: block.hash,
      identityVersionId: block.identityVersionId,
      roleVariant: block.role,
      outputLanguage: block.outputLanguage,
      outputLanguageContractHash: block.outputLanguageContractHash,
      traditionContractHash: block.traditionContractHash,
      droppedSections: block.droppedSections,
      identityTail: block.identityTail,
    };
    const idSec = sectionFor(template, 'narrative_identity_block', 'narrative_identity');
    if (idSec) {
      items.push({
        kind: 'narrative_identity_block',
        id: `narrative_identity_block:${block.identityVersionId}`,
        section: idSec.name,
        tier: idSec.tier,
        provenance: 'narrative_identity',
        source: {
          kind: 'narrative_identity',
          ref: block.identityRef,
          version: block.identityVersionId,
          project_id: opts.projectId,
        },
        text: block.text,
        materiality: 'material',
      });
    }
  }

  const input: AssemblyInput = {
    workspaceId,
    projectId: opts.projectId,
    role: opts.role,
    contract: opts.contract,
    clockStart: plan.clockStart,
    items,
    language: ctx.lang,
    narrativeBlock,
    activeConstraintSet: {
      id: constraints.id,
      contentHash: constraints.contentHash,
      renderedText: constraints.renderedText,
      hardText: constraints.hardText,
      tokenCount: constraints.tokenCount,
      hardCount: constraints.hard.length,
      softCount: constraints.soft.length,
      assumptionCount: constraints.assumptions.length,
      conflictCount: constraints.conflicts.length,
      specVersion: constraints.specVersion,
    },
    previousChapter: previous,
    pins: {
      canonVersion: ctx.canonVersion,
      specVersion: opts.spec.version,
      bibleVersion: opts.bibleVersion ?? opts.contract.pinned.bible_version,
      narrativeIdentityVersionId: opts.contract.narrative_identity_version_id,
      productionPolicyVersion: policyVersion,
      promptSetId: opts.promptSetId,
    },
    policyContext: {
      ...opts.policy.context,
      ...(opts.budgetTokens !== undefined
        ? {
            writer_input_budget_tokens: opts.budgetTokens,
            input_budget_tokens: { [template.name]: opts.budgetTokens },
          }
        : {}),
    },
    retrieval,
    queryPlanHash: plan.hash,
    jobId: opts.jobId,
  };
  return { input, plan, constraints, template };
}

function truthKo(truth: string): string {
  const map: Record<string, string> = {
    true: '참',
    false: '거짓',
    unknown: '미정',
    undetermined: '미정',
  };
  return map[truth.toLowerCase()] ?? truth;
}
