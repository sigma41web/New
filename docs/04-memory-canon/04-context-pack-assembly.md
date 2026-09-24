# Context Pack Assembly

## 1. Definition

A **Context Pack** is the complete, versioned, manifested input bundle for one LLM call, assembled by
`packages/context` from a **pack template** (per role) against a pinned `(canon_version, spec_version,
bible_version, narrative_identity_version, template_version)` and a token budget. It is:

- **Deterministic**: same inputs → same bytes → same `pack_hash`.
- **Tiered**: T0 mandatory, T1 critical, T2 relevant, T3 optional (ADR-0010).
- **Manifested**: a JSON manifest lists every included item (kind, id, version, tokens, tier, rank score,
  compression applied, **materiality**) and every dropped item with reason.
- **Validated**: T0 items are re-found byte-for-byte in the rendered prompt; the Active Constraint Set hash
  matches; the Narrative Identity Block hash matches and both contract hashes are present; the previous
  chapter's tail hash matches the accepted version.
- **Cached**: rendered sections cached by content hash; provider prompt caching exploited by ordering
  stable sections first.

Schema: `schemas/context-pack-manifest.schema.json`.

## 2. Pipeline

```
ContractOrTask ─► Query Plan ─► Fetch (structured, lexical, vector, graph) ─► Candidate items
   ─► Rank (per tier rules) ─► Compress (approved compressors) ─► Fit to budget (tier policy)
   ─► Render (role template, section order) ─► Validate ─► Manifest + hash ─► Store ─► Call
```

### 2.1 Query plan derivation (from the chapter contract)
- Entities: participants, mentioned_only, locations, items in state_deltas, abilities in progression.
- Propositions: knowledge_deltas, knowledge_guards, secrets owned by participants.
- Promises: setups/payoffs + all `open` promises whose `due_window` intersects this chapter ±3 or whose
  `related_entities` intersect participants.
- Time: story_time window → events within the arc; last known states before `story_time.start`.
- Keywords: English noun phrases from contract text (lightweight NP chunker) plus registry names/terms for
  lexical search.
- Prior arcs: arcs whose participants intersect ≥ 2 contract participants → L2 summaries.

### 2.2 Fetch (see `05-retrieval-and-indexing.md`)
Structured queries produce **authoritative state** (current facts, knowledge, relationships incl. register).
Lexical and vector retrieval produce **relevance candidates** (older events, evidence, summaries). Graph hops
expand: entity → events (last 5 involving each participant pair) → propositions → promises.

### 2.3 Ranking (T2 only)
`score = w_r * relevance(bm25/vector fused via RRF) + w_e * entity_overlap + w_t * temporal_proximity +
w_i * importance + w_p * promise_link + w_c * contract_keyword_hit`; weights per template version; ties by
recency. Items already implied by T1 are deduplicated by ID. Diversity: at most 3 items per
(entity, attribute) key; at most 40% of T2 tokens from one source kind.

### 2.4 Compression (approved compressors only)
| Item kind | Compressor | Notes |
| --- | --- | --- |
| Active Constraint Set | pre-compiled at contract time (ADR-0033): scope-filtered, deduplicated, grouped by category, stable IDs, ≤ budget | never re-derived at pack time |
| Facts/states | table renderer (`character · attribute · value · valid (chapters) · evidence`) | lossless on values |
| Knowledge | stance table | lossless |
| Relationships | pair table with register summary (formality/familiarity/deference), address terms, titles | lossless |
| Events | one-line `ch.N [frame] summary` | from stored `summary`; no LLM at pack time |
| Previous chapter | verbatim tail (never compressed) + stored L1 summary | tail length = `policy.context.previous_tail_words` (starting value 400, sentence-aligned; ADR-0041) |
| L2/L3 summaries | stored tiers; choose lowest tier that fits | never generated at pack time |
| Evidence spans | quote trimmed to ≤ 60 words around the fact | boundaries at sentence edges |
| Narrative Identity Block | compiler with role budget | never truncated (compile error instead) |
No LLM call is made during assembly (determinism, cost); all summaries are precomputed at commit time.

### 2.5 Budget fitting
Budget per role comes from the pinned Production Policy: `policy.context.writer_input_budget_tokens` for
`pack.scene_writer` and `policy.context.input_budget_tokens.<template>` for the other templates (starting
values, `standard.v1`: writer 24k; chapter_planner 14k; continuity_checker 20k; extractor 18k). T0 first (must fit or `PACK_T0_OVERFLOW`
error → operator must raise budget/model), T1 next (compress via cheaper renderers; if still over, error
`PACK_T1_OVERFLOW` — never drop silently; the template may define a T1 **degradation ladder**, e.g., previous
chapter tail `previous_tail_words` → `previous_tail_floor_words` (starting values 400 → 250), knowledge table limited to contract propositions + secrets only, full states
for POV + top-4 participants and compact rows for others), T2 fill by rank, T3 if room. Token counting uses
the target model's tokenizer when available, else a calibrated English estimator (words × 1.3 ± margin);
the manifest records both counts and the estimator used.

**Why T0 cannot grow unboundedly (ADR-0033):** hard requirements are never rendered as the raw
requirement list. `PlanningHorizonWorkflow` compiles, per chapter, an **Active Constraint Set**: requirements
whose scope covers this chapter (series-wide, this season/arc, this chapter range, these participants), with
duplicates merged, superseded items dropped, content restrictions folded into one block, and each constraint
carrying its stable requirement ID. Its size is bounded by `policy.context.active_constraints_cap_tokens` (starting value 1,200); if a
project's in-scope constraints exceed the cap, the workflow raises `CONSTRAINTS_OVERFLOW` and asks the user
to consolidate (the UI offers merge suggestions) rather than trimming silently.

### 2.6 Rendering
Section order (writer pack) — chosen to maximize provider prefix caching and recency of the most
constraining content:
1. System preamble (role, output schema)
2. `<<NARRATIVE_IDENTITY>>` block (stable per project; begins with the Output-Language Contract and the
   Narrative-Tradition Contract)
3. Active Constraint Set (stable per arc)
4. L4 series summary (stable-ish)
5. Bible slice: participants (identity + register digest + voice notes), locations, naming/terminology
   registry slice
6. Arc plan + minor arc beats
7. Canon state tables: participant states, knowledge, relationships (register), promises due, timeline
   position
8. Retrieved older canon (T2), each with `ch.N` and evidence quote
9. Previous chapter: L1 summary, then **verbatim tail**, then ending hook
10. Chapter Contract (full) + scene plan (for writer: the current scene highlighted; previous drafted scenes
    of this chapter included verbatim — job-scoped exception to the accepted-only rule)
11. Task instruction + `IDENTITY_TAIL` + output schema reminder

Untrusted text (imported feedback/documents) never appears in writer packs; where used (planner soft
signals) it is wrapped `<<UNTRUSTED>>…<<END UNTRUSTED>>` with a data-role label and never rendered in the
system position.

Every rendered line carries a provenance tag `[LABEL · source:ref@version]` where LABEL ∈ HARD, SOFT,
ASSUMPTION, FACT, EVENT, KNOWLEDGE, RELATIONSHIP, PROMISE, ACCEPTED (manuscript excerpt), SUMMARY, PLANNED,
UNTRUSTED, IDENTITY, CONTRACT, TIMELINE, EVIDENCE, REGISTRY, DRAFT (job-scoped text under evaluation); the
manifest stores the same `source` and `provenance` per item. Plan material (the contract, arc slots,
hypotheses) is rendered under PLANNED headings in the conditional mood and is never emitted as a FACT or
EVENT line.

### 2.7 Validation (pre-call)
- All T0 item IDs present; Active Constraint Set bytes equal the compiled artifact for this contract.
- Narrative Identity Block hash equals compiled hash; header present; **both** contract hashes present in
  the manifest (the Guard re-checks at the gateway).
- Previous chapter tail hash equals the slice hash derived from the accepted version.
- No item from disallowed sources (quarantine tables, non-accepted versions except current job scenes,
  plan items outside the `[PLANNED]` section).
- Manifest token totals ≤ budget.
Failures raise before the call; the job retries assembly once with the degradation ladder, then
`needs_attention`.

### 2.8 Dependency edges from packs (ADR-0032)
When a pack is stored, the assembler writes dependency edges for every canon item it included:
T0/T1 items and contract anchors → `material`; T2/T3 items → `contextual`. After the chapter is accepted,
`CanonCommitWorkflow` **promotes** contextual edges to material where the writer's `claims[]` or the
extractor's evidence reference the item (entity + attribute match within the claim span). Only material
edges drive staleness.

## 3. Templates (MVP set)

| Template | Role(s) | T0 | T1 | T2 | Budget (Standard) |
| --- | --- | --- | --- | --- | --- |
| `pack.requirements` | requirement_interpreter | intake form + free text (user role, injection-screened; any input language) | — | — | 6k |
| `pack.concept` | concept_generator/merger | Active Constraint Set (series scope), planner block, angle seed | — | — | 8k |
| `pack.compare` | concept_comparator, chapter_comparator | both candidates (+ scorecards for chapters), contract or spec | — | — | 20k |
| `pack.bible` | bible specialists, bible_consistency_checker | spec, concept, planner block, previously produced bible sections | — | — | 14k |
| `pack.series_architect` | series_architect | Active Constraint Set, planner block, concept | — | — | 8k |
| `pack.arc_planner` | arc_planner | Active Constraint Set, planner block, blueprint, season | prior arc L2s, promise ledger (open), protagonist state & progression, cast summary | events of last arc | 14k |
| `pack.chapter_planner` | chapter_planner | Active Constraint Set, planner block, arc plan, contract slot | previous chapter L1 + hook, states/knowledge/relationships for arc participants, promises due, cadence stats last 10 chapters | related older events | 14k |
| `pack.scene_planner` | scene_planner | contract, planner block | previous chapter tail (short), states/knowledge for participants, speaker pairs with register | — | 10k |
| `pack.scene_writer` | scene_writer, scene_rewriter | as §2.6 | as §2.6 | as §2.6 | 24k (input) |
| `pack.line_editor` | line_editor, chapter_assembler | editor block, contract shape fields, registry slice | chapter text (full), register digests | — | 16k |
| `pack.reviser` | prose/structure/dialogue/continuity revisers, retcon_patcher | editor block, span ± context, issues, must-preserve facts | register digests for speakers in span; scene plan for structure scope | — | 6k |
| `pack.continuity_checker` | continuity_checker, contract_compliance_judge | chapter text (paragraph IDs), contract, states/knowledge/relationships/timeline for participants (with evidence quotes), locked facts | retrieved older events/facts by contract entities | — | 20k |
| `pack.knowledge_leak_checker` | knowledge_leak_checker | chapter text, knowledge table, guards, secrets | — | — | 14k |
| `pack.prose_judge` | prose_judge | `judge_rubric_prose` block, chapter text, prose lint report | — | — | 12k |
| `pack.structure_judge` | structure_judge | `judge_rubric_structure` block, chapter text, structure lint report, contract shape fields | — | — | 12k |
| `pack.genre_judge` | genre_judge | `judge_rubric_genre` block, chapter text, terminology compliance report | — | — | 10k |
| `pack.voice_judge` | voice_judge | `judge_rubric_prose` (register section), chapter utterances with speaker annotations, register digests, register check report | voice exemplars (≤ 3 per participant) | — | 10k |
| `pack.repetition` | repetition_judge | current L1 (pre-pass) or arc plan; last 10 L1s; current/prior arc L2s | — | — | 8k |
| `pack.promise` | promise_checker | contract setups/payoffs; promise ledger slice; extraction pre-pass | — | — | 6k |
| `pack.extractor` | extractor_a/b | chapter text, registry (entities, names, terms), contract hypotheses (labelled), pre-pass annotations | — | — | 18k |
| `pack.adjudicator` | extraction_adjudicator | conflicting items, spans ± context | — | — | 6k |
| `pack.summarizer` | summarizer_l1/l2/l3/l4 | summarizer_min block, text or child summaries, registry | — | — | 12k |

## 4. The previous chapter (special treatment)

For chapter k the pack contains, from chapter k−1's **accepted** version only: (a) L1 summary (≤
`policy.context.l1_summary_max_words`, starting value 120), (b) the **last `policy.context.previous_tail_words`
words verbatim** (starting value 400; sentence-aligned; extended backward to the start of the last scene if
that scene is shorter than `previous_tail_extend_to_scene_below_words`, starting value 600), (c) the recorded
`ending_hook`, (d) the state/knowledge/relationship deltas and promise transitions committed from k−1 (so
"what just changed" is explicit), (e) the current relevant facts at the start of chapter k (participants'
states as of `story_time.start`), (f) elapsed story time between k−1 end and k start from the contract. If chapter k−1 is not accepted, chapter k cannot start (FR-7.13). For k=1, (b)
is replaced by the concept's chapter-one hook plan.

### 4.1 Long-story memory (ADR-0061)

Chapter k−1 is not the only memory. Beyond it:

- **Story so far** (`story_so_far`, T2; writer, chapter planner, continuity checker). The L1 summaries of
  every accepted chapter before k−1, in blocks of ten chapters, one item per block. The newest block ranks
  first, so a tight budget sheds the oldest. The digest is deterministic: accepted summaries only, never a
  model call and never a draft.
- **First meetings** (`first_meetings`, T1; same templates). For each pair of on-page participants, this
  gives the accepted chapter in which both first took part in a canonical event, or states that they
  never have. Pairs related from before the story are marked as related. A pair that has not met must not
  know each other's names before an introduction.
- **Overdue promises.** An open promise past the end of its due window is always in the promise section,
  whoever is on page. Its line states the number of chapters it is overdue, and it ranks as most urgent.
- **Arc chaining.** The brief for the next arc carries the previous arc's planned exit together with how
  the last accepted chapter actually ended (its L1 summary and ending hook). The accepted text wins where
  they differ.
- **Series audit.** `series:audit` is a deterministic whole-serial report, and it blocks nothing. It
  lists overdue promises, characters absent from canonical events past a threshold, canonical story time
  that moves backwards between chapters, and openings that read like the previous chapter's opening.

## 5. Caching and deduplication

- Section-level cache keyed by content hash (identity block, Active Constraint Set, bible slice, L4
  summary).
- Provider prompt caching: stable sections first; the manifest records `cache_prefix_hash`.
- Cross-call dedup within a chapter job: scene-writer calls for scenes 2..n reuse identical sections 1–8;
  only sections 9–11 change. Evaluators reuse chapter text as a shared cached section where the provider
  supports it.

## 6. Versioning

Template versions are immutable; changing weights, sections, or degradation ladders creates a new version
and runs the retrieval regression tests. Every call records `pack_id`, `pack_hash`, `template_version`.

## 7. Failure handling

| Failure | Handling |
| --- | --- |
| Retrieval store timeout | retry ×2; fall back to structured-only T2 (manifest `degradation.lexical = timeout`; evaluators run with full pack later so misses are caught) |
| Embedding service down / not configured | lexical + structured only; manifest `degradation.vector = unavailable | not_configured` (ADR-0045) |
| Structured (authoritative) canon query fails | `STRUCTURED_RETRIEVAL_UNAVAILABLE` — no pack, no call; never degraded |
| T0 overflow | `PACK_T0_OVERFLOW` → job `needs_attention` with actionable message (contract too long; constraints over cap → consolidate) |
| T1 overflow after the ladder | `PACK_T1_OVERFLOW` — T1 is never dropped silently |
| Missing previous chapter acceptance | `PREVIOUS_CHAPTER_NOT_ACCEPTED`; job waits (Temporal signal) or fails fast per batch policy; a draft is never substituted |
| Prohibited source reaches a mandatory slot | `PROHIBITED_SOURCE` (quarantined/rejected/working manuscript, untrusted text, another project) |
