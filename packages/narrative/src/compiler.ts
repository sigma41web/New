/**
 * Narrative Identity Block compiler (docs/02-narrative-identity/01 §4, /02 §9). Deterministic: the same
 * composed identity + role variant + participants → the same bytes → the same hash. The two contracts are
 * always the first two sections and are never shed; every other section sheds in reverse priority when the
 * role budget is exceeded, and overflow of the unsheddable core is a compile error, never a truncation.
 */
import { type ComposedIdentity, sha256 } from './profiles.js';
import {
  IDENTITY_TAIL_KO,
  renderCadenceKo,
  renderGenresKo,
  renderNamingKo,
  renderParticipantsKo,
  renderAvoidKo,
  renderExemplarsKo,
  renderPreferencesKo,
  renderRegisterKo,
  renderRubricKo,
  renderSettingKo,
  renderStructureKo,
  renderTerminologyKo,
  SECTION_TITLES_KO,
} from './compiler-ko.js';

export type RoleVariant =
  | 'writer_full'
  | 'editor_full'
  | 'planner_compact'
  | 'judge_rubric_prose'
  | 'judge_rubric_structure'
  | 'judge_rubric_genre'
  | 'judge_rubric_voice'
  | 'summarizer_min';

export interface ParticipantDigest {
  readonly displayName: string;
  readonly shortForms?: readonly string[] | undefined;
  /** "toward <counterpart>: <register summary>" lines, already rendered from the relationship ledger */
  readonly registerLines?: readonly string[] | undefined;
  readonly verbalHabits?: readonly string[] | undefined;
  readonly forbiddenExpressions?: readonly string[] | undefined;
}

export interface CompileOptions {
  readonly role: RoleVariant;
  /** Token budget for the whole block (estimated at 1.3 tokens per word). */
  readonly budgetTokens: number;
  readonly participants?: readonly ParticipantDigest[] | undefined;
  readonly contentRestrictions?: readonly string[] | undefined;
}

export interface CompiledBlock {
  readonly text: string;
  readonly hash: string;
  readonly identityVersionId: string;
  readonly identityRef: string;
  readonly role: RoleVariant;
  readonly outputLanguage: 'en' | 'ko';
  readonly outputLanguageContractHash: string;
  readonly traditionContractHash: string;
  readonly sections: readonly string[];
  readonly droppedSections: readonly string[];
  readonly estTokens: number;
  /** Short reminder appended after the task instruction for writer/editor roles. */
  readonly identityTail: string | undefined;
}

export class BlockOverflowError extends Error {
  constructor(
    readonly needed: number,
    readonly budget: number,
  ) {
    super(
      `NARRATIVE_BLOCK_OVERFLOW: unsheddable sections need ${needed} tokens, budget is ${budget}`,
    );
    this.name = 'BlockOverflowError';
  }
}

export const HEADER_PREFIX = '<<NARRATIVE_IDENTITY';

export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/**
 * Korean block estimator (ADR-0062): one token per 자 without line breaks — `korean_chars_v1`, the unit Korean
 * context packs are measured in (ADR-0059). Word counts undercounted Korean blocks two- to threefold.
 */
export function estimateTokensKo(text: string): number {
  return Array.from(text.replace(/\n/g, '')).length;
}

interface Section {
  readonly name: string;
  readonly text: string;
  /** lower = shed first; Infinity = never shed */
  readonly priority: number;
}

function bullet(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

function renderStructure(id: ComposedIdentity): string {
  const s = id.tradition.structure ?? {};
  const r = id.tradition.rhythm ?? {};
  const over = id.preferences?.numeric_overrides ?? {};
  const narrWords =
    over['tradition.rhythm.paragraph_max_words_narration'] ?? r.paragraph_max_words_narration;
  const lines: string[] = [];
  if (s.hook_within_sentences !== undefined)
    lines.push(
      `Open on tension or continuation within the first ${s.hook_within_sentences} sentences.`,
    );
  if (s.opening_types_allowed)
    lines.push(`Allowed openings: ${s.opening_types_allowed.join(', ')}.`);
  if (s.opening_types_forbidden)
    lines.push(`Never open with: ${s.opening_types_forbidden.join(', ')}.`);
  if (s.scene_count_band)
    lines.push(`Use ${s.scene_count_band.min}–${s.scene_count_band.max} scenes per episode.`);
  if (s.local_payoff_required_any_of)
    lines.push(`Deliver at least one local payoff: ${s.local_payoff_required_any_of.join(', ')}.`);
  if (s.ending_types_allowed)
    lines.push(
      `End with forward pull: ${s.ending_types_allowed.join(', ')}. Never end on ${(s.ending_types_forbidden ?? []).join(' or ')}.`,
    );
  if (s.exposition?.max_consecutive_sentences !== undefined)
    lines.push(
      `No more than ${s.exposition.max_consecutive_sentences} consecutive sentences of exposition; carry lore through ${(s.exposition.lore_via ?? []).join(', ')}.`,
    );
  if (r.paragraph_max_sentences !== undefined)
    lines.push(
      `Keep paragraphs to ${r.paragraph_max_sentences} sentences or fewer${narrWords !== undefined ? ` and about ${narrWords} words of narration at most` : ''}; one-line paragraphs are welcome for emphasis.`,
    );
  if (r.dialogue_ratio_band)
    lines.push(
      `Keep roughly ${Math.round(r.dialogue_ratio_band.min * 100)}–${Math.round(r.dialogue_ratio_band.max * 100)}% of the words inside dialogue, with short reaction beats between lines.`,
    );
  if (r.monologue_ratio_band)
    lines.push(
      `Inner monologue (italics) stays within ${Math.round(r.monologue_ratio_band.min * 100)}–${Math.round(r.monologue_ratio_band.max * 100)}% of the text.`,
    );
  return lines.length ? bullet(lines) : '';
}

function renderCadence(id: ComposedIdentity): string {
  const c = id.primaryGenre?.cadence ?? id.tradition.structure?.cadence;
  if (!c) return '';
  const lines: string[] = [];
  if (c.progression_event_every_chapters)
    lines.push(`A visible progression event every ${c.progression_event_every_chapters} chapters.`);
  if (c.satisfaction_every_chapters)
    lines.push(
      `A satisfaction beat (사이다) at least every ${c.satisfaction_every_chapters} chapters.`,
    );
  if (c.max_frustration_streak)
    lines.push(`Never more than ${c.max_frustration_streak} consecutive chapters of pure setback.`);
  if ('relationship_milestone_every_chapters' in c && c.relationship_milestone_every_chapters)
    lines.push(
      `A relationship milestone every ${c.relationship_milestone_every_chapters} chapters.`,
    );
  return bullet(lines);
}

function renderGenres(id: ComposedIdentity): string {
  return id.genres
    .map((g) => {
      const lines: string[] = [];
      if (g.reader_fantasy) lines.push(`Reader fantasy: ${g.reader_fantasy}`);
      if (g.vocabulary?.preferred_terms?.length)
        lines.push(`Use these English terms: ${g.vocabulary.preferred_terms.join(', ')}.`);
      if (g.vocabulary?.discouraged_terms?.length)
        lines.push(`Avoid: ${g.vocabulary.discouraged_terms.join(', ')}.`);
      for (const d of g.devices ?? [])
        lines.push(
          `Device "${d.id}": ${d.description}${d.max_per_chapter !== undefined ? ` (at most ${d.max_per_chapter} per chapter)` : ''}`,
        );
      if (g.taboos?.length) lines.push(`Ration or avoid: ${g.taboos.join('; ')}.`);
      return `Genre ${g.genre_id ?? '?'}:\n${bullet(lines)}`;
    })
    .join('\n');
}

function renderSetting(id: ComposedIdentity): string {
  const s = id.setting;
  if (!s) return '';
  const lines: string[] = [];
  if (s.setting_type) lines.push(`Setting type: ${s.setting_type}.`);
  if (s.place_names_policy) lines.push(`Place names: ${s.place_names_policy}.`);
  if (s.institutions?.length) lines.push(`Institutions: ${s.institutions.join(', ')}.`);
  if (s.currency) lines.push(`Currency: ${s.currency}.`);
  if (s.cultural_texture) lines.push(`Cultural texture: ${s.cultural_texture.replace(/_/g, ' ')}.`);
  if (s.cultural_reference_policy) lines.push(s.cultural_reference_policy);
  return bullet(lines);
}

function renderNaming(id: ComposedIdentity): string {
  const n = id.naming;
  if (!n) return '';
  const lines: string[] = [];
  if (n.style)
    lines.push(
      `Name style: ${n.style.replace(/_/g, ' ')}${n.romanization_system ? ` (${n.romanization_system.replace(/_/g, ' ')})` : ''}.`,
    );
  if (n.name_order) lines.push(`Name order: ${n.name_order.replace('_', '–')}.`);
  if (n.given_name_hyphenation) lines.push(`Given names: ${n.given_name_hyphenation}.`);
  for (const note of n.notes ?? []) lines.push(note);
  lines.push(
    'Use only display names and short forms from the naming registry; never native-script names in prose.',
  );
  return bullet(lines);
}

function renderRegister(id: ComposedIdentity): string {
  const p = id.registerPolicy;
  if (!p) return '';
  const lines: string[] = [];
  for (const r of p.rendering_rules ?? []) lines.push(`When ${r.condition}: ${r.guidance}`);
  if (p.anti_patterns?.length) lines.push(`Never: ${p.anti_patterns.join('; ')}.`);
  if (p.allowed_shift_reasons?.length)
    lines.push(
      `Register may shift only for: ${p.allowed_shift_reasons.join(', ')} — mark such shifts.`,
    );
  return bullet(lines);
}

function renderTerminology(id: ComposedIdentity): string {
  const t = id.terminology;
  if (!t) return '';
  const lines: string[] = [];
  if (t.default_decision)
    lines.push(`Default: ${t.default_decision} Korean-origin concepts into plain English.`);
  const rendered = (t.terms ?? []).map((x) => {
    if (x.decision === 'translate') return x.english ?? '?';
    if (x.decision === 'romanize') return `*${x.romanized ?? '?'}* (romanized)`;
    if (x.decision === 'gloss_first_use')
      return `*${x.romanized ?? '?'}* — gloss on first use: ${x.gloss ?? ''}`;
    return `${x.romanized ?? x.english ?? '?'} (script preserved only in: ${(x.preserve_contexts ?? []).join(', ')})`;
  });
  if (rendered.length) lines.push(`Approved renderings: ${rendered.join('; ')}.`);
  lines.push('Any other romanized or non-English token is an error.');
  return bullet(lines);
}

function renderPreferences(id: ComposedIdentity): string {
  const p = id.preferences;
  if (!p) return '';
  const lines: string[] = [];
  for (const t of p.textual ?? [])
    lines.push(`${t.priority === 'must' ? 'Must' : 'Prefer'} (${t.scope ?? 'all'}): ${t.text}`);
  if (p.forbidden_expressions?.length)
    lines.push(
      `Forbidden expressions: ${p.forbidden_expressions.map((x) => `"${x}"`).join(', ')}.`,
    );
  return bullet(lines);
}

function renderParticipants(parts: readonly ParticipantDigest[]): string {
  return parts
    .map((p) => {
      const lines: string[] = [];
      if (p.shortForms?.length) lines.push(`short forms: ${p.shortForms.join(', ')}`);
      for (const l of p.registerLines ?? []) lines.push(l);
      if (p.verbalHabits?.length) lines.push(`verbal habits: ${p.verbalHabits.join('; ')}`);
      if (p.forbiddenExpressions?.length)
        lines.push(`never says: ${p.forbiddenExpressions.join('; ')}`);
      return `${p.displayName}\n${bullet(lines)}`;
    })
    .join('\n');
}

type Rubric = NonNullable<ComposedIdentity['tradition']['rubric']>;

function renderRubric(rubric: Rubric | undefined, title: string): string {
  if (!rubric?.length) return '';
  return (
    `${title} — score each dimension 1–5 with evidence paragraph ids first:\n` +
    rubric
      .map((d) => {
        const anchors = d.anchors as Record<string, string | undefined>;
        return `- ${d.dimension}${d.weight !== undefined ? ` (weight ${d.weight})` : ''}: 1 = ${anchors['1'] ?? ''} · 3 = ${anchors['3'] ?? ''} · 5 = ${anchors['5'] ?? ''}`;
      })
      .join('\n')
  );
}

const ROLE_SECTIONS: Record<RoleVariant, readonly string[]> = {
  writer_full: [
    'structure',
    'cadence',
    'genres',
    'setting',
    'naming',
    'register',
    'participants',
    'terminology',
    'preferences',
    'avoid',
    'exemplars',
    'restrictions',
  ],
  editor_full: [
    'structure',
    'cadence',
    'genres',
    'naming',
    'register',
    'participants',
    'terminology',
    'preferences',
    'avoid',
    'exemplars',
    'restrictions',
  ],
  planner_compact: ['structure', 'cadence', 'genres', 'setting', 'restrictions'],
  judge_rubric_prose: ['prose_rubric', 'avoid', 'register', 'terminology', 'naming'],
  judge_rubric_structure: ['structure', 'cadence', 'structure_rubric', 'genres'],
  judge_rubric_genre: ['genres', 'genre_rubric', 'terminology'],
  // ADR-0060: voice is judged against register rules, the participants' voice cards and naming.
  judge_rubric_voice: ['register', 'participants', 'naming', 'avoid'],
  summarizer_min: ['naming', 'terminology'],
};

export function compileBlock(id: ComposedIdentity, opts: CompileOptions): CompiledBlock {
  const langContract = id.outputLanguage.contract_text;
  const tradContract = id.tradition.contract_text;
  if (!langContract) throw new Error('OUTPUT_LANGUAGE_CONTRACT_MISSING');
  if (!tradContract) throw new Error('TRADITION_CONTRACT_MISSING');
  const langHash = sha256(langContract);
  const tradHash = sha256(tradContract);
  const header = `${HEADER_PREFIX} identity=${id.ref} role=${opts.role} lang=${id.outputLanguage.language}/${id.outputLanguage.locale ?? 'en-US'} tradition=${id.tradition.tradition_id ?? 'kr-webnovel'}>>`;

  // ADR-0055: a Korean manuscript identity renders its whole block in Korean; English stays byte-stable.
  const isKo = id.outputLanguage.language === 'ko';
  const R = isKo
    ? {
        structure: renderStructureKo,
        cadence: renderCadenceKo,
        genres: renderGenresKo,
        setting: renderSettingKo,
        naming: renderNamingKo,
        register: renderRegisterKo,
        participants: renderParticipantsKo,
        terminology: renderTerminologyKo,
        preferences: renderPreferencesKo,
        rubric: renderRubricKo,
      }
    : {
        structure: renderStructure,
        cadence: renderCadence,
        genres: renderGenres,
        setting: renderSetting,
        naming: renderNaming,
        register: renderRegister,
        participants: renderParticipants,
        terminology: renderTerminology,
        preferences: renderPreferences,
        rubric: renderRubric,
      };
  const rubricTitles = isKo
    ? [
        '한국어 문장 채점 기준 (차원 A)',
        '한국 웹소설 구조 채점 기준 (차원 B)',
        '장르 채점 기준 (차원 C)',
      ]
    : [
        'English prose rubric (dimension A)',
        'Korean-webnovel structure rubric (dimension B)',
        'Genre rubric (dimension C)',
      ];
  const candidates: Record<string, Section> = {
    structure: { name: 'structure', text: R.structure(id), priority: 90 },
    cadence: { name: 'cadence', text: R.cadence(id), priority: 60 },
    genres: { name: 'genres', text: R.genres(id), priority: 70 },
    setting: { name: 'setting', text: R.setting(id), priority: 30 },
    naming: { name: 'naming', text: R.naming(id), priority: 80 },
    register: { name: 'register', text: R.register(id), priority: 85 },
    participants: {
      name: 'participants',
      text: R.participants(opts.participants ?? []),
      priority: 88,
    },
    terminology: { name: 'terminology', text: R.terminology(id), priority: 75 },
    preferences: { name: 'preferences', text: R.preferences(id), priority: 40 },
    // Korean-only craft sections (ADR-0056); empty for English identities, so English blocks keep their bytes.
    avoid: { name: 'avoid', text: isKo ? renderAvoidKo(id) : '', priority: 72 },
    // ADR-0062: exemplars are the most direct lever against 번역투, so they outrank everything but the
    // participants' voice cards; setting, preferences and cadence go first when a Korean block is tight.
    exemplars: { name: 'exemplars', text: isKo ? renderExemplarsKo(id) : '', priority: 86 },
    restrictions: {
      name: 'restrictions',
      text: opts.contentRestrictions?.length ? bullet(opts.contentRestrictions) : '',
      priority: Infinity,
    },
    prose_rubric: {
      name: 'prose_rubric',
      text: R.rubric(id.outputLanguage.rubric, rubricTitles[0] ?? ''),
      priority: Infinity,
    },
    structure_rubric: {
      name: 'structure_rubric',
      text: R.rubric(id.tradition.rubric, rubricTitles[1] ?? ''),
      priority: Infinity,
    },
    genre_rubric: {
      name: 'genre_rubric',
      text: R.rubric(id.primaryGenre?.rubric, rubricTitles[2] ?? ''),
      priority: Infinity,
    },
  };
  const wanted = ROLE_SECTIONS[opts.role]
    .map((n) => candidates[n])
    .filter((s): s is Section => s !== undefined && s.text.length > 0);

  const core = isKo
    ? [
        header,
        `## 출력 언어 계약 (한국어)\n${langContract}`,
        `## 서사 전통 계약 (한국 연재 웹소설)\n${tradContract}`,
      ]
    : [
        header,
        `## Output-Language Contract (English)\n${langContract}`,
        `## Narrative-Tradition Contract (Korean serialized webnovel)\n${tradContract}`,
      ];
  const est = isKo ? estimateTokensKo : estimateTokens;
  const coreTokens =
    est(core.join('\n\n')) +
    est(
      wanted
        .filter((s) => s.priority === Infinity)
        .map((s) => s.text)
        .join('\n'),
    );
  if (coreTokens > opts.budgetTokens) throw new BlockOverflowError(coreTokens, opts.budgetTokens);

  const included: Section[] = [];
  const dropped: string[] = [];
  // Highest priority first; shed the lowest until the block fits.
  const byPriority = [...wanted].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );
  let total = est(core.join('\n\n'));
  for (const s of byPriority) {
    const t = est(s.text) + 4;
    if (s.priority === Infinity || total + t <= opts.budgetTokens) {
      included.push(s);
      total += t;
    } else {
      dropped.push(s.name);
    }
  }
  // Render in the role's canonical order for stable bytes.
  const ordered = ROLE_SECTIONS[opts.role]
    .map((n) => included.find((s) => s.name === n))
    .filter((s): s is Section => s !== undefined);
  const titles: Record<string, string> = {
    structure: 'Structure and rhythm',
    cadence: 'Cadence',
    genres: 'Genre conventions',
    setting: 'Setting and culture',
    naming: 'Naming',
    register: 'Dialogue register',
    participants: 'Participants',
    terminology: 'Terminology',
    preferences: 'Project prose preferences',
    avoid: 'Diction to avoid',
    exemplars: 'Style exemplars',
    restrictions: 'Content restrictions (hard)',
    prose_rubric: 'Rubric',
    structure_rubric: 'Rubric',
    genre_rubric: 'Rubric',
  };
  const body = [
    ...core,
    ...ordered.map(
      (s) => `## ${(isKo ? SECTION_TITLES_KO[s.name] : titles[s.name]) ?? s.name}\n${s.text}`,
    ),
    '<<END_NARRATIVE_IDENTITY>>',
  ].join('\n\n');
  const tail =
    opts.role === 'writer_full' || opts.role === 'editor_full'
      ? id.outputLanguage.language === 'ko'
        ? IDENTITY_TAIL_KO
        : `IDENTITY_TAIL: Write natural English composed directly in English (no translation-like syntax, no honorific suffixes). Keep Korean-webnovel form: early hook, dialogue-forward scenes, short mobile paragraphs, a local payoff, and an ending with forward pull.`
      : undefined;
  return {
    text: body,
    hash: sha256(body),
    identityVersionId: id.identityVersionId,
    identityRef: id.ref,
    role: opts.role,
    outputLanguage: id.outputLanguage.language ?? 'en',
    outputLanguageContractHash: langHash,
    traditionContractHash: tradHash,
    sections: [
      'header',
      'output_language_contract',
      'tradition_contract',
      ...ordered.map((s) => s.name),
    ],
    droppedSections: dropped,
    estTokens: est(body),
    identityTail: tail,
  };
}
