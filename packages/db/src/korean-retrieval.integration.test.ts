/**
 * ADR-0058: Korean lexical retrieval over accepted text. The fixture is an original, studio-written Korean
 * serial (8 chapters, 48 paragraphs) with 26 query → expected paragraph pairs whose queries use different
 * particles, endings and aliases than the text. Documents are indexed through the real acceptance path
 * (`canon.index_accepted_version`), so the language and entity tagging under test are the production ones.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveManuscriptVersion,
  commitDelta,
  createManuscriptVersion,
  createPool,
  getProject,
  indexAcceptedVersion,
  lexicalSearch,
  migrate,
  type Pool,
} from './index.js';
import { databaseUrl } from './testkit.js';

interface Fixture {
  readonly entities: readonly { key: string; display_name: string; aliases: string[] }[];
  readonly chapters: readonly { chapter_no: number; paragraphs: string[] }[];
  readonly queries: readonly { id: string; query: string; expected: [number, string][] }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'testdata', 'ko-retrieval.json'), 'utf8'),
) as Fixture;
const K = 5;
const url = databaseUrl();
const run = url ? describe : describe.skip;

async function recallAtK(pool: Pool, projectId: string, language: 'en' | 'ko') {
  const misses: string[] = [];
  for (const q of fixture.queries) {
    const hits = await lexicalSearch(pool, {
      projectId,
      query: q.query,
      language,
      kinds: ['chapter_paragraph'],
      limit: K,
    });
    const got = new Set(hits.map((h) => `${String(h.chapter_no)}:${h.ref_key}`));
    if (!q.expected.some(([c, p]) => got.has(`${String(c)}:${p}`))) misses.push(q.id);
  }
  return { recall: (fixture.queries.length - misses.length) / fixture.queries.length, misses };
}

run('Korean lexical retrieval (ADR-0058)', () => {
  let pool: Pool;
  let projectId = '';

  beforeAll(async () => {
    pool = createPool({ connectionString: url ?? '', max: 4 });
    await migrate(pool);
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('ko-retrieval') RETURNING id`,
    );
    const workspaceId = ws.rows[0]?.id ?? '';
    const p = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version, output_language)
       VALUES ($1, '검은 손의 아카데미', 'standard.v1', 'ko') RETURNING id`,
      [workspaceId],
    );
    projectId = p.rows[0]?.id ?? '';
    await pool.query(
      `INSERT INTO timelines (workspace_id, project_id, kind, name) VALUES ($1, $2, 'main', 'main')`,
      [workspaceId, projectId],
    );
    for (const e of fixture.entities)
      await pool.query(
        `INSERT INTO entities (workspace_id, project_id, type, display_name, aliases)
         VALUES ($1, $2, 'character', $3, $4)`,
        [workspaceId, projectId, e.display_name, e.aliases],
      );
    for (const ch of fixture.chapters) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO chapters (workspace_id, project_id, number, status)
         VALUES ($1, $2, $3, 'drafted') RETURNING id`,
        [workspaceId, projectId, ch.chapter_no],
      );
      const chapterId = c.rows[0]?.id ?? '';
      const version = await createManuscriptVersion(pool, {
        workspaceId,
        projectId,
        chapterId,
        origin: 'assembled',
        text: ch.paragraphs.join('\n\n'),
      });
      await approveManuscriptVersion(pool, version.id, 'fixture');
      await commitDelta(pool, {
        projectId,
        parentVersion: (await getProject(pool, projectId)).canon_version,
        source: 'chapter_acceptance',
        chapterId,
        manuscriptVersionId: version.id,
        delta: { items: [] },
      });
      await indexAcceptedVersion(pool, version.id);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('stores Korean manuscripts, summaries and search documents as Korean', async () => {
    const mv = await pool.query<{ language: string }>(
      'SELECT DISTINCT language FROM manuscript_versions WHERE project_id = $1',
      [projectId],
    );
    expect(mv.rows.map((r) => r.language)).toEqual(['ko']);
    const docs = await pool.query<{ language: string; n: string }>(
      `SELECT language, count(*)::text AS n FROM search_documents WHERE project_id = $1 GROUP BY language`,
      [projectId],
    );
    expect(docs.rows).toEqual([{ language: 'ko', n: '48' }]);
  });

  it('tags two-syllable Korean names on indexed paragraphs', async () => {
    const tagged = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM search_documents d
         JOIN entities e ON e.id = ANY(d.entity_ids)
        WHERE d.project_id = $1 AND e.display_name = '레온'`,
      [projectId],
    );
    expect(Number(tagged.rows[0]?.n)).toBeGreaterThanOrEqual(10);
  });

  it(`finds the expected paragraph for Korean queries: recall@${String(K)} ≥ 0.95, above English FTS`, async () => {
    const ko = await recallAtK(pool, projectId, 'ko');
    const en = await recallAtK(pool, projectId, 'en');
    expect(ko.misses).toEqual([]);
    expect(ko.recall).toBeGreaterThanOrEqual(0.95);
    // The English configuration indexes each eojeol whole; particles make it miss.
    expect(en.recall).toBeLessThan(ko.recall);
  });

  it('expands a query through registry aliases (공녀 → 세라핀)', async () => {
    const hits = await lexicalSearch(pool, {
      projectId,
      query: '공녀의 비밀',
      language: 'ko',
      kinds: ['chapter_paragraph'],
      limit: K,
    });
    expect(hits.some((h) => h.text.includes('세라핀'))).toBe(true);
  });

  it('orders results totally (rank, chapter, id) so replays are stable', async () => {
    const a = await lexicalSearch(pool, {
      projectId,
      query: '회중시계',
      language: 'ko',
      limit: 10,
    });
    const b = await lexicalSearch(pool, {
      projectId,
      query: '회중시계',
      language: 'ko',
      limit: 10,
    });
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(a.map((h) => `${String(h.chapter_no)}:${h.ref_key}`)).toEqual([
      '1:p6',
      '2:p6',
      '4:p6',
      '8:p4',
    ]);
  });
});
