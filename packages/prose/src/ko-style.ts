/**
 * Deterministic Korean webnovel style lint (ADR-0056).
 *
 * The Korean language layer lists the diction the model must not use (번역투 markers, stale-cliché
 * patterns); this lint measures the SAME lists on a manuscript, plus the mobile-serial rhythm metrics a
 * Korean webnovel editor checks first: paragraph density, dialogue share, 그/그녀 density, simile density,
 * sentence-initial conjunctions, Latin-script leakage, format drift and verbatim reuse of the studio's
 * style exemplars. Findings carry paragraph ids and code-point spans so a targeted revision can anchor on
 * them. It is a signal, not a literary judgment: thresholds are starting values (ADR-0029).
 */
import { codePointLength } from './codepoints.js';
import { toNfcText } from './nfc.js';
import { segmentParagraphs } from './paragraphs.js';

export type KoStyleSeverity = 'minor' | 'major' | 'blocking';

export interface KoStyleMarker {
  readonly id: string;
  readonly pattern: string;
  readonly weight?: number | undefined;
  readonly severity?: string | undefined;
  readonly note?: string | undefined;
  readonly is_regex?: boolean | undefined;
}

export interface KoStylePattern extends KoStyleMarker {
  readonly category: string;
}

export interface KoStyleSource {
  /** 번역투 markers (output_language.translation_markers). */
  readonly translationMarkers?: readonly KoStyleMarker[] | undefined;
  /** Forbidden patterns (output_language.forbidden_patterns): format drift and stale clichés. */
  readonly forbiddenPatterns?: readonly KoStylePattern[] | undefined;
  /** rule id → { warn, fail } (output_language.lint_thresholds). */
  readonly thresholds?:
    Readonly<Record<string, { warn: number; fail: number } | undefined>> | undefined;
  /** Names and approved terms that may appear in Latin script. */
  readonly allowlist?: readonly string[] | undefined;
  /** Studio exemplar passages the manuscript must never reuse verbatim. */
  readonly exemplarTexts?: readonly string[] | undefined;
  /**
   * Registered character names (display names, short forms, aliases): KO-NAME-01 flags a word one syllable
   * away from one of them. Places and items are left out — their names share syllables with common nouns.
   */
  readonly personNames?: readonly string[] | undefined;
}

export type KoStyleIssueKind =
  | 'translation_like_english'
  | 'literary_drift'
  | 'paragraph_length'
  | 'weak_pacing'
  | 'repetitive_sentence_openings'
  | 'format_drift'
  | 'unapproved_untranslated_term'
  | 'weak_ending'
  | 'naming_registry_violation'
  | 'other';

export interface KoStyleFinding {
  readonly rule_id: string;
  readonly kind: KoStyleIssueKind;
  readonly severity: KoStyleSeverity;
  /** Korean, operator- and reviser-facing. */
  readonly message: string;
  readonly paragraph_ids: readonly string[];
  /** Code-point span into the NFC text, for single-hit rules. */
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly quote?: string | undefined;
  readonly value?: number | undefined;
  readonly threshold?: number | undefined;
}

export interface KoStyleMetrics {
  readonly characters: number;
  readonly paragraphs: number;
  readonly dialogue_ratio: number;
  readonly long_paragraph_ratio: number;
  readonly max_paragraph_chars: number;
  readonly pronoun_per_1k: number;
  readonly simile_per_1k: number;
  readonly translation_weighted_per_1k: number;
  readonly cliche_hits: number;
  readonly conjunction_per_1k: number;
  /** Share of characters inside ‘…’ (속마음/inner monologue), reported apart from dialogue (ADR-0062). */
  readonly monologue_ratio?: number | undefined;
}

export interface KoStyleReport {
  readonly metrics: KoStyleMetrics;
  readonly findings: readonly KoStyleFinding[];
}

/** Starting values when the language layer does not carry a threshold (ADR-0029: calibration-dependent). */
const DEFAULT_THRESHOLDS: Readonly<Record<string, { warn: number; fail: number }>> = {
  'KO-TRN-RATE': { warn: 2.0, fail: 4.0 },
  'KO-AIT-COUNT': { warn: 3, fail: 6 },
  'KO-PRN-RATE': { warn: 3.0, fail: 6.0 },
  'KO-SIM-RATE': { warn: 1.2, fail: 2.5 },
  'KO-PARA-LONG': { warn: 0.08, fail: 0.18 },
  'KO-PARA-CHARS': { warn: 180, fail: 260 },
  'KO-DLG-LOW': { warn: 0.22, fail: 0.12 },
  'KO-CONJ-RATE': { warn: 2.5, fail: 5.0 },
};

const PRONOUN = /(?<![가-힣])(그|그녀)(는|가|의|를|에게|와|도|만|한테)(?![가-힣])/gu;
const SIMILE = /마치|듯(이|한|했|하)/gu;
const CONJ = /(^|[.!?…”’]\s+)(그리고|그러나|하지만|그런데|또한|따라서|게다가)(?=[\s,])/gu;
const LATIN = /[A-Za-z][A-Za-z'-]{3,}/gu;
const SENTENCE_END = /[.!?…]+[”’"']?(?=\s|$)/gu;

function severityOf(raw: string | undefined): KoStyleSeverity {
  return raw === 'blocking' || raw === 'major' ? raw : 'minor';
}

function compile(pattern: string, isRegex: boolean | undefined): RegExp | undefined {
  try {
    return isRegex === false
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')
      : new RegExp(pattern, 'gu');
  } catch {
    return undefined;
  }
}

/** UTF-16 index → code-point offset, for spans. */
function cp(text: string, utf16: number): number {
  return codePointLength(text.slice(0, utf16));
}

function isDialogue(p: string): boolean {
  return /^[“"]/.test(p.trim());
}

function quotedChars(p: string): number {
  let n = 0;
  for (const m of p.matchAll(/“[^”]*”|"[^"]*"/gu)) n += codePointLength(m[0]);
  return n;
}

function monologueChars(p: string): number {
  let n = 0;
  for (const m of p.matchAll(/‘[^’]*’/gu)) n += codePointLength(m[0]);
  return n;
}

function sentenceCount(p: string): number {
  const n = [...p.matchAll(SENTENCE_END)].length;
  return Math.max(1, n);
}

export function lintKoreanWebnovel(input: string, src: KoStyleSource = {}): KoStyleReport {
  const nfc = toNfcText(input);
  const text = nfc.text;
  const paragraphs = segmentParagraphs(nfc);
  const chars = Math.max(1, codePointLength(text.replace(/\n/g, '')));
  const per1k = (n: number) => Math.round((n / chars) * 1000 * 100) / 100;
  const th = (id: string) => src.thresholds?.[id] ?? DEFAULT_THRESHOLDS[id];
  const findings: KoStyleFinding[] = [];
  const paraAt = (utf16: number) => {
    const at = cp(text, utf16);
    return paragraphs.find((p) => at >= p.start && at < p.end)?.id ?? paragraphs[0]?.id ?? 'p1';
  };
  const rate = (
    ruleId: string,
    value: number,
    kind: KoStyleIssueKind,
    message: (v: number, t: number) => string,
    ids: readonly string[] = [],
    inverted = false,
  ) => {
    const t = th(ruleId);
    if (!t) return;
    const failed = inverted ? value <= t.fail : value >= t.fail;
    const warned = inverted ? value <= t.warn : value >= t.warn;
    if (!failed && !warned) return;
    const threshold = failed ? t.fail : t.warn;
    findings.push({
      rule_id: ruleId,
      kind,
      severity: failed ? 'major' : 'minor',
      message: message(value, threshold),
      paragraph_ids: ids,
      value,
      threshold,
    });
  };

  // --- 번역투 markers: each hit is evidence; the weighted rate is the gate.
  let weighted = 0;
  for (const m of src.translationMarkers ?? []) {
    if (m.id === 'TRN-KO-02') continue; // Latin script is measured below with the allowlist
    const re = compile(m.pattern, m.is_regex);
    if (!re) continue;
    for (const hit of text.matchAll(re)) {
      weighted += m.weight ?? 0.4;
      const start = cp(text, hit.index);
      findings.push({
        rule_id: m.id,
        kind: 'translation_like_english',
        severity: 'minor',
        message: `번역투: “${hit[0]}” — ${m.note ?? '자연스러운 한국어로 고친다.'}`,
        paragraph_ids: [paraAt(hit.index)],
        start,
        end: start + codePointLength(hit[0]),
        quote: hit[0],
      });
    }
  }
  const translationRate = per1k(weighted);
  rate(
    'KO-TRN-RATE',
    translationRate,
    'translation_like_english',
    (v, t) =>
      `번역투 밀도 ${String(v)}/1,000자 (기준 ${String(t)}). 대명사·‘~에 대해’·‘~를 통해’·피동을 걷어 낸다.`,
  );

  // --- forbidden patterns: format drift at their own severity, stale clichés counted.
  let cliches = 0;
  for (const f of src.forbiddenPatterns ?? []) {
    const re = compile(f.pattern, f.is_regex);
    if (!re) continue;
    for (const hit of text.matchAll(re)) {
      const stale = f.category === 'stale_cliche';
      // ADR-0062: a misspelling is an orthography error readers comment on, not format drift.
      const spelling = f.category === 'spelling';
      if (stale) cliches++;
      const start = cp(text, hit.index);
      findings.push({
        rule_id: f.id,
        kind: stale ? 'literary_drift' : spelling ? 'other' : 'format_drift',
        severity: stale || spelling ? 'minor' : severityOf(f.severity),
        message: `${stale ? 'AI 상투구' : spelling ? '맞춤법' : '형식 위반'}: “${hit[0].trim()}” — ${f.note ?? '고친다.'}`,
        paragraph_ids: [paraAt(hit.index)],
        start,
        end: start + codePointLength(hit[0]),
        quote: hit[0],
      });
    }
  }
  rate(
    'KO-AIT-COUNT',
    cliches,
    'literary_drift',
    (v, t) =>
      `AI 상투구 ${String(v)}회 (기준 ${String(t)}회). 감정은 이름 대신 행동·반응으로 보여 준다.`,
  );

  // --- Latin script outside the allowlist.
  const allowed = new Set((src.allowlist ?? []).flatMap((a) => a.split(/\s+/)).map((a) => a));
  for (const hit of text.matchAll(LATIN)) {
    if (allowed.has(hit[0])) continue;
    const start = cp(text, hit.index);
    findings.push({
      rule_id: 'TRN-KO-02',
      kind: 'unapproved_untranslated_term',
      severity: 'major',
      message: `로마자 단어 “${hit[0]}” — 한글 표기로 쓴다.`,
      paragraph_ids: [paraAt(hit.index)],
      start,
      end: start + codePointLength(hit[0]),
      quote: hit[0],
    });
  }

  // --- rhythm metrics.
  const pronouns = [...text.matchAll(PRONOUN)].length;
  rate(
    'KO-PRN-RATE',
    per1k(pronouns),
    'translation_like_english',
    (v, t) =>
      `‘그/그녀’ 밀도 ${String(v)}/1,000자 (기준 ${String(t)}). 이름·호칭을 쓰거나 주어를 생략한다.`,
  );
  const similes = [...text.matchAll(SIMILE)].length;
  rate(
    'KO-SIM-RATE',
    per1k(similes),
    'literary_drift',
    (v, t) =>
      `비유(‘마치’·‘~듯’) 밀도 ${String(v)}/1,000자 (기준 ${String(t)}). 비유를 걷어 내고 동작으로 쓴다.`,
  );
  const conj = [...text.matchAll(CONJ)].length;
  rate(
    'KO-CONJ-RATE',
    per1k(conj),
    'repetitive_sentence_openings',
    (v, t) =>
      `문두 접속사(‘그리고’·‘하지만’ 등) ${String(v)}/1,000자 (기준 ${String(t)}). 접속사 없이 잇는다.`,
  );

  const narration = paragraphs.filter((p) => !isDialogue(p.text));
  const paraChars = th('KO-PARA-CHARS');
  const long = narration.filter(
    (p) => sentenceCount(p.text) > 3 || codePointLength(p.text) > (paraChars?.warn ?? 180),
  );
  const longRatio = paragraphs.length
    ? Math.round((long.length / paragraphs.length) * 1000) / 1000
    : 0;
  rate(
    'KO-PARA-LONG',
    longRatio,
    'paragraph_length',
    (v, t) =>
      `긴 서술 문단 비율 ${String(Math.round(v * 100))}% (기준 ${String(Math.round(t * 100))}%). 한두 문장씩 끊고 강조 문장은 한 줄 문단으로 뗀다.`,
    long.map((p) => p.id),
  );
  const maxChars = paragraphs.reduce((a, p) => Math.max(a, codePointLength(p.text)), 0);
  const worst = paragraphs.filter((p) => codePointLength(p.text) >= (paraChars?.fail ?? 260));
  for (const p of worst)
    findings.push({
      rule_id: 'KO-PARA-CHARS',
      kind: 'paragraph_length',
      severity: 'major',
      message: `문단 ${p.id}이 ${String(codePointLength(p.text))}자로 너무 길다 (기준 ${String(paraChars?.fail ?? 260)}자). 모바일 한 화면에 들어가게 쪼갠다.`,
      paragraph_ids: [p.id],
      start: p.start,
      end: p.end,
      value: codePointLength(p.text),
      threshold: paraChars?.fail ?? 260,
    });

  const quoted = paragraphs.reduce((a, p) => a + quotedChars(p.text), 0);
  const dialogueRatio = Math.round((quoted / chars) * 1000) / 1000;
  if (paragraphs.length >= 12)
    rate(
      'KO-DLG-LOW',
      dialogueRatio,
      'weak_pacing',
      (v, t) =>
        `대사 비중 ${String(Math.round(v * 100))}% (기준 ${String(Math.round(t * 100))}% 이상). 요약 서술을 대사와 반응 비트로 바꾼다.`,
      [],
      true,
    );

  // --- ending: a reflective/summary last paragraph is the Western/AI habit the tradition forbids.
  const last = paragraphs[paragraphs.length - 1];
  if (
    last &&
    /(그렇게 .{0,20}(하루|밤|날)(가|이) (저물|지나|흘러)|시작에 불과|(세상|인생|사람)(은|이란) (원래|언제나|늘|결국))/u.test(
      last.text,
    )
  )
    findings.push({
      rule_id: 'KO-END-01',
      kind: 'weak_ending',
      severity: 'major',
      message:
        '마지막 문단이 요약·관조로 닫힌다. 다음 화를 누르게 만드는 절단(위기·폭로·등장·결단)으로 끝낸다.',
      paragraph_ids: [last.id],
      start: last.start,
      end: last.end,
    });

  // --- ADR-0062 rules run only when the language layer carries their threshold (lang/ko@4 onward), so a
  // project pinned to an earlier layer lints exactly as before.
  // KO-END-02: a run of narration sentences that all close on the same two syllables (했다. 했다. 했다.).
  const endTh = src.thresholds?.['KO-END-02'];
  if (endTh) {
    let run: { ending: string; ids: string[]; n: number } | undefined;
    let worst: { ending: string; ids: string[]; n: number } | undefined;
    for (const p of paragraphs) {
      if (isDialogue(p.text)) {
        run = undefined;
        continue;
      }
      for (const m of p.text.matchAll(SENTENCE_END)) {
        const before = p.text.slice(0, m.index).replace(/[^가-힣]/gu, '');
        const ending = Array.from(before).slice(-2).join('');
        if (Array.from(ending).length < 2) continue;
        run =
          run?.ending === ending
            ? { ending, ids: [...new Set([...run.ids, p.id])], n: run.n + 1 }
            : { ending, ids: [p.id], n: 1 };
        if (!worst || run.n > worst.n) worst = run;
      }
    }
    if (worst && worst.n >= endTh.warn)
      findings.push({
        rule_id: 'KO-END-02',
        kind: 'other',
        severity: worst.n >= endTh.fail ? 'major' : 'minor',
        message: `서술 문장 ${String(worst.n)}개가 연달아 ‘~${worst.ending}.’로 끝난다 (기준 ${String(endTh.warn)}개). 어미와 문장 길이를 바꿔 호흡을 살린다.`,
        paragraph_ids: worst.ids.slice(0, 6),
        value: worst.n,
        threshold: worst.n >= endTh.fail ? endTh.fail : endTh.warn,
      });
  }
  // KO-NAME-01: a word one syllable away from a registered name (서지얀 for 서지안) — a misspelled name.
  const nameTh = src.thresholds?.['KO-NAME-01'];
  if (nameTh) {
    const names = [...new Set((src.personNames ?? []).filter((n) => /^[가-힣]{3,}$/u.test(n)))];
    const known = new Set([...(src.allowlist ?? []), ...(src.personNames ?? [])]);
    const near = new Map<string, { name: string; at: number }>();
    for (const m of text.matchAll(/[가-힣]{3,}/gu)) {
      const word = m[0];
      if (known.has(word) || names.some((n) => word.startsWith(n))) continue;
      for (const n of names) {
        const len = Array.from(n).length;
        const head = Array.from(word).slice(0, len);
        if (head.length !== len) continue;
        const diff = head.filter((ch, i) => ch !== Array.from(n)[i]).length;
        // One differing syllable, never the first (서지얀/서지안, not 김지안/서지안 which may be kin).
        if (diff === 1 && head[0] === Array.from(n)[0] && !near.has(head.join(''))) {
          near.set(head.join(''), { name: n, at: m.index });
          break;
        }
      }
    }
    if (near.size >= nameTh.warn)
      for (const [word, { name, at }] of near) {
        const start = cp(text, at);
        findings.push({
          rule_id: 'KO-NAME-01',
          kind: 'naming_registry_violation',
          severity: near.size >= nameTh.fail ? 'major' : 'minor',
          message: `등록된 이름과 한 글자 다르다: “${word}” — ‘${name}’의 오기인지 확인한다.`,
          paragraph_ids: [paraAt(at)],
          start,
          end: start + codePointLength(word),
          quote: word,
        });
      }
  }

  // --- verbatim reuse of the studio exemplars (ADR-0025: exemplars are rhythm references, never content).
  const lines = (src.exemplarTexts ?? [])
    .flatMap((t) => toNfcText(t).text.split(/\n+/))
    .map((l) => l.trim())
    .filter((l) => codePointLength(l) >= 14);
  for (const l of new Set(lines)) {
    const at = text.indexOf(l);
    if (at < 0) continue;
    const start = cp(text, at);
    findings.push({
      rule_id: 'EXEMPLAR-COPY',
      kind: 'other',
      severity: 'major',
      message: `문체 견본 문장을 그대로 옮겼다: “${l.slice(0, 40)}” — 이 작품의 문장으로 새로 쓴다.`,
      paragraph_ids: [paraAt(at)],
      start,
      end: start + codePointLength(l),
      quote: l,
    });
  }

  return {
    metrics: {
      characters: chars,
      paragraphs: paragraphs.length,
      dialogue_ratio: dialogueRatio,
      long_paragraph_ratio: longRatio,
      max_paragraph_chars: maxChars,
      pronoun_per_1k: per1k(pronouns),
      simile_per_1k: per1k(similes),
      translation_weighted_per_1k: translationRate,
      cliche_hits: cliches,
      conjunction_per_1k: per1k(conj),
      monologue_ratio:
        Math.round((paragraphs.reduce((a, p) => a + monologueChars(p.text), 0) / chars) * 1000) /
        1000,
    },
    findings,
  };
}

/**
 * A compact Korean digest of a report for judge and reviser prompts: the metrics line plus the strongest
 * findings (majors first), bounded so a noisy draft cannot flood the prompt.
 */
export function koStyleDigest(report: KoStyleReport, maxFindings = 12): string {
  const m = report.metrics;
  const head = `측정: ${String(m.characters)}자, 문단 ${String(m.paragraphs)}개, 대사 ${String(Math.round(m.dialogue_ratio * 100))}%, 긴 서술 문단 ${String(Math.round(m.long_paragraph_ratio * 100))}%, 최장 문단 ${String(m.max_paragraph_chars)}자, ‘그/그녀’ ${String(m.pronoun_per_1k)}/1,000자, 비유 ${String(m.simile_per_1k)}/1,000자, 번역투 가중 ${String(m.translation_weighted_per_1k)}/1,000자, AI 상투구 ${String(m.cliche_hits)}회.`;
  const order: Record<KoStyleSeverity, number> = { blocking: 0, major: 1, minor: 2 };
  const top = [...report.findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, maxFindings)
    .map(
      (f) =>
        `- [${f.rule_id}${f.paragraph_ids.length ? ` ${f.paragraph_ids.slice(0, 3).join(',')}` : ''}] ${f.severity === 'minor' ? '' : `(${f.severity}) `}${f.message}`,
    );
  return top.length ? `${head}\n${top.join('\n')}` : `${head}\n- 결정적 문체 지적 없음.`;
}
