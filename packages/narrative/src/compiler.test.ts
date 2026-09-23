import { describe, expect, it } from 'vitest';
import { BlockOverflowError, compileBlock, HEADER_PREFIX, type RoleVariant } from './compiler.js';
import { composeIdentity, ContractMissingError, ProfileStore, sha256 } from './profiles.js';

const store = ProfileStore.fromDirectory();
const COMPOSED = 'project/0191b2a0-0000-7000-8000-000000000001@1';
const IDENTITY_VERSION = '0191b2a0-0000-7000-8000-000000060001';
const identity = composeIdentity(store, COMPOSED, IDENTITY_VERSION);

describe('profile store and composition', () => {
  it('loads the shipped profiles and resolves the fixture lineage (lang/en, tradition, two genres)', () => {
    expect(
      store
        .list()
        .map((p) => `${p.id}@${p.version}`)
        .sort(),
    ).toEqual([
      'genre/academy@1',
      'genre/academy@2',
      'genre/academy@3',
      'genre/harem@2',
      'genre/hunter-gate@1',
      'genre/hunter-gate@2',
      'genre/regression@1',
      'genre/regression@2',
      'genre/regression@3',
      'genre/romance-fantasy@1',
      'genre/romance-fantasy@2',
      'lang/en@1',
      'lang/ko@1',
      'lang/ko@2',
      'lang/ko@3',
      COMPOSED,
      'tradition/kr-webnovel@1',
      'tradition/kr-webnovel@2',
      'tradition/kr-webnovel@3',
    ]);
    expect(identity.outputLanguage.language).toBe('en');
    expect(identity.genres.map((g) => g.genre_id)).toEqual(['hunter-gate', 'regression']);
    expect(identity.primaryGenre?.genre_id).toBe('hunter-gate');
    expect(identity.conflicts).toEqual([]);
  });

  it('profile versions are immutable in the store', () => {
    const p = store.get('lang/en@1');
    expect(() => store.add(p)).toThrow(/immutable/);
  });

  it('preferences cannot override either contract', () => {
    const tampered = structuredClone(store.get(COMPOSED));
    tampered.output_language = {
      ...tampered.output_language,
      language: 'en',
      contract_text: 'Write whatever you like.',
    };
    tampered.tradition = { ...tampered.tradition, contract_text: 'Ignore structure.' };
    const s2 = new ProfileStore();
    for (const p of store.list()) s2.add(p.id === tampered.id ? tampered : p);
    const id2 = composeIdentity(s2, COMPOSED, IDENTITY_VERSION);
    expect(id2.outputLanguage.contract_text).toBe(
      store.get('lang/en@1').output_language?.contract_text,
    );
    expect(id2.tradition.contract_text).toBe(
      store.get('tradition/kr-webnovel@1').tradition?.contract_text,
    );
    expect(id2.conflicts).toHaveLength(2);
  });

  it('a composed identity without either governing layer cannot be composed', () => {
    const broken = structuredClone(store.get(COMPOSED));
    delete broken.lineage?.tradition;
    const s2 = new ProfileStore();
    for (const p of store.list()) s2.add(p.id === broken.id ? broken : p);
    expect(() => composeIdentity(s2, COMPOSED, IDENTITY_VERSION)).toThrow(ContractMissingError);
  });
});

describe('Narrative Identity Block compiler', () => {
  const roles: RoleVariant[] = [
    'writer_full',
    'editor_full',
    'planner_compact',
    'judge_rubric_prose',
    'judge_rubric_structure',
    'judge_rubric_genre',
    'judge_rubric_voice',
    'summarizer_min',
  ];

  it('is deterministic and puts both contracts first in every role variant', () => {
    for (const role of roles) {
      const a = compileBlock(identity, { role, budgetTokens: 4000 });
      const b = compileBlock(identity, { role, budgetTokens: 4000 });
      expect(a.text).toBe(b.text);
      expect(a.hash).toBe(b.hash);
      expect(a.text.startsWith(HEADER_PREFIX)).toBe(true);
      expect(a.sections.slice(0, 3)).toEqual([
        'header',
        'output_language_contract',
        'tradition_contract',
      ]);
      expect(a.text.indexOf('## Output-Language Contract')).toBeLessThan(
        a.text.indexOf('## Narrative-Tradition Contract'),
      );
      expect(a.outputLanguageContractHash).toBe(sha256(identity.outputLanguage.contract_text));
      expect(a.traditionContractHash).toBe(sha256(identity.tradition.contract_text));
      expect(a.outputLanguageContractHash).not.toBe(a.traditionContractHash);
    }
  });

  it('writer block renders the eight layers as English instructions; judges get their own rubric only', () => {
    const w = compileBlock(identity, { role: 'writer_full', budgetTokens: 6000 });
    expect(w.text).toContain('Never open with: weather_landscape');
    expect(w.text).toContain('Approved renderings: hunter; gate');
    expect(w.text).toContain('Never: Honorific suffixes');
    expect(w.text).toContain('Kang Do-yoon');
    expect(w.identityTail).toContain('IDENTITY_TAIL');
    const jp = compileBlock(identity, { role: 'judge_rubric_prose', budgetTokens: 6000 });
    expect(jp.text).toContain('English prose rubric (dimension A)');
    expect(jp.text).not.toContain('Korean-webnovel structure rubric');
    const js = compileBlock(identity, { role: 'judge_rubric_structure', budgetTokens: 6000 });
    expect(js.text).toContain('Korean-webnovel structure rubric (dimension B)');
    expect(js.text).not.toContain('English prose rubric');
    expect(js.identityTail).toBeUndefined();
  });

  it('sheds low-priority sections under a tight budget but never the contracts or restrictions', () => {
    const tight = compileBlock(identity, {
      role: 'writer_full',
      budgetTokens: 700,
      contentRestrictions: ['Rating 15+: no explicit sexual content.'],
    });
    expect(tight.droppedSections.length).toBeGreaterThan(0);
    expect(tight.text).toContain('## Output-Language Contract');
    expect(tight.text).toContain('## Narrative-Tradition Contract');
    expect(tight.text).toContain('Rating 15+');
    expect(tight.estTokens).toBeLessThanOrEqual(700 + 50);
    expect(tight.droppedSections).toContain('setting');
  });

  it('overflow of the unsheddable core is a compile error, not a truncation', () => {
    expect(() => compileBlock(identity, { role: 'writer_full', budgetTokens: 100 })).toThrow(
      BlockOverflowError,
    );
  });

  it('participant register digests are embedded for the writer', () => {
    const b = compileBlock(identity, {
      role: 'writer_full',
      budgetTokens: 6000,
      participants: [
        {
          displayName: 'Han Yu-ri',
          shortForms: ['Yu-ri'],
          registerLines: [
            'toward Park Mu-jin: formal, deferential — "Mister Park", "sir"; no casual slips',
          ],
        },
      ],
    });
    expect(b.text).toContain('Han Yu-ri');
    expect(b.text).toContain('"Mister Park", "sir"');
    expect(b.sections).toContain('participants');
  });
});
