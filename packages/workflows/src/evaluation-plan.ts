/**
 * Evaluation orchestration (ADR-0060): which evaluators run for a version, how many at once, and how a
 * gated dimension's score is composed. All of it is read from the pinned Production Policy's `evaluation`
 * block; a policy without the block keeps the ADR-0056 behaviour (sequential, core evaluators only, the
 * judge's own 0–100 number, full re-evaluation after every patch).
 */
import { type Generated } from '@yeonjae/domain';
import { type NfcText, type Paragraph } from '@yeonjae/prose';
import { anchorIssueQuote } from './judge-normalize.js';

type Issue = Generated.IssueSchema.Issue;
type Scorecard = Generated.ScorecardSchema.Scorecard;
type ProductionPolicy = Generated.ProductionPolicySchema.ProductionPolicy;
export type EvaluationPolicy = NonNullable<ProductionPolicy['evaluation']>;

export type EvaluatorName =
  | 'contract_checker'
  | 'continuity_checker'
  | 'knowledge_leak_checker'
  | 'prose_judge'
  | 'structure_judge'
  | 'genre_judge'
  | 'voice_judge'
  | 'promise_checker'
  | 'repetition_judge';

/** The seven evaluators every policy runs, in the order their findings enter the scorecard. */
export const CORE_EVALUATORS: readonly EvaluatorName[] = [
  'contract_checker',
  'continuity_checker',
  'knowledge_leak_checker',
  'prose_judge',
  'structure_judge',
  'genre_judge',
  'voice_judge',
];

/** The issue dimension each evaluator reports on. */
export const EVALUATOR_DIMENSION: Readonly<Record<EvaluatorName, Issue['dimension']>> = {
  contract_checker: 'contract',
  continuity_checker: 'continuity',
  knowledge_leak_checker: 'knowledge',
  prose_judge: 'prose',
  structure_judge: 'structure',
  genre_judge: 'genre',
  voice_judge: 'voice',
  promise_checker: 'promise',
  repetition_judge: 'repetition',
};

export type GatedDimension = 'prose' | 'structure' | 'genre' | 'voice';

/** The judges' 1–5 rubric sub-scores: the keys their output shapes ask for (prompt families @4.x). */
export const RUBRIC_KEYS: Readonly<Record<GatedDimension, readonly string[]>> = {
  prose: ['idiomatic_korean', 'readability', 'register_fidelity', 'translation_markers'],
  structure: [
    'hook_timing',
    'dialogue_forwardness',
    'local_payoff',
    'ending_pull',
    'exposition_control',
  ],
  genre: ['reader_fantasy', 'device_correctness', 'vocabulary_register', 'taboo_restraint'],
  voice: ['distinguishability', 'verbal_habits', 'register_naturalness', 'register_consistency'],
};

/**
 * Run `tasks` with at most `limit` in flight; results keep the task order whatever the completion order.
 * After the first failure nothing new starts, the tasks already in flight are awaited, and the first
 * error is rethrown — so a failed evaluation never leaves provider calls running behind the step.
 */
export async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) continue;
      try {
        results[i] = await task();
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const width = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw failure.error;
  return results;
}

/** What the previous round left behind for a targeted re-evaluation. */
export interface EvaluationCarry {
  readonly scorecard: Scorecard;
  readonly versionText: string;
  readonly targetedDimension: Issue['dimension'];
  /** The patch declared changed claims or rewrote a scene: continuity and knowledge must re-run. */
  readonly changedClaims: boolean;
  /** Patches applied since every evaluator last ran on the whole chapter. */
  readonly patchesSinceFull: number;
}

export interface ReevaluationPlan {
  readonly mode: 'full' | 'targeted';
  readonly rerun: readonly EvaluatorName[];
  readonly carried: readonly EvaluatorName[];
}

/** Evaluators whose previous section or call id is missing from the parent scorecard. */
function sectionOf(scorecard: Scorecard, e: EvaluatorName): Record<string, unknown> | undefined {
  const key =
    e === 'contract_checker'
      ? 'contract_compliance'
      : e === 'promise_checker'
        ? 'promises'
        : e === 'repetition_judge'
          ? 'repetition'
          : EVALUATOR_DIMENSION[e];
  return (scorecard.sections as Record<string, Record<string, unknown> | undefined>)[key];
}

/**
 * Which evaluators re-run after a patch (ADR-0060, drift-detection §4). Full re-evaluation when the policy
 * says so, when there is no parent scorecard or when `smokeAfterPatches` patches have accumulated. Otherwise
 * the targeted dimension's evaluator re-runs; continuity and knowledge re-run when the patch changed
 * claims; the contract checker re-runs when claims changed or a criterion had failed; and any evaluator
 * re-runs whose carried findings no longer anchor in the new text or whose section the parent lacks.
 */
export function planReevaluation(input: {
  readonly evaluators: readonly EvaluatorName[];
  readonly reevaluation: 'full' | 'targeted';
  readonly carry?: EvaluationCarry | undefined;
  readonly smokeAfterPatches: number;
  readonly unanchored: ReadonlySet<EvaluatorName>;
}): ReevaluationPlan {
  const carry = input.carry;
  if (input.reevaluation === 'full' || !carry || carry.patchesSinceFull >= input.smokeAfterPatches)
    return { mode: 'full', rerun: [...input.evaluators], carried: [] };
  const failedCriterion = carry.scorecard.acceptance.criteria_results.some((c) => !c.passed);
  const rerun: EvaluatorName[] = [];
  const carried: EvaluatorName[] = [];
  for (const e of input.evaluators) {
    const section = sectionOf(carry.scorecard, e);
    const must =
      EVALUATOR_DIMENSION[e] === carry.targetedDimension ||
      (carry.changedClaims && (e === 'continuity_checker' || e === 'knowledge_leak_checker')) ||
      (e === 'contract_checker' && (carry.changedClaims || failedCriterion)) ||
      input.unanchored.has(e) ||
      !section ||
      typeof section.evaluator_call_id !== 'string';
    (must ? rerun : carried).push(e);
  }
  return { mode: 'targeted', rerun, carried };
}

/**
 * Re-anchor an earlier version's issues in the patched text. A quoted issue moves with its quote; an
 * unquoted one keeps its paragraphs only when their text is unchanged. `undefined` means at least one
 * issue no longer anchors, so its evaluator must re-run.
 */
export function reanchorIssues(
  issues: readonly Issue[],
  before: { readonly paragraphs: readonly Paragraph[] },
  after: { readonly text: NfcText; readonly paragraphs: readonly Paragraph[] },
): Issue['chapter_span'][] | undefined {
  const oldText = new Map(before.paragraphs.map((p) => [p.id, p.text]));
  const newText = new Map(after.paragraphs.map((p) => [p.id, p.text]));
  const out: Issue['chapter_span'][] = [];
  for (const i of issues) {
    const span = i.chapter_span;
    if (!span) {
      out.push(undefined);
      continue;
    }
    if (span.quote) {
      const found = anchorIssueQuote(after.text, after.paragraphs, span.quote);
      if (!found) return undefined;
      out.push({ ...span, ...found });
      continue;
    }
    const unchanged = (span.paragraph_ids ?? []).every(
      (id) => oldText.has(id) && oldText.get(id) === newText.get(id),
    );
    if (!unchanged) return undefined;
    out.push({ ...span });
  }
  return out;
}

/** The judge's rubric sub-scores on 0–100: missing keys count as 1, the lowest (fail closed). */
export function rubricScore(
  dimension: GatedDimension,
  scores: Readonly<Record<string, number>>,
): number {
  const keys = RUBRIC_KEYS[dimension];
  const mean =
    keys.reduce((a, k) => {
      const v = scores[k];
      return a + (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : 1);
    }, 0) / keys.length;
  return round1((mean - 1) * 25);
}

/** A dimension's deterministic composite: 100 minus the policy's points per deterministic finding. */
export function lintComposite(
  findings: readonly Pick<Issue, 'severity'>[],
  points: EvaluationPolicy['lint_penalty_points'],
): number {
  let score = 100;
  for (const f of findings)
    score -=
      f.severity === 'blocking'
        ? points.blocking
        : f.severity === 'major'
          ? points.major
          : f.severity === 'minor'
            ? points.minor
            : 0;
  return round1(Math.max(0, score));
}

/** judge_weight × rubric score + (1 − judge_weight) × deterministic composite (drift-detection §2). */
export function composeDimensionScore(
  judgeWeight: number,
  rubric: number,
  composite: number,
): number {
  const w = Math.max(0, Math.min(1, judgeWeight));
  return round1(w * rubric + (1 - w) * composite);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
