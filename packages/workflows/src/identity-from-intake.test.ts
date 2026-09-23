import { describe, expect, it } from 'vitest';
import { compileBlock, composeIdentity, ProfileStore } from '@yeonjae/narrative';
import { identityProfileFromIntake } from './identity-from-intake.js';
import { type StoryIntake } from './planning.js';

const BASE: StoryIntake = {
  title_working: 'Test Novel',
  premise:
    'A disgraced cadet discovers the academy’s ledger of the world is being rewritten, one page at a time.',
  premise_language: 'en',
  genre: { primary: 'academy' },
  main_character: { name: 'Kael', role: 'protagonist', description: 'new arrival' },
  target_chapters: 200,
  target_words_per_chapter: 3000,
  operating_mode: 'autopilot',
};

const store = ProfileStore.fromDirectory();

describe('identityProfileFromIntake manuscript language (ADR-0054)', () => {
  it('defaults to the English output-language profile when unset', () => {
    const profile = identityProfileFromIntake('project-x', BASE, store);
    expect(profile.lineage?.output_language).toBe('lang/en@1');
    expect(profile.output_language?.language).toBe('en');
  });

  it('selects the Korean output-language profile when manuscript_language is ko', () => {
    const profile = identityProfileFromIntake(
      'project-x',
      { ...BASE, manuscript_language: 'ko' },
      store,
    );
    expect(profile.lineage?.output_language).toBe('lang/ko@3');
    expect(profile.lineage?.tradition).toBe('tradition/kr-webnovel@3');
    expect(profile.lineage?.genres).toEqual(['genre/academy@3']);
    expect(profile.output_language?.language).toBe('ko');
    expect(profile.output_language?.locale).toBe('ko-KR');
  });
});

describe('Korean identity block (ADR-0055)', () => {
  const koStore = ProfileStore.fromDirectory();
  const profile = identityProfileFromIntake(
    'project-ko',
    {
      ...BASE,
      manuscript_language: 'ko',
      genre: { primary: 'academy', secondary: ['possession'] },
      main_character: { name: '루카스 에버하트', role: 'protagonist', description: '엑스트라' },
    },
    koStore,
  );
  koStore.add(profile);
  const identity = composeIdentity(koStore, 'project/project-ko@1', 'version-1');

  it('drops the English-manuscript policies for a Korean fantasy project', () => {
    expect(profile.setting?.setting_type).toBe('secondary_world');
    expect(profile.naming?.style).toBe('western');
    expect(profile.naming?.romanization_system).toBeUndefined();
    const rules = JSON.stringify(profile.register_policy);
    expect(rules).not.toMatch(/sir|ma’am|contractions/i);
  });

  it.each([
    'writer_full',
    'editor_full',
    'planner_compact',
    'judge_rubric_prose',
    'judge_rubric_structure',
    'judge_rubric_genre',
    'judge_rubric_voice',
    'summarizer_min',
  ] as const)('renders the %s block in Korean with no English instructions', (role) => {
    const block = compileBlock(identity, { role, budgetTokens: 6000 });
    expect(block.outputLanguage).toBe('ko');
    const body = block.text.split('\n').slice(1).join('\n');
    expect(body).toMatch(/출력 언어 계약/);
    expect(body).not.toMatch(/Output-Language Contract|English|Never open with|Use these/);
    expect(body).not.toMatch(/\b(the|and|with|never|must) [a-z]+/i);
    if (block.identityTail) expect(block.identityTail).toMatch(/한국어/);
  });
});

describe('Korean webnovel craft layers (ADR-0056)', () => {
  const craftStore = ProfileStore.fromDirectory();
  const profile = identityProfileFromIntake(
    'project-harem',
    {
      ...BASE,
      manuscript_language: 'ko',
      genre: { primary: 'academy', secondary: ['possession', 'harem'] },
      main_character: { name: '이안 하르트', role: 'protagonist', description: '엑스트라' },
    },
    craftStore,
  );
  craftStore.add(profile);
  const identity = composeIdentity(craftStore, 'project/project-harem@1', 'version-1');

  it('composes from the newest Korean layers, including the Korean-only harem overlay', () => {
    expect(profile.lineage?.genres).toEqual([
      'genre/academy@3',
      'genre/regression@3',
      'genre/harem@2',
    ]);
    // English projects never pick up the Korean-only layer.
    const en = identityProfileFromIntake(
      'project-en',
      { ...BASE, genre: { primary: 'academy', secondary: ['harem'] } },
      craftStore,
    );
    expect(en.lineage?.genres).toEqual(['genre/academy@1']);
  });

  it('gives writers and editors the avoid list and at most three studio exemplars; planners get neither', () => {
    for (const role of ['writer_full', 'editor_full'] as const) {
      const block = compileBlock(identity, { role, budgetTokens: 6000 });
      expect(block.sections).toEqual(expect.arrayContaining(['avoid', 'exemplars']));
      expect(block.text).toMatch(/## 쓰지 않는 문장 \(번역투·AI 상투구\)/);
      expect(block.text).toMatch(/## 문체 견본 \(리듬 참고용, 베끼기 금지\)/);
      expect(block.text.match(/〔견본 \d — /g)).toHaveLength(3);
      expect(block.text).toMatch(/절대 가져다 쓰지 않/);
    }
    const planner = compileBlock(identity, { role: 'planner_compact', budgetTokens: 6000 });
    expect(planner.sections).not.toContain('exemplars');
    expect(planner.text).not.toMatch(/문체 견본/);
    const judge = compileBlock(identity, { role: 'judge_rubric_prose', budgetTokens: 6000 });
    expect(judge.sections).toContain('avoid');
  });

  it('sheds the exemplars before the core rules under a tight budget', () => {
    const block = compileBlock(identity, { role: 'writer_full', budgetTokens: 2600 });
    expect(block.droppedSections).toContain('exemplars');
    expect(block.sections).toContain('structure');
  });
});
