import { describe, expect, it } from 'vitest';
import { segmentParagraphs, toNfcText } from '@yeonjae/prose';
import {
  composeDimensionScore,
  CORE_EVALUATORS,
  lintComposite,
  planReevaluation,
  reanchorIssues,
  rubricScore,
  runBounded,
  type EvaluationCarry,
  type EvaluatorName,
} from './evaluation-plan.js';
import { type Issue, type Scorecard } from './evaluation.js';

const POINTS = { minor: 4, major: 15, blocking: 40 };

describe('runBounded (ADR-0060)', () => {
  it('keeps task order whatever the completion order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const task = (value: number, ms: number) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return value;
    };
    const out = await runBounded([task(1, 30), task(2, 5), task(3, 15), task(4, 1)], 2);
    expect(out).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('with a limit of one runs strictly in order (the ADR-0056 behaviour)', async () => {
    const order: number[] = [];
    const task = (n: number) => async () => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 1));
      return n;
    };
    await runBounded([task(1), task(2), task(3)], 1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('starts nothing after a failure, waits for what is in flight and rethrows the first error', async () => {
    const started: number[] = [];
    let settled = 0;
    const task =
      (n: number, fail = false) =>
      async () => {
        started.push(n);
        await new Promise((r) => setTimeout(r, n === 2 ? 20 : 1));
        settled++;
        if (fail) throw new Error(`boom ${n}`);
        return n;
      };
    await expect(runBounded([task(1, true), task(2), task(3), task(4)], 2)).rejects.toThrow(
      'boom 1',
    );
    expect(started).toEqual([1, 2]);
    expect(settled).toBe(2);
  });
});

function scorecard(partial: Partial<Scorecard> & { failedCriterion?: boolean } = {}): Scorecard {
  const section = (id: string) => ({
    score: 90,
    passed: true,
    issue_ids: [],
    evaluator_call_id: id,
  });
  const { failedCriterion, ...rest } = partial;
  return {
    id: '00000000-0000-8000-8000-000000000001',
    manuscript_version_id: '00000000-0000-8000-8000-000000000002',
    canon_version: 1,
    quality_tier: 'standard',
    overall: { score: 90, blocking_count: 0, major_count: 1, minor_count: 0, note_count: 0 },
    sections: {
      prose: section('00000000-0000-8000-8000-00000000000a'),
      structure: section('00000000-0000-8000-8000-00000000000b'),
      genre: section('00000000-0000-8000-8000-00000000000c'),
      voice: section('00000000-0000-8000-8000-00000000000d'),
      contract_compliance: section('00000000-0000-8000-8000-00000000000e'),
      continuity: section('00000000-0000-8000-8000-00000000000f'),
      knowledge: section('00000000-0000-8000-8000-000000000010'),
      promises: section('00000000-0000-8000-8000-000000000011'),
      repetition: section('00000000-0000-8000-8000-000000000012'),
    },
    issues: [],
    acceptance: {
      criteria_results: [{ criterion_id: 'AC-1', passed: !failedCriterion }],
      dimension_results: [],
      auto_approvable: false,
      production_policy_version: 'policy/standard@2',
      gate_outcome: 'rejected',
    },
    evaluator_calls: [],
    ...rest,
  } as Scorecard;
}

const ALL: EvaluatorName[] = [...CORE_EVALUATORS, 'promise_checker', 'repetition_judge'];
const carry = (over: Partial<EvaluationCarry> = {}): EvaluationCarry => ({
  scorecard: scorecard(),
  versionText: 'p',
  targetedDimension: 'prose',
  changedClaims: false,
  patchesSinceFull: 1,
  ...over,
});

describe('planReevaluation (ADR-0060, drift-detection §4)', () => {
  const plan = (
    c: EvaluationCarry | undefined,
    extra: Partial<Parameters<typeof planReevaluation>[0]> = {},
  ) =>
    planReevaluation({
      evaluators: ALL,
      reevaluation: 'targeted',
      carry: c,
      smokeAfterPatches: 3,
      unanchored: new Set(),
      ...extra,
    });

  it('re-runs only the targeted dimension after a claim-neutral patch', () => {
    const p = plan(carry());
    expect(p.mode).toBe('targeted');
    expect(p.rerun).toEqual(['prose_judge']);
    expect(p.carried).toHaveLength(ALL.length - 1);
  });

  it('re-runs continuity, knowledge and the contract checker when the patch changed claims', () => {
    expect(plan(carry({ changedClaims: true, targetedDimension: 'voice' })).rerun).toEqual([
      'contract_checker',
      'continuity_checker',
      'knowledge_leak_checker',
      'voice_judge',
    ]);
  });

  it('re-runs the contract checker while a criterion is failing', () => {
    const p = plan(carry({ scorecard: scorecard({ failedCriterion: true }) }));
    expect(p.rerun).toEqual(['contract_checker', 'prose_judge']);
  });

  it('re-runs an evaluator whose carried findings no longer anchor, or whose section is missing', () => {
    const sc = scorecard();
    const { repetition: _r, ...sections } = sc.sections;
    const p = plan(carry({ scorecard: { ...sc, sections } }), {
      unanchored: new Set<EvaluatorName>(['genre_judge']),
    });
    expect(p.rerun).toEqual(['prose_judge', 'genre_judge', 'repetition_judge']);
  });

  it('runs everything when the policy says full, without a parent, or after smoke_after_patches patches', () => {
    expect(plan(carry(), { reevaluation: 'full' })).toMatchObject({ mode: 'full', carried: [] });
    expect(plan(undefined)).toMatchObject({ mode: 'full', rerun: ALL });
    expect(plan(carry({ patchesSinceFull: 3 }))).toMatchObject({ mode: 'full', rerun: ALL });
  });
});

describe('reanchorIssues', () => {
  const before = toNfcText('첫 문단이다.\n\n“여기서 멈춰.” 레온이 말했다.\n\n마지막 문단이다.');
  const after = toNfcText('첫 문단을 고쳤다.\n\n“여기서 멈춰.” 레온이 말했다.\n\n마지막 문단이다.');
  const issue = (span: Issue['chapter_span']): Issue =>
    ({
      id: '00000000-0000-8000-8000-000000000003',
      source: 'judge:voice_judge',
      dimension: 'voice',
      kind: 'register_error',
      severity: 'minor',
      override_class: 'advisory',
      confidence: 0.8,
      claim: '말높이',
      status: 'open',
      chapter_span: span,
    }) as Issue;
  const b = { paragraphs: segmentParagraphs(before) };
  const a = { text: after, paragraphs: segmentParagraphs(after) };

  it('moves a quoted finding with its quote and keeps an unquoted one on an unchanged paragraph', () => {
    const spans = reanchorIssues(
      [
        issue({ manuscript_version_id: 'v1', paragraph_ids: ['p2'], quote: '“여기서 멈춰.”' }),
        issue({ manuscript_version_id: 'v1', paragraph_ids: ['p3'] }),
      ],
      b,
      a,
    );
    expect(spans?.[0]).toMatchObject({ paragraph_ids: ['p2'], quote: '“여기서 멈춰.”' });
    expect(spans?.[1]).toMatchObject({ paragraph_ids: ['p3'] });
  });

  it('refuses when a quote vanished or an unquoted paragraph changed', () => {
    expect(
      reanchorIssues(
        [issue({ manuscript_version_id: 'v1', paragraph_ids: ['p1'], quote: '첫 문단이다.' })],
        b,
        a,
      ),
    ).toBeUndefined();
    expect(
      reanchorIssues([issue({ manuscript_version_id: 'v1', paragraph_ids: ['p1'] })], b, a),
    ).toBeUndefined();
  });
});

describe('rubric scores and composites (drift-detection §2)', () => {
  it('maps the 1–5 rubric mean onto 0–100 and counts a missing key as 1', () => {
    expect(
      rubricScore('prose', {
        idiomatic_korean: 5,
        readability: 5,
        register_fidelity: 5,
        translation_markers: 5,
      }),
    ).toBe(100);
    expect(
      rubricScore('prose', { idiomatic_korean: 4, readability: 4, register_fidelity: 4 }),
    ).toBe(56.3);
    expect(rubricScore('voice', {})).toBe(0);
    expect(rubricScore('genre', { reader_fantasy: 9, device_correctness: -2 })).toBe(25);
  });

  it('takes the policy points per deterministic finding off 100, floored at 0', () => {
    expect(lintComposite([], POINTS)).toBe(100);
    expect(
      lintComposite([{ severity: 'minor' }, { severity: 'major' }, { severity: 'note' }], POINTS),
    ).toBe(81);
    expect(
      lintComposite(
        [{ severity: 'blocking' }, { severity: 'blocking' }, { severity: 'blocking' }],
        POINTS,
      ),
    ).toBe(0);
  });

  it('composes judge_weight × rubric + (1 − judge_weight) × composite', () => {
    expect(composeDimensionScore(0.6, 75, 100)).toBe(85);
    expect(composeDimensionScore(0.7, 50, 90)).toBe(62);
    expect(composeDimensionScore(1, 40, 0)).toBe(40);
  });
});
