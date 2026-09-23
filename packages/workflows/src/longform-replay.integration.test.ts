/**
 * B-4-1 (deterministic portion): a compressed 120-chapter continuity/replay validation of the real
 * chapter-production loop on Postgres 16, with no credentials and no live provider call.
 *
 * WHAT THIS IS. Exactly 120 sequential chapters are produced to acceptance in ONE project, through the
 * SAME `produceChapter` the CLI and the worker run: real migrations, real context packs, real deterministic
 * checks, all six replayed evaluators, the real approval lock, the real extraction, the real atomic
 * acceptance commit, the real L1 summary, the real accepted-only index and the real dependency edges.
 * Only the model responses are replaced, by the generated deterministic seed in `longform-fixture.ts`.
 *
 * WHAT THIS IS NOT. It is not the live 20-chapter × five-night validation B-4-1 also requires. No live
 * model is called here, nothing is calibrated here, and a green run of this suite is evidence about
 * determinism, continuity and idempotency only — never about live model quality.
 *
 * WHY 120 AND NOT "A LOOP". B-6-1 already proves 1 → 2 → 3. Three chapters cannot distinguish a working
 * long-range memory from a working one-step memory. The seed therefore carries state that only survives
 * 120 correct links: a porter-share fact superseded five times across the run, each supersede citing the
 * canon id the previous one created; three promises opened in chapter 1 and paid at chapters 3, 60 and
 * 120; a relationship state changed at chapter 2 and again at 119. Chapter 120 cannot pay a chapter-1
 * promise unless all 119 chapters before it committed correctly.
 *
 * DIAGNOSTICS. Every assertion that can fail per chapter reports through `where()`, which names the
 * chapter, the workflow step, the canon version and the invariant. Manuscript prose, prompts and
 * credentials are never logged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptedChapter,
  acceptedCorpus,
  createManuscriptVersion,
  dependencyEdgesFor,
  getManuscriptVersion,
  getProject,
  listCommits,
  migrate,
  quarantineContains,
  quarantineVersion,
  resetDatabase,
  searchDocumentsContaining,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { checkOutputLanguage, toNfcText } from '@yeonjae/prose';
import {
  exportAccepted,
  produceChapter,
  type ChapterProductionResult,
} from './chapter-production.js';
import { WorkflowError } from './errors.js';
import {
  LONGFORM_CHAPTERS,
  LONGFORM_PROMISE_PAYOFFS,
  LONGFORM_RELATIONSHIP,
  longformChapterText,
  longformEndingHook,
  longformShare,
  longformShareChapters,
  longformShareFactLocalId,
} from './longform-fixture.js';
import { createLongformHarness, type LongformHarness } from './longform-harness.js';

const run = databaseUrl() ? describe : describe.skip;

/** Continuity boundaries the tranche must exercise explicitly: the first, the middle and the last. */
const BOUNDARIES = [
  [1, 2],
  [59, 60],
  [119, 120],
] as const;

/**
 * The string CI greps for in the JUnit report to prove this suite actually executed. Changing it without
 * changing `.github/workflows/ci.yml` turns the no-skip guard off, so both move together.
 */
export const EVIDENCE_MARKER = 'B-4-1 120-chapter replay completion evidence';
const EVIDENCE_PATH = 'coverage/longform-replay-evidence.json';

/** Progress/runtime reporting. `console.error` is the repository's allowed console channel. */
function report(message: string): void {
  console.error(`[B-4-1 replay] ${message}`);
}

/** Failure diagnostics: chapter, step, canon version, invariant. Never prose, prompts or secrets. */
function where(chapterNo: number, step: string, canonVersion: number, invariant: string): string {
  return `chapter ${chapterNo} | step ${step} | canon v${canonVersion} | invariant: ${invariant}`;
}

run(`120-chapter deterministic continuity replay (B-4-1 deterministic portion)`, () => {
  let pool: Pool;
  let h: LongformHarness;
  const results: ChapterProductionResult[] = [];
  /** Hashes from an independent first pass over the same seed, for the determinism comparison. */
  const firstPass: {
    normalizedPack: [string, string][];
    acsHash: string;
    contentHash: string | undefined;
    summaryHash: string | undefined;
  }[] = [];
  const DETERMINISM_PREFIX = 3;
  /** Pinned so the two determinism passes differ in nothing an equivalent run may differ in. */
  const PINNED_WORKSPACE = '0191b2a0-0000-7000-8000-0000000004a0';
  const PINNED_PROJECT = '0191b2a0-0000-7000-8000-0000000004a1';
  let elapsedMs = 0;

  beforeAll(async () => {
    pool = await freshDatabase();

    // Pass 1 — the determinism reference. The fixture story bible pins fixed entity and promise ids, so
    // two projects cannot coexist in one database; the reference pass therefore runs first, on its own
    // clean schema, and the database is reset before the real 120-chapter run below.
    {
      const ref = await createLongformHarness(pool, {
        chapters: DETERMINISM_PREFIX,
        workspaceId: PINNED_WORKSPACE,
        projectId: PINNED_PROJECT,
      });
      const refDeps = { pool, gateway: ref.gateway(), bindings: ref.bindings };
      for (let k = 1; k <= DETERMINISM_PREFIX; k++) {
        const r = await produceChapter(refDeps, ref.input(k));
        firstPass.push({
          normalizedPack: await normalizedPackContent(pool, ref.projectId, k),
          acsHash: r.contract.acs_hash,
          contentHash: (await getManuscriptVersion(pool, r.accepted?.manuscript_version_id ?? ''))
            ?.content_hash,
          summaryHash: r.accepted?.summary_hash,
        });
      }
      await resetDatabase(pool);
      await migrate(pool);
    }

    // Pass 2 — the 120-chapter run every other assertion reads.
    h = await createLongformHarness(pool, {
      workspaceId: PINNED_WORKSPACE,
      projectId: PINNED_PROJECT,
      // One chapter of recordings beyond the run, for the crash/resume proof below. It is produced
      // after the 120 are accepted and is excluded from every count assertion.
      chapters: LONGFORM_CHAPTERS + 1,
    });
    const deps = { pool, gateway: h.gateway(), bindings: h.bindings };
    const started = Date.now();
    for (let k = 1; k <= LONGFORM_CHAPTERS; k++) {
      let result: ChapterProductionResult;
      try {
        result = await produceChapter(deps, h.input(k));
      } catch (err) {
        const wf = err instanceof WorkflowError ? err : undefined;
        const canon = (await getProject(pool, h.projectId)).canon_version;
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${where(k, wf?.options.step ?? 'unknown', canon, `${wf?.code ?? 'ERROR'} — chapter production must complete`)}: ${detail}`,
          { cause: err },
        );
      }
      if (result.status !== 'completed')
        throw new Error(
          `${where(k, 'produceChapter', result.accepted?.canon_version ?? -1, 'every chapter reaches status completed')}: got ${result.status}`,
        );
      results.push(result);
    }
    elapsedMs = Date.now() - started;
    // Runtime is reported, never used as a pass/fail condition: a slow CI runner is not a defect.
    report(
      `${LONGFORM_CHAPTERS} chapters accepted in ${(elapsedMs / 1000).toFixed(1)}s ` +
        `(${(elapsedMs / LONGFORM_CHAPTERS).toFixed(0)} ms/chapter), replay misses: ${h.provider.misses.length}`,
    );
  }, 1_800_000);

  afterAll(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------------------------------
  // the count itself, and the absence of spend
  // -------------------------------------------------------------------------------------------------

  it(`${EVIDENCE_MARKER}: processes exactly ${LONGFORM_CHAPTERS} sequential chapters, each accepted exactly once`, async () => {
    // This is the guard against the suite quietly shrinking: the completion evidence CI greps for.
    expect(results).toHaveLength(LONGFORM_CHAPTERS);
    expect(results.map((r) => r.chapter_no)).toEqual(
      Array.from({ length: LONGFORM_CHAPTERS }, (_, i) => i + 1),
    );
    const accepted = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM manuscript_versions mv
         JOIN chapters c ON c.id = mv.chapter_id
        WHERE c.project_id = $1 AND mv.status = 'accepted'`,
      [h.projectId],
    );
    expect(accepted.rows[0]?.n).toBe(String(LONGFORM_CHAPTERS));

    // Machine-readable completion evidence. CI asserts against this file, so a suite that silently
    // skipped, was filtered out, or ran fewer than 120 chapters cannot pass as if it had run.
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(
      EVIDENCE_PATH,
      `${JSON.stringify(
        {
          suite: EVIDENCE_MARKER,
          chapters_requested: LONGFORM_CHAPTERS,
          chapters_completed: results.length,
          accepted_manuscript_versions: Number(accepted.rows[0]?.n ?? '0'),
          final_canon_version: (await getProject(pool, h.projectId)).canon_version,
          replay_misses: h.provider.misses.length,
          live_provider_calls: 0,
          elapsed_ms: elapsedMs,
          database_url_present: Boolean(databaseUrl()),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    report(`${EVIDENCE_MARKER}: ${results.length} chapters, evidence written to ${EVIDENCE_PATH}`);
  }, 120_000);

  it('makes no live provider call: every response was replayed, no recording missed, no key present', () => {
    expect(h.provider.misses).toEqual([]);
    expect(h.provider.served.every((s) => s.by === 'activity')).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------------
  // English output-language check on every accepted manuscript
  // -------------------------------------------------------------------------------------------------

  it('every accepted manuscript passes the English output-language check', async () => {
    // One query for all 120 versions rather than 120 round-trips: a per-chapter query loop is slow
    // enough on a loaded CI runner to trip the default test timeout for reasons that have nothing to
    // do with the invariant being checked.
    const rows = await pool.query<{ id: string; status: string; text: string }>(
      `SELECT id, status, text FROM manuscript_versions WHERE project_id = $1 AND status = 'accepted'`,
      [h.projectId],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    for (const r of results) {
      const canon = r.accepted?.canon_version ?? -1;
      const v = byId.get(r.accepted?.manuscript_version_id ?? '');
      expect(
        v?.status,
        where(r.chapter_no, 'accept', canon, 'the produced version is accepted'),
      ).toBe('accepted');
      const check = checkOutputLanguage(toNfcText(v?.text ?? ''), { minConfidence: 0.99 });
      expect(
        check.passed,
        where(r.chapter_no, 'evaluate', canon, 'accepted manuscript is English (OUTPUT-LANG-001)'),
      ).toBe(true);
      expect(
        check.english_confidence,
        where(r.chapter_no, 'evaluate', canon, 'English confidence ≥ 0.99'),
      ).toBeGreaterThanOrEqual(0.99);
      for (const s of r.scenes)
        expect(
          s.language_confidence,
          where(r.chapter_no, 'scene_draft', canon, 'gateway checked scene output language'),
        ).toBe(1);
    }
  }, 120_000);

  // -------------------------------------------------------------------------------------------------
  // canon advances monotonically, exactly once per acceptance
  // -------------------------------------------------------------------------------------------------

  it('canon advances monotonically and exactly once per accepted commit', async () => {
    // The two bible commits are v1 and v2, so chapter k accepts at canon v(k+2).
    results.forEach((r, i) => {
      const expected = i + 3;
      expect(
        r.accepted?.canon_version,
        where(
          r.chapter_no,
          'accept',
          r.accepted?.canon_version ?? -1,
          'canon advances by exactly 1',
        ),
      ).toBe(expected);
    });
    const project = await getProject(pool, h.projectId);
    expect(project.canon_version).toBe(LONGFORM_CHAPTERS + 2);
    const commits = await listCommits(pool, h.projectId);
    expect(commits).toHaveLength(LONGFORM_CHAPTERS + 2);
    expect(commits.slice(0, 2).map((c) => c.source)).toEqual(['bible', 'bible']);
    expect(commits.slice(2).every((c) => c.source === 'chapter_acceptance')).toBe(true);
    // Strictly increasing, no gaps, no repeats.
    expect(commits.map((c) => c.version)).toEqual(
      Array.from({ length: LONGFORM_CHAPTERS + 2 }, (_, i) => i + 1),
    );
    // Each acceptance commit's base is the version the PREVIOUS acceptance produced: no skipped link.
    const bases = await pool.query<{ version: number; base: number }>(
      `SELECT version, (delta->>'base_canon_version')::int AS base
         FROM canon_commits WHERE project_id = $1 AND source = 'chapter_acceptance' ORDER BY version`,
      [h.projectId],
    );
    for (const row of bases.rows)
      expect(
        row.base,
        where(row.version - 2, 'accept', row.version, 'commit base is the previous canon version'),
      ).toBe(row.version - 1);
  }, 120_000);

  // -------------------------------------------------------------------------------------------------
  // chapter k receives chapter k−1's accepted state
  // -------------------------------------------------------------------------------------------------

  it.each(BOUNDARIES.map(([from, to]) => ({ from, to })))(
    'chapter $to receives chapter $from accepted summary, tail, hook and committed deltas',
    async ({ from, to }) => {
      const prev = results[from - 1];
      const canon = results[to - 1]?.accepted?.canon_version ?? -1;
      const packs = await pool.query<{ variables: Record<string, string> }>(
        `SELECT payload->'variables' AS variables
           FROM workflow_artifacts
          WHERE project_id = $1 AND kind = 'context_pack' AND key LIKE $2
          ORDER BY created_at`,
        [h.projectId, `${to}:%`],
      );
      const text =
        packs.rows.map((r) => r.variables.previous_text ?? '').find((t) => t.length > 0) ?? '';
      expect(
        text.length,
        where(to, 'pack', canon, `chapter ${to}'s pack carries a previous-chapter section`),
      ).toBeGreaterThan(0);
      // The L1 summary of chapter k−1, by content.
      expect(
        text,
        where(to, 'pack', canon, `previous section carries chapter ${from}'s L1 summary`),
      ).toContain(`Chapter ${from} factual summary`);
      // Its exact ending hook.
      expect(
        text,
        where(to, 'pack', canon, `previous section carries chapter ${from}'s verbatim ending hook`),
      ).toContain(longformEndingHook(from));
      // Its verbatim tail.
      expect(
        text,
        where(to, 'pack', canon, `previous section carries chapter ${from}'s verbatim tail`),
      ).toContain(`Chapter ${from} ending, verbatim`);
      // Its committed canon deltas.
      expect(
        text,
        where(to, 'pack', canon, `previous section carries chapter ${from}'s committed delta`),
      ).toMatch(/event\/assert|fact\/(assert|supersede)|promise_event\//);
      // And it is chapter k−1 that is carried, not an earlier one.
      if (from > 1)
        expect(
          text,
          where(
            to,
            'pack',
            canon,
            'the carried hook is the immediate predecessor, not an older one',
          ),
        ).not.toContain(longformEndingHook(from - 1));
      // The prior chapter's accepted state is what the workflow read.
      const lookup = await acceptedChapter(pool, h.projectId, from);
      expect(lookup.state).toBe('accepted');
      expect(prev?.accepted?.manuscript_version_id).toBe(
        lookup.state === 'accepted' ? lookup.chapter.version.id : undefined,
      );
    },
    120_000,
  );

  it('chapter k reads the canon version chapter k−1 wrote, for all 120 chapters', () => {
    results.forEach((r, i) => {
      // Chapter 1 starts before the bible commits, so it reads canon v0; chapter k > 1 reads the
      // version chapter k−1's acceptance produced (v(k+1)).
      const expectedRead = i === 0 ? 0 : i + 2;
      expect(
        r.pins.canonVersionRead,
        where(
          r.chapter_no,
          'init',
          r.accepted?.canon_version ?? -1,
          'pinned canon read is k−1 output',
        ),
      ).toBe(expectedRead);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // long-range continuity: facts, promises, relationships set up early and resolved late
  // -------------------------------------------------------------------------------------------------

  it('a fact asserted in chapter 1 is superseded five times across 120 chapters, each link citing the last', async () => {
    const chapters = longformShareChapters();
    expect(chapters).toEqual([1, 21, 41, 61, 81, 101]);
    const facts = await pool.query<{
      id: string;
      value_text: string;
      asserted_at_version: number;
      superseded_by_fact_id: string | null;
      valid_to: unknown;
    }>(
      `SELECT id, value_text, asserted_at_version, superseded_by_fact_id, valid_to
         FROM facts
        WHERE project_id = $1 AND entity_id = $2 AND attribute = 'porter.share'
        ORDER BY asserted_at_version`,
      [h.projectId, h.bindings.doyoon ?? (await doyoonId(pool, h.projectId))],
    );
    expect(facts.rows).toHaveLength(chapters.length);
    // Each fact but the last is closed and points at its successor: one unbroken chain.
    facts.rows.forEach((row, i) => {
      const chapterNo = chapters[i] ?? -1;
      const canon = chapterNo + 2;
      expect(
        row.value_text,
        where(chapterNo, 'accept', canon, 'the share fact records this chapter’s value'),
      ).toContain('porter share');
      if (i < facts.rows.length - 1) {
        expect(
          row.superseded_by_fact_id,
          where(chapterNo, 'accept', canon, 'a superseded share fact points at its replacement'),
        ).toBe(facts.rows[i + 1]?.id);
        expect(
          row.valid_to,
          where(chapterNo, 'accept', canon, 'a superseded share fact is closed'),
        ).not.toBeNull();
      } else {
        expect(
          row.superseded_by_fact_id,
          where(chapterNo, 'accept', canon, 'the current share fact is open'),
        ).toBeNull();
        expect(row.valid_to).toBeNull();
      }
    });
    // The value at chapter 120 is the one chapter 101 established, five renegotiations after chapter 1.
    expect(facts.rows[facts.rows.length - 1]?.value_text).toContain(
      `${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][longformShare(LONGFORM_CHAPTERS)]} percent`,
    );
    expect(longformShareFactLocalId(LONGFORM_CHAPTERS)).toBe('f-share-101');
  }, 120_000);

  it('a promise opened in chapter 1 is paid in chapter 120, 119 chapters later', async () => {
    const events = await pool.query<{ kind: string; number: number }>(
      `SELECT pe.kind, c.number
         FROM promise_events pe
         JOIN chapters c ON c.id = pe.chapter_id
        WHERE pe.promise_id = $1 ORDER BY c.number`,
      [watcherPromiseId()],
    );
    expect(events.rows.map((r) => [r.number, r.kind])).toEqual([
      [1, 'opened'],
      [LONGFORM_PROMISE_PAYOFFS.compass, 'advanced'],
      [LONGFORM_CHAPTERS, 'paid'],
    ]);
    const promise = await pool.query<{ status: string }>(
      'SELECT status FROM promises WHERE id = $1',
      [watcherPromiseId()],
    );
    expect(
      promise.rows[0]?.status,
      where(
        LONGFORM_CHAPTERS,
        'accept',
        LONGFORM_CHAPTERS + 2,
        'the chapter-1 promise is paid at 120',
      ),
    ).toBe('paid');
  }, 120_000);

  it('the mid-run promise opened in chapter 1 is paid at chapter 60 and the early one at chapter 3', async () => {
    const statuses = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM promises WHERE project_id = $1 ORDER BY id`,
      [h.projectId],
    );
    expect(statuses.rows.every((r) => r.status === 'paid')).toBe(true);
    const paid = await pool.query<{ number: number }>(
      `SELECT c.number FROM promise_events pe JOIN chapters c ON c.id = pe.chapter_id
        WHERE pe.kind = 'paid' ORDER BY c.number`,
    );
    expect(paid.rows.map((r) => r.number)).toEqual([
      LONGFORM_PROMISE_PAYOFFS.gateRun,
      LONGFORM_PROMISE_PAYOFFS.compass,
      LONGFORM_PROMISE_PAYOFFS.watcher,
    ]);
  }, 120_000);

  it('a relationship state established at chapter 2 is superseded at chapter 119', async () => {
    const rows = await pool.query<{ type: string; asserted_at_version: number; valid_to: unknown }>(
      `SELECT type, asserted_at_version, valid_to FROM relationship_states
        WHERE project_id = $1 ORDER BY asserted_at_version`,
      [h.projectId],
    );
    // bible seeds two (both directions), chapter 2 supersedes one, chapter 119 supersedes that.
    const types = rows.rows.map((r) => r.type);
    expect(types).toContain('colleague');
    expect(types).toContain('ally');
    const late = rows.rows[rows.rows.length - 1];
    expect(
      late?.asserted_at_version,
      where(
        LONGFORM_RELATIONSHIP.supersededAt,
        'accept',
        LONGFORM_RELATIONSHIP.supersededAt + 2,
        'the late relationship change commits at chapter 119',
      ),
    ).toBe(LONGFORM_RELATIONSHIP.supersededAt + 2);
    expect(late?.valid_to).toBeNull();
  }, 120_000);

  // -------------------------------------------------------------------------------------------------
  // determinism: identical hashes across equivalent reruns
  // -------------------------------------------------------------------------------------------------

  it('an equivalent independent run reproduces identical artifact hashes and identical pack content', async () => {
    // The reference pass in `beforeAll` ran the same seed against its own clean schema, with the same
    // pinned workspace/project ids, the same pinned identity, policy and prompt set.
    //
    // Artifact hashes that are a function of PINNED inputs only must be bit-identical, and are asserted
    // as such below. The rendered context pack additionally embeds row identifiers the DATABASE
    // allocates (canon row ids, the job id) — UUIDv7s that legitimately differ between two independent
    // runs — so it is compared with those identifiers normalized. Byte-exact pack stability within a
    // run (the property replay and resume actually depend on) is proved by the rerun test below, which
    // requires every step to replay from its checkpoint.
    expect(firstPass).toHaveLength(DETERMINISM_PREFIX);
    for (let k = 1; k <= DETERMINISM_PREFIX; k++) {
      const ref = firstPass[k - 1];
      const now = results[k - 1];
      const canon = now?.accepted?.canon_version ?? -1;
      expect(
        await normalizedPackContent(pool, h.projectId, k),
        where(
          k,
          'pack',
          canon,
          'rendered context-pack content is identical across equivalent runs',
        ),
      ).toEqual(ref?.normalizedPack);
      expect(
        now?.contract.acs_hash,
        where(k, 'chapter_contract', canon, 'active constraint set hash is identical'),
      ).toBe(ref?.acsHash);
      const version = await getManuscriptVersion(pool, now?.accepted?.manuscript_version_id ?? '');
      expect(
        version?.content_hash,
        where(k, 'assemble', canon, 'accepted manuscript content hash is identical'),
      ).toBe(ref?.contentHash);
      expect(
        now?.accepted?.summary_hash,
        where(k, 'summarize', canon, 'L1 summary hash is identical'),
      ).toBe(ref?.summaryHash);
    }
  }, 120_000);

  it('the generated chapter text is a pure function of the chapter number', () => {
    // If this drifted, the fixture would no longer be a seed and the rerun test above would be circular.
    for (const k of [1, 59, 60, 119, 120])
      expect(longformChapterText(k)).toBe(longformChapterText(k));
    expect(longformChapterText(1)).not.toBe(longformChapterText(2));
  });

  // -------------------------------------------------------------------------------------------------
  // deterministic retry/resume duplicates nothing
  // -------------------------------------------------------------------------------------------------

  it('re-running every accepted chapter duplicates no spend, version, commit, summary, document, edge or terminal event', async () => {
    const before = await counters(pool, h.projectId);
    const deps = { pool, gateway: h.gateway(), bindings: h.bindings };
    // Re-drive a spread of chapters, including both ends and a mid-run boundary. Each replays from
    // job_steps; nothing may be created a second time.
    for (const k of [1, 2, 59, 60, 119, 120]) {
      const again = await produceChapter(deps, h.input(k));
      expect(
        again.status,
        where(
          k,
          'produceChapter',
          again.accepted?.canon_version ?? -1,
          'a rerun completes by replay',
        ),
      ).toBe('completed');
      expect(
        again.accepted?.canon_version,
        where(k, 'accept', again.accepted?.canon_version ?? -1, 'a rerun does not advance canon'),
      ).toBe(results[k - 1]?.accepted?.canon_version);
      expect(again.steps.every((s) => s.status === 'replayed')).toBe(true);
    }
    const after = await counters(pool, h.projectId);
    expect(after).toEqual(before);
    // And no duplicate model spend under any idempotency key.
    const dupes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT idempotency_key FROM llm_calls WHERE project_id = $1 AND status <> 'failed'
          GROUP BY idempotency_key HAVING count(*) > 1) d`,
      [h.projectId],
    );
    expect(dupes.rows[0]?.n, 'no duplicated provider/model spend record').toBe('0');
    // Exactly one terminal job event per chapter workflow.
    const terminal = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT job_id FROM job_events je JOIN jobs j ON j.id = je.job_id
          WHERE j.project_id = $1 AND je.terminal GROUP BY job_id HAVING count(*) > 1) d`,
      [h.projectId],
    );
    expect(terminal.rows[0]?.n, 'no duplicated terminal job event').toBe('0');
  }, 600_000);

  it('a crash mid-chapter resumes without duplicating the acceptance tail', async () => {
    // Chapter 121 is produced with an injected failure after extraction — after real model calls and
    // before the commit — then resumed. The acceptance tail must run exactly once.
    const k = LONGFORM_CHAPTERS + 1;
    const deps = { pool, gateway: h.gateway(), bindings: h.bindings };
    const before = await counters(pool, h.projectId);
    await expect(produceChapter(deps, h.input(k, { failAfterStep: 'extract' }))).rejects.toThrow();
    const mid = await counters(pool, h.projectId);
    expect(
      mid.commits,
      where(
        k,
        'extract',
        before.canonVersion,
        'a failure before the commit leaves canon untouched',
      ),
    ).toBe(before.commits);
    const resumed = await produceChapter(deps, h.input(k));
    expect(resumed.status).toBe('completed');
    const after = await counters(pool, h.projectId);
    expect(
      after.commits,
      where(k, 'accept', after.canonVersion, 'the resumed run commits exactly once'),
    ).toBe(before.commits + 1);
    expect(after.summaries).toBe(before.summaries + 1);
    const dupes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT idempotency_key FROM llm_calls WHERE project_id = $1 AND status <> 'failed'
          GROUP BY idempotency_key HAVING count(*) > 1) d`,
      [h.projectId],
    );
    expect(dupes.rows[0]?.n).toBe('0');
  }, 300_000);

  // -------------------------------------------------------------------------------------------------
  // non-accepted text never escapes
  // -------------------------------------------------------------------------------------------------

  it('rejected, quarantined and working text never enters canon, retrieval, summaries, index, edges or export', async () => {
    const marker = 'QUARANTINE MARKER: this sentence must never leave the quarantine table.';
    const chapterId = await chapterIdOf(pool, h.projectId, 5);
    // Created through the production path, so it is a real working candidate — not a hand-inserted row
    // that bypasses the manuscript guard.
    const draft = await createManuscriptVersion(pool, {
      workspaceId: h.workspaceId,
      projectId: h.projectId,
      chapterId,
      origin: 'candidate',
      text: `${marker}\n\nA losing candidate that was never approved.`,
    });
    const draftId = draft.id;
    await quarantineVersion(pool, draftId, 'B-4-1: proving non-accepted text is isolated');

    expect(await quarantineContains(pool, h.projectId, marker)).toBe(true);
    // Not in canon evidence.
    const evidence = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM evidence_spans WHERE quote LIKE $1`,
      [`%${marker}%`],
    );
    expect(evidence.rows[0]?.n, 'quarantined text is not cited by canon evidence').toBe('0');
    // Not in accepted-only retrieval, summaries or the search index.
    for (const text of await acceptedCorpus(pool, h.projectId)) expect(text).not.toContain(marker);
    expect(await searchDocumentsContaining(pool, h.projectId, marker)).toBe(0);
    const summaries = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM summaries WHERE project_id = $1 AND text LIKE $2`,
      [h.projectId, `%${marker}%`],
    );
    expect(summaries.rows[0]?.n).toBe('0');
    // Not a dependency edge target.
    expect(await dependencyEdgesFor(pool, h.projectId, draftId)).toEqual([]);
    // Not exportable, and absent from the export surface.
    const exported = await exportAccepted(pool, { projectId: h.projectId });
    expect(exported.chapters).toHaveLength(LONGFORM_CHAPTERS + 1);
    expect(exported.text).not.toContain(marker);
    // A non-accepted version cannot be exported even when asked for by name.
    await expect(
      pool.query(`SELECT text FROM manuscript_versions WHERE id = $1`, [draftId]),
    ).resolves.toMatchObject({ rowCount: 0 });
  }, 300_000);

  // -------------------------------------------------------------------------------------------------
  // the durable surfaces are exactly one per chapter
  // -------------------------------------------------------------------------------------------------

  it('each chapter produced exactly one summary, one indexed document set and its dependency edges', async () => {
    // Two grouped queries rather than 240 round-trips, for the same reason as the language test above.
    const summaries = await pool.query<{ chapter_from: number; n: string }>(
      `SELECT chapter_from, count(*)::text AS n FROM summaries
        WHERE project_id = $1 AND tier = 'L1' GROUP BY chapter_from`,
      [h.projectId],
    );
    const summaryCount = new Map(summaries.rows.map((row) => [row.chapter_from, row.n]));
    const edges = await pool.query<{ dependent_id: string; n: string }>(
      `SELECT dependent_id, count(*)::text AS n FROM dependency_edges
        WHERE project_id = $1 GROUP BY dependent_id`,
      [h.projectId],
    );
    const edgeCount = new Map(edges.rows.map((row) => [row.dependent_id, Number(row.n)]));
    for (const r of results) {
      const canon = r.accepted?.canon_version ?? -1;
      expect(
        summaryCount.get(r.chapter_no),
        where(r.chapter_no, 'summarize', canon, 'exactly one L1 summary per accepted chapter'),
      ).toBe('1');
      expect(
        r.accepted?.indexed_documents,
        where(r.chapter_no, 'summarize', canon, 'the accepted version is indexed'),
      ).toBeGreaterThan(0);
      expect(
        edgeCount.get(r.accepted?.manuscript_version_id ?? '') ?? 0,
        where(
          r.chapter_no,
          'dependency_edges',
          canon,
          'the accepted version records its dependencies',
        ),
      ).toBeGreaterThan(0);
    }
  }, 300_000);
});

// -----------------------------------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------------------------------

async function counters(pool: Pool, projectId: string) {
  const q = async (sql: string) =>
    Number((await pool.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? '0');
  return {
    llmCalls: await q(`SELECT count(*)::text AS n FROM llm_calls WHERE project_id = $1`),
    versions: await q(
      `SELECT count(*)::text AS n FROM manuscript_versions WHERE project_id = $1 AND status = 'accepted'`,
    ),
    commits: await q(`SELECT count(*)::text AS n FROM canon_commits WHERE project_id = $1`),
    summaries: await q(`SELECT count(*)::text AS n FROM summaries WHERE project_id = $1`),
    searchDocs: await q(`SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1`),
    edges: await q(`SELECT count(*)::text AS n FROM dependency_edges WHERE project_id = $1`),
    terminalEvents: await q(
      `SELECT count(*)::text AS n FROM job_events je JOIN jobs j ON j.id = je.job_id
        WHERE j.project_id = $1 AND je.terminal`,
    ),
    canonVersion: (await getProject(pool, projectId)).canon_version,
  };
}

async function normalizedPackContent(
  pool: Pool,
  projectId: string,
  chapterNo: number,
): Promise<[string, string][]> {
  // The content the model was actually given, per pack of the chapter, normalized for what two
  // INDEPENDENT runs may legitimately differ in: the concrete UUIDs the database allocated for canon
  // rows and the job, and — because several pack items tie-break on those ids — the relative order of
  // otherwise-equivalent T1 state lines. Everything else (which items were selected, their text, the
  // pinned header, the budget outcome) must match exactly.
  const rows = await pool.query<{
    key: string;
    payload: { renderedSystem: string; renderedUser: string };
  }>(
    `SELECT key, payload FROM workflow_artifacts
      WHERE project_id = $1 AND kind = 'context_pack' AND key LIKE $2 ORDER BY key`,
    [projectId, `${chapterNo}:%`],
  );
  return rows.rows.map((row) => [
    row.key,
    `${row.payload.renderedSystem}\n${row.payload.renderedUser}`
      .replace(UUID_RE, '<uuid>')
      .split('\n')
      .sort()
      .join('\n'),
  ]);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function chapterIdOf(pool: Pool, projectId: string, number: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM chapters WHERE project_id = $1 AND number = $2',
    [projectId, number],
  );
  return r.rows[0]?.id ?? '';
}

async function doyoonId(pool: Pool, projectId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM entities WHERE project_id = $1 AND display_name = 'Kang Do-yoon'`,
    [projectId],
  );
  return r.rows[0]?.id ?? '';
}

function watcherPromiseId(): string {
  return '0191b2a0-0000-7000-8000-0000000d0003';
}
