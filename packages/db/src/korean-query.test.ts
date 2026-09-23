import { describe, expect, it } from 'vitest';
import { containsPattern, koreanQueryTerms, koreanStem } from './korean-query.js';

describe('Korean query normalization (ADR-0058)', () => {
  it('removes one trailing particle or ending, keeping at least two syllables', () => {
    expect(koreanStem('레온은')).toBe('레온');
    expect(koreanStem('레온의')).toBe('레온');
    expect(koreanStem('세라핀에게')).toBe('세라핀');
    expect(koreanStem('결투를')).toBe('결투');
    expect(koreanStem('마탑에서')).toBe('마탑');
    // Two syllables stay whole: the particle-like ending is part of the word.
    expect(koreanStem('최고')).toBe('최고');
    expect(koreanStem('빛이')).toBe('빛이');
    // Non-Hangul words are left alone.
    expect(koreanStem('HP')).toBe('HP');
  });

  it('turns a query into ordered, deduplicated content stems', () => {
    expect(koreanQueryTerms('레온의 결투 신청과 기숙사 방 판돈')).toEqual([
      '레온',
      '결투',
      '신청',
      '기숙사',
      '판돈',
    ]);
    expect(koreanQueryTerms('72시간 카운트다운 상태창이 처음 뜬 장면')).toEqual([
      '72시간',
      '카운트다운',
      '상태창',
      '처음',
    ]);
    expect(koreanQueryTerms('레온은 레온을 레온의')).toEqual(['레온']);
  });

  it('escapes LIKE metacharacters', () => {
    expect(containsPattern('100%_완료')).toBe('%100\\%\\_완료%');
  });
});
