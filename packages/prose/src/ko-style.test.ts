import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { koStyleDigest, lintKoreanWebnovel } from './ko-style.js';

const markers = [
  { id: 'TRN-KO-03', pattern: '(을|를) 통해(서)?', weight: 0.4, note: '‘~로’로.' },
  { id: 'TRN-KO-09', pattern: '(을|를) 느낄 수 있었다', weight: 0.5, note: '감각을 바로.' },
];
const patterns = [
  {
    id: 'AIT-KO-01',
    category: 'stale_cliche',
    pattern: '알 수 없는 (감정|기분)',
    severity: 'minor',
  },
  { id: 'SP-02', category: 'outline', pattern: '(^|\\n)\\s*(#{1,6}\\s)', severity: 'major' },
];

describe('lintKoreanWebnovel', () => {
  it('flags 번역투, clichés, format drift and Latin script with code-point spans', () => {
    const text =
      '# 1화\n\n그는 검을 통해 증명했다. 그녀의 살기를 느낄 수 있었다.\n\n알 수 없는 감정이 밀려왔다. OKAY.';
    const r = lintKoreanWebnovel(text, {
      translationMarkers: markers,
      forbiddenPatterns: patterns,
    });
    const ids = r.findings.map((f) => f.rule_id);
    expect(ids).toEqual(
      expect.arrayContaining(['TRN-KO-03', 'TRN-KO-09', 'AIT-KO-01', 'SP-02', 'TRN-KO-02']),
    );
    const trn = r.findings.find((f) => f.rule_id === 'TRN-KO-03');
    expect(trn?.paragraph_ids).toEqual(['p2']);
    expect(trn?.quote).toBe('을 통해');
    expect(r.metrics.cliche_hits).toBe(1);
  });

  it('measures pronoun density, long paragraphs, dialogue share and reflective endings', () => {
    const long =
      '그는 걸었다. 그는 멈췄다. 그는 돌아봤다. 그는 다시 걸었다. 그녀는 그를 보고 있었다. 그의 발소리가 울렸다.';
    const text =
      [...Array(12).keys()].map(() => long).join('\n\n') + '\n\n그렇게 그날 하루가 저물었다.';
    const r = lintKoreanWebnovel(text);
    const ids = r.findings.map((f) => f.rule_id);
    expect(ids).toEqual(
      expect.arrayContaining(['KO-PRN-RATE', 'KO-PARA-LONG', 'KO-DLG-LOW', 'KO-END-01']),
    );
    expect(r.findings.find((f) => f.rule_id === 'KO-END-01')?.severity).toBe('major');
    expect(koStyleDigest(r)).toContain('측정:');
  });

  it('passes a clean mobile-serial passage and respects the allowlist', () => {
    const text =
      '“비켜.”\n\n반장이 턱을 치켜들었다.\n\n“싫은데?”\n\n‘셋. 진짜는 뒤에 있는 놈.’\n\n[근력이 1 올랐습니다.]\n\n문 뒤에서 누가 박수를 쳤다.';
    const r = lintKoreanWebnovel(text, {
      translationMarkers: markers,
      forbiddenPatterns: patterns,
    });
    expect(r.findings).toEqual([]);
    const withLatin = lintKoreanWebnovel('“Lumen이다.”', { allowlist: ['Lumen'] });
    expect(withLatin.findings.filter((f) => f.rule_id === 'TRN-KO-02')).toEqual([]);
  });

  it('detects verbatim reuse of a studio exemplar line', () => {
    const exemplar = '“재밌는 신입이 들어왔네.”\n\n학생회 완장을 찬 여자가 웃고 있었다.';
    const r = lintKoreanWebnovel('그때였다.\n\n학생회 완장을 찬 여자가 웃고 있었다.', {
      exemplarTexts: [exemplar],
    });
    expect(r.findings.map((f) => f.rule_id)).toContain('EXEMPLAR-COPY');
  });
});

describe('ADR-0062 rules: spelling, ending monotony, misspelled names', () => {
  const profile = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../examples/narrative-profiles/lang-ko.v4.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as {
    output_language: {
      forbidden_patterns: { id: string; category: string; pattern: string; severity: string }[];
      lint_thresholds: Record<string, { warn: number; fail: number }>;
    };
  };
  const v4 = {
    forbiddenPatterns: profile.output_language.forbidden_patterns,
    thresholds: profile.output_language.lint_thresholds,
  };

  it('reports common misspellings from the language layer as minor 맞춤법 findings with the correction', () => {
    const r = lintKoreanWebnovel(
      '처음 보는 천장이 낮설었다. 몇일이 지났는지 모른다. 금새 해가 졌다.',
      v4,
    );
    const spelling = r.findings.filter((f) => f.rule_id.startsWith('KO-SP-'));
    expect(spelling.map((f) => f.rule_id)).toEqual(['KO-SP-01', 'KO-SP-02', 'KO-SP-03']);
    for (const f of spelling) {
      expect(f.kind).toBe('other');
      expect(f.severity).toBe('minor');
      expect(f.message).toMatch(/^맞춤법: /);
    }
    expect(spelling[0]?.message).toContain('‘낯설다’');
    expect(spelling[0]?.quote).toBe('낮설');
  });

  it('flags a run of narration sentences closing on the same two syllables, not varied endings', () => {
    const monotone =
      '그는 문을 열었다. 복도를 걸었다. 창을 넘었다. 벽을 짚었다. 빵을 먹었다. 외투를 벗었다.';
    expect(
      lintKoreanWebnovel(monotone, v4).findings.find((f) => f.rule_id === 'KO-END-02'),
    ).toMatchObject({ severity: 'minor', value: 6, threshold: 5 });
    // Four in a row is below the starting threshold (5).
    const four = '그는 문을 열었다. 복도를 걸었다. 창을 넘었다. 벽을 짚었다. 칼을 잡았다.';
    expect(lintKoreanWebnovel(four, v4).findings.some((f) => f.rule_id === 'KO-END-02')).toBe(
      false,
    );
    const varied = '그는 문을 열었다. 복도는 길었다. 누군가 웃는다. 발소리가 멈췄지. 조용하다.';
    expect(lintKoreanWebnovel(varied, v4).findings.some((f) => f.rule_id === 'KO-END-02')).toBe(
      false,
    );
  });

  it('flags a word one syllable away from a registered character name, never the name or its particles', () => {
    const r = lintKoreanWebnovel(
      '서지안은 칼을 들었다. 서지얀이 뒤를 돌아봤다. 서지안의 손이 떨렸다.',
      {
        ...v4,
        personNames: ['서지안'],
      },
    );
    const names = r.findings.filter((f) => f.rule_id === 'KO-NAME-01');
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({
      kind: 'naming_registry_violation',
      severity: 'minor',
      quote: '서지얀',
    });
  });

  it('runs none of the three rules for a language layer without their thresholds (lang/ko@3)', () => {
    const r = lintKoreanWebnovel(
      '그는 문을 열었다. 복도를 걸었다. 창을 넘었다. 벽을 짚었다. 칼을 잡았다. 서지얀이 웃었다.',
      { personNames: ['서지안'] },
    );
    expect(r.findings.some((f) => ['KO-END-02', 'KO-NAME-01'].includes(f.rule_id))).toBe(false);
  });

  it('reports the 속마음 share apart from dialogue', () => {
    const r = lintKoreanWebnovel('‘이상하다.’ 그는 생각했다.\n\n“뭐야?” 그녀가 물었다.', v4);
    expect(r.metrics.monologue_ratio).toBeGreaterThan(0);
    expect(r.metrics.dialogue_ratio).toBeGreaterThan(0);
  });
});
