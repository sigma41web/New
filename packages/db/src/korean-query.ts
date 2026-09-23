/**
 * Korean query normalization for lexical retrieval (ADR-0058).
 *
 * Korean attaches particles and verbal endings to the word, so the words of a query rarely appear in the
 * text in the same form (query 레온의 결투, text 레온은 결투를 신청했다). Each query word is reduced to a stem
 * by removing ONE trailing particle or common ending, longest first, only while at least two syllables
 * remain — 레온은 → 레온, but 최고 stays 최고. Stems are then matched as substrings of the indexed text,
 * which also covers the longer inflected forms in the text. Deterministic and dictionary-free: no
 * morphological analysis runs in the pipeline.
 */

// Case and auxiliary particles, copula forms and frequent endings. Longest-first matching.
const SUFFIXES = [
  '이었다',
  '이라는',
  '이라고',
  '에게서',
  '으로서',
  '으로써',
  '에서는',
  '에게는',
  '까지는',
  '부터는',
  '께서',
  '에서',
  '에게',
  '한테',
  '으로',
  '이랑',
  '까지',
  '부터',
  '조차',
  '마저',
  '처럼',
  '보다',
  '하고',
  '이나',
  '이며',
  '이고',
  '이다',
  '였다',
  '했다',
  '한다',
  '된다',
  '하는',
  '되는',
  '하며',
  '해서',
  '라는',
  '이란',
  '에는',
  '와의',
  '과의',
  '으로의',
  '로의',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '께',
  '로',
  '와',
  '과',
  '랑',
  '도',
  '만',
  '나',
  '며',
].sort((a, b) => b.length - a.length);

// Query-phrasing words that name no story content.
const STOP = new Set([
  '장면',
  '사실',
  '것',
  '수',
  '등',
  '때',
  '중',
  '및',
  '그',
  '저',
  '더',
  '좀',
  '매우',
  '정말',
  '내용',
  '부분',
]);

const WORD = /[0-9A-Za-z가-힣]+/gu;
const HANGUL = /^[가-힣]+$/u;

/** One stem per query word, in order, deduplicated; at most `max` terms. */
export function koreanQueryTerms(query: string, max = 12): string[] {
  const out: string[] = [];
  for (const m of query.normalize('NFC').matchAll(WORD)) {
    const stem = koreanStem(m[0]);
    if (stem.length < 2 || STOP.has(stem) || out.includes(stem)) continue;
    out.push(stem);
    if (out.length >= max) break;
  }
  return out;
}

/** Remove one trailing particle or ending from a Hangul word, keeping at least two syllables. */
export function koreanStem(word: string): string {
  if (!HANGUL.test(word)) return word;
  for (const s of SUFFIXES)
    if (word.length - s.length >= 2 && word.endsWith(s)) return word.slice(0, -s.length);
  return word;
}

/** A LIKE pattern matching `term` anywhere, with LIKE metacharacters escaped. */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
