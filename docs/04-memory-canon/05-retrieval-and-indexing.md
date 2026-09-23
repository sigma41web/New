# Retrieval and Indexing

## 1. Sources and indexes

| Source (accepted/canonical only) | Index type | Notes |
| --- | --- | --- |
| `facts` | B-tree `(project, entity, attribute, valid_from_ord)`, `(project, timeline, valid_from_ord)`; partial index on `retracted_at_version IS NULL` | authoritative state queries |
| `events` | B-tree `(project, timeline, clock_ord)`, GIN on participants array | temporal & participant queries |
| `knowledge_states` | B-tree `(project, knower, proposition, valid_from_ord)` | ledger queries |
| `relationship_states` | B-tree `(project, from, to, valid_from_ord)` | pair queries |
| `promises` | B-tree `(project, status, due_min, due_max)`, GIN on related_entities | due-window queries |
| `search_documents` | `tsvector` (English full-text: stemming via `english` dictionary; registry names and romanized terms as exact tokens via a project synonym/thesaurus dictionary) GIN; `embedding` HNSW (cosine) per embedding-model table (see §4) | over: L1/L2/L3 summaries, event summaries, evidence quotes (≤ 60 words), proposition statements, entity descriptions |
| `edges` | adjacency `(project, from_kind, from_id, rel, to_kind, to_id)` | graph hops |

Document granularity for `search_documents`: one row per accepted-chapter paragraph, per event, per
evidence quote, per L1 summary, per L2/L3 summary, per non-secret proposition, per entity description version.
Each row carries `story_clock`, `chapter_no`, `entity_ids[]`, `kind`, `importance`, `canon_version_added`,
`manuscript_version_id`, `language` (`en`). Rows citing a manuscript version may cite only an `accepted` one
(BEFORE trigger); de-acceptance deletes the version's rows in the same transaction; indexing is idempotent
per `(project, kind, ref, key)` (`canon.index_accepted_version`, `canon.reindex_project`; ADR-0045).

## 2. Query types

1. **State-at-time** (structured): current facts for entity set at story clock; used for T1. No ranking.
2. **Temporal neighborhood** (structured): events within ±N chapters or the current arc for participants.
3. **Semantic recall** (hybrid): query strings built from the contract (`purpose`, must_happen descriptions,
   proposition statements, promise statements) → BM25 over English tokens + vector kNN → Reciprocal Rank
   Fusion → top 60 → ranker.
4. **Graph expansion**: from top items and contract entities: entity→events (last 5 per pair of
   participants), event→propositions, promise→setup events; capped at 40 items.
5. **Evidence fetch**: for each selected fact/event, load evidence quotes (≤ 60 words trimmed at sentence
   boundaries) from the immutable version.

## 3. Tokenization and names

English full-text search uses PostgreSQL's `english` configuration (stemming, stop words). The project's
**naming and terminology registry** is compiled into a per-project thesaurus so multi-word names ("Kang
Do-yoon", "Vice-Guildmaster Choi") and romanized terms (*murim*, *sunbae*) index as single tokens, and
aliases/short forms expand at query time ("Do-yoon" ↔ "Kang Do-yoon"; "the compass" ↔ "old compass").
Native-script names (if stored) are indexed as aliases for inspector search only, never for manuscript
generation.

**Korean projects (ADR-0058).** Korean attaches particles and endings to the word, so a whitespace/`english`
tokenizer indexes every eojeol whole (레온은, 레온을, 레온의 are three tokens). Korean documents are stored with
`language = 'ko'` (derived from the manuscript version or project) and indexed by a partial `pg_trgm` GIN
index. A Korean query is reduced to stems (one trailing particle or ending removed while two syllables
remain), stems that equal a registry surface expand to the entity's other surfaces, and documents rank by
weighted term hits, then word similarity, then chapter and id. Two-syllable Hangul names are entity-tagged.

## 4. Embeddings (ADR-0035)

Provider-independent embedding role (`embedder`). Because dimension and semantics differ across
providers/models, embeddings are stored **per model** in `embedding_sets { id, project_id, model_id,
provider, dimension, status: building|active|retired }` with a child table per set
(`search_document_embeddings` partitioned by `embedding_set_id`, each partition's `vector(n)` typmod matching
its set's dimension). Exactly one set is `active` per project; retrieval reads
the active set; a model change creates a new set, runs a re-embed job over accepted content (idempotent,
resumable, budgeted), then flips `active` atomically. Old sets are retired after a grace period. Retrieval
tests run against the fixture on every active-set flip.

## 5. Reranking

MVP: deterministic weighted ranker (pack assembly §2.3). Beta: optional cross-encoder reranker (role
`reranker`) over top 60 for T2 when the template enables it; A/B measured by retrieval tests.

## 6. Retrieval tests (fixture-driven)

For the fixture story (`docs/07-quality/02-fixture-story.md`), the suite defines **recall targets**: for a
contract at chapter 41 referencing Mu-jin's permanent limp (established ch.9/ch.14), the pack must include
the ch.9 injury fact + evidence; for the reveal in ch.58, the pack must include the `lie` event from ch.23
and the `believes_false` row. Recall@pack ≥ 0.95 for `core` items; ≥ 0.85 for `major`.

Korean retrieval has its own fixture (`packages/db/src/testdata/ko-retrieval.json`, an original
studio-written serial, 26 query → paragraph pairs); CI asserts recall@5 ≥ 0.95 through the real indexing
path and that the Korean path beats English FTS on the same documents (ADR-0058).

## 7. Failure modes

| Failure | Mitigation |
| --- | --- |
| Alias drift (new nickname not registered) | `EP-NAME-01` unknown name variant → extraction proposes alias → entity linking improves |
| Embedding model outage / no embedder configured | lexical + structured only; manifest `degradation.vector = unavailable | not_configured` (ADR-0045) |
| Lexical store outage | structured only; manifest `degradation.lexical = unavailable | timeout`; T2/T3 lexical candidates omitted |
| Structured canon store outage | no pack (`STRUCTURED_RETRIEVAL_UNAVAILABLE`); generation blocks |
| Index lag after commit | commit tx writes `search_documents` rows synchronously (lexical); embeddings async with `embedding_pending` flag; ranker treats pending rows as lexical-only; a version that leaves `accepted` loses its rows by trigger |
| Huge participant sets (academy ensemble) | T1 degradation ladder: full states for POV + top-4 participants, compact rows for others |
| Embedding model migration mid-project | dual sets; active-set flip only after re-embed completes; recall test gate |
