import { describe, expect, it } from 'vitest';
import { contentHash, PromptRegistry, PromptRegistryError, renderPrompt } from './registry.js';

const REQUIRED_FAMILIES = [
  'requirement_interpreter',
  'assumption_explainer',
  'concept_generator',
  'concept_comparator',
  'chapter_comparator',
  'character_designer',
  'world_builder',
  'power_system_designer',
  'story_architect',
  'arc_planner',
  'chapter_planner',
  'scene_planner',
  'scene_writer',
  'chapter_assembler',
  'contract_checker',
  'continuity_checker',
  'knowledge_leak_checker',
  'prose_judge',
  'structure_judge',
  'genre_judge',
  'voice_judge',
  'targeted_reviser',
  'canon_extractor',
  'extraction_reconciler',
  'factual_summarizer',
  // ADR-0060
  'promise_checker',
  'repetition_judge',
];
const TOTAL_PROMPT_VERSIONS = 303;
/** Families that first appear after the v3/v4.0.0 families (ADR-0060). */
const ADDED_AFTER_V4: ReadonlySet<string> = new Set(['promise_checker', 'repetition_judge']);
/** The active default set (latest `active` version of every family). */
const ACTIVE_VERSION = '4.0.0';
/** Families with a later live-run fix on top of ACTIVE_VERSION (ADR-0056). */
const ACTIVE_OVERRIDES: Readonly<Record<string, string>> = {
  arc_planner: '4.0.1',
  canon_extractor: '4.3.0',
  story_architect: '4.3.0',
  targeted_reviser: '4.0.1',
  chapter_planner: '4.2.0',
  scene_planner: '4.2.0',
  scene_writer: '4.2.0',
  structure_judge: '4.1.0',
  prose_judge: '4.1.0',
  genre_judge: '4.4.0',
  voice_judge: '4.4.0',
  continuity_checker: '4.4.0',
  knowledge_leak_checker: '4.4.0',
  promise_checker: '4.4.0',
  repetition_judge: '4.4.0',
};

describe('prompt registry (ADR-0016)', () => {
  const reg = PromptRegistry.fromDirectory();

  it('loads all production families with verified immutable content hashes', () => {
    expect(reg.families()).toEqual([...REQUIRED_FAMILIES].sort());
    expect(reg.list()).toHaveLength(TOTAL_PROMPT_VERSIONS);
    for (const v of reg.list()) {
      expect(v.status).toBe('active');
      expect(v.content_hash).toBe(contentHash(v, v.system_template, v.user_template));
      expect(v.changelog.length).toBeGreaterThan(10);
      expect(v.regression_cases.length).toBeGreaterThan(0);
    }
  });

  it('style-sensitive prompts embed the identity block and name a variant; manuscript prompts are style-sensitive', () => {
    for (const v of reg.list()) {
      if (v.style_sensitive) {
        expect(v.identity_variant, v.id).not.toBeNull();
        expect(v.system_template, v.id).toContain('{{narrative_identity_block}}');
      }
      if (v.manuscript_producing) expect(v.style_sensitive, v.id).toBe(true);
    }
    expect(reg.get('scene_writer@1.0.0')).toMatchObject({
      manuscript_producing: true,
      identity_variant: 'writer_full',
      model_class: 'P',
    });
    expect(reg.get('prose_judge@1.0.0').identity_variant).toBe('judge_rubric_prose');
    expect(reg.get('structure_judge@1.0.0').identity_variant).toBe('judge_rubric_structure');
    expect(reg.get('canon_extractor@1.0.0').style_sensitive).toBe(false);
  });

  it('Korean v2 prompts are authored in Korean; no prompt asks for a translation step (ADR-0054, NO-TRANSLATION-001)', () => {
    for (const v of reg.list()) {
      const text = `${v.system_template}\n${v.user_template}`;
      expect(text, v.id).not.toMatch(/translate (it|this|the text) into English/i);
      const hasHangul = /[\uac00-\ud7a3]/.test(text);
      if (!v.version.startsWith('1.')) {
        expect(hasHangul, `${v.id} Korean version must be authored in Korean`).toBe(true);
      } else {
        expect(hasHangul, `${v.id} legacy version contains Hangul`).toBe(false);
      }
    }
  });

  it('rejects a version whose recorded hash does not match its content (immutability)', () => {
    const v = reg.get('scene_writer@1.0.0');
    const r2 = new PromptRegistry();
    expect(() =>
      r2.add(
        { ...v, version: '1.0.1', content_hash: v.content_hash },
        v.system_template + ' edited',
        v.user_template,
      ),
    ).toThrow(PromptRegistryError);
    expect(() =>
      r2.add(
        { ...v, version: '1.0.1', content_hash: v.content_hash },
        v.system_template + ' edited',
        v.user_template,
      ),
    ).toThrow(/HASH_MISMATCH/);
  });

  it('rejects undeclared template variables and style-sensitive prompts without the block', () => {
    const base = reg.get('assumption_explainer@1.0.0');
    const r2 = new PromptRegistry();
    expect(() =>
      r2.add(
        { ...base, version: '2.0.0', content_hash: undefined },
        'hello {{unknown_var}}',
        base.user_template,
      ),
    ).toThrow(/UNKNOWN_VARIABLE/);
    expect(() =>
      r2.add(
        {
          ...base,
          version: '2.0.0',
          content_hash: undefined,
          style_sensitive: true,
          identity_variant: 'planner_compact',
        },
        'no block here',
        base.user_template,
      ),
    ).toThrow(/MISSING_VARIABLE/);
    expect(() =>
      r2.add(
        {
          ...base,
          version: '2.0.0',
          content_hash: undefined,
          style_sensitive: true,
          identity_variant: null,
        },
        base.system_template,
        base.user_template,
      ),
    ).toThrow(/IDENTITY_VARIANT_REQUIRED/);
  });

  it('renders with all declared variables and refuses missing ones', () => {
    const v = reg.get('assumption_explainer@1.0.0');
    const r = renderPrompt(v, { assumptions_json: '[{"assumption_id":"a1"}]' });
    expect(r.user).toContain('"assumption_id":"a1"');
    expect(r.promptHash).toBe(v.content_hash);
    expect(() => renderPrompt(v, {})).toThrow(/MISSING_VARIABLE/);
    const w = reg.get('scene_writer@1.0.0');
    expect(() =>
      renderPrompt(w, Object.fromEntries(w.input_variables.map((x) => [x, 'x']))),
    ).toThrow(/narrative_identity_block/);
  });

  it('v3 and v4 prompts are Korean end to end: no English section labels or instructions (ADR-0055)', () => {
    const provenanceTags = new Set(['FACT', 'PLANNED', 'SUMMARY', 'EVIDENCE', 'UNTRUSTED']);
    for (const v of reg.list().filter((x) => /^[34]\./.test(x.version))) {
      const text = `${v.system_template}\n${v.user_template}`;
      for (const m of text.matchAll(/\[([A-Z][A-Z ]{2,})/g)) {
        const label = (m[1] ?? '').trim();
        expect(provenanceTags.has(label), `${v.id} has English label [${label}`).toBe(true);
      }
      // Single-brace placeholders never substitute; they reached the model verbatim in v2.x.
      expect(text, v.id).not.toMatch(/(?<!\{)\{[a-z_]+\}(?!\})/);
      // Instruction prose outside the JSON shape must not contain English sentences.
      const prose = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('{') && !l.includes('{{'))
        .join('\n');
      expect(prose, v.id).not.toMatch(/\b(the|and|must|never|return|write)\b [a-z]+ [a-z]+/i);
    }
  });

  it('arc_planner@4.0.1 gives repetition_check the schema object shape (live-run fix)', () => {
    expect(reg.get('arc_planner@4.0.0').user_template).toContain('"repetition_check": "..."');
    const fixed = reg.get('arc_planner@4.0.1');
    expect(fixed.user_template).toContain('"repetition_check": {"compared_arc_ids": []');
    expect(fixed.input_variables).toEqual(reg.get('arc_planner@4.0.0').input_variables);
  });

  it('targeted_reviser@4.0.1 asks for the exact quote and the schema shapes (live-run fix)', () => {
    const old = reg.get('targeted_reviser@4.0.0');
    expect(old.user_template).toContain('"changed_claims": [{"before": "...", "after": "..."}]');
    const fixed = reg.get('targeted_reviser@4.0.1');
    expect(fixed.user_template).toContain('"span": {"original_quote":');
    expect(fixed.user_template).toContain('"changed_claims": []');
    expect(fixed.user_template).not.toContain('"regression"');
    expect(fixed.user_template).not.toContain('"start": 0');
    expect(fixed.input_variables).toEqual(old.input_variables);
    expect(fixed.output_schema).toBe(old.output_schema);
  });

  it('v4.1.0 applies the first live chapter: enum shapes and one opening rule (ADR-0056 §13)', () => {
    const judges = ['prose_judge', 'structure_judge', 'genre_judge', 'voice_judge'];
    const checkers = ['continuity_checker', 'knowledge_leak_checker'];
    const planners = ['chapter_planner', 'scene_planner', 'scene_writer'];
    for (const fam of [...judges, ...checkers, ...planners]) {
      const old = reg.get(`${fam}@4.0.0`);
      const v = reg.get(`${fam}@4.1.0`);
      expect(v.input_variables, fam).toEqual(old.input_variables);
      expect(v.output_mode, fam).toBe(old.output_mode);
      expect(v.output_schema, fam).toBe(old.output_schema);
    }
    for (const fam of judges) {
      const user = reg.get(`${fam}@4.1.0`).user_template;
      expect(user, fam).not.toMatch(/"kind": "(prose|structure|genre|voice)_issue"/);
      expect(user, fam).not.toMatch(/"dimension_scores": \{"(prose|structure|genre|voice)": 72\}/);
      expect(user, fam).toMatch(/1~5점/);
    }
    expect(reg.get('prose_judge@4.1.0').user_template).toContain(
      '"drift_flags": ["translation_like|literary|light_novel|format"]',
    );
    expect(reg.get('structure_judge@4.1.0').user_template).toContain(
      '"drift_flags": ["western_novel|serial|exposition|cadence"]',
    );
    expect(reg.get('continuity_checker@4.1.0').user_template).toContain(
      '"repair": {"scope": "sentence|paragraph|dialogue|scene", "suggestion":',
    );
    // The planner no longer exempts a possession wake-up; the judge and writer name the same opening.
    expect(reg.get('chapter_planner@4.0.0').system_template).toContain(
      '빙의 직후의 충격은 사건 한복판으로 친다',
    );
    expect(reg.get('chapter_planner@4.1.0').system_template).not.toContain('사건 한복판으로 친다');
    for (const fam of ['chapter_planner', 'structure_judge', 'scene_writer'])
      expect(reg.get(`${fam}@4.1.0`).system_template, fam).toContain('‘눈을 떴다’');
  });

  it('v4.2.0: the writer does not count its own draft and resolves conflicts by precedence (ADR-0056 §14)', () => {
    for (const fam of ['chapter_planner', 'scene_planner', 'scene_writer']) {
      const old = reg.get(`${fam}@4.1.0`);
      const v = reg.get(`${fam}@4.2.0`);
      expect(v.input_variables, fam).toEqual(old.input_variables);
      expect(v.output_mode, fam).toBe(old.output_mode);
      expect(v.output_schema, fam).toBe(old.output_schema);
      expect(v.user_template, fam).toBe(old.user_template);
    }
    const writer = reg.get('scene_writer@4.2.0').system_template;
    expect(reg.get('scene_writer@4.1.0').system_template).toContain('±12% 안');
    expect(writer).not.toContain('±12%');
    expect(writer).toContain('글자 수를 세거나 검산하지 않는다');
    expect(writer).toContain(
      '정사 상태·지식 표 > 이전 텍스트 > 회차 계약(위험·대응 포함) > 장면 계획',
    );
    expect(reg.get('chapter_planner@4.2.0').system_template).toContain(
      '말버릇에 적힌 대사는 틀이다',
    );
    expect(reg.get('scene_planner@4.2.0').system_template).toContain(
      '이전 장면에서 이미 정해진 대로 이어 간다',
    );
  });

  it('v4 keeps the v3 variable surfaces and output shapes, except the prose-only scene writer (ADR-0056)', () => {
    for (const fam of reg.families()) {
      if (ADDED_AFTER_V4.has(fam)) continue;
      const v3 = reg.get(`${fam}@3.0.0`);
      const v4 = reg.get(`${fam}@4.0.0`);
      expect(v4.output_schema, fam).toBe(v3.output_schema);
      if (fam === 'scene_writer') continue;
      expect(v4.input_variables, fam).toEqual(v3.input_variables);
      expect(v4.output_mode, fam).toBe(v3.output_mode);
    }
    const writer = reg.get('scene_writer@4.0.0');
    // The writer answers with prose itself; the workflow builds the scene-draft envelope.
    expect(writer.output_mode).toBe('text');
    expect(writer.input_variables).toEqual(
      expect.arrayContaining([
        ...reg.get('scene_writer@3.0.0').input_variables,
        'scene_total',
        'scene_role',
      ]),
    );
    expect(writer.user_template).not.toMatch(/speaker_annotations|claims/);
    expect(writer.system_template).toMatch(/원고 본문만 출력한다/);
  });

  it('v4.4.0 gives every evaluator its own inputs and adds the two missing evaluators (ADR-0060)', () => {
    const continuity = reg.get('continuity_checker@4.4.0');
    expect(continuity.input_variables).toEqual(
      expect.arrayContaining(['locked_canon', 'story_position', 'canon_state', 'chapter_text']),
    );
    expect(continuity.input_variables).not.toContain('locked_facts');
    const leak = reg.get('knowledge_leak_checker@4.4.0');
    expect(leak.input_variables).toEqual([
      'chapter_text',
      'knowledge_stances',
      'knowledge_guard_list',
      'reader_secrets',
    ]);
    const voice = reg.get('voice_judge@4.4.0');
    expect(voice.identity_variant).toBe('judge_rubric_voice');
    expect(voice.input_variables).toEqual(
      expect.arrayContaining(['voice_cards', 'address_matrix', 'register_check_report']),
    );
    expect(reg.get('genre_judge@4.4.0').input_variables).toEqual([
      'chapter_text',
      'terminology_checks',
    ]);
    for (const fam of ['promise_checker', 'repetition_judge']) {
      const v = reg.get(`${fam}@4.4.0`);
      expect(v, fam).toMatchObject({
        style_sensitive: false,
        output_mode: 'json',
        status: 'active',
      });
      expect(v.system_template, fam).toMatch(/[\uac00-\ud7a3]/);
    }
    expect(reg.get('promise_checker@4.4.0').input_variables).toEqual([
      'chapter_text',
      'chapter_obligations',
      'promise_ledger',
    ]);
    // The four existing families keep their answer example: only the inputs changed.
    for (const fam of [
      'continuity_checker',
      'knowledge_leak_checker',
      'voice_judge',
      'genre_judge',
    ]) {
      const example = (t: string) =>
        t.split('\n')[t.split('\n').findIndex((l) => l.startsWith('[출력 스키마')) + 1];
      expect(example(reg.get(`${fam}@4.4.0`).user_template), fam).toBe(
        example(reg.get(`${fam}@4.1.0`).user_template),
      );
    }
  });

  it('builds a pinned prompt set from the active versions', () => {
    const set = reg.activeSet();
    expect(Object.keys(set.mapping)).toHaveLength(27);
    for (const fam of Object.keys(set.mapping)) {
      expect(set.mapping[fam], fam).toBe(`${fam}@${ACTIVE_OVERRIDES[fam] ?? ACTIVE_VERSION}`);
    }
    expect(set.id).toMatch(/^set:[0-9a-f]{16}$/);
  });

  it('pins the full-bible contracts in the revised planning prompts', () => {
    expect(reg.get('character_designer@1.1.0').system_template).toMatch(
      /every supplied character name is authoritative/i,
    );
    expect(reg.get('world_builder@1.1.0').system_template).toMatch(
      /at least one meaningful location/i,
    );
    expect(reg.get('power_system_designer@1.1.0').system_template).toMatch(/need not be magical/i);
    expect(reg.get('story_architect@1.1.0').system_template).toMatch(
      /contiguous, non-overlapping/i,
    );
    expect(reg.get('story_architect@1.1.0').system_template).toMatch(
      /target chapter count through the committed ending/i,
    );
    expect(reg.get('arc_planner@1.1.0').system_template).toMatch(
      /complete supplied planned bible/i,
    );
    expect(reg.get('chapter_planner@1.1.0').system_template).toMatch(/complete \[PLANNED\] bible/i);
    for (const family of ['story_architect', 'arc_planner', 'chapter_planner']) {
      expect(reg.get(`${family}@1.1.0`).system_template).toContain('[PLANNED]');
    }
  });
});
