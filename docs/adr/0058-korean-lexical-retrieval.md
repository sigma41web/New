# ADR-0058: Korean lexical retrieval with pg_trgm and particle-stripped stems

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** product owner
- **Relates to:** ADR-0011 (hybrid retrieval), ADR-0045 (retrieval implementation), ADR-0054 §5 (storage
  follows the manuscript), ADR-0035 (embedding migrations), the Step 0 improvement audit (§2.1–2.3, §2.7)

## Context

The lexical retriever used PostgreSQL's `english` text-search configuration on both sides
(`to_tsvector('english', text)`, `websearch_to_tsquery('english', …)`). Korean attaches particles and
endings to the word, so each eojeol became its own token: on PostgreSQL 16.14,
`to_tsvector('english','레온은 검을 들었다.') @@ websearch_to_tsquery('english','레온')` is false. Three
storage defects compounded it: no Korean row was ever stored as Korean (`projects.output_language`,
`manuscript_versions.language`, `summaries.language` and `search_documents.language` all kept their `'en'`
default, contrary to ADR-0054 §5); entity tagging (`canon.entities_mentioned`) ignored names shorter than
three characters, which excludes most Korean given names (레온, 이안, 서하); and the query plan dropped every
two-character word before it reached the retriever.

## Decision

1. **pg_trgm backs Korean search.** Candidates evaluated against the project's PostgreSQL 16 setup:
   - `pg_trgm` — contrib, shipped with every PostgreSQL 16 distribution, the CI `postgres:16` image and the
     local cluster; trusted extension (installable without superuser). Trigrams over Hangul syllables work
     in `C.UTF-8` and `en_US.UTF-8` databases. Two-syllable terms cannot use the trigram index for
     `LIKE '%xy%'` and fall back to a filtered scan, which is acceptable at one project's scale
     (a 200-화 novel is ~20k paragraph documents).
   - `pg_bigm` — bigrams suit two-syllable Korean words better, but it is not in the CI image or the local
     cluster and managed PostgreSQL offerings rarely ship it.
   - PGroonga — strongest Korean search, but an external extension with its own index engine; not
     installable in the CI image or on common managed PostgreSQL.
   Chosen: `pg_trgm`, with a partial GIN index `search_documents_text_trgm_idx` on Korean documents only.
2. **Query normalization in the application.** `koreanQueryTerms` reduces each query word by one trailing
   particle or common ending (longest first, at least two syllables kept: 레온은 → 레온, 최고 stays), drops a
   few query-phrasing words, and matches stems as substrings. Stems that equal a registry surface expand to
   the entity's other surfaces (display name, short forms, aliases) at weight 0.8. Rank = weighted term
   hits, then `word_similarity`, then chapter and id (total order, replay-stable). No morphological
   analyzer runs; the rules are deterministic.
3. **Storage follows the manuscript (fixes ADR-0054 §5).** Composing the identity from the intake sets
   `projects.output_language`; manuscript versions and L1 summaries take the project's language; a trigger
   derives each search document's language from its manuscript version or project. Migration 0021
   backfills projects whose pinned identity is Korean, their summaries and search documents (manuscript
   versions are immutable and keep their stored value; the trigger reads the project as well).
4. **Two-syllable Hangul names are tagged.** `canon.entities_mentioned` accepts a two-syllable Hangul
   surface; Latin surfaces still need three characters. The query plan keeps two-syllable Hangul words.
5. **English is unchanged.** `en` projects keep the tsvector path, `postgres_fts_english`, and every
   recorded English replay. The Korean retriever reports `postgres_trgm_korean`.
6. **Vector retrieval stays off for Korean.** A real multilingual embedding provider cannot be measured
   without credentials, and the lexical path already reaches recall@5 = 1.00 on the fixture, which
   therefore cannot show a vector gain. Hybrid mode for `ko` waits for a paraphrase-heavy fixture and a
   measured improvement (ADR-0011, ADR-0035).

## Measured

Fixture `packages/db/src/testdata/ko-retrieval.json`: an original studio-written serial (8 chapters, 48
paragraphs) with 26 query → expected paragraph pairs whose wording differs from the text in particles,
endings and aliases. recall@5 on the prototype and in CI: English FTS over the same Korean documents
**0.77 (20/26)**; Korean path **1.00 (26/26)**.

## Alternatives considered

- A Korean text-search configuration built from a dictionary (e.g. a morphological tokenizer) — rejected:
  it needs a native extension or dictionary files outside the CI image, and ADR-0028 keeps Korean
  morphology out of the pipeline.
- Keep English FTS and add stems as OR terms — rejected: the index still holds whole eojeol, so a stem
  never matches an inflected form.

## Consequences

- Migration 0021 (`pg_trgm`, the language trigger, the partial trigram index, the entity-tagging fix and
  the backfills). `lexicalSearch` takes `language`; `PgLexicalRetriever` takes the project language.
- Korean packs retrieve different (relevant) T2 items and record `postgres_trgm_korean`; English packs are
  byte-identical.
- Follow-ups: an embedding provider adapter and a paraphrase fixture for WS2.7; Korean token estimation and
  character-based context budgets (WS2.4–2.5).
