/**
 * Deterministic English renderers for canon rows and the Chapter Contract (docs/04-memory-canon/04 §2.4). No
 * LLM is involved; every renderer is a pure function of its inputs so identical rows give identical bytes.
 * Plans are always rendered under a PLANNED label and in the conditional mood ("must happen"), never as
 * events that occurred.
 */
import { elapsedDays, type StoryClock } from '@yeonjae/domain';
import { countWords } from './hash.js';
import { type ChapterContract } from './types.js';

export type NameOf = (id: string) => string;

export function clockLabel(c: StoryClock | null | undefined): string {
  if (!c) return 'open';
  const world = c.world_date ? ` (${c.world_date}${c.precision === 'approx' ? ' ±' : ''})` : '';
  return `ch.${c.chapter_no}.${c.ordinal}${world}`;
}

export function trimQuote(quote: string, maxWords = 60): string {
  const words = quote.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return quote;
  return `${words.slice(0, maxWords).join(' ')} …`;
}

export function valueLabel(value: unknown, valueText: string | null | undefined): string {
  if (valueText) return valueText;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function attributeLabel(attribute: string, key: string | null | undefined): string {
  return key ? `${attribute}[${key}]` : attribute;
}

export interface RegisterLike {
  formality?: number | undefined;
  deference?: number | undefined;
  familiarity?: number | undefined;
  intimacy?: number | undefined;
  directness?: number | undefined;
  contractions?: string | undefined;
  hedging?: string | undefined;
  address_terms?: string[] | undefined;
  titles?: string[] | undefined;
}

export function registerLabel(r: RegisterLike | null | undefined): string {
  if (!r) return 'register unspecified';
  const parts: string[] = [];
  for (const k of ['formality', 'deference', 'familiarity', 'intimacy', 'directness'] as const) {
    const v = r[k];
    if (v !== undefined) parts.push(`${k} ${v}`);
  }
  if (r.contractions) parts.push(`contractions ${r.contractions}`);
  if (r.hedging) parts.push(`hedging ${r.hedging}`);
  if (r.address_terms?.length)
    parts.push(`address terms: ${r.address_terms.map((t) => `"${t}"`).join(', ')}`);
  if (r.titles?.length) parts.push(`titles: ${r.titles.map((t) => `"${t}"`).join(', ')}`);
  return parts.join('; ');
}

export function elapsedLabel(from: StoryClock | undefined, to: StoryClock): string | undefined {
  if (!from) return undefined;
  const e = elapsedDays(from, to);
  if (!e.comparable) return undefined;
  const days = Math.round(e.days * 10) / 10;
  return `${days} day${days === 1 ? '' : 's'} of story time (${from.world_date ?? '?'} → ${to.world_date ?? '?'})`;
}

/** The Chapter Contract as PLANNED text: objectives, not history. */
export function renderContract(c: ChapterContract, nameOf: NameOf): string {
  const lines: string[] = [];
  lines.push(
    `Chapter ${c.chapter_number} contract v${c.version} (${c.status}) — everything below is PLANNED and has not happened yet.`,
  );
  lines.push(`Purpose: ${c.purpose}`);
  if (c.reader_experience) lines.push(`Reader experience: ${c.reader_experience}`);
  if (c.arc_objective_contribution) lines.push(`Arc contribution: ${c.arc_objective_contribution}`);
  // Ids travel with the names: downstream planners must copy participant, POV and location ids
  // verbatim, and a model can only copy what it was shown.
  const withId = (id: string) => `${nameOf(id)} (id ${id})`;
  lines.push(
    `POV: ${withId(c.pov.character_id)} (${c.pov.person.replace('_', ' ')}). Participants: ${c.participants
      .map(
        (p) => `${withId(p.character_id)} [${p.role_in_chapter}${p.on_page ? '' : ', off-page'}]`,
      )
      .join('; ')}.`,
  );
  if (c.mentioned_only?.length)
    lines.push(`Mentioned only: ${c.mentioned_only.map(nameOf).join(', ')}.`);
  lines.push(`Locations: ${c.locations.map(withId).join(', ') || '—'}.`);
  lines.push(
    `Story time: ${clockLabel(c.story_time.start)} → ${clockLabel(c.story_time.end)}${
      c.story_time.elapsed_since_previous
        ? `; since previous chapter: ${c.story_time.elapsed_since_previous}`
        : ''
    }.`,
  );
  lines.push('Must happen (PLANNED):');
  for (const m of c.must_happen)
    lines.push(`- ${m.id} (${m.kind}; verified by ${m.verifiable_by}): ${m.description}`);
  lines.push('Must NOT happen:');
  for (const m of c.must_not_happen)
    lines.push(
      `- ${m.id} [${m.source}${m.requirement_id ? ` ${m.requirement_id}` : ''}]: ${m.description}`,
    );
  if (c.state_deltas.length) {
    lines.push('Planned state changes (PLANNED — not yet true):');
    for (const d of c.state_deltas)
      lines.push(
        `- ${nameOf(d.entity_id)} · ${attributeLabel(d.attribute, d.key)}: ${valueLabel(d.from, undefined)} → ${valueLabel(d.to, undefined)}${
          d.when_in_chapter ? ` (${d.when_in_chapter})` : ''
        }${d.description ? ` — ${d.description}` : ''}`,
      );
  }
  if (c.knowledge_deltas.length) {
    lines.push('Planned knowledge changes (PLANNED — require an on-page channel):');
    for (const d of c.knowledge_deltas) {
      const who =
        d.knower.kind === 'character' && d.knower.entity_id
          ? nameOf(d.knower.entity_id)
          : d.knower.kind;
      lines.push(
        `- ${who}: ${d.from_stance} → ${d.to_stance}${d.proposition_id ? ` on ${d.proposition_id}` : ''} — ${d.how}`,
      );
    }
  }
  if (c.relationship_deltas.length) {
    lines.push('Planned relationship changes (PLANNED):');
    for (const d of c.relationship_deltas)
      lines.push(
        `- ${nameOf(d.from_id)} → ${nameOf(d.to_id)}: ${d.axis} ${d.direction}${d.new_type ? ` to ${d.new_type}` : ''}${
          d.address_term_change?.length
            ? `; address terms → ${d.address_term_change.map((t) => `"${t}"`).join(', ')}`
            : ''
        }${d.description ? ` — ${d.description}` : ''}`,
      );
  }
  if (c.setups.length || c.payoffs.length) {
    lines.push('Promises touched (PLANNED):');
    for (const s of c.setups) lines.push(`- setup/${s.kind ?? 'touch'} ${s.promise_id}: ${s.how}`);
    for (const s of c.payoffs) lines.push(`- payoff/${s.kind ?? 'pay'} ${s.promise_id}: ${s.how}`);
  }
  if (c.progression?.milestone_id)
    lines.push(
      `Progression: ${c.progression.milestone_id} (${c.progression.magnitude ?? 'minor'}) via ${c.progression.mechanism ?? '—'}.`,
    );
  lines.push(
    `Emotional movement: ${c.emotional_movement.start} → ${c.emotional_movement.peak ? `${c.emotional_movement.peak} → ` : ''}${c.emotional_movement.end}.`,
  );
  lines.push(
    `Conflict (${c.conflict.type}): ${c.conflict.description}${c.conflict.reversal ? ` Reversal: ${c.conflict.reversal}` : ''}`,
  );
  lines.push(
    `Local satisfaction: ${c.local_satisfaction.map((s) => `${s.type} — ${s.description}`).join('; ')}.`,
  );
  lines.push(`Opening (${c.opening.type}): ${c.opening.description}`);
  lines.push(`Ending state (PLANNED): ${c.ending_state}`);
  lines.push(
    `Hook (${c.hook.type}): ${c.hook.description}${c.hook.question_raised ? ` Question raised: ${c.hook.question_raised}` : ''}`,
  );
  lines.push(
    `Shape: ${c.scene_count} scenes; dialogue density target ${c.dialogue_density_target}; length ${c.length_target.value} ${c.length_target.unit} ±${Math.round(
      (c.length_target.tolerance_ratio ?? 0) * 100,
    )}%.`,
  );
  if (c.continuity_risks.length) {
    lines.push('Continuity risks:');
    for (const r of c.continuity_risks)
      lines.push(`- ${r.description}${r.mitigation ? ` (mitigation: ${r.mitigation})` : ''}`);
  }
  if (c.continuity_anchors.length) {
    lines.push('Continuity anchors (canon the chapter depends on):');
    for (const a of c.continuity_anchors)
      lines.push(
        `- ${a.statement}${a.evidence?.length ? ` — evidence ch.${a.evidence[0]?.chapter_no ?? '?'} ${a.evidence[0]?.paragraph_id ?? ''} “${trimQuote(a.evidence[0]?.quote ?? '')}”` : ''}`,
      );
  }
  lines.push(
    `Acceptance criteria: ${c.acceptance_criteria.map((a) => `${a.id} (${a.kind}${a.threshold !== undefined ? ` ≥ ${a.threshold}` : ''})`).join(', ')}.`,
  );
  return lines.join('\n');
}

/** Chapter text with stable paragraph ids for checkers/extractors. */
export function renderWithParagraphIds(
  paragraphs: readonly { id: string; text: string }[],
): string {
  return paragraphs.map((p) => `[${p.id}] ${p.text}`).join('\n\n');
}

export function wordsOf(text: string): number {
  return countWords(text);
}

// ---------------------------------------------------------------------------------------------------------
// Korean renderers (ADR-0055). Same inputs, same determinism; used when the pack's manuscript language is ko.
// ---------------------------------------------------------------------------------------------------------

export const STANCE_KO: Readonly<Record<string, string>> = {
  knows: '앎',
  suspects: '의심',
  believes_false: '잘못 믿음',
  pretends: '가장함',
  unaware: '모름',
  forgot: '잊음',
  doubts: '의혹',
};

const PERSON_KO: Readonly<Record<string, string>> = {
  first: '1인칭',
  third_limited: '밀착 3인칭',
  third_omniscient: '전지적 3인칭',
};

const WHEN_KO: Readonly<Record<string, string>> = { early: '초반', middle: '중반', late: '후반' };

/**
 * The topic particle a Korean word takes: 은 after a final consonant (받침), 는 otherwise. A word that does
 * not end in a Hangul syllable keeps the neutral 은(는).
 */
export function topicParticleKo(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '은(는)';
  return code % 28 === 0 ? '는' : '은';
}

export function clockLabelKo(c: StoryClock | null | undefined): string {
  if (!c) return '미정';
  const world = c.world_date ? ` (${c.world_date}${c.precision === 'approx' ? ' 무렵' : ''})` : '';
  return `${c.chapter_no}화.${c.ordinal}${world}`;
}

export function registerLabelKo(r: RegisterLike | null | undefined): string {
  if (!r) return '말높이 미지정';
  const names: Record<string, string> = {
    formality: '격식',
    deference: '존대',
    familiarity: '친밀',
    intimacy: '애정',
    directness: '직설',
  };
  const parts: string[] = [];
  for (const k of ['formality', 'deference', 'familiarity', 'intimacy', 'directness'] as const) {
    const v = r[k];
    if (v !== undefined) parts.push(`${names[k]} ${v}`);
  }
  if (r.address_terms?.length)
    parts.push(`호칭: ${r.address_terms.map((t) => `"${t}"`).join(', ')}`);
  if (r.titles?.length) parts.push(`직함: ${r.titles.map((t) => `"${t}"`).join(', ')}`);
  return parts.join('; ');
}

export function elapsedLabelKo(from: StoryClock | undefined, to: StoryClock): string | undefined {
  if (!from) return undefined;
  const e = elapsedDays(from, to);
  if (!e.comparable) return undefined;
  const days = Math.round(e.days * 10) / 10;
  return `이야기 시간 ${days}일 경과 (${from.world_date ?? '?'} → ${to.world_date ?? '?'})`;
}

/** 회차 계약을 PLANNED 텍스트로: 목표일 뿐 일어난 역사가 아니다. */
export function renderContractKo(c: ChapterContract, nameOf: NameOf): string {
  const lines: string[] = [];
  lines.push(
    `${c.chapter_number}화 계약 v${c.version} (${c.status}) — 아래는 모두 PLANNED이며 아직 일어나지 않았다.`,
  );
  lines.push(`목적: ${c.purpose}`);
  if (c.reader_experience) lines.push(`독자 경험: ${c.reader_experience}`);
  if (c.arc_objective_contribution) lines.push(`아크 기여: ${c.arc_objective_contribution}`);
  const withId = (id: string) => `${nameOf(id)} (id ${id})`;
  lines.push(
    `시점: ${withId(c.pov.character_id)} (${PERSON_KO[c.pov.person] ?? c.pov.person}). 참여자: ${c.participants
      .map((p) => `${withId(p.character_id)} [${p.role_in_chapter}${p.on_page ? '' : ', 지면 밖'}]`)
      .join('; ')}.`,
  );
  if (c.mentioned_only?.length) lines.push(`언급만: ${c.mentioned_only.map(nameOf).join(', ')}.`);
  lines.push(`장소: ${c.locations.map(withId).join(', ') || '—'}.`);
  lines.push(
    `스토리 시간: ${clockLabelKo(c.story_time.start)} → ${clockLabelKo(c.story_time.end)}${
      c.story_time.elapsed_since_previous
        ? `; 직전 회차 이후: ${c.story_time.elapsed_since_previous}`
        : ''
    }.`,
  );
  lines.push('반드시 일어날 일 (PLANNED):');
  for (const m of c.must_happen) lines.push(`- ${m.id} (${m.kind}): ${m.description}`);
  lines.push('절대 일어나면 안 되는 일:');
  for (const m of c.must_not_happen)
    lines.push(
      `- ${m.id} [${m.source}${m.requirement_id ? ` ${m.requirement_id}` : ''}]: ${m.description}`,
    );
  if (c.state_deltas.length) {
    lines.push('계획된 상태 변화 (PLANNED — 아직 사실 아님):');
    for (const d of c.state_deltas)
      lines.push(
        `- ${nameOf(d.entity_id)} · ${attributeLabel(d.attribute, d.key)}: ${valueLabel(d.from, undefined)} → ${valueLabel(d.to, undefined)}${
          d.when_in_chapter ? ` (${WHEN_KO[d.when_in_chapter] ?? d.when_in_chapter})` : ''
        }${d.description ? ` — ${d.description}` : ''}`,
      );
  }
  if (c.knowledge_deltas.length) {
    lines.push('계획된 지식 변화 (PLANNED — 지면 위의 전달 경로가 필요):');
    for (const d of c.knowledge_deltas) {
      const who =
        d.knower.kind === 'character' && d.knower.entity_id
          ? nameOf(d.knower.entity_id)
          : d.knower.kind;
      lines.push(
        `- ${who}: ${STANCE_KO[d.from_stance] ?? d.from_stance} → ${STANCE_KO[d.to_stance] ?? d.to_stance}${d.proposition_id ? ` (${d.proposition_id})` : ''} — ${d.how}`,
      );
    }
  }
  if (c.relationship_deltas.length) {
    lines.push('계획된 관계 변화 (PLANNED):');
    for (const d of c.relationship_deltas)
      lines.push(
        `- ${nameOf(d.from_id)} → ${nameOf(d.to_id)}: ${d.axis} ${d.direction}${d.new_type ? ` → ${d.new_type}` : ''}${
          d.address_term_change?.length
            ? `; 호칭 변화 → ${d.address_term_change.map((t) => `"${t}"`).join(', ')}`
            : ''
        }${d.description ? ` — ${d.description}` : ''}`,
      );
  }
  if (c.setups.length || c.payoffs.length) {
    lines.push('다루는 약속·복선 (PLANNED):');
    for (const s of c.setups) lines.push(`- 설치/${s.kind ?? 'touch'} ${s.promise_id}: ${s.how}`);
    for (const s of c.payoffs) lines.push(`- 회수/${s.kind ?? 'pay'} ${s.promise_id}: ${s.how}`);
  }
  if (c.progression?.milestone_id)
    lines.push(
      `성장: ${c.progression.milestone_id} (${c.progression.magnitude ?? 'minor'}) — 방식: ${c.progression.mechanism ?? '—'}.`,
    );
  lines.push(
    `감정 이동: ${c.emotional_movement.start} → ${c.emotional_movement.peak ? `${c.emotional_movement.peak} → ` : ''}${c.emotional_movement.end}.`,
  );
  lines.push(
    `갈등 (${c.conflict.type}): ${c.conflict.description}${c.conflict.reversal ? ` 반전: ${c.conflict.reversal}` : ''}`,
  );
  lines.push(
    `로컬 보상: ${c.local_satisfaction.map((s) => `${s.type} — ${s.description}`).join('; ')}.`,
  );
  lines.push(`도입 (${c.opening.type}): ${c.opening.description}`);
  lines.push(`회차 종료 상태 (PLANNED): ${c.ending_state}`);
  lines.push(
    `절단 (${c.hook.type}): ${c.hook.description}${c.hook.question_raised ? ` 남기는 질문: ${c.hook.question_raised}` : ''}`,
  );
  lines.push(
    `형태: 장면 ${c.scene_count}개; 대사 밀도 목표 ${c.dialogue_density_target}; 분량 ${c.length_target.value}${c.length_target.unit === 'characters' ? '자' : ` ${c.length_target.unit}`} ±${Math.round(
      (c.length_target.tolerance_ratio ?? 0) * 100,
    )}%.`,
  );
  if (c.tone_notes?.length) lines.push(`톤: ${c.tone_notes.join('; ')}`);
  if (c.continuity_risks.length) {
    lines.push('연속성 위험:');
    for (const r of c.continuity_risks)
      lines.push(`- ${r.description}${r.mitigation ? ` (대응: ${r.mitigation})` : ''}`);
  }
  if (c.continuity_anchors.length) {
    lines.push('연속성 앵커 (이 회차가 기대는 정사):');
    for (const a of c.continuity_anchors)
      lines.push(
        `- ${a.statement}${a.evidence?.length ? ` — 근거 ${a.evidence[0]?.chapter_no ?? '?'}화 ${a.evidence[0]?.paragraph_id ?? ''} “${trimQuote(a.evidence[0]?.quote ?? '')}”` : ''}`,
      );
  }
  lines.push(
    `수용 기준: ${c.acceptance_criteria.map((a) => `${a.id} (${a.kind}${a.threshold !== undefined ? ` ≥ ${a.threshold}` : ''})`).join(', ')}.`,
  );
  return lines.join('\n');
}
