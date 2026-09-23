import { describe, expect, it } from 'vitest';
import { toNfcText } from './nfc.js';
import { repetitionDigestKo, repetitionReport } from './repetition.js';

const CH1 = [
  '눈을 떴을 때 천장은 낯선 회색이었다.',
  '레온은 숨을 고르며 손가락을 하나씩 접어 보았다.',
  '[이름: 레온 / 레벨: 1]',
  '“오늘도 살아남는다. 그게 전부다.”',
].join('\n\n');

const CH2 = [
  '눈을 떴을 때 천장은 낯선 회색이었다.',
  '레온은 숨을 고르며 손가락을 하나씩 접어 보았다. 이번에는 다섯 개가 전부 움직였다.',
  '[이름: 레온 / 레벨: 1]',
  '그는 문을 열었다. 그는 복도를 걸었다. 그는 계단 앞에서 멈췄다.',
].join('\n\n');

describe('repetitionReport (ADR-0060)', () => {
  const r = repetitionReport(toNfcText(CH2), [{ chapter_no: 1, text: CH1 }]);

  it('finds verbatim passages and sentences reused from an earlier chapter', () => {
    expect(r.prior_chapters).toEqual([1]);
    expect(r.repeated_sentences.map((s) => s.paragraph_id)).toEqual(['p1', 'p2']);
    expect(r.repeated_passages[0]).toMatchObject({ paragraph_id: 'p1', chapters: [1] });
    expect(r.overlap_ratio).toBeGreaterThan(0.3);
  });

  it('skips status windows, which repeat by design', () => {
    expect(r.repeated_passages.some((p) => p.quote.includes('레벨'))).toBe(false);
  });

  it('measures opening similarity and the sentence openings the chapter leans on', () => {
    expect(r.opening_similarity[0]?.jaccard).toBeGreaterThan(0.3);
    expect(r.sentence_openings).toEqual([{ opening: '그는', count: 3 }]);
  });

  it('reports a first chapter as having nothing to compare', () => {
    const first = repetitionReport(toNfcText(CH1), []);
    expect(first).toMatchObject({
      overlap_ratio: 0,
      repeated_passages: [],
      repeated_sentences: [],
    });
    expect(repetitionDigestKo(first)).toContain('첫 화');
  });

  it('renders a Korean digest', () => {
    const digest = repetitionDigestKo(r);
    expect(digest).toContain('비교한 이전 화: 1화');
    expect(digest).toContain('‘그는’ 3회');
    // Paragraph ids are identifiers; everything else is Korean.
    expect(digest.replace(/\[p\d+\]/g, '')).not.toMatch(/[A-Za-z]/);
  });
});
