/**
 * Deterministic cross-chapter repetition report (ADR-0060), the evidence the repetition judge reads. It
 * compares a chapter with the accepted chapters before it: verbatim passages and sentences reused from them,
 * how alike the chapter openings and endings are, and which sentence openings the chapter itself leans on.
 * Status-window lines (a paragraph in [ ] or 【 】) repeat by design and are skipped. The report finds
 * candidates only; whether a repeat is a flaw (or a deliberate refrain) is the judge's call.
 */
import { type NfcText } from './nfc.js';
import { segmentParagraphs } from './paragraphs.js';

export interface PriorChapter {
  readonly chapter_no: number;
  readonly text: string;
}

export interface RepetitionReport {
  readonly shingle_words: number;
  readonly prior_chapters: readonly number[];
  /** Share of this chapter's word shingles already used in the prior chapters (0–1). */
  readonly overlap_ratio: number;
  readonly repeated_passages: readonly RepeatedSpan[];
  readonly repeated_sentences: readonly RepeatedSpan[];
  readonly opening_similarity: readonly { chapter_no: number; jaccard: number }[];
  readonly ending_similarity: readonly { chapter_no: number; jaccard: number }[];
  readonly sentence_openings: readonly { opening: string; count: number }[];
}

export interface RepeatedSpan {
  readonly paragraph_id: string;
  readonly quote: string;
  readonly chapters: readonly number[];
}

const SHINGLE = 4;
const EDGE_CHARS = 200;
const MAX_LISTED = 12;
const SENTENCE = /[^.!?…]+[.!?…]*[”’"']?/gu;

function isStatusWindow(p: string): boolean {
  const t = p.trim();
  return /^[[【]/u.test(t) && /[\]】]$/u.test(t);
}

function words(s: string): string[] {
  return s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function shingles(ws: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(' '));
  return out;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return Math.round((inter / (sa.size + sb.size - inter)) * 1000) / 1000;
}

function proseParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !isStatusWindow(p));
}

export function repetitionReport(text: NfcText, prior: readonly PriorChapter[]): RepetitionReport {
  const paragraphs = segmentParagraphs(text).filter((p) => !isStatusWindow(p.text));
  const priorShingles = new Map<string, Set<number>>();
  const priorSentences = new Map<string, Set<number>>();
  for (const ch of prior) {
    const body = proseParagraphs(ch.text).join('\n\n');
    for (const s of shingles(words(body), SHINGLE)) {
      const set = priorShingles.get(s) ?? new Set<number>();
      set.add(ch.chapter_no);
      priorShingles.set(s, set);
    }
    for (const m of body.matchAll(SENTENCE)) {
      const key = words(m[0]).join(' ');
      if (Array.from(key).length < 10) continue;
      const set = priorSentences.get(key) ?? new Set<number>();
      set.add(ch.chapter_no);
      priorSentences.set(key, set);
    }
  }

  let total = 0;
  let reused = 0;
  const passages: RepeatedSpan[] = [];
  const sentences: RepeatedSpan[] = [];
  const openings = new Map<string, number>();
  for (const p of paragraphs) {
    const ws = words(p.text);
    const sh = shingles(ws, SHINGLE);
    total += sh.length;
    // A passage is a run of at least two consecutive reused shingles (five or more words verbatim).
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart >= 0 && end - runStart >= 2) {
        const chapters = new Set<number>();
        for (let i = runStart; i < end; i++)
          for (const c of priorShingles.get(sh[i] ?? '') ?? []) chapters.add(c);
        passages.push({
          paragraph_id: p.id,
          quote: ws.slice(runStart, end + SHINGLE - 1).join(' '),
          chapters: [...chapters].sort((a, b) => a - b),
        });
      }
      runStart = -1;
    };
    sh.forEach((s, i) => {
      if (priorShingles.has(s)) {
        reused++;
        if (runStart < 0) runStart = i;
      } else flush(i);
    });
    flush(sh.length);
    for (const m of p.text.matchAll(SENTENCE)) {
      const sw = words(m[0]);
      const first = sw[0];
      if (first) openings.set(first, (openings.get(first) ?? 0) + 1);
      const hit = priorSentences.get(sw.join(' '));
      if (hit)
        sentences.push({
          paragraph_id: p.id,
          quote: m[0].trim(),
          chapters: [...hit].sort((a, b) => a - b),
        });
    }
  }

  const body = paragraphs.map((p) => p.text).join('\n\n');
  const head = (s: string) => words(Array.from(s).slice(0, EDGE_CHARS).join(''));
  const tail = (s: string) => words(Array.from(s).slice(-EDGE_CHARS).join(''));
  const bigrams = (ws: string[]) => shingles(ws, 2);
  const priorBodies = prior.map((c) => ({
    n: c.chapter_no,
    body: proseParagraphs(c.text).join('\n\n'),
  }));
  return {
    shingle_words: SHINGLE,
    prior_chapters: prior.map((c) => c.chapter_no),
    overlap_ratio: total ? Math.round((reused / total) * 1000) / 1000 : 0,
    repeated_passages: passages.slice(0, MAX_LISTED),
    repeated_sentences: sentences.slice(0, MAX_LISTED),
    opening_similarity: priorBodies.map((c) => ({
      chapter_no: c.n,
      jaccard: jaccard(bigrams(head(body)), bigrams(head(c.body))),
    })),
    ending_similarity: priorBodies.map((c) => ({
      chapter_no: c.n,
      jaccard: jaccard(bigrams(tail(body)), bigrams(tail(c.body))),
    })),
    sentence_openings: [...openings.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([opening, count]) => ({ opening, count })),
  };
}

/** The report as the repetition judge reads it (Korean prompt surface). */
export function repetitionDigestKo(r: RepetitionReport): string {
  const chapters = (cs: readonly number[]) => cs.map((c) => `${String(c)}화`).join('·');
  const sim = (xs: readonly { chapter_no: number; jaccard: number }[]) =>
    xs.length
      ? xs
          .map((x) => `${String(x.chapter_no)}화 ${String(Math.round(x.jaccard * 100))}%`)
          .join(', ')
      : '비교할 이전 화 없음';
  return [
    r.prior_chapters.length
      ? `비교한 이전 화: ${chapters(r.prior_chapters)}. 이번 화의 ${String(r.shingle_words)}어절 연쇄 중 이전 화에 이미 나온 비율 ${String(Math.round(r.overlap_ratio * 100))}%.`
      : '비교할 이전 화가 없다(첫 화).',
    r.repeated_passages.length
      ? `이전 화와 어절 단위로 그대로 겹치는 구절 ${String(r.repeated_passages.length)}곳:`
      : '이전 화와 어절 단위로 그대로 겹치는 구절은 없다.',
    ...r.repeated_passages.map(
      (x) => `- [${x.paragraph_id}] “${x.quote}” (${chapters(x.chapters)})`,
    ),
    ...(r.repeated_sentences.length
      ? [
          `이전 화의 문장을 그대로 다시 쓴 곳 ${String(r.repeated_sentences.length)}곳:`,
          ...r.repeated_sentences.map(
            (x) => `- [${x.paragraph_id}] “${x.quote}” (${chapters(x.chapters)})`,
          ),
        ]
      : []),
    `도입부 유사도(앞 ${String(EDGE_CHARS)}자, 두 어절 연쇄 자카드): ${sim(r.opening_similarity)}.`,
    `마무리 유사도(끝 ${String(EDGE_CHARS)}자): ${sim(r.ending_similarity)}.`,
    r.sentence_openings.length
      ? `이번 화에서 자주 쓴 문장 첫 어절: ${r.sentence_openings.map((o) => `‘${o.opening}’ ${String(o.count)}회`).join(', ')}.`
      : '세 번 넘게 반복된 문장 첫 어절은 없다.',
  ].join('\n');
}
