# ADR-0061: Long-story memory — story-so-far digest, first meetings, overdue promises, arc chaining from the accepted ending, series audit

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** product owner
- **Relates to:** ADR-0010 (tiered packs), ADR-0012 (rolling-horizon planning), ADR-0060 (promise checker),
  the Step 0 improvement audit (§4, PR #1)

## Context

A 200-chapter serial fails on what the model cannot see. The Step 0 audit (§4) found these gaps:

- the writer saw chapter k−1, at most twelve recent events, lexical retrieval and only those promises that
  shared a participant or had a due window near k, so an **overdue** promise sharing no participant was
  invisible (§4.0, §4.5);
- only an L1 summary write path existed (§4.1);
- there was no first-meeting ledger, although readers catch a character greeting a stranger by name at
  once (§4.3; the first live chapter of ADR-0056 had this defect);
- the next arc chained from the previous arc's *planned* exit (§4.6);
- no audit looked across the whole serial (§4.7).

## Decision

1. **Overdue promises are always visible.** `promisesForChapter` also returns every open or advanced
   promise whose `due_max_chapter` is before chapter k. Its pack line says how many chapters it is overdue
   (`회수 기한 N화 초과`), and it ranks as most urgent. The chapter planner, writer and checker all see it,
   and so does the promise checker (ADR-0060), which treats a promise past its window as major.
2. **Story so far.** A new `story_so_far` section (T2) in the writer, chapter planner and continuity
   checker packs. It holds the L1 summaries of every accepted chapter before k−1, in blocks of ten
   chapters, with the newest block ranked first so the budget sheds the oldest. It is a deterministic
   digest of accepted summaries. Model-written L2/L3 summaries (the design's `summarizer_l2`) are
   deferred: the digest needs no new model call, no new table state and no migration, and every pack
   snapshot records exactly what the writer saw.
3. **First meetings.** A new `first_meetings` section (T1) in the same three packs. For each pair of
   on-page participants it gives the first accepted chapter in which both took part in a canonical,
   unretracted event, or says they have not met. A pair with a canon relationship (known before the story)
   is marked as related instead. It is derived from canon events at fetch time.
4. **Arcs chain from the accepted ending.** The next arc's brief carries the previous arc's planned exit
   together with the last accepted chapter's L1 summary and ending hook, and states that the accepted text
   wins where they differ.
5. **Series audit.** `auditSeries` and the `series:audit` CLI command produce a deterministic report over accepted
   canon:
   - overdue promises;
   - characters absent from canonical events for more than a threshold (report parameter, default 20
     chapters);
   - canonical story time that moves backwards between chapters;
   - chapter openings whose first 200 characters read like the previous chapter's (two-word Jaccard at or
     above a threshold, default 0.5).

   It blocks nothing, and its thresholds are report parameters, not gates.
6. The three changed pack templates move to `1.1.0`. Checkpointed packs replay as stored.

## Alternatives considered

- Model-written L2 arc summaries at arc end. Deferred: they add a model call per arc and a write path whose
  scope (arc boundaries are estimates until an arc is planned) is not settled. The deterministic digest
  gives the writer the same facts in the accepted L1 wording.
- A stored first-meeting ledger table. Rejected: the ledger is a pure function of accepted canon events,
  and computing it at fetch time cannot drift from canon.
- Gating chapters on the audit. Rejected: whether an absent character or a repeated opening is a flaw is
  an authorial call.

## Consequences

- The 120-chapter replay ran with the story-so-far and first-meeting sections. Chapter 120's writer pack
  carries all twelve blocks (chapters 1–118) within its budget.
- Pack content changes for new jobs in every language. Replays are keyed by activity, so their outcomes
  are unchanged.
- On the synthetic 120-chapter fixture, the audit flags that all 119 chapter openings after the first
  repeat the fixture's template opening. On real prose that is the 매 화 같은 도입 problem it exists to
  catch.
- Not done: the retcon flow (edit an accepted chapter, then re-extract and list the dependent chapters)
  and model-written L2–L4 summaries.
