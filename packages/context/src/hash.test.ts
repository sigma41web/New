import { describe, expect, it } from 'vitest';
import {
  countKoreanChars,
  estimateTokens,
  estimatorFor,
  KOREAN_TOKEN_ESTIMATOR_ID,
  TOKEN_ESTIMATOR_ID,
} from './hash.js';

describe('token estimators (ADR-0059)', () => {
  const ko = '레온은 검을 뽑았다.\n“이번에는 도망치지 않아.”';

  it('counts Korean length in 자: spaces included, line breaks excluded', () => {
    expect(countKoreanChars(ko)).toBe(ko.length - 1);
    expect(countKoreanChars('가 나\r\n다')).toBe(4);
  });

  it('selects the estimator by manuscript language and names it', () => {
    expect(estimatorFor('ko').id).toBe(KOREAN_TOKEN_ESTIMATOR_ID);
    expect(estimatorFor('ko').estimate(ko)).toBe(countKoreanChars(ko));
    expect(estimatorFor('en').id).toBe(TOKEN_ESTIMATOR_ID);
    expect(estimatorFor('en').estimate('the gate opened')).toBe(estimateTokens('the gate opened'));
  });

  it('no longer undercounts Korean the way the word estimator does', () => {
    // Six eojeol → 8 English-estimated tokens for 26자 that real tokenizers count as ~18–28.
    expect(estimateTokens(ko)).toBeLessThan(estimatorFor('ko').estimate(ko) / 2);
  });
});
