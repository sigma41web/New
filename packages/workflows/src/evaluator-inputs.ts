/**
 * What each evaluator reads (ADR-0060). The Step 0 audit (§3.1) found evaluators fed the wrong slices of
 * the checker pack. These builders render the inputs the 4.4.0 evaluator prompts declare: voice cards and
 * designed address terms for the voice judge, reader-facing secrets for the knowledge-leak checker, the
 * chapter's planned promise touches for the promise checker, a deterministic terminology report for the
 * genre judge and the openings and endings of earlier accepted chapters for the repetition judge. Planned
 * material is labelled PLANNED by the prompts that read it; nothing here is canon.
 */
import { acceptedChapter, type Pool } from '@yeonjae/db';
import { type NfcText, type Paragraph, type PriorChapter } from '@yeonjae/prose';
import { type ComposedIdentity } from '@yeonjae/narrative';
import { type ChapterContract, type StoryBible } from './planning.js';

type Lang = 'en' | 'ko';
type Rec = Readonly<Record<string, unknown>>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(str).filter((x): x is string => x !== undefined);
  const one = str(v);
  return one ? [one] : [];
};
const recs = (v: unknown): Rec[] =>
  Array.isArray(v) ? v.filter((x): x is Rec => typeof x === 'object' && x !== null) : [];

function nameOf(bible: StoryBible | undefined): (id: string) => string {
  const names = new Map((bible?.entities ?? []).map((e) => [e.id, e.display_name]));
  return (id) => names.get(id) ?? id;
}

/** The chapter's on-page and mentioned participants, as bible entities. */
function participants(contract: ChapterContract, bible: StoryBible | undefined) {
  const ids = new Set(contract.participants.map((p) => p.character_id));
  return (bible?.entities ?? []).filter((e) => ids.has(e.id));
}

/** Voice cards: how each participant speaks, from the bible's character design. */
export function voiceCards(
  contract: ChapterContract,
  bible: StoryBible | undefined,
  lang: Lang,
): string | undefined {
  const lines: string[] = [];
  for (const e of participants(contract, bible)) {
    const d = e.design ?? {};
    const voice = list(d.voice_notes).join('; ');
    const short = [...(e.short_forms ?? [])].join(', ');
    const role = str(d.role);
    const parts =
      lang === 'ko'
        ? [
            voice ? `말투: ${voice}` : undefined,
            short ? `약칭: ${short}` : undefined,
            str(d.rank) ? `서열: ${str(d.rank) ?? ''}` : undefined,
          ]
        : [
            voice ? `voice: ${voice}` : undefined,
            short ? `short forms: ${short}` : undefined,
            str(d.rank) ? `rank: ${str(d.rank) ?? ''}` : undefined,
          ];
    const body = parts.filter(Boolean).join(' / ');
    lines.push(`- ${e.display_name}${role ? ` (${role})` : ''}${body ? `: ${body}` : ''}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** The designed register and address terms of each participant toward each counterpart (호칭 matrix). */
export function addressMatrix(
  contract: ChapterContract,
  bible: StoryBible | undefined,
  lang: Lang,
): string | undefined {
  const lines: string[] = [];
  for (const e of participants(contract, bible)) {
    for (const r of recs(e.design?.registers)) {
      const toward = str(r.toward);
      if (!toward) continue;
      const terms = list(r.address_terms);
      const type = str(r.type);
      lines.push(
        lang === 'ko'
          ? `- ${e.display_name} → ${toward}: ${type ?? '말높이 미지정'}${terms.length ? `; 호칭 ‘${terms.join('’, ‘')}’` : ''}`
          : `- ${e.display_name} → ${toward}: ${type ?? 'register unspecified'}${terms.length ? `; address terms “${terms.join('”, “')}”` : ''}`,
      );
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Reader-facing secrets that may not be revealed in this chapter: bible secret propositions whose earliest
 * reveal chapter is later than this one (or unset), with the characters allowed to know them.
 */
export function readerSecrets(
  chapterNo: number,
  bible: StoryBible | undefined,
  lang: Lang,
): string | undefined {
  const n = nameOf(bible);
  const lines: string[] = [];
  for (const p of bible?.propositions ?? []) {
    const secret = p.secret;
    if (!secret) continue;
    const notBefore =
      typeof secret.reveal_not_before_chapter === 'number'
        ? secret.reveal_not_before_chapter
        : undefined;
    if (notBefore !== undefined && notBefore <= chapterNo) continue;
    const knowers = list(secret.allowed_knower_ids).map(n);
    lines.push(
      lang === 'ko'
        ? `- “${p.statement}” — 아는 인물: ${knowers.join(', ') || '없음'}; ${notBefore !== undefined ? `${String(notBefore)}화부터 공개 가능` : '공개 시점 미정'}`
        : `- “${p.statement}” — known to: ${knowers.join(', ') || 'nobody'}; ${notBefore !== undefined ? `may be revealed from chapter ${String(notBefore)}` : 'reveal chapter not set'}`,
    );
  }
  return lines.length ? lines.join('\n') : undefined;
}

const TOUCH_KO: Record<string, string> = { open: '깔기', advance: '진전', pay: '회수' };

/** The contract's planned promise touches (setups and payoffs), with their promise ids. */
export function chapterObligations(
  contract: ChapterContract,
  bible: StoryBible | undefined,
  lang: Lang,
): string | undefined {
  const statements = new Map((bible?.promises ?? []).map((p) => [p.id, p.statement]));
  const lines = [...contract.setups, ...contract.payoffs].map((t, i) => {
    const planned = t.kind ?? (i < contract.setups.length ? 'open' : 'pay');
    const statement = statements.get(t.promise_id);
    return lang === 'ko'
      ? `- 약속 ${t.promise_id}${statement ? ` “${statement}”` : ''} — 이번 회차 계획: ${planned} (${TOUCH_KO[planned] ?? planned}) — ${t.how}`
      : `- promise ${t.promise_id}${statement ? ` “${statement}”` : ''} — planned in this chapter: ${planned} — ${t.how}`;
  });
  return lines.length ? lines.join('\n') : undefined;
}

export interface TerminologyReport {
  readonly text: string;
  /** Share of the terminology entries used in the chapter that were written only in their policy form. */
  readonly compliance: number;
}

const STATUS_WINDOW = /^\s*[[【].*[\]】]\s*$/u;

/**
 * The genre judge's deterministic evidence: which registered names appear, whether each terminology entry
 * used in the chapter kept its policy form or mixed in an alias, and the status-window / system-message
 * blocks the chapter carries.
 */
export function terminologyChecks(input: {
  readonly text: NfcText;
  readonly paragraphs: readonly Paragraph[];
  readonly allowlist: readonly string[];
  readonly identity: ComposedIdentity;
  readonly primaryGenre: string | undefined;
  readonly lang: Lang;
}): TerminologyReport {
  const ko = input.lang === 'ko';
  const where = (needle: string) =>
    input.paragraphs.filter((p) => p.text.includes(needle)).map((p) => p.id);
  const names = [...new Set(input.allowlist.filter((n) => n && input.text.text.includes(n)))];
  let used = 0;
  const mixed: string[] = [];
  const mixedTerms = new Set<string>();
  for (const t of input.identity.terminology?.terms ?? []) {
    const canonical = ko ? t.source_term : (t.english ?? t.romanized ?? t.source_term);
    const aliases = (t.aliases ?? []).filter((a) => a && a !== canonical);
    const aliasHits = aliases.filter((a) => input.text.text.includes(a));
    if (!input.text.text.includes(canonical) && aliasHits.length === 0) continue;
    used++;
    if (aliasHits.length) mixedTerms.add(canonical);
    for (const a of aliasHits)
      mixed.push(
        ko
          ? `- ‘${canonical}’ 대신 ‘${a}’ (${where(a).join(', ')})`
          : `- “${a}” instead of “${canonical}” (${where(a).join(', ')})`,
      );
  }
  const windows = input.paragraphs.filter((p) => STATUS_WINDOW.test(p.text)).map((p) => p.id);
  const lines = ko
    ? [
        `주 장르: ${input.primaryGenre ?? '(미지정)'}.`,
        `등록 이름 ${String(input.allowlist.length)}개 중 이번 화에 나온 이름 ${String(names.length)}개${names.length ? `: ${names.slice(0, 12).join(', ')}` : ''}.`,
        `용어 정책 ${String(input.identity.terminology?.terms?.length ?? 0)}개 중 이번 화에 쓴 용어 ${String(used)}개, 정책 표기와 다른 이형이 섞인 용어 ${String(mixedTerms.size)}개.`,
        ...mixed,
        `상태창·시스템 메시지 블록 ${String(windows.length)}개${windows.length ? ` (${windows.join(', ')})` : ''}.`,
      ]
    : [
        `Primary genre: ${input.primaryGenre ?? '(unspecified)'}.`,
        `Registered names: ${String(input.allowlist.length)}; appearing in this chapter: ${String(names.length)}${names.length ? ` (${names.slice(0, 12).join(', ')})` : ''}.`,
        `Terminology entries: ${String(input.identity.terminology?.terms?.length ?? 0)}; used in this chapter: ${String(used)}; mixed with a non-policy alias: ${String(mixedTerms.size)}.`,
        ...mixed,
        `Status-window / system-message blocks: ${String(windows.length)}${windows.length ? ` (${windows.join(', ')})` : ''}.`,
      ];
  return {
    text: lines.join('\n'),
    compliance: used ? Math.round(((used - mixedTerms.size) / used) * 1000) / 1000 : 1,
  };
}

/** The accepted text of up to `window` chapters before `chapterNo`, oldest first; drafts are never read. */
export async function priorAcceptedChapters(
  db: Pool,
  projectId: string,
  chapterNo: number,
  window = 3,
): Promise<PriorChapter[]> {
  const out: PriorChapter[] = [];
  for (let n = Math.max(1, chapterNo - window); n < chapterNo; n++) {
    const found = await acceptedChapter(db, projectId, n);
    if (found.state === 'accepted') out.push({ chapter_no: n, text: found.chapter.version.text });
  }
  return out;
}

/** The opening and ending of each prior chapter, as the repetition judge reads them. */
export function priorChapterEdges(
  prior: readonly PriorChapter[],
  lang: Lang,
  edge = 300,
): string | undefined {
  if (prior.length === 0) return undefined;
  return prior
    .map((c) => {
      const chars = Array.from(c.text.trim());
      const head = chars.slice(0, edge).join('');
      const tail = chars.length > edge * 2 ? chars.slice(-edge).join('') : '';
      return lang === 'ko'
        ? `[${String(c.chapter_no)}화 — 도입]\n${head}${tail ? `\n[${String(c.chapter_no)}화 — 마무리]\n${tail}` : ''}`
        : `[chapter ${String(c.chapter_no)} — opening]\n${head}${tail ? `\n[chapter ${String(c.chapter_no)} — ending]\n${tail}` : ''}`;
    })
    .join('\n\n');
}
