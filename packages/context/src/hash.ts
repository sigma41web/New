/**
 * Deterministic hashing and token estimation shared by every context-pack stage. Hashes are sha256 over
 * canonical bytes (sorted keys, UTF-8, no whitespace variance) so identical pinned inputs give identical
 * hashes on every machine.
 */
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/** English token estimator (calibrated starting value 1.3 tokens/word); the manifest records its id. */
export const TOKEN_ESTIMATOR_ID = 'english_estimator_v1';

/**
 * Korean token estimator (ADR-0059): one token per 자 — characters with spaces, without line breaks, the
 * platform's length unit. Calibrated on 4,091자 of Korean webnovel prose: o200k_base 0.70 tokens/자,
 * cl100k_base 1.08 tokens/자, while the English estimator undercounted the same text 2.2–3.3×.
 */
export const KOREAN_TOKEN_ESTIMATOR_ID = 'korean_chars_v1';

export function countKoreanChars(text: string): number {
  let n = 0;
  for (const ch of text) if (ch !== '\n' && ch !== '\r') n++;
  return n;
}

export function estimateTokensKo(text: string): number {
  return countKoreanChars(text);
}

/** The estimator for a pack's language; its id is recorded in the manifest. */
export function estimatorFor(lang: 'en' | 'ko'): {
  readonly id: string;
  readonly estimate: (text: string) => number;
} {
  return lang === 'ko'
    ? { id: KOREAN_TOKEN_ESTIMATOR_ID, estimate: estimateTokensKo }
    : { id: TOKEN_ESTIMATOR_ID, estimate: estimateTokens };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function estimateTokens(text: string): number {
  return Math.ceil(countWords(text) * 1.3);
}

/**
 * Content-addressed UUID (RFC 9562 v8): the first 122 bits of a sha256 digest with version and variant set.
 * Used for artifacts whose identity IS their content (Active Constraint Sets), so recompiling the same
 * constraints yields the same id and stores are idempotent (ADR-0045).
 */
export function uuidFromHash(hash: string): string {
  const hex = hash.replace(/^sha256:/, '');
  const b = Buffer.from(hex.slice(0, 32), 'hex');
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80; // version 8
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stable comparator for strings (code-unit order, never locale-dependent). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
