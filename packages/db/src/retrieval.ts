/**
 * Read paths and derived-artifact writes for context assembly (Checkpoint 4, migration 0003).
 *
 * Everything here reads accepted/canonical content only: manuscript text is read through
 * `acceptedChapter`, which refuses any status but `accepted`; search documents can only cite accepted
 * versions (trigger); L1 summaries can only be stored for accepted versions (trigger). Structured queries
 * delegate to the bitemporal SQL helpers of migration 0001 so "as of chapter k / canon version v" semantics
 * are defined exactly once, in the database.
 */
import { type Client, type Pool, rethrowCanon, withTransaction } from './client.js';
import { type StoryClock } from '@yeonjae/domain';
import { toNfcText } from '@yeonjae/prose';
import { createHash } from 'node:crypto';
import { containsPattern, koreanQueryTerms } from './korean-query.js';
import { type FactRow, type KnowledgeRow, type ManuscriptVersionRow } from './repo.js';

type Queryable = Pool | Client;

export interface AcceptedChapter {
  readonly chapterId: string;
  readonly chapterNo: number;
  readonly version: ManuscriptVersionRow;
  readonly acceptedCommitId: string;
  readonly acceptedCanonVersion: number;
}

export type ChapterLookup =
  | { readonly state: 'accepted'; readonly chapter: AcceptedChapter }
  | { readonly state: 'missing' }
  | {
      readonly state: 'not_accepted';
      readonly chapterStatus: string;
      readonly latestVersionStatus?: string | undefined;
    };

/** The accepted text of chapter `chapterNo`, or the precise reason there is none. Never returns a draft. */
export async function acceptedChapter(
  db: Queryable,
  projectId: string,
  chapterNo: number,
): Promise<ChapterLookup> {
  const ch = await db.query<{ id: string; status: string; accepted_version_id: string | null }>(
    'SELECT id, status, accepted_version_id FROM chapters WHERE project_id = $1 AND number = $2',
    [projectId, chapterNo],
  );
  const chapter = ch.rows[0];
  if (!chapter) return { state: 'missing' };
  if (chapter.status !== 'accepted' || !chapter.accepted_version_id) {
    const latest = await db.query<{ status: string }>(
      'SELECT status FROM manuscript_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1',
      [chapter.id],
    );
    return {
      state: 'not_accepted',
      chapterStatus: chapter.status,
      latestVersionStatus: latest.rows[0]?.status,
    };
  }
  const v = await db.query<ManuscriptVersionRow & { accepted_version: number | null }>(
    `SELECT mv.*, cc.version AS accepted_version
       FROM manuscript_versions mv LEFT JOIN canon_commits cc ON cc.id = mv.accepted_commit_id
      WHERE mv.id = $1 AND mv.status = 'accepted'`,
    [chapter.accepted_version_id],
  );
  const row = v.rows[0];
  if (!row?.accepted_commit_id) return { state: 'not_accepted', chapterStatus: chapter.status };
  const { accepted_version, ...version } = row;
  return {
    state: 'accepted',
    chapter: {
      chapterId: chapter.id,
      chapterNo,
      version,
      acceptedCommitId: row.accepted_commit_id,
      acceptedCanonVersion: accepted_version ?? 0,
    },
  };
}

export interface CommitDeltaRow {
  readonly id: string;
  readonly version: number;
  readonly delta: { readonly items?: readonly unknown[] } | null;
  readonly item_counts: Record<string, number>;
}

export async function commitById(
  db: Queryable,
  commitId: string,
): Promise<CommitDeltaRow | undefined> {
  const r = await db.query<CommitDeltaRow>(
    'SELECT id, version, delta, item_counts FROM canon_commits WHERE id = $1',
    [commitId],
  );
  return r.rows[0];
}

export interface SummaryRow {
  readonly id: string;
  readonly tier: 'L1' | 'L2' | 'L3' | 'L4';
  readonly manuscript_version_id: string | null;
  readonly text: string;
  readonly ending_hook: string | null;
  readonly canon_version: number;
  readonly content_hash: string;
  readonly chapter_from: number | null;
  readonly chapter_to: number | null;
}

/** Store (idempotently) the L1 summary + ending hook of an accepted version. Refused for anything else. */
export async function upsertL1Summary(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    manuscriptVersionId: string;
    chapterNo: number;
    text: string;
    endingHook?: string | undefined;
    canonVersion: number;
    promptVersionId?: string | undefined;
  },
): Promise<SummaryRow> {
  const text = toNfcText(input.text).text;
  const hook = input.endingHook === undefined ? null : toNfcText(input.endingHook).text;
  const hash = `sha256:${createHash('sha256')
    .update(text)
    .update('\u0000')
    .update(hook ?? '')
    .digest('hex')}`;
  const r = await db
    .query<SummaryRow>(
      `INSERT INTO summaries (workspace_id, project_id, tier, scope_kind, chapter_from, chapter_to, manuscript_version_id, text, ending_hook, canon_version, prompt_version_id, content_hash, language)
       VALUES ($1, $2, 'L1', 'chapter', $3, $3, $4, $5, $6, $7, $8, $9, (SELECT output_language FROM projects WHERE id = $2))
       ON CONFLICT (manuscript_version_id) WHERE tier = 'L1'
       DO UPDATE SET text = EXCLUDED.text, ending_hook = EXCLUDED.ending_hook, canon_version = EXCLUDED.canon_version,
                     prompt_version_id = EXCLUDED.prompt_version_id, content_hash = EXCLUDED.content_hash
       RETURNING id, tier, manuscript_version_id, text, ending_hook, canon_version, content_hash, chapter_from, chapter_to`,
      [
        input.workspaceId,
        input.projectId,
        input.chapterNo,
        input.manuscriptVersionId,
        text,
        hook,
        input.canonVersion,
        input.promptVersionId ?? null,
        hash,
      ],
    )
    .catch(rethrowCanon);
  return r.rows[0] ?? rethrowCanon(new Error('summary upsert returned no row'));
}

export async function l1SummaryFor(
  db: Queryable,
  manuscriptVersionId: string,
): Promise<SummaryRow | undefined> {
  const r = await db.query<SummaryRow>(
    `SELECT s.id, s.tier, s.manuscript_version_id, s.text, s.ending_hook, s.canon_version, s.content_hash, s.chapter_from, s.chapter_to
       FROM summaries s JOIN manuscript_versions mv ON mv.id = s.manuscript_version_id
      WHERE s.manuscript_version_id = $1 AND s.tier = 'L1' AND mv.status = 'accepted'`,
    [manuscriptVersionId],
  );
  return r.rows[0];
}

/** Synchronous lexical indexing of an accepted version (paragraphs, L1, evidence quotes, commit events/propositions). */
export async function indexAcceptedVersion(
  db: Queryable,
  manuscriptVersionId: string,
): Promise<number> {
  const r = await db
    .query<{ n: number }>('SELECT canon.index_accepted_version($1) AS n', [manuscriptVersionId])
    .catch(rethrowCanon);
  return r.rows[0]?.n ?? 0;
}

export async function reindexProject(pool: Pool, projectId: string): Promise<number> {
  return withTransaction(pool, async (client) => {
    const r = await client
      .query<{ n: number }>('SELECT canon.reindex_project($1) AS n', [projectId])
      .catch(rethrowCanon);
    return r.rows[0]?.n ?? 0;
  });
}

export interface SearchHit {
  readonly id: string;
  readonly kind: 'chapter_paragraph' | 'summary_l1' | 'event' | 'proposition' | 'evidence_quote';
  readonly ref_kind: string;
  readonly ref_id: string;
  readonly ref_key: string;
  readonly chapter_no: number | null;
  readonly clock_ord: string | number | null;
  readonly timeline_id: string | null;
  readonly entity_ids: string[];
  readonly importance: string | null;
  readonly text: string;
  readonly manuscript_version_id: string | null;
  readonly canon_version_added: number;
  readonly rank: number;
}

export interface LexicalQuery {
  readonly projectId: string;
  /** English query text; words are OR-ed for recall (`mode: 'any'`, default) or AND-ed (`mode: 'all'`). */
  readonly query: string;
  readonly mode?: 'any' | 'all' | undefined;
  /**
   * The project's manuscript language. `ko` searches Korean documents by particle-stripped stems over the
   * trigram index, with registry aliases expanded (ADR-0058); `en` (default) uses English full-text search.
   */
  readonly language?: 'en' | 'ko' | undefined;
  readonly timelineId?: string | undefined;
  readonly entityIds?: readonly string[] | undefined;
  readonly chapterMax?: number | undefined;
  readonly kinds?: readonly SearchHit['kind'][] | undefined;
  readonly limit?: number | undefined;
}

/**
 * English full-text search over accepted/canonical documents. Filters: timeline (isolation), entities (any),
 * chapter upper bound (never read the future), kinds. Ordering is total: rank desc, chapter asc, id asc.
 */
export async function lexicalSearch(db: Queryable, q: LexicalQuery): Promise<SearchHit[]> {
  if (q.language === 'ko') return koreanLexicalSearch(db, q);
  const words = q.query
    .split(/\s+/)
    .map((w) => w.replace(/["'’“”()]/g, ''))
    .filter((w) => w.length > 0 && !/^(or|and|not)$/i.test(w));
  if (words.length === 0) return [];
  const query = (q.mode ?? 'any') === 'any' ? words.join(' or ') : words.join(' ');
  const params: unknown[] = [q.projectId, query];
  const where: string[] = ['d.project_id = $1', `d.tsv @@ websearch_to_tsquery('english', $2)`];
  if (q.timelineId) {
    params.push(q.timelineId);
    where.push(`(d.timeline_id = $${params.length} OR d.timeline_id IS NULL)`);
  }
  if (q.entityIds && q.entityIds.length > 0) {
    params.push([...q.entityIds]);
    where.push(`d.entity_ids && $${params.length}::uuid[]`);
  }
  if (q.chapterMax !== undefined) {
    params.push(q.chapterMax);
    where.push(`(d.chapter_no IS NULL OR d.chapter_no <= $${params.length})`);
  }
  if (q.kinds && q.kinds.length > 0) {
    params.push([...q.kinds]);
    where.push(`d.kind = ANY($${params.length}::text[])`);
  }
  params.push(q.limit ?? 40);
  const r = await db.query<SearchHit>(
    `SELECT d.id, d.kind, d.ref_kind, d.ref_id, d.ref_key, d.chapter_no, d.clock_ord, d.timeline_id, d.entity_ids, d.importance,
            d.text, d.manuscript_version_id, d.canon_version_added,
            ts_rank_cd(d.tsv, websearch_to_tsquery('english', $2))::float8 AS rank
       FROM search_documents d
      WHERE ${where.join(' AND ')}
      ORDER BY rank DESC, d.chapter_no ASC NULLS LAST, d.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/** Weight of a registry surface reached through an alias of a query term (the term itself weighs 1). */
const ALIAS_WEIGHT = 0.8;
const MAX_KOREAN_TERMS = 16;

/**
 * Korean search (ADR-0058): each query word is reduced to its stem (one particle or ending removed), stems
 * that name a registry entity bring the entity's other surfaces (display name, short forms, aliases), and a
 * document matches when it contains any term. Rank = weighted term hits, then word similarity, then chapter
 * and id, so the order is total and replays are stable. Backed by the Korean-only trigram index.
 */
async function koreanLexicalSearch(db: Queryable, q: LexicalQuery): Promise<SearchHit[]> {
  const stems = koreanQueryTerms(q.query);
  if (stems.length === 0) return [];
  const weights = new Map<string, number>(stems.map((s) => [s, 1]));
  const registry = await db.query<{ surfaces: string[] }>(
    `SELECT ARRAY[e.display_name] || e.short_forms || e.aliases AS surfaces
       FROM entities e
      WHERE e.project_id = $1 AND e.status = 'active'
        AND (ARRAY[e.display_name] || e.short_forms || e.aliases) && $2::text[]
      ORDER BY e.id`,
    [q.projectId, stems],
  );
  for (const row of registry.rows)
    for (const s of row.surfaces)
      if (s.length >= 2 && !weights.has(s) && weights.size < MAX_KOREAN_TERMS)
        weights.set(s, ALIAS_WEIGHT);
  const terms = [...weights.keys()];
  const params: unknown[] = [
    q.projectId,
    terms,
    terms.map(containsPattern),
    terms.map((t) => weights.get(t) ?? 1),
  ];
  const where: string[] = ['d.project_id = $1', `d.language = 'ko'`, 'd.text LIKE ANY($3::text[])'];
  if (q.timelineId) {
    params.push(q.timelineId);
    where.push(`(d.timeline_id = $${params.length} OR d.timeline_id IS NULL)`);
  }
  if (q.entityIds && q.entityIds.length > 0) {
    params.push([...q.entityIds]);
    where.push(`d.entity_ids && $${params.length}::uuid[]`);
  }
  if (q.chapterMax !== undefined) {
    params.push(q.chapterMax);
    where.push(`(d.chapter_no IS NULL OR d.chapter_no <= $${params.length})`);
  }
  if (q.kinds && q.kinds.length > 0) {
    params.push([...q.kinds]);
    where.push(`d.kind = ANY($${params.length}::text[])`);
  }
  params.push(q.limit ?? 40);
  const r = await db.query<SearchHit>(
    `SELECT d.id, d.kind, d.ref_kind, d.ref_id, d.ref_key, d.chapter_no, d.clock_ord, d.timeline_id, d.entity_ids, d.importance,
            d.text, d.manuscript_version_id, d.canon_version_added,
            (SELECT sum(u.w * (CASE WHEN d.text LIKE u.p THEN 1 ELSE 0 END) + 0.001 * word_similarity(u.t, d.text))
               FROM unnest($2::text[], $3::text[], $4::float8[]) AS u(t, p, w))::float8 AS rank
       FROM search_documents d
      WHERE ${where.join(' AND ')}
      ORDER BY rank DESC, d.chapter_no ASC NULLS LAST, d.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function searchDocumentCount(db: Queryable, projectId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1',
    [projectId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

export async function searchDocumentsContaining(
  db: Queryable,
  projectId: string,
  phrase: string,
): Promise<number> {
  const r = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1 AND text LIKE $2',
    [projectId, `%${phrase}%`],
  );
  return Number(r.rows[0]?.n ?? '0');
}

// ---------------------------------------------------------------------------------------------------------
// structured canonical retrieval (authoritative)
// ---------------------------------------------------------------------------------------------------------

export interface EntityDigest {
  readonly id: string;
  readonly type: string;
  readonly display_name: string;
  readonly short_forms: string[];
  readonly aliases: string[];
  readonly fields: Record<string, unknown>;
  readonly status: string;
}

export async function entitiesById(
  db: Queryable,
  projectId: string,
  ids: readonly string[],
): Promise<EntityDigest[]> {
  if (ids.length === 0) return [];
  const r = await db.query<EntityDigest>(
    `SELECT id, type, display_name, short_forms, aliases, fields, status FROM entities
      WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [projectId, [...ids]],
  );
  return r.rows;
}

export async function entitiesOfType(
  db: Queryable,
  projectId: string,
  type: string,
): Promise<EntityDigest[]> {
  const r = await db.query<EntityDigest>(
    `SELECT id, type, display_name, short_forms, aliases, fields, status FROM entities
      WHERE project_id = $1 AND type = $2 AND status = 'active' ORDER BY id`,
    [projectId, type],
  );
  return r.rows;
}

export interface TimelineInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: 'main' | 'prior_loop' | 'alternate' | 'source_story';
  readonly parent_timeline_id: string | null;
  readonly divergence_clock: StoryClock | null;
}

export async function timelinesOf(db: Queryable, projectId: string): Promise<TimelineInfo[]> {
  const r = await db.query<TimelineInfo>(
    'SELECT id, name, kind, parent_timeline_id, divergence_clock FROM timelines WHERE project_id = $1 ORDER BY id',
    [projectId],
  );
  return r.rows;
}

/** All live facts of an entity on one timeline as of a clock (and canon version): the T1 state table. */
export async function entityStateAt(
  db: Queryable,
  q: {
    projectId: string;
    entityId: string;
    clock: StoryClock;
    timelineId: string;
    asOfVersion: number;
  },
): Promise<FactRow[]> {
  const r = await db.query<FactRow>(
    'SELECT * FROM canon.state_at($1, $2, NULL, $3::jsonb, $4, $5, NULL) ORDER BY attribute, key, id',
    [q.projectId, q.entityId, JSON.stringify(q.clock), q.timelineId, q.asOfVersion],
  );
  return r.rows;
}

export interface FactEvidenceRow {
  readonly fact_id: string;
  readonly manuscript_version_id: string;
  readonly chapter_no: number | null;
  readonly paragraph_id: string | null;
  readonly start_cp: number;
  readonly end_cp: number;
  readonly quote: string;
  readonly version_status: string;
}

/** Evidence quotes for facts; only quotes on accepted versions are returned (the join enforces it). */
export async function evidenceForFacts(
  db: Queryable,
  factIds: readonly string[],
): Promise<FactEvidenceRow[]> {
  if (factIds.length === 0) return [];
  const r = await db.query<FactEvidenceRow>(
    `SELECT fe.fact_id, es.manuscript_version_id, es.chapter_no, es.paragraph_id, es.start_cp, es.end_cp, es.quote, mv.status AS version_status
       FROM fact_evidence fe JOIN evidence_spans es ON es.id = fe.evidence_span_id
       JOIN manuscript_versions mv ON mv.id = es.manuscript_version_id
      WHERE fe.fact_id = ANY($1::uuid[]) AND mv.status = 'accepted'
      ORDER BY fe.fact_id, es.start_cp, es.id`,
    [[...factIds]],
  );
  return r.rows;
}

export interface PropositionRow {
  readonly id: string;
  readonly statement: string;
  readonly kind: string;
  readonly entity_ids: string[];
  readonly secret: {
    owner_ids?: string[];
    allowed_knower_ids?: string[];
    reader_may_know?: boolean;
    reveal_not_before_chapter?: number;
  } | null;
  readonly retracted_at_version: number | null;
}

export async function propositionsById(
  db: Queryable,
  projectId: string,
  ids: readonly string[],
  asOfVersion: number,
): Promise<PropositionRow[]> {
  if (ids.length === 0) return [];
  const r = await db.query<PropositionRow>(
    `SELECT id, statement, kind, entity_ids, secret, retracted_at_version FROM propositions
      WHERE project_id = $1 AND id = ANY($2::uuid[])
        AND (retracted_at_version IS NULL OR retracted_at_version > $3)
      ORDER BY id`,
    [projectId, [...ids], asOfVersion],
  );
  return r.rows;
}

/** Propositions touching any of the entities (by entity_ids overlap) — the "secrets owned by participants" set. */
export async function propositionsTouching(
  db: Queryable,
  projectId: string,
  entityIds: readonly string[],
  asOfVersion: number,
): Promise<PropositionRow[]> {
  if (entityIds.length === 0) return [];
  const r = await db.query<PropositionRow>(
    `SELECT id, statement, kind, entity_ids, secret, retracted_at_version FROM propositions
      WHERE project_id = $1 AND entity_ids && $2::uuid[]
        AND (retracted_at_version IS NULL OR retracted_at_version > $3)
      ORDER BY id`,
    [projectId, [...entityIds], asOfVersion],
  );
  return r.rows;
}

export async function knowledgeOfKnowerAt(
  db: Queryable,
  q: {
    projectId: string;
    knowerKind: 'character' | 'narrator' | 'reader';
    knowerEntityId?: string | undefined;
    clock: StoryClock;
    timelineId: string;
    asOfVersion: number;
  },
): Promise<KnowledgeRow[]> {
  const r = await db.query<KnowledgeRow>(
    'SELECT * FROM canon.knowledge_at($1, $2, $3, NULL, $4::jsonb, $5, $6) ORDER BY proposition_id, id',
    [
      q.projectId,
      q.knowerKind,
      q.knowerEntityId ?? null,
      JSON.stringify(q.clock),
      q.timelineId,
      q.asOfVersion,
    ],
  );
  return r.rows;
}

export async function truthOnTimeline(
  db: Queryable,
  propositionId: string,
  timelineId: string,
  clock: StoryClock,
  asOfVersion: number,
): Promise<'true' | 'false' | 'unknown'> {
  const r = await db.query<{ v: 'true' | 'false' | 'unknown' }>(
    'SELECT canon.truth_at($1, $2, $3::jsonb, $4) AS v',
    [propositionId, timelineId, JSON.stringify(clock), asOfVersion],
  );
  return r.rows[0]?.v ?? 'unknown';
}

export interface RelationshipRow {
  readonly id: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly type: string;
  readonly axes: Record<string, number> | null;
  readonly power_dynamic: string | null;
  readonly register: Record<string, unknown> | null;
  readonly note: string | null;
  readonly valid_from: StoryClock;
  readonly valid_to: StoryClock | null;
  readonly asserted_at_version: number;
}

/** Directional pair state (from → to) at a clock. Both directions must be asked for separately. */
export async function relationshipAt(
  db: Queryable,
  q: {
    projectId: string;
    fromId: string;
    toId: string;
    clock: StoryClock;
    timelineId: string;
    asOfVersion: number;
  },
): Promise<RelationshipRow | undefined> {
  const r = await db.query<RelationshipRow>(
    'SELECT * FROM canon.relationship_at($1, $2, $3, $4::jsonb, $5, $6) ORDER BY id LIMIT 1',
    [q.projectId, q.fromId, q.toId, JSON.stringify(q.clock), q.timelineId, q.asOfVersion],
  );
  return r.rows[0];
}

export interface PromiseRow {
  readonly id: string;
  readonly type: string;
  readonly statement: string;
  readonly importance: 'core' | 'major' | 'minor';
  readonly status: string;
  readonly due_min_chapter: number | null;
  readonly due_max_chapter: number | null;
  readonly related_entity_ids: string[];
  readonly related_proposition_ids: string[];
  readonly resolution_hint: string | null;
  readonly last_event_kind: string | null;
  readonly last_event_chapter: number | null;
}

export async function promisesForChapter(
  db: Queryable,
  q: {
    projectId: string;
    chapterNo: number;
    entityIds: readonly string[];
    explicitIds: readonly string[];
    window: number;
  },
): Promise<PromiseRow[]> {
  const r = await db.query<PromiseRow>(
    `SELECT p.id, p.type, p.statement, p.importance, p.status, p.due_min_chapter, p.due_max_chapter,
            p.related_entity_ids, p.related_proposition_ids, p.resolution_hint,
            le.kind AS last_event_kind, lc.number AS last_event_chapter
       FROM promises p
       LEFT JOIN LATERAL (SELECT pe.kind, pe.chapter_id FROM promise_events pe WHERE pe.promise_id = p.id ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1) le ON true
       LEFT JOIN chapters lc ON lc.id = le.chapter_id
      WHERE p.project_id = $1
        AND (p.id = ANY($4::uuid[])
             OR (p.status IN ('open','advanced')
                 AND (p.related_entity_ids && $3::uuid[]
                      OR (p.due_min_chapter IS NOT NULL AND p.due_min_chapter <= $2::int + $5::int AND coalesce(p.due_max_chapter, 2147483647) >= $2::int - $5::int))))
      ORDER BY p.id`,
    [q.projectId, q.chapterNo, [...q.entityIds], [...q.explicitIds], q.window],
  );
  return r.rows;
}

export interface EventRow {
  readonly id: string;
  readonly timeline_id: string;
  readonly clock_start: StoryClock;
  readonly frame: string;
  readonly type: string;
  readonly summary: string;
  readonly location_id: string | null;
  readonly importance: string | null;
  readonly asserted_at_version: number;
  readonly source_chapter_no: number | null;
  readonly participant_ids: string[];
}

/**
 * Canonical events on one timeline in the window [sinceClock, beforeClock) involving any of the entities,
 * newest first — the structured temporal neighborhood (docs/04-memory-canon/05 §2.2). Older events are
 * reached through lexical retrieval, never through this query.
 */
export async function eventsBefore(
  db: Queryable,
  q: {
    projectId: string;
    timelineId: string;
    beforeClock: StoryClock;
    sinceClock?: StoryClock | undefined;
    entityIds: readonly string[];
    asOfVersion: number;
    limit: number;
  },
): Promise<EventRow[]> {
  const ord = q.beforeClock.chapter_no * 1_000_000 + q.beforeClock.ordinal;
  const since = q.sinceClock ? q.sinceClock.chapter_no * 1_000_000 + q.sinceClock.ordinal : 0;
  const r = await db.query<EventRow>(
    `SELECT e.id, e.timeline_id, e.clock_start, e.frame, e.type, e.summary, e.location_id, e.importance, e.asserted_at_version,
            c.number AS source_chapter_no,
            coalesce((SELECT array_agg(ep.entity_id ORDER BY ep.entity_id) FROM event_participants ep WHERE ep.event_id = e.id), '{}') AS participant_ids
       FROM events e LEFT JOIN chapters c ON c.id = e.source_chapter_id
      WHERE e.project_id = $1 AND e.timeline_id = $2 AND e.clock_ord < $3 AND e.clock_ord >= $7
        AND e.asserted_at_version <= $4 AND (e.retracted_at_version IS NULL OR e.retracted_at_version > $4)
        AND ($5::uuid[] = '{}' OR EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.entity_id = ANY($5::uuid[]))
             OR e.location_id = ANY($5::uuid[]))
      ORDER BY e.clock_ord DESC, e.id DESC
      LIMIT $6`,
    [q.projectId, q.timelineId, ord, q.asOfVersion, [...q.entityIds], q.limit, since],
  );
  return r.rows;
}

export async function eventsById(
  db: Queryable,
  projectId: string,
  ids: readonly string[],
  asOfVersion: number,
): Promise<EventRow[]> {
  if (ids.length === 0) return [];
  const r = await db.query<EventRow>(
    `SELECT e.id, e.timeline_id, e.clock_start, e.frame, e.type, e.summary, e.location_id, e.importance, e.asserted_at_version,
            c.number AS source_chapter_no,
            coalesce((SELECT array_agg(ep.entity_id ORDER BY ep.entity_id) FROM event_participants ep WHERE ep.event_id = e.id), '{}') AS participant_ids
       FROM events e LEFT JOIN chapters c ON c.id = e.source_chapter_id
      WHERE e.project_id = $1 AND e.id = ANY($2::uuid[])
        AND e.asserted_at_version <= $3 AND (e.retracted_at_version IS NULL OR e.retracted_at_version > $3)
      ORDER BY e.id`,
    [projectId, [...ids], asOfVersion],
  );
  return r.rows;
}

/** World/power rules: live facts of ability/term/organization entities and world_rule propositions. */
export async function worldRulesAt(
  db: Queryable,
  q: {
    projectId: string;
    clock: StoryClock;
    timelineId: string;
    asOfVersion: number;
    entityIds: readonly string[];
  },
): Promise<{
  facts: (FactRow & { entity_name: string; entity_type: string })[];
  propositions: PropositionRow[];
}> {
  const ord = q.clock.chapter_no * 1_000_000 + q.clock.ordinal;
  const facts = await db.query<FactRow & { entity_name: string; entity_type: string }>(
    `SELECT f.*, e.display_name AS entity_name, e.type AS entity_type
       FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.project_id = $1 AND f.timeline_id = $2
        AND (e.type IN ('ability','term','organization') OR f.attribute LIKE 'rule.%' OR f.attribute LIKE 'world.%' OR f.attribute LIKE 'power.rule%')
        AND ($5::uuid[] = '{}' OR e.type IN ('ability','term') OR f.entity_id = ANY($5::uuid[]))
        AND f.valid_from_ord <= $3 AND (f.valid_to_ord IS NULL OR f.valid_to_ord > $3)
        AND f.asserted_at_version <= $4 AND (f.retracted_at_version IS NULL OR f.retracted_at_version > $4)
      ORDER BY e.display_name, f.attribute, f.key, f.id`,
    [q.projectId, q.timelineId, ord, q.asOfVersion, [...q.entityIds]],
  );
  const props = await db.query<PropositionRow>(
    `SELECT id, statement, kind, entity_ids, secret, retracted_at_version FROM propositions
      WHERE project_id = $1 AND kind = 'world_rule' AND (retracted_at_version IS NULL OR retracted_at_version > $2)
        AND (secret IS NULL OR secret = 'null'::jsonb)
      ORDER BY id`,
    [q.projectId, q.asOfVersion],
  );
  return { facts: facts.rows, propositions: props.rows };
}

// ---------------------------------------------------------------------------------------------------------
// derived artifacts: Active Constraint Sets and context-pack records
// ---------------------------------------------------------------------------------------------------------

export async function storeActiveConstraintSet(
  db: Queryable,
  input: {
    id: string;
    workspaceId: string;
    projectId: string;
    chapterNo: number;
    specVersion: number;
    contentHash: string;
    renderedText: string;
    itemIds: readonly string[];
    tokenCount: number;
    hardCount: number;
  },
): Promise<void> {
  await db
    .query(
      `INSERT INTO active_constraint_sets (id, workspace_id, project_id, chapter_no, spec_version, content_hash, rendered_text, item_ids, token_count, hard_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.chapterNo,
        input.specVersion,
        input.contentHash,
        input.renderedText,
        [...input.itemIds],
        input.tokenCount,
        input.hardCount,
      ],
    )
    .catch(rethrowCanon);
}

export async function storeContextPack(
  db: Queryable,
  input: {
    id: string;
    workspaceId: string;
    projectId: string;
    jobId?: string | undefined;
    template: string;
    templateVersion: string;
    role: string;
    canonVersion: number;
    packHash: string;
    manifest: unknown;
    tokenCounts: unknown;
    renderedSystemHash: string;
    renderedUserHash: string;
    degraded: boolean;
  },
): Promise<{ stored: boolean }> {
  const r = await db
    .query(
      `INSERT INTO context_packs (id, workspace_id, project_id, job_id, template, template_version, role, canon_version, pack_hash, manifest, token_counts, rendered_system_hash, rendered_user_hash, degraded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
       ON CONFLICT (pack_hash) DO NOTHING`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.jobId ?? null,
        input.template,
        input.templateVersion,
        input.role,
        input.canonVersion,
        input.packHash,
        JSON.stringify(input.manifest),
        JSON.stringify(input.tokenCounts),
        input.renderedSystemHash,
        input.renderedUserHash,
        input.degraded,
      ],
    )
    .catch(rethrowCanon);
  return { stored: (r.rowCount ?? 0) > 0 };
}

export async function createPromise(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    type: string;
    statement: string;
    importance: 'core' | 'major' | 'minor';
    status?: string | undefined;
    dueMinChapter?: number | undefined;
    dueMaxChapter?: number | undefined;
    relatedEntityIds?: readonly string[] | undefined;
    relatedPropositionIds?: readonly string[] | undefined;
    resolutionHint?: string | undefined;
    id?: string | undefined;
  },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO promises (id, workspace_id, project_id, type, statement, importance, status, due_min_chapter, due_max_chapter, related_entity_ids, related_proposition_ids, resolution_hint)
     VALUES (coalesce($12::uuid, canon.uuid_v7()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      input.workspaceId,
      input.projectId,
      input.type,
      input.statement,
      input.importance,
      input.status ?? 'planned',
      input.dueMinChapter ?? null,
      input.dueMaxChapter ?? null,
      [...(input.relatedEntityIds ?? [])],
      [...(input.relatedPropositionIds ?? [])],
      input.resolutionHint ?? null,
      input.id ?? null,
    ],
  );
  return r.rows[0]?.id ?? rethrowCanon(new Error('promise insert returned no row'));
}
