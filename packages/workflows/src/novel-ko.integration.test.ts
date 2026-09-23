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
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import {
  Gateway,
  MemoryBudget,
  MockProvider,
  type Provider,
  type ProviderRequest,
} from '@yeonjae/gateway';
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
  const provider = new MockProvider((req) => {
    seen.push(req);
    return script(req);
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
  }, 300_000);
});

const EVALUATOR_ROLES = new Set([
  'contract_checker',
  'continuity_checker',
  'knowledge_leak_checker',
  'prose_judge',
  'structure_judge',
  'genre_judge',
  'voice_judge',
  'promise_checker',
  'repetition_judge',
]);

run('Korean novel run under standard.v2: evaluation v2 (ADR-0060)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  const seen: ProviderRequest[] = [];
  let inFlight = 0;
  let evaluatorPeak = 0;
  // Chapter 1's first prose judgment finds one 번역투 sentence, so one revision round runs and the
  // re-evaluation after the patch is targeted (ADR-0060): only the prose judge answers again.
  const flaggedSentence = (prompt: string) => {
    const p2 = /\n\[p2\] ([^\n]+)/.exec(prompt)?.[1] ?? '';
    return /^[^.!?…]+[.!?…]/.exec(p2)?.[0] ?? p2;
  };
  const mock = new MockProvider((req) => {
    seen.push(req);
    const activity = req.trace?.activityId ?? '';
    if (req.trace?.role === 'prose_judge' && activity.endsWith(':1:r0'))
      return {
        json: {
          judge_score: 60,
          dimension_scores: {
            idiomatic_korean: 2,
            readability: 3,
            register_fidelity: 3,
            translation_markers: 2,
          },
          drift_flags: [],
          issues: [
            {
              kind: 'translation_like_english',
              severity: 'major',
              confidence: 0.9,
              claim: '번역투 문장이다. 주어를 줄이고 동작으로 쓴다.',
              quote: flaggedSentence(req.user),
            },
          ],
        },
      };
    if (req.trace?.role === 'targeted_reviser') {
      const span = /\[수정할 구간\]\n([\s\S]*?)\n\n\[뒷 맥락\]/.exec(req.user)?.[1] ?? '';
      const sentence = /^[^.!?…]+[.!?…]/.exec(span.trim())?.[0] ?? span.trim();
      return {
        json: {
          scope: 'sentence',
          span: { original_quote: sentence },
          new_text: `문득 ${sentence}`,
          changed_claims: [],
          preserved_facts_ack: [],
          speaker_annotations: [],
        },
      };
    }
    return script(req);
  });
  // Evaluator answers take a few milliseconds, so parallel evaluation is observable as overlap.
  const provider: Provider = {
    name: 'mock',
    async complete(req, signal) {
      const evaluator = EVALUATOR_ROLES.has(req.trace?.role ?? '');
      if (evaluator) evaluatorPeak = Math.max(evaluatorPeak, ++inFlight);
      try {
        if (evaluator) await new Promise((r) => setTimeout(r, 10));
        return await mock.complete(req, signal);
      } finally {
        if (evaluator) inFlight--;
      }
    },
  };

  beforeAll(async () => {
    pool = await freshDatabase();
    workspaceId = await createWorkspace(pool, 'novel-ko-v2-e2e');
    ({ projectId } = await createProject(pool, {
      workspaceId,
      title: '재의 장부',
      operatingMode: 'autopilot',
      policyVersion: 'policy/standard@2',
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

  it('runs nine evaluators four at a time and gates on rubric sub-scores', async () => {
    const started = await startNovel(makeDeps(), { projectId, intake: INTAKE });
    await approveConcept(pool, {
      projectId,
      conceptId: started.concepts[0]?.id ?? '',
      autoContinue: true,
    });
    const runner = new NovelRunner({ pool, makeDeps, runnerId: 'ko-v2-runner', leaseSeconds: 30 });
    while (await runner.tick()) {
      const r = await getNovelRun(pool, projectId);
      if (r?.status === 'paused') await resumeNovelRun(pool, { projectId, autoContinue: true });
    }
    const after = await getNovelRun(pool, projectId);
    expect(after?.last_error ?? null).toBeNull();
    expect(after?.status).toBe('completed');

    // Both optional evaluators ran for every chapter, and evaluators overlapped (max_parallel_evaluators 4).
    const roles = (role: string) => seen.filter((r) => r.trace?.role === role);
    expect(roles('promise_checker')).toHaveLength(2);
    expect(roles('repetition_judge')).toHaveLength(2);
    expect(evaluatorPeak).toBeGreaterThan(1);
    expect(evaluatorPeak).toBeLessThanOrEqual(4);

    // Every evaluator read its own inputs: the voice judge its own rubric and a register report, the
    // repetition judge chapter 1's opening when judging chapter 2, the knowledge checker separate slots.
    const voice = roles('voice_judge')[0];
    expect(voice?.system).toMatch(/role=judge_rubric_voice/);
    expect(voice?.user).toMatch(/\[말높이 검사 보고 — 결정적 검사\]\n따옴표 발화 \d+개/);
    const repetition = roles('repetition_judge').map((r) => r.user);
    expect(repetition[0]).toMatch(/비교할 이전 화가 없다/);
    expect(repetition[1]).toMatch(/\[1화 — 도입\]/);
    const leak = roles('knowledge_leak_checker')[0]?.user ?? '';
    expect(leak).toMatch(/\[지식 입장/);
    expect(leak).toMatch(/\[독자에게 아직 밝히면 안 되는 비밀/);
    const continuity = roles('continuity_checker')[0]?.user ?? '';
    // The timeline section reaches the continuity checker once (it was sent twice before ADR-0060).
    const titles = [
      '타임라인 위치 — 현실 프레임과 고정값',
      'TIMELINE POSITION — reality frame and pins',
    ];
    expect(titles.reduce((n, t) => n + continuity.split(t).length - 1, 0)).toBe(1);
    expect(continuity).toMatch(/\[잠긴 사실 — 절대 어기면 안 되는 정사\]/);

    // The re-evaluation after chapter 1's patch was targeted: only the prose judge answered again, the
    // other evaluators' findings were carried from the parent version's scorecard.
    const round1 = seen
      .filter((r) => EVALUATOR_ROLES.has(r.trace?.role ?? ''))
      .filter((r) => (r.trace?.activityId ?? '').endsWith(':1:r1'))
      .map((r) => r.trace?.role);
    expect(round1).toEqual(['prose_judge']);

    // Gated dimensions are composed from the rubric sub-scores and the deterministic composites.
    const cards = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_artifacts
        WHERE project_id = $1 AND step = 'evaluate' AND kind = 'scorecard' ORDER BY created_at`,
      [projectId],
    );
    expect(cards.rows.length).toBe(3);
    const [first, revised] = cards.rows.map((r) => r.payload);
    const revisedSections = (revised?.sections ?? {}) as Record<string, Record<string, unknown>>;
    expect(revised?.evaluator_calls).toHaveLength(1);
    expect(revisedSections.continuity?.carried_from).toBe(first?.id);
    expect(revisedSections.voice?.carried_from).toBe(first?.id);
    expect(revisedSections.prose?.carried_from).toBeUndefined();
    expect(
      (revisedSections.prose?.score as number) >
        ((first?.sections as Record<string, Record<string, number>>).prose?.score ?? 100),
    ).toBe(true);
    for (const { payload } of cards.rows) {
      const sections = payload.sections as Record<string, Record<string, unknown>>;
      expect(Object.keys(sections)).toEqual(expect.arrayContaining(['promises', 'repetition']));
      const prose = sections.prose ?? {};
      expect(prose.score_model).toBe('rubric_subscores');
      // idiomatic 4, readability 5, register 4, markers 5 → mean 4.5 → 87.5 (the flagged first
      // judgment: 2, 3, 3, 2 → 37.5); judge_weight 0.6.
      expect(prose.rubric_score).toBe(payload === first ? 37.5 : 87.5);
      expect(prose.judge_weight).toBe(0.6);
      expect(prose.score).toBe(
        Math.round(
          (0.6 * (prose.rubric_score as number) + 0.4 * (prose.lint_composite as number)) * 10,
        ) / 10,
      );
      expect(prose.judge_score).toBe(payload === first ? 60 : 86);
      expect(typeof sections.voice?.register_violation_rate).toBe('number');
      expect(typeof sections.genre?.terminology_compliance).toBe('number');
    }
  }, 300_000);
});
