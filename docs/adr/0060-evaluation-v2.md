# ADR-0060: Evaluation v2 — own inputs, promise and repetition evaluators, parallel runs, rubric-composed gates, targeted re-evaluation

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** product owner
- **Relates to:** ADR-0014 (patch regression), ADR-0029 (calibration), ADR-0041 (Production Policy), ADR-0056
  (Korean craft engine), ADR-0057 (schema-generated shapes), the Step 0 improvement audit (§3, PR #1)

## Context

The Step 0 audit (§3) found five gaps in chapter evaluation:

1. Evaluators read the wrong slices of the checker pack. The knowledge-leak checker received the whole
   canon state as both its knowledge table and its secrets, and the timeline position as its knowledge
   guards. The continuity checker received the timeline position (timeline, locked facts, knowledge guards
   and contract) as its locked facts, so it read that block twice. The voice judge was compiled with the
   prose rubric, and it saw no voice cards and no address terms. The genre judge's terminology report was
   one line of counts.
2. The pipeline's `promise_checker` and `repetition_judge` (generation pipeline §4 step [5]) did not exist.
3. Seven evaluator calls ran one after another.
4. Gates read a 0–100 number the judge chose. The designed composition (`judge_weight` × judge +
   (1 − `judge_weight`) × deterministic composite, drift-detection §2) was never implemented.
5. Every evaluator re-ran after every patch, although drift-detection §4 describes a targeted regression
   check.

## Decision

1. **Every evaluator reads its own inputs.** The checker pack keeps its rendered sections by name
   (`StoredPack.sections`), so an evaluator can read one section. Prompt families @4.4.0 declare new
   variables:
   - `continuity_checker`: `story_position` (active constraints, timeline, contract) and `locked_canon`
     (locked facts only);
   - `knowledge_leak_checker`: `knowledge_stances`, `knowledge_guard_list` and `reader_secrets`
     (PLANNED bible secrets whose earliest reveal chapter is still ahead);
   - `voice_judge`: its own rubric variant `judge_rubric_voice` (register, participants, naming, avoid),
     `voice_cards` and `address_matrix` from the bible's character design, the canon register digests and
     a deterministic dialogue register report;
   - `genre_judge`: `terminology_checks`, a deterministic report of registered names, terminology entries
     written in a non-policy form, and status-window blocks.

   New variables carry new names. Older pinned versions keep receiving exactly the inputs they received.
2. **Two new evaluators.** `promise_checker@4.4.0` checks the contract's planned promise touches
   (`setups`/`payoffs`) against the open promise ledger and reports `touches` and findings.
   `repetition_judge@4.4.0` compares the chapter with up to three earlier *accepted* chapters: their
   openings and endings, plus a deterministic report from `@yeonjae/prose` `repetitionReport` (reused
   four-word runs, reused sentences, opening and ending similarity, repeated sentence openings;
   status windows are skipped). Neither evaluator is style-sensitive. Their answer schemas live in
   `model-output.schema.json`, and their output shapes are generated from those schemas (ADR-0057). Each
   writes its own scorecard section (`promises`, `repetition`). Each gates only through its blocking and
   major findings.
3. **A Production Policy `evaluation` block** carries every number and switch:
   - `max_parallel_evaluators`;
   - `optional_evaluators`;
   - `score_model` (`judge_score` | `rubric_subscores`);
   - `reevaluation` (`full` | `targeted`);
   - `lint_penalty_points`.

   `standard.v2` is `standard.v1` plus this block. The starting values, `standard.v2`, are 4 evaluators at
   a time, both optional evaluators, `rubric_subscores`, `targeted`, and 4/15/40 points for a
   minor/major/blocking deterministic finding. A policy **without** the block keeps the ADR-0056
   behaviour: sequential calls, the seven core evaluators, the judge's own number and full
   re-evaluation, with byte-identical scorecards. A policy that lists an optional evaluator the pinned
   prompt set lacks fails the evaluation closed.
4. **Rubric-composed gates.** Under `rubric_subscores`, a gated dimension scores `judge_weight` × rubric
   score + (1 − `judge_weight`) × deterministic composite. The rubric score is the mean of the judge's
   1–5 sub-scores over the keys its output shape asks for, mapped to 0–100. A missing key counts as 1, so
   a judge cannot raise its score by leaving out a low one. The composites are:
   - prose: 100 minus the policy's points for each deterministic prose or output-language finding;
   - structure: the same, for deterministic structure findings;
   - genre: terminology compliance × 100;
   - voice: (1 − dialogue register violation rate) × 100.

   The judge's own `judge_score` is still recorded. Each section records `score_model`, `rubric_score`,
   `judge_weight` and its composite.
5. **Parallel evaluation.** At most `max_parallel_evaluators` evaluator calls run at once. Findings enter
   the scorecard in the fixed ADR-0056 order, whatever order the calls finish in. After the first failure
   no new call starts, the calls already running are awaited, and the step fails. Retrying the step then
   reuses the completed calls through their idempotency keys.
6. **Targeted re-evaluation** (drift-detection §4) applies after a patch under `reevaluation: targeted`.
   The deterministic checks and the targeted dimension's evaluator always re-run. Continuity and
   knowledge re-run when the patch declared changed claims or rewrote a scene. The contract checker
   re-runs when claims changed or a criterion was failing. Any other evaluator re-runs when one of its
   carried findings no longer anchors in the patched text (a quoted finding moves with its quote; an
   unquoted one needs its paragraphs unchanged) or when its section is missing. Once
   `revision.smoke_after_patches` patches have accumulated since the last full run, every evaluator
   re-runs. A carried section records `carried_from`. The ADR-0014 regression check still compares full
   scorecards.
7. **Who gets v2.** `standard.v2` is opt-in: `createProject({ policyVersion })` or `project:create
   --policy=policy/standard@2`. New projects keep `standard.v1` for now, because the composed scores and
   the new evaluators are uncalibrated (ADR-0029). The default should move after a live Korean run.

## Alternatives considered

- Folding the input fixes into the existing prompt versions. Rejected: a pinned version must render
  exactly as it did.
- Deterministic repetition findings as gating issues. Rejected for now: refrains, catchphrases and
  status windows repeat by design. The report is evidence, and the judge decides.
- Carrying style judges forward while re-running nothing else. Rejected: canon correctness outranks cost,
  so continuity and knowledge re-run whenever the patch changes a claim.
- Rubric weights from the tradition profile. Deferred: the profile rubric names Korean dimensions that do
  not map one-to-one onto the judges' output keys. Equal weights over the output keys are deterministic
  and auditable until calibration (Workstream 8).

## Consequences

- Projects on `standard.v1`, and every replay pinned to it, produce the same scorecards and the same
  approvals as before. The contrast baseline was re-pinned to `genre_judge@4.4.0` and `voice_judge@4.4.0`
  with all 2,000 entries identical.
- A `standard.v2` chapter with nothing to fix costs two more evaluator calls. With four calls in flight,
  its evaluation time tends toward that of its slowest calls instead of their sum; this has not been
  measured against a live provider. A claim-neutral revision round re-runs one model evaluator instead of
  nine.
- Thresholds, weights and penalty points remain starting values, uncalibrated until the contrast-set
  calibration round.
