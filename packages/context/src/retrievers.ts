/**
 * Optional retrieval sources (docs/04-memory-canon/05, ADR-0011, ADR-0045). Structured canon queries are
 * authoritative and live in @yeonjae/db; the sources here only *discover* candidates for T2/T3. Each one may
 * be absent, fail or time out without blocking assembly: the degradation ladder records the outcome in the
 * manifest and the pack is built from the remaining sources.
 */
import { lexicalSearch, type Client, type Pool, type SearchHit } from '@yeonjae/db';

export interface RetrievalQuery {
  readonly projectId: string;
  readonly text: string;
  readonly timelineId: string;
  readonly entityIds: readonly string[];
  /** Never read chapters after this one (the previous accepted chapter). */
  readonly chapterMax: number;
  readonly limit: number;
}

export interface RetrievedCandidate {
  readonly kind: SearchHit['kind'];
  readonly refId: string;
  readonly refKey: string;
  readonly chapterNo: number | null;
  readonly timelineId: string | null;
  readonly entityIds: readonly string[];
  readonly importance: string | null;
  readonly text: string;
  readonly manuscriptVersionId: string | null;
  readonly canonVersionAdded: number;
  /** Relevance in [0, 1] relative to the best hit of the same query. */
  readonly relevance: number;
}

export interface LexicalRetriever {
  readonly name: string;
  search(q: RetrievalQuery, signal?: AbortSignal): Promise<RetrievedCandidate[]>;
}

/**
 * Vector retrieval interface. No implementation ships in Checkpoint 4 (ADR-0045): embeddings need a live
 * embedder and pgvector; until an `embedding_sets` row is active the source reports `not_configured`.
 */
export interface VectorRetriever {
  readonly name: string;
  readonly embeddingSetId: string;
  search(q: RetrievalQuery, signal?: AbortSignal): Promise<RetrievedCandidate[]>;
}

export class PgLexicalRetriever implements LexicalRetriever {
  readonly name: string;
  /** `ko` projects search Korean documents with the trigram path (ADR-0058); `en` keeps English FTS. */
  constructor(
    private readonly db: Pool | Client,
    private readonly language: 'en' | 'ko' = 'en',
  ) {
    this.name = language === 'ko' ? 'postgres_trgm_korean' : 'postgres_fts_english';
  }

  async search(q: RetrievalQuery): Promise<RetrievedCandidate[]> {
    const hits = await lexicalSearch(this.db, {
      projectId: q.projectId,
      query: q.text,
      language: this.language,
      timelineId: q.timelineId,
      chapterMax: q.chapterMax,
      limit: q.limit,
    });
    const best = hits.reduce((m, h) => Math.max(m, h.rank), 0);
    return hits.map((h) => ({
      kind: h.kind,
      refId: h.ref_id,
      refKey: h.ref_key,
      chapterNo: h.chapter_no,
      timelineId: h.timeline_id,
      entityIds: h.entity_ids,
      importance: h.importance,
      text: h.text,
      manuscriptVersionId: h.manuscript_version_id,
      canonVersionAdded: h.canon_version_added,
      relevance: best > 0 ? Math.round((h.rank / best) * 1e6) / 1e6 : 0,
    }));
  }
}

/** Test/fault helper: a retriever that always fails, to exercise the degradation ladder. */
export class FailingRetriever implements LexicalRetriever, VectorRetriever {
  readonly embeddingSetId = 'none';
  constructor(
    readonly name: string,
    private readonly error: Error = new Error(`${name} unavailable`),
  ) {}
  search(): Promise<RetrievedCandidate[]> {
    return Promise.reject(this.error);
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
