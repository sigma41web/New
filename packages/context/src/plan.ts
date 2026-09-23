/**
 * Query planning (docs/04-memory-canon/04 §2.1). A deterministic plan derived from the Chapter Contract: which
 * entities, propositions, promises, time window and timeline to fetch, which knowledge guards apply, and
 * which English phrases to hand to lexical retrieval for distant events. The plan is hashed into the
 * manifest so two packs built from the same contract can be compared stage by stage.
 */
import { type StoryClock } from '@yeonjae/domain';
import { cmp, hashObject } from './hash.js';
import { type ChapterContract } from './types.js';

export interface QueryPlan {
  readonly chapterNo: number;
  readonly povCharacterId: string;
  readonly participantIds: readonly string[];
  readonly onPageIds: readonly string[];
  readonly mentionedIds: readonly string[];
  readonly locationIds: readonly string[];
  /** Items/abilities/organizations named by state deltas and progression. */
  readonly stateEntityIds: readonly string[];
  /** Every entity the pack should know about (union, sorted). */
  readonly allEntityIds: readonly string[];
  readonly timelineId: string;
  readonly clockStart: StoryClock;
  readonly clockEnd: StoryClock;
  readonly elapsedSincePrevious: string | undefined;
  readonly continuityRiskFactIds: readonly string[];
  readonly anchorFactIds: readonly string[];
  readonly guards: readonly {
    readonly characterId: string;
    readonly propositionIds: readonly string[];
  }[];
  readonly contractPropositionIds: readonly string[];
  readonly promises: readonly {
    readonly promiseId: string;
    readonly kind: 'open' | 'advance' | 'pay' | 'touch';
  }[];
  readonly previousChapterNo: number | undefined;
  /** Chapters whose accepted state is "recent" (k−3 … k−1). */
  readonly recentChapterNos: readonly number[];
  readonly plannedObjectives: readonly string[];
  /** English lexical queries for distant events, one per must_happen / risk / purpose phrase. */
  readonly lexicalQueries: readonly string[];
  readonly speakerPairs: readonly { readonly from: string; readonly to: string }[];
  readonly hash: string;
}

const STOP = new Set(
  'a an the and or but of to in on at for with by from as is are was were be been being this that these those it its into onto than then there their they them he she his her him we our you your not no do does did done has have had having will would can could should may might must about after before during while until when where who whom which what why how all any each every some such only own same so too very just also over under again further once here both few more most other into out up down off above below between through against'.split(
    ' ',
  ),
);

/** Lowercased content words, order preserved, duplicates removed; names keep their hyphens. */
export function keywordPhrase(text: string): string {
  const words = text
    .replace(/[“”"()[\]{}:;,.!?—–]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['’]+|['’]+$/g, ''))
    // Two-syllable Hangul words carry content (레온, 결투, 마탑); two Latin letters rarely do (ADR-0058).
    .filter((w) => (w.length > 2 || /^[가-힣]{2}$/u.test(w)) && !STOP.has(w.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out.slice(0, 12).join(' ');
}

function uniqSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(cmp);
}

export function buildQueryPlan(contract: ChapterContract): QueryPlan {
  const participantIds = uniqSorted(contract.participants.map((p) => p.character_id));
  const onPageIds = uniqSorted(
    contract.participants.filter((p) => p.on_page).map((p) => p.character_id),
  );
  const mentionedIds = uniqSorted(contract.mentioned_only ?? []);
  const locationIds = uniqSorted(contract.locations);
  const stateEntityIds = uniqSorted([
    ...contract.state_deltas.map((d) => d.entity_id),
    ...contract.must_happen.flatMap((m) => m.entity_ids ?? []),
  ]);
  const allEntityIds = uniqSorted([
    contract.pov.character_id,
    ...participantIds,
    ...mentionedIds,
    ...locationIds,
    ...stateEntityIds,
  ]);
  const guards = [...contract.knowledge_guards]
    .map((g) => ({
      characterId: g.character_id,
      propositionIds: uniqSorted(g.must_not_know_proposition_ids),
    }))
    .sort((a, b) => cmp(a.characterId, b.characterId));
  const contractPropositionIds = uniqSorted([
    ...contract.knowledge_deltas.flatMap((d) => (d.proposition_id ? [d.proposition_id] : [])),
    ...contract.must_happen.flatMap((m) => m.proposition_ids ?? []),
    ...guards.flatMap((g) => g.propositionIds),
  ]);
  const promises = [
    ...contract.setups.map((s) => ({
      promiseId: s.promise_id,
      kind: s.kind ?? ('touch' as const),
    })),
    ...contract.payoffs.map((s) => ({ promiseId: s.promise_id, kind: s.kind ?? ('pay' as const) })),
  ].sort((a, b) => cmp(a.promiseId, b.promiseId) || cmp(a.kind, b.kind));
  const k = contract.chapter_number;
  const recent: number[] = [];
  for (let c = Math.max(1, k - 3); c < k; c++) recent.push(c);
  const plannedObjectives = [
    `Purpose: ${contract.purpose}`,
    ...contract.must_happen.map((m) => `Must happen ${m.id} (${m.kind}): ${m.description}`),
    ...contract.must_not_happen.map((m) => `Must not happen ${m.id}: ${m.description}`),
    `Ending state: ${contract.ending_state}`,
    `Hook (${contract.hook.type}): ${contract.hook.description}`,
  ];
  const lexicalQueries = uniqSorted(
    [
      contract.purpose,
      ...contract.must_happen.map((m) => m.description),
      ...contract.continuity_risks.map((r) => r.description),
      ...contract.continuity_anchors.map((a) => a.statement),
    ]
      .map(keywordPhrase)
      .filter((q) => q.length > 0),
  );
  const speakerPairs: { from: string; to: string }[] = [];
  for (const a of onPageIds)
    for (const b of onPageIds) if (a !== b) speakerPairs.push({ from: a, to: b });
  const plan = {
    chapterNo: k,
    povCharacterId: contract.pov.character_id,
    participantIds,
    onPageIds,
    mentionedIds,
    locationIds,
    stateEntityIds,
    allEntityIds,
    timelineId: contract.timeline_id,
    clockStart: contract.story_time.start,
    clockEnd: contract.story_time.end,
    elapsedSincePrevious: contract.story_time.elapsed_since_previous,
    continuityRiskFactIds: uniqSorted(
      contract.continuity_risks.flatMap((r) => r.related_fact_ids ?? []),
    ),
    anchorFactIds: uniqSorted(contract.continuity_anchors.map((a) => a.fact_id)),
    guards,
    contractPropositionIds,
    promises,
    previousChapterNo: k > 1 ? k - 1 : undefined,
    recentChapterNos: recent,
    plannedObjectives,
    lexicalQueries,
    speakerPairs,
  };
  return { ...plan, hash: hashObject(plan) };
}
