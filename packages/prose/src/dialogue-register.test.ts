import { describe, expect, it } from 'vitest';
import {
  checkDialogueRegister,
  dialogueRegisterDigestKo,
  sentenceLevel,
} from './dialogue-register.js';
import { toNfcText } from './nfc.js';

describe('sentenceLevel (ADR-0060 register check)', () => {
  it('places 합쇼체, 해요체 and 반말 endings', () => {
    expect(sentenceLevel('보고서는 제가 올리겠습니다.')).toBe('hapsyo');
    expect(sentenceLevel('지금 갑니까?')).toBe('hapsyo');
    expect(sentenceLevel('자리에 앉으십시오.')).toBe('hapsyo');
    expect(sentenceLevel('그건 제가 할게요.')).toBe('haeyo');
    expect(sentenceLevel('벌써 끝났죠?')).toBe('haeyo');
    expect(sentenceLevel('그건 내가 할게.')).toBe('banmal');
    expect(sentenceLevel('빨리 따라와!')).toBe('banmal');
    expect(sentenceLevel('내가 간다니까!')).toBe('banmal');
  });

  it('leaves one-word answers, vocatives without a predicate and 그러니까 filler unplaced or 반말 as written', () => {
    expect(sentenceLevel('네.')).toBeUndefined();
    expect(sentenceLevel('선배님!')).toBeUndefined();
    expect(sentenceLevel('그러니까.')).toBe('banmal');
  });
});

describe('checkDialogueRegister', () => {
  const text = toNfcText(
    [
      '“오늘 훈련은 여기까지입니다. 수고하셨습니다.”',
      '교관이 등을 돌렸다.',
      '“야, 너 방금 봤어? 아, 아니에요. 죄송합니다.”',
      '“괜찮아. 신경 쓰지 마.”',
    ].join('\n\n'),
  );

  it('counts levels per utterance and reports polite-and-반말 mixing inside one quotation', () => {
    const r = checkDialogueRegister(text);
    expect(r.utterances).toBe(3);
    expect(r.classified).toBe(3);
    expect(r.by_level).toEqual({ hapsyo: 2, haeyo: 1, banmal: 2 });
    expect(r.mixed).toHaveLength(1);
    expect(r.mixed[0]?.paragraph_id).toBe('p3');
    expect(r.mixed[0]?.levels).toEqual(['banmal', 'haeyo', 'hapsyo']);
    expect(r.register_violation_rate).toBeCloseTo(0.333, 3);
  });

  it('renders a Korean digest that cites the paragraph', () => {
    const digest = dialogueRegisterDigestKo(checkDialogueRegister(text));
    expect(digest).toContain('따옴표 발화 3개');
    expect(digest).toContain('[p3]');
    expect(digest).toContain('반말+해요체+합쇼체');
    // Paragraph ids are identifiers; everything else is Korean.
    expect(digest.replace(/\[p\d+\]/g, '')).not.toMatch(/[A-Za-z]/);
  });

  it('reports nothing for narration without dialogue', () => {
    const r = checkDialogueRegister(toNfcText('비가 그쳤다.\n\n레온은 창문을 닫았다.'));
    expect(r).toMatchObject({ utterances: 0, classified: 0, register_violation_rate: 0 });
  });
});
