/**
 * The Korean-manuscript product loop end to end with the simulated model (ADR-0054/0055): a Korean intake
 * composes the Korean identity layers, the requirement interpreter returns Korean requirements with no
 * English paraphrase, and chapters are planned, drafted, evaluated and accepted in Korean.
 *
 * Regression: before ADR-0055 the Active Constraint Set demanded an English `text_en` for every non-English
 * requirement, so the first Korean chapter contract failed with CONSTRAINT_UNRENDERABLE.
 */
import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { createProject, createWorkspace, getNovelRun, PgAuditStore, type Pool } from '@yeonjae/db';
import { loadSchemas } from '@yeonjae/domain';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { Gateway, MemoryBudget, MockProvider, type ProviderRequest } from '@yeonjae/gateway';
import { simulatedModelScript as script } from './simulated-model.js';
import { approveConcept, resumeNovelRun, startNovel } from './novel.js';
import { NovelRunner } from './novel-runner.js';
import { ArtifactLlmOutputStore } from './runtime.js';
import { REPLAY_ROUTING } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const INTAKE = {
  title_working: '재의 장부',
  premise:
    '파면당한 길드 회계사가 도시의 게이트 방위 자금 장부가 조작됐다는 걸 알아채고, 그걸 증명하려고 직접 헌터 서열을 오른다.',
  premise_language: 'ko',
  manuscript_language: 'ko',
  genre: { primary: 'hunter-gate', secondary: ['academy'] },
  main_character: { name: '서지안', role: 'protagonist', description: '29세. 전직 길드 회계사.' },
  supporting_characters: [
    { name: '백태호', role: 'mentor', description: '48세, 은퇴한 B급 척후.' },
    { name: '문해린', role: 'antagonist', description: '35세, 길드 재무 담당.' },
  ],
  content_restrictions: ['성적인 묘사 금지'],
  target_chapters: 2,
  target_characters_per_chapter: 1400,
  operating_mode: 'autopilot',
};

const routing = {
  ...REPLAY_ROUTING,
  R: REPLAY_ROUTING.R.map((r) => ({ ...r, provider: 'mock' })),
  P: REPLAY_ROUTING.P.map((r) => ({ ...r, provider: 'mock' })),
  M: REPLAY_ROUTING.M.map((r) => ({ ...r, provider: 'mock' })),
  C: REPLAY_ROUTING.C.map((r) => ({ ...r, provider: 'mock' })),
};

run('Korean novel run: intake → bible → chapters, prompts in Korean (simulated live model)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  const seen: ProviderRequest[] = [];
  // Words the model itself wrote. The simulated model's bible and plan content is English fixture data;
  // when later prompts quote it back that is model content, not a rendering this system added.
  const modelWords = new Set<string>();
  const provider = new MockProvider((req) => {
    seen.push(req);
    const out = script(req);
    for (const m of JSON.stringify(out).matchAll(/[A-Za-z][A-Za-z'’-]+/g)) modelWords.add(m[0]);
    return out;
  });

  beforeAll(async () => {
    pool = await freshDatabase();
    workspaceId = await createWorkspace(pool, 'novel-ko-e2e');
    ({ projectId } = await createProject(pool, {
      workspaceId,
      title: '재의 장부',
      operatingMode: 'autopilot',
    }));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const makeDeps = () => ({
    pool,
    gateway: new Gateway({
      providers: new Map([['mock', provider]]),
      routing,
      budget: new MemoryBudget(10_000_000),
      audit: new PgAuditStore(
        pool,
        { workspaceId, projectId },
        new ArtifactLlmOutputStore(pool, { workspaceId, projectId }),
      ),
    }),
  });

  it('plans and accepts Korean chapters from Korean requirements', async () => {
    const started = await startNovel(makeDeps(), { projectId, intake: INTAKE });
    expect(started.run.status).toBe('awaiting_approval');
    const concept = started.concepts[0];
    await approveConcept(pool, { projectId, conceptId: concept?.id ?? '', autoContinue: true });
    const runner = new NovelRunner({ pool, makeDeps, runnerId: 'ko-runner', leaseSeconds: 30 });
    while (await runner.tick()) {
      const r = await getNovelRun(pool, projectId);
      if (r?.status === 'paused') await resumeNovelRun(pool, { projectId, autoContinue: true });
    }
    const after = await getNovelRun(pool, projectId);
    expect(after?.last_error ?? null).toBeNull();
    expect(after?.status).toBe('completed');

    const chapters = await pool.query<{ number: number; status: string }>(
      'SELECT number, status FROM chapters WHERE project_id = $1 ORDER BY number',
      [projectId],
    );
    expect(chapters.rows).toEqual([
      { number: 1, status: 'accepted' },
      { number: 2, status: 'accepted' },
    ]);

    // Every style-sensitive prompt carried the Korean identity block, and the writer saw a Korean contract.
    const writer = seen.filter((r) => r.trace?.role === 'scene_writer');
    expect(writer.length).toBeGreaterThan(0);
    for (const r of writer) {
      expect(r.system).toMatch(/lang=ko\/ko-KR/);
      expect(r.system).toMatch(/## 출력 언어 계약 \(한국어\)/);
      expect(r.system).not.toMatch(/Output-Language Contract/);
      expect(`${r.system}\n${r.user}`).toMatch(/회차 계약/);
    }
    const planner = seen.filter((r) => r.trace?.role === 'chapter_planner');
    for (const r of planner) {
      expect(r.user).toMatch(/하드 요구사항/);
      expect(r.user).not.toMatch(/Use ONLY the entity ids above/);
    }

    // KO-PROMPT-SURFACE-001: no English instruction or canon rendering reaches any Korean prompt. Every
    // model call of the run is scanned; Latin words are allowed only as identifiers (schema keys and enum
    // values, snake_case, provenance tags) — see `englishLeaks`.
    const leaks = seen.flatMap((r) =>
      englishLeaks(`${r.system}\n${r.user}`, modelWords).map(
        (w) => `${r.trace?.role ?? '?'}: ${w}`,
      ),
    );
    expect([...new Set(leaks)]).toEqual([]);
  }, 300_000);
});

/** Schema keys and enum values: identifiers a Korean prompt may carry verbatim. */
const SCHEMA_WORDS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) {
        out.add(k);
        if (k === 'enum' && Array.isArray(v))
          for (const e of v) if (typeof e === 'string') out.add(e);
        if (k === 'const' && typeof v === 'string') out.add(v);
        walk(v);
      }
  };
  for (const s of loadSchemas().schemas.values()) walk(s.schema);
  return out;
})();

/** Provenance tags, identity-block markers and model-facing ids that are identifiers by design (ADR-0055). */
const TAGS = new Set([
  'FACT',
  'PLANNED',
  'SUMMARY',
  'EVIDENCE',
  'UNTRUSTED',
  'KNOWLEDGE',
  'RELATIONSHIP',
  'BEGIN',
  'END',
  'NARRATIVE',
  'IDENTITY',
  'TAIL',
  'lang',
  'ko',
  'KR',
  'id',
  'ids',
  'json',
  'JSON',
  'REQ',
  'HP',
  'MP',
  // Extraction sweep ids the canon_extractor prompt defines.
  'event-first',
  'entity-first',
]);

/**
 * Latin-script words in a Korean prompt that are neither identifiers nor model content: schema keys and
 * enum values, JSON keys of the prompt's own shape example, quoted or dashed ids (`"leaderboard"`,
 * `AC-LEN`), provenance tags, genre jargon Korean readers write in Latin (NTR), and words the model
 * produced earlier in the run.
 */
function englishLeaks(text: string, modelWords: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const jsonKeys = new Set([...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]));
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'’-]{2,}/g)) {
    const w = m[0].replace(/[’'-]+$/, '');
    const at = m.index;
    const before = text[at - 1] ?? '';
    const after = text[at + m[0].length] ?? '';
    if (before === '_' || after === '_' || /[0-9]/.test(before) || /[0-9]/.test(after)) continue;
    if (before === '"' && after === '"') continue;
    // Quoted examples of forbidden Latin words (‘OK’→‘좋아’) are the instruction, not a leak.
    if (before === '‘' && (after === '’' || m[0].endsWith('’'))) continue;
    // Enum alternatives ("a|b|c"), dotted identifiers (power.rank, pack.chapter_planner) and the
    // `new:<…>` proposition-ref form are identifiers.
    if (before === '|' || after === '|' || before === '.' || after === '.' || after === ':')
      continue;
    // Id fragments (`<uuid>#guard@1`).
    if (before === '#' || after === '@') continue;
    if (/^[A-Z]+(-[A-Z0-9]+)+$/.test(w) || w === 'NTR') continue;
    if (TAGS.has(w) || SCHEMA_WORDS.has(w) || SCHEMA_WORDS.has(w.toLowerCase())) continue;
    if (jsonKeys.has(w) || modelWords.has(w) || modelWords.has(m[0])) continue;
    out.push(
      `${w} ← “${text.slice(Math.max(0, at - 30), at + w.length + 30).replace(/\s+/g, ' ')}”`,
    );
  }
  return out;
}
