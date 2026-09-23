/**
 * Deterministic Korean dialogue register check (ADR-0060). Every quoted utterance is split into sentences
 * and each sentence ending is classified as 합쇼체, 해요체 or 반말. An utterance that mixes a polite level
 * with 반말 inside one quotation is reported: it is the register slip readers notice first. The check never
 * attributes speakers (the voice judge does that from the narration), and it is a heuristic signal: an
 * ending it cannot place is left unclassified rather than guessed.
 */
import { type NfcText } from './nfc.js';
import { segmentParagraphs } from './paragraphs.js';

export type SpeechLevel = 'hapsyo' | 'haeyo' | 'banmal';

export interface DialogueRegisterReport {
  readonly utterances: number;
  /** Utterances with at least one classified sentence ending. */
  readonly classified: number;
  readonly by_level: Readonly<Record<SpeechLevel, number>>;
  readonly mixed: readonly {
    readonly paragraph_id: string;
    readonly quote: string;
    readonly levels: readonly SpeechLevel[];
  }[];
  /** mixed / classified (0 when nothing was classified). */
  readonly register_violation_rate: number;
}

const QUOTED = /“([^”]+)”/gu;
const SENTENCE = /[^.!?…~]+[.!?…~]*/gu;
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** 종성 index of ㅂ in a precomposed syllable. */
const JONG_BIEUP = 17;
/** Final syllables that close a 반말 (해체/해라체) sentence. One-syllable sentences are never classified. */
const BANMAL_FINALS = new Set(
  Array.from('다어아여야지냐니자라래게네군나걸든데대고까해워와줘봐가거서마렴구'),
);

function jongseong(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= HANGUL_BASE && cp <= HANGUL_LAST ? (cp - HANGUL_BASE) % 28 : -1;
}

/** The level of one sentence, from its last Hangul word; undefined when the ending is not a predicate. */
export function sentenceLevel(sentence: string): SpeechLevel | undefined {
  const words = sentence
    .replace(/[^\p{Script=Hangul}\s]/gu, ' ')
    .trim()
    .split(/\s+/u);
  const last = words[words.length - 1] ?? '';
  const syllables = Array.from(last);
  if (syllables.length < 2) return undefined;
  const end = syllables.slice(-2).join('');
  const before = syllables[syllables.length - 3] ?? '';
  if (/^(니다|니까)$/u.test(end)) {
    // 합쇼체 needs 습 or a ㅂ-final syllable before 니다/니까: 합니다, 갑니까 — not 그러니까.
    if (before === '습' || jongseong(before) === JONG_BIEUP) return 'hapsyo';
    return end === '니까' ? 'banmal' : undefined;
  }
  if (/(십시오|십시다|시지요)$/u.test(last)) return 'hapsyo';
  const final = syllables[syllables.length - 1] ?? '';
  if (final === '요' || final === '죠') return 'haeyo';
  if (BANMAL_FINALS.has(final)) return 'banmal';
  return undefined;
}

export function checkDialogueRegister(text: NfcText): DialogueRegisterReport {
  const byLevel: Record<SpeechLevel, number> = { hapsyo: 0, haeyo: 0, banmal: 0 };
  const mixed: { paragraph_id: string; quote: string; levels: SpeechLevel[] }[] = [];
  let utterances = 0;
  let classified = 0;
  for (const p of segmentParagraphs(text)) {
    for (const m of p.text.matchAll(QUOTED)) {
      utterances++;
      const levels = new Set<SpeechLevel>();
      for (const s of (m[1] ?? '').matchAll(SENTENCE)) {
        const level = sentenceLevel(s[0]);
        if (level) levels.add(level);
      }
      if (levels.size === 0) continue;
      classified++;
      for (const l of levels) byLevel[l]++;
      if (levels.has('banmal') && (levels.has('hapsyo') || levels.has('haeyo')))
        mixed.push({ paragraph_id: p.id, quote: m[0], levels: [...levels].sort() });
    }
  }
  return {
    utterances,
    classified,
    by_level: byLevel,
    mixed,
    register_violation_rate: classified ? Math.round((mixed.length / classified) * 1000) / 1000 : 0,
  };
}

const LEVEL_KO: Record<SpeechLevel, string> = { hapsyo: '합쇼체', haeyo: '해요체', banmal: '반말' };

/** The report as the voice judge reads it (Korean prompt surface). */
export function dialogueRegisterDigestKo(r: DialogueRegisterReport, maxMixed = 8): string {
  const lines = [
    `따옴표 발화 ${String(r.utterances)}개, 어미로 말높이를 판정한 발화 ${String(r.classified)}개: 합쇼체 ${String(r.by_level.hapsyo)}, 해요체 ${String(r.by_level.haeyo)}, 반말 ${String(r.by_level.banmal)}.`,
    r.mixed.length
      ? `한 발화 안에서 존대와 반말이 섞인 곳 ${String(r.mixed.length)}개 (비율 ${String(Math.round(r.register_violation_rate * 100))}%). 의도된 전환인지 실수인지 판단한다:`
      : '한 발화 안에서 존대와 반말이 섞인 곳은 없다.',
    ...r.mixed
      .slice(0, maxMixed)
      .map(
        (m) => `- [${m.paragraph_id}] ${m.quote} (${m.levels.map((l) => LEVEL_KO[l]).join('+')})`,
      ),
  ];
  return lines.join('\n');
}
