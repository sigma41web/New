/**
 * Series audit (ADR-0061): a deterministic read of a whole serial's accepted state, for the problems that
 * only show across many chapters. It never calls a model and never reads a draft:
 *
 * - promises still open past the end of their due window;
 * - characters who have not taken part in a canonical event for a long stretch (or never have);
 * - canonical story time that moves backwards from one chapter to the next without a flashback frame;
 * - chapters whose opening reads like the previous chapter's opening.
 *
 * Thresholds are report parameters with defaults, not production gates; the audit informs the author and
 * the planner and blocks nothing.
 */
import { type Pool } from '@yeonjae/db';
import { repetitionReport, toNfcText } from '@yeonjae/prose';

export interface SeriesAuditOptions {
  /** A character counts as absent after this many accepted chapters without a canonical event. */
  readonly absentAfterChapters?: number | undefined;
  /** Opening similarity (two-word Jaccard over the first 200 characters) that counts as a repeat. */
  readonly openingSimilarity?: number | undefined;
}

export interface SeriesAudit {
  readonly project_id: string;
  readonly accepted_chapters: number;
  readonly last_chapter: number;
  readonly overdue_promises: readonly {
    readonly promise_id: string;
    readonly statement: string;
    readonly importance: string;
    readonly due_max_chapter: number;
    readonly overdue_by: number;
    readonly last_event_chapter: number | null;
  }[];
  readonly absent_characters: readonly {
    readonly entity_id: string;
    readonly name: string;
    readonly last_chapter: number | null;
    readonly absent_for: number;
  }[];
  readonly clock_regressions: readonly {
    readonly chapter_no: number;
    readonly earliest_ord: number;
    readonly previous_latest_ord: number;
  }[];
  readonly repeated_openings: readonly {
    readonly chapter_no: number;
    readonly earlier_chapter: number;
    readonly jaccard: number;
  }[];
  readonly thresholds: {
    readonly absent_after_chapters: number;
    readonly opening_similarity: number;
  };
}

export async function auditSeries(
  pool: Pool,
  projectId: string,
  options: SeriesAuditOptions = {},
): Promise<SeriesAudit> {
  const absentAfter = options.absentAfterChapters ?? 20;
  const openingSimilarity = options.openingSimilarity ?? 0.5;
  const chapters = await pool.query<{ number: number; text: string }>(
    `SELECT c.number, mv.text
       FROM chapters c JOIN manuscript_versions mv ON mv.id = c.accepted_version_id AND mv.status = 'accepted'
      WHERE c.project_id = $1 AND c.status = 'accepted'
      ORDER BY c.number`,
    [projectId],
  );
  const last = chapters.rows.at(-1)?.number ?? 0;

  const overdue = await pool.query<{
    id: string;
    statement: string;
    importance: string;
    due_max_chapter: number;
    last_event_chapter: number | null;
  }>(
    `SELECT p.id, p.statement, p.importance, p.due_max_chapter,
            (SELECT max(c.number) FROM promise_events pe JOIN chapters c ON c.id = pe.chapter_id
              WHERE pe.promise_id = p.id) AS last_event_chapter
       FROM promises p
      WHERE p.project_id = $1 AND p.status IN ('open', 'advanced')
        AND p.due_max_chapter IS NOT NULL AND p.due_max_chapter < $2
      ORDER BY p.due_max_chapter, p.id`,
    [projectId, last],
  );

  const seen = await pool.query<{ id: string; display_name: string; last_chapter: number | null }>(
    `SELECT en.id, en.display_name,
            (SELECT max(c.number) FROM event_participants ep
               JOIN events e ON e.id = ep.event_id AND e.frame = 'canonical' AND e.retracted_at_version IS NULL
               JOIN chapters c ON c.id = e.source_chapter_id
              WHERE ep.entity_id = en.id) AS last_chapter
       FROM entities en
      WHERE en.project_id = $1 AND en.type = 'character'
      ORDER BY en.id`,
    [projectId],
  );

  const clocks = await pool.query<{ chapter_no: number; min_ord: string; max_ord: string }>(
    `SELECT c.number AS chapter_no, min(e.clock_ord) AS min_ord, max(e.clock_ord) AS max_ord
       FROM events e JOIN chapters c ON c.id = e.source_chapter_id
      WHERE e.project_id = $1 AND e.frame = 'canonical' AND e.retracted_at_version IS NULL
        AND c.status = 'accepted'
      GROUP BY c.number ORDER BY c.number`,
    [projectId],
  );
  const regressions: SeriesAudit['clock_regressions'][number][] = [];
  for (let i = 1; i < clocks.rows.length; i++) {
    const prev = clocks.rows[i - 1];
    const cur = clocks.rows[i];
    if (!prev || !cur) continue;
    if (Number(cur.min_ord) < Number(prev.max_ord))
      regressions.push({
        chapter_no: cur.chapter_no,
        earliest_ord: Number(cur.min_ord),
        previous_latest_ord: Number(prev.max_ord),
      });
  }

  const openings: SeriesAudit['repeated_openings'][number][] = [];
  for (let i = 1; i < chapters.rows.length; i++) {
    const prev = chapters.rows[i - 1];
    const cur = chapters.rows[i];
    if (!prev || !cur) continue;
    const r = repetitionReport(toNfcText(cur.text), [{ chapter_no: prev.number, text: prev.text }]);
    const j = r.opening_similarity[0]?.jaccard ?? 0;
    if (j >= openingSimilarity)
      openings.push({ chapter_no: cur.number, earlier_chapter: prev.number, jaccard: j });
  }

  return {
    project_id: projectId,
    accepted_chapters: chapters.rows.length,
    last_chapter: last,
    overdue_promises: overdue.rows.map((p) => ({
      promise_id: p.id,
      statement: p.statement,
      importance: p.importance,
      due_max_chapter: p.due_max_chapter,
      overdue_by: last - p.due_max_chapter,
      last_event_chapter: p.last_event_chapter,
    })),
    absent_characters: seen.rows
      .map((c) => ({
        entity_id: c.id,
        name: c.display_name,
        last_chapter: c.last_chapter,
        absent_for: last - (c.last_chapter ?? 0),
      }))
      .filter((c) => c.absent_for > absentAfter)
      .sort((a, b) => b.absent_for - a.absent_for || (a.entity_id < b.entity_id ? -1 : 1)),
    clock_regressions: regressions,
    repeated_openings: openings,
    thresholds: { absent_after_chapters: absentAfter, opening_similarity: openingSimilarity },
  };
}
