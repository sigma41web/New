# ADR-0062: Prose quality for Korean manuscripts — exemplars outrank setting in a truly measured identity block; spelling, ending-monotony and misspelled-name lint

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** product owner
- **Relates to:** ADR-0025 (studio exemplars), ADR-0029 (calibration), ADR-0056 (Korean craft engine and style
  lint), the WS2b Korean token estimator (`korean_chars_v1`, PR #4), the Step 0 improvement audit (§5, PR #1)

## Context

The Step 0 audit (§5) found three gaps in the prose quality of Korean manuscripts:

- **Exemplars were shed early (5.1).** The Narrative Identity Block ranked the studio exemplars at priority
  50, below cadence and genres. It measured Korean with the English word estimator, which undercounted a
  Korean block two- to threefold (WS2b, PR #4). WS2b deferred moving the block to the Korean estimator,
  because at the old priority that move would have shed exemplars first.
- **The lint had gaps (5.5, 5.6, 5.8).** It had no spelling check, although readers flag 낮설다, 몇일 and
  금새 at once. Nothing caught narration that closes sentence after sentence on the same two syllables.
  Nothing caught a misspelled character name (서지얀 for 서지안). The dialogue share also counted only
  “…”; ‘…’ is 속마음, and the contract tracks it separately as monologue density.

Measured on Korean identities composed from intake: writer blocks are 5,185–6,653자
(hunter-gate, regression, academy).

## Decision

1. **Korean blocks are measured in 자.** `estimateTokensKo`, one token per 자 without line breaks
   (`korean_chars_v1`, the WS2b pack estimator), budgets every Korean identity block. English blocks keep the word
   estimator and their bytes.
2. **Exemplars outrank setting.** The exemplars section moves from priority 50 to 86: above register,
   naming, terminology, avoid, genres and cadence, and below structure and the participants' voice cards.
   It exists only for Korean identities.
3. **Korean writer and editor packs give the block 35% of the pack budget instead of 25%.** A block
   measured in 자 counts about 1.4× its real tokens (o200k 0.70 tokens/자), so this keeps the same room in
   real tokens. At the writer's 24,000 budget (starting value, `standard.v1`), the three measured blocks
   fit whole (8,400) and keep their exemplars. At 6,000 they would have dropped cadence and setting,
   or genres.
4. **`lang/ko@4`** is `lang/ko@3` plus:
   - twenty-two common misspellings as `forbidden_patterns` of the new category `spelling`. Each is a minor
     `맞춤법` finding whose note names the correction;
   - thresholds for two new rules, both starting values:
     - **KO-END-02**: a run of at least 5 narration sentences that close on the same two syllables is
       minor; at least 9 is major;
     - **KO-NAME-01**: a word one syllable away from a registered *character* name (the first syllable must
       match; particles are ignored) is minor per distinct misspelling; at 4 distinct ones they turn
       major.

   The new rules run only when the language layer carries their thresholds, so a project pinned to
   `lang/ko@3` lints exactly as before. Intake selects the latest Korean layer, so new projects get
   `@4`. Places and items are left out of KO-NAME-01 because their names share syllables with common nouns.
5. The lint reports `monologue_ratio` (the ‘…’ share) next to the dialogue share.

## Alternatives considered

- A general Korean spelling and spacing checker. It is not available as a vetted dependency. A curated list
  of the errors readers flag, versioned in the language layer, is deterministic and reviewable, and it
  can grow.
- Keeping the English estimator for the identity block only. Rejected: the block would stay undercounted
  while the pack around it is measured in 자 (WS2b).
- Making KO-END-02 and KO-NAME-01 part of `@3`. Rejected: a pinned layer lints as it did.

## Consequences

- Korean identity blocks now report their real size in 자. A new Korean project's lint also reports
  misspellings, monotonous endings and misspelled names as prose findings. The findings carry quotes and
  paragraph ids, so the targeted reviser can fix them.
- English identities, English packs and every replay pinned to `@3` are unchanged.
- Not done:
  - user style samples (5.2), which land with the intake changes of Workstream 6;
  - a polish pass (5.4);
  - best-of-N chapter candidates (5.9);
  - continuation and trim (5.11);
  - Korean export headings (5.12);
  - prompt-rule restructuring (5.14, Workstream 9).
