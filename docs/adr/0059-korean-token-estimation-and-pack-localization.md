# ADR-0059: Korean token estimation and a fully Korean canon rendering

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** product owner
- **Relates to:** ADR-0010 (tiered packs), ADR-0018 (hard budgets), ADR-0034 (length model), ADR-0055
  (KO-PROMPT-SURFACE-001), the Step 0 improvement audit (§2.4–2.6, PR #1)

## Context

Context-pack budgets are measured by `english_estimator_v1` (1.3 tokens per whitespace word). Korean has
about one eojeol per 3–4 자, so the estimate undercounts Korean. Measured on 4,091자 of Korean webnovel prose
(the retrieval fixture and the studio exemplars): `o200k_base` 0.70 tokens/자 (2,882 tokens), `cl100k_base`
1.08 tokens/자 (4,435 tokens); the English estimator predicted 1,340 — 2.2× and 3.3× too few. A Korean
writer pack "within" its 24,000-token budget could therefore be two to three times larger in real tokens.

Korean packs also still carried English canon renderings: event lines (`ch.`, ` at `, English clock labels),
committed-delta lines (`Committed from chapter …`, `register:`, `promise`, `entity`, `alias`, `is … on
timeline`), the ` — CONTINUITY ANCHOR` marker, knowledge extras (`believes:`, `certainty`, ` by …`) inside
the Korean branch, the TIMELINE POSITION section and the soft-preference suffixes.

## Decision

1. **`korean_chars_v1`.** A Korean pack is measured at one token per 자 (characters with spaces, without
   line breaks — the platform's own length unit). It sits between the two calibrated tokenizers, closer to
   the conservative one, so a budget is never exceeded several-fold again. The estimator is selected by
   the pack's manuscript language and recorded in `token_counts.estimator`; English packs keep
   `english_estimator_v1` and their bytes. The Active Constraint Set cap uses the same selection.
2. **Budgets re-checked for Korean.** The policy budgets stay the same numbers, now in estimated real tokens
   for Korean: `writer_input_budget_tokens` (starting value, `standard.v1`) holds a 5,500자 contract-scale
   brief, the identity block, the previous chapter's tail and T1 canon with room for T2; checker and
   extractor budgets hold a full 5,500자 chapter plus canon. T2 retrieval is shed first when a Korean pack
   is large — before this change it was never shed because the pack was undercounted.
3. **Every canon rendering has a Korean form.** Packs without an identity block (checker, extractor) take
   their language from the project, so their section titles are Korean too. Event lines, committed-delta
   lines (including the `N화에서 확정 (정사 vX)` prefix), the continuity anchor, knowledge extras, the
   timeline section and the soft-preference suffixes render in Korean for Korean packs. Schema identifiers
   (item type/op, frames, stances, event types), ids and provenance tags stay as identifiers (ADR-0055).
4. **A test scans every model call.** The Korean end-to-end run scans the system and user prompt of every
   model call for Latin-script words; only schema keys and enum values, snake_case identifiers and the
   provenance/identity tags are allowed. Any English rendering or instruction fails CI.
5. **Lengths.** Scene drafts record `characters` (자) and a language-neutral `language_confidence`
   (`english_confidence` stays, deprecated, for checkpoints written earlier). The chapter length gate
   already counts 자 for Korean (contract unit `characters`). The previous-chapter tail and the reviser's
   span budget stay in whitespace units, which for Korean are 어절 and are labelled as such in the prompts.

## Alternatives considered

- A new policy version with Korean budgets — deferred: the numbers do not need to change once they are
  measured correctly; a Korean policy version belongs with character-denominated tail sizes.
- Per-model tokenizers in the estimator — rejected for now: the gateway may route one pack to several
  model families; the estimator must be deterministic and model-independent to keep pack hashes stable.
- Moving the identity-block compiler to the Korean estimator in the same change — deferred: it would shed
  Korean exemplar sections at the current identity budget; it lands with the exemplar priority change
  (Workstream 5.1).

## Consequences

- Korean packs built after this change record `korean_chars_v1`; checkpointed packs replay unchanged.
  English packs, manifests and replays are byte-identical.
- Re-measured on the Korean end-to-end run: writer packs 12,105 and 14,116 of 24,000 estimated tokens,
  checker packs 6,003 and 7,990 of 20,000, extractor packs 4,945 and 5,096 of 18,000 — every Korean pack
  still fits its unchanged budget with nothing shed. A Korean pack that outgrows its budget now sheds T2
  first, as the budget rules intend; before this change the undercount hid the overflow.
- Korean packs contain no English labels; `novel-ko.integration.test.ts` enforces it for every call.
