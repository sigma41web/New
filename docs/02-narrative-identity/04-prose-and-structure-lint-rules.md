# Prose and Structure Lint Rules

Deterministic checks implemented in `packages/prose` (English text analysis; optional grammar service,
ADR-0028) and `packages/narrative` (structure rules, thresholds). All rules emit
`Violation { rule_id, severity, span, message, metric_value, threshold }` with spans in Unicode code-point
offsets (ADR-0030). Severities and thresholds come from the bound Narrative Identity version and are
**calibration-dependent starting values** (ADR-0029). Two rule families:

- **EP-\*** English Prose rules (dimension A) — apply to English manuscript text only.
- **ST-\*** Structure rules (dimension B) — language-neutral Korean-webnovel form.

Korean-language rules (sentence-ending repetition, pronoun omission expectations, morphological honorific
checks, Korean punctuation) **do not exist in this system**; they cannot apply to English prose.

## 1. Preprocessing

1. NFC normalize; strip chapter headers; parse **system blocks** (status windows, system messages,
   leaderboards, forum interludes, letters) separately using the tradition/genre format grammars.
2. Segment paragraphs, sentences (English sentence splitter tolerant of quotes, ellipses, abbreviations),
   utterances (text within the locale's dialogue quotes, with speaker annotations from the structured
   draft).
3. English token/POS tagging (lightweight tagger in `packages/prose`; optional grammar service adds
   grammar diagnostics).
4. **Output-language check** (gate before everything else): language identification on prose segments
   excluding registry romanizations and preserved-script contexts; English ≥ 0.99 required (`EP-LANG-01`,
   blocking).
5. Build per-paragraph feature vectors; cache by paragraph hash for incremental re-lint after patches.

## 2. English prose rules (EP-*)

| Rule | Metric | Starting warn / fail | Span |
| --- | --- | --- | --- |
| `EP-LANG-01` Output language | non-English prose segment detected | fail (blocking) | segment |
| `EP-GRM-01` Grammar/fluency signals | grammar-service diagnostics per 1,000 words (if service enabled) or heuristic signals (subject–verb agreement patterns, article omission before singular count nouns, tense inconsistency in narration) | 3 / 6 | sentence |
| `EP-OPEN-01` Repetitive sentence openings | consecutive sentences starting with the same word/lemma (excluding dialogue) | 3 / 4 | run |
| `EP-OPEN-02` Opening-pattern monotony | share of narrative sentences starting with a pronoun subject (`He/She/They/It`) in a scene | 0.6 / 0.75 | scene |
| `EP-LEN-01` Long sentence | words per sentence (en); 어절 per sentence (ko) | 35 / 50 (en); 18 / 25 (ko) | sentence |
| `EP-LEN-02` Long paragraph | words per paragraph (en); 어절 per paragraph (ko) | 60 / 90 narration, 40 / 60 dialogue (en); 30 / 45 narration, 20 / 30 dialogue (ko) | paragraph |
| `EP-LEN-03` Low rhythm variance | stdev of sentence length (words/어절) within a scene below floor | 4 / 3 | scene |
| `EP-DLG-01` Dialogue-tag overuse | share of utterances with tags other than said/asked (`exclaimed`, `retorted`…) | 0.2 / 0.35 | utterance |
| `EP-DLG-02` Adverb-tagged dialogue | `said/asked + -ly adverb` share | 0.15 / 0.3 | utterance |
| `EP-DLG-03` Tag density | share of utterances with any explicit tag (vs action beats) | 0.5 / 0.7 | chapter |
| `EP-FLT-01` Filter words | `felt/saw/heard/noticed/realized that` per 1,000 words | 6 / 10 | each |
| `EP-ADV-01` Adverb density | `-ly` adverbs per 1,000 words (narration) | 12 / 20 | scene |
| `EP-TRN-*` Translation-like syntax | see §2.3; aggregated `translation_marker_rate` per 1,000 words | 1.5 / 3.0 | span |
| `EP-LOC-01` Spelling-locale inconsistency | tokens from the *other* locale's spelling list (color/colour, realize/realise) | 1 / 3 | token |
| `EP-PUNC-01` Quote style | straight quotes; wrong quote nesting for locale; `「」` | fail | span |
| `EP-PUNC-02` Ellipsis/dash style | `...`; spaced em dashes (en-US); > 2 ellipses per paragraph | warn | span |
| `EP-TERM-01` Unapproved untranslated term | romanized/foreign token not in the terminology registry (dictionary + registry check) | fail | token |
| `EP-TERM-02` Inconsistent rendering | two spellings for one registry term (Jaro-Winkler ≥ 0.9 variants) | fail | token |
| `EP-TERM-03` Script outside preserve contexts | Hangul/CJK characters outside `preserve_contexts` | fail (blocking) | token |
| `EP-TERM-04` Missing first-use gloss | policy `gloss_first_use` term without gloss on first appearance in the project | major | token |
| `EP-NAME-01` Name registry violation | name spelling not matching `display_name`/`short_forms`/`romanization` | fail | token |
| `EP-NAME-02` Native-script name in prose | `native_script_name` appears in manuscript text | fail | token |
| `EP-HON-01` Honorific suffix as morpheme | `-ssi`, `-nim`, `-ah/-ya`, `-kun/-san/-chan` attached to names | major (LN markers for the Japanese set) | token |
| `EP-HON-02` Literal kinship address for non-kin | "older brother"/"older sister" used as vocative for non-relatives when the register policy says nickname/name | major | utterance |
| `EP-CALQUE-01` Known calque phrases | list: "have you eaten (rice)", "I will go first" (farewell), "work hard" (as greeting), "my heart rose to my throat", "fighting!" | major each (unless registry allows as stylistic) | span |
| `EP-LN-01` Light-novel markers | `「」『』`, tilde-stretch (`~`) emphasis, ellipsis-only reaction lines clusters | major | span |
| `EP-FMT-01` Screenplay/script markers | `INT.`, `EXT.`, `SCENE 1`, `CUT TO`, `(V.O.)`, `[Dialogue]`, panel markers | fail (blocking) | span |
| `EP-FMT-02` Outline markers | markdown headers/bullets/numbered lists inside prose | fail | span |
| `EP-REP-01` Intra-chapter repeated n-gram | 8-gram repeats (excluding names/system text) | 2 / 4 | spans |
| `EP-REP-02` Cross-chapter repeated paragraph | simhash Hamming ≤ 6 vs any accepted paragraph | fail | paragraph |
| `EP-REP-03` Repeated opening/closing template | ending paragraph n-gram overlap ≥ 0.6 with last 5 accepted endings | warn | paragraph |
| `EP-LENGTH-01` Chapter length | words vs target ± tolerance | ±12% warn / ±20% fail | chapter |
| `EP-TRUNC-01` Truncation | ends mid-sentence, unbalanced quotes, generator `finish_reason=length` | fail | end |

### 2.3 Translation-like syntax marker set (`EP-TRN-*`)

Patterns that betray a source-language template in English. Each has weight and contributes to
`translation_marker_rate`; `major`-weighted patterns also raise individual violations.

| ID | Pattern (illustrative) | Weight | Note |
| --- | --- | --- | --- |
| TRN-01 | Article omission before singular count nouns ("He entered gate", "She is healer") | 1.0 | strong marker |
| TRN-02 | Topic-fronting with resumptive pronoun ("The device, it cried") | 1.0 | Korean/Japanese word-order echo |
| TRN-03 | Honorific suffix or title-after-name constructions ("Kang Do-yoon hunter-nim") | 1.0 | overlaps EP-HON-01 |
| TRN-04 | Literal aspect calques ("did the eating", "gave a look of") > 2/1,000 | 0.6 | |
| TRN-05 | "As expected of…" / "It can't be helped" / "This guy…" / "That person" as pronoun | 0.8 | stock translated phrases |
| TRN-06 | "…, right?" tag-question density > 6/1,000 | 0.4 | |
| TRN-07 | Sentence-initial "Anyway," / "In any case," > 4/1,000 | 0.3 | |
| TRN-08 | "Un-" negation of adjectives where English uses different lexeme ("unbig") — dictionary check | 0.6 | rare |
| TRN-09 | Possessive over-marking of body parts ("She lowered her own head") | 0.5 | |
| TRN-10 | Reported thought without idiomatic frame ("He thought that he should do that thing") | 0.6 | |
| TRN-11 | Kinship vocatives for non-kin ("Older sister, wait!") | 0.8 | overlaps EP-HON-02 |
| TRN-12 | Onomatopoeia transliterations as words ("kwaaang!", "heok") | 0.6 | |
| TRN-13 | Number/counter calques ("three people of hunters") | 0.8 | |
| TRN-14 | Overuse of "the" before proper nouns/titles ("the Chairman Lee said to the Do-yoon") | 0.8 | |
| TRN-15 | Dialogue punctuation calques (`"…!"` clusters, ellipsis-only lines) | 0.5 | |
| TRN-16 | Unnatural formality register in casual scenes ("Would you be so kind as to pass the salt" between siblings) — flagged only with register digest | 0.4 | uses register check |
| TRN-KO-01 | Essayistic stock openers that break serialized flow ("참고로", "일단은", "한 마디로") | 0.6 | Korean-manuscript drift (ADR-0054) |
| TRN-KO-02 | Untranslated English words left in Korean prose outside the terminology allowlist | 0.4 | Korean-manuscript drift (ADR-0054) |
| TRN-KO-03 | "~를 통해" used as an all-purpose instrument particle (English "through") | 0.4 | Korean translationese (ADR-0055) |
| TRN-KO-04 | "~에 있어(서)" borrowed formality (Japanese において / English "in") | 0.6 | Korean translationese (ADR-0055) |
| TRN-KO-05 | Double passive ("되어지다", "잊혀지다") | 0.6 | Korean translationese (ADR-0055) |
| TRN-KO-06 | "~를 가지고 있다" for possession or traits (English "have") | 0.4 | Korean translationese (ADR-0055) |
| TRN-KO-07 | "~하는 중이다" progressive (English "be -ing") | 0.3 | Korean translationese (ADR-0055) |
| TRN-KO-08 | "~에 의해(서)" English-style passive | 0.5 | Korean translationese (ADR-0056) |
| TRN-KO-09 | "~을 느낄 수 있었다" (English "could feel") | 0.5 | Korean translationese (ADR-0056) |
| TRN-KO-10 | "~것을/수 알 수 있었다" (English "could tell") | 0.4 | Korean translationese (ADR-0056) |
| TRN-KO-11 | "~것이었다" repetition | 0.2 | Korean translationese (ADR-0056) |
| TRN-KO-12 | "~에게 있어(서)" (English "for someone") | 0.6 | Korean translationese (ADR-0056) |
| TRN-KO-13 | "~와 관련하여/관련된" (English "regarding") | 0.3 | Korean translationese (ADR-0056) |
| TRN-KO-14 | "그/그녀" + particle as an English pronoun calque | 0.15 | Korean translationese (ADR-0056) |

The list is data (`output_language.translation_markers`), not code; changes are profile versions and go
through the contrast-set regression (translation-like variants must keep scoring higher).

### 2.4 Korean webnovel style lint (`KO-*`, ADR-0056)

For Korean manuscripts `lintKoreanWebnovel` (`@yeonjae/prose`) reads the composed identity's language layer
(`translation_markers`, `forbidden_patterns`, `lint_thresholds`) and reports findings with paragraph ids and
code-point spans. Thresholds are starting values in `lang/ko@3` (ADR-0029: calibration-dependent).

| Rule | Metric | Severity | Span |
| --- | --- | --- | --- |
| `TRN-KO-*` 번역투 marker | each hit of a language-layer marker (‘~에 대해’, ‘~를 통해’, ‘~에 의해’, ‘~을 느낄 수 있었다’ …) | minor per hit | hit |
| `KO-TRN-RATE` | weighted marker hits per 1,000 characters | warn → minor, fail → major | chapter |
| `AIT-KO-*` AI 상투구 | each hit of a stale-cliché pattern (‘알 수 없는 감정’, ‘시간이 멈춘 듯’, ‘정적이 흘렀다’ …) | minor per hit | hit |
| `KO-AIT-COUNT` | cliché hits per chapter | warn → minor, fail → major | chapter |
| `KO-PRN-RATE` | ‘그/그녀’ + particle per 1,000 characters | warn → minor, fail → major | chapter |
| `KO-SIM-RATE` | ‘마치’/‘~듯’ per 1,000 characters | warn → minor, fail → major | chapter |
| `KO-PARA-LONG` | share of narration paragraphs over three sentences or the paragraph character warn threshold | warn → minor, fail → major | paragraphs |
| `KO-PARA-CHARS` | a single paragraph at or over the fail length | major | paragraph |
| `KO-DLG-LOW` | quoted-dialogue share (chapters of 12+ paragraphs) | at/below warn → minor, at/below fail → major | chapter |
| `KO-CONJ-RATE` | sentence-initial ‘그리고/그러나/하지만…’ per 1,000 characters | warn → minor, fail → major | chapter |
| `TRN-KO-02` | Latin-script word outside the name/term allowlist | major | hit |
| `SP-*`, `LN-01` | format drift (screenplay, outline, labels, light-novel brackets) | the pattern's severity | hit |
| `KO-END-01` | final paragraph closes on a summary/reflection (‘그렇게 하루가 저물었다’, ‘시작에 불과했다’ …) | major (structure) | last paragraph |
| `EXEMPLAR-COPY` | a studio exemplar line of ≥ 14 characters appears verbatim | major | hit |
| `KO-SP-*` 맞춤법 (ADR-0062) | each hit of a language-layer `spelling` pattern (‘낮설다’, ‘몇일’, ‘금새’ …); the note names the correction | minor per hit | hit |
| `KO-END-02` (ADR-0062) | a run of narration sentences closing on the same two syllables | warn → minor, fail → major | paragraphs |
| `KO-NAME-01` (ADR-0062) | a word one syllable (not the first) away from a registered character name | minor per distinct word; fail count → major | hit |

KO-END-02 and KO-NAME-01 run only when the language layer carries their thresholds (`lang/ko@4` onward), so
a project pinned to an earlier layer lints as it did. The report also carries `monologue_ratio`, the ‘…’
(속마음) share, next to the dialogue share.

Major findings gate approval and are revision targets; minor findings are evidence for the prose judge and
the reviser. The digest (metrics line + strongest findings) is the prose judge's `prose_lint_report`.

## 3. Structure rules (ST-*)

| Rule | Metric | Starting warn / fail | Span |
| --- | --- | --- | --- |
| `ST-HOOK-01` Late hook | index of first sentence matching hook features (dialogue, action verb with tension noun, threat, status text, continuation of prior cliffhanger) | 5 / 8 | opening |
| `ST-OPEN-01` Forbidden opening type | opening classified as weather/landscape, lore dump, or waking-routine by feature rules | fail | opening |
| `ST-SCENE-01` Scene count | scenes outside tradition band | warn / fail at ±2 | chapter |
| `ST-PAY-01` Missing local payoff markers | none of the payoff feature sets detected (reveal verbs, achievement/status change, emotional beat, humor markers, satisfaction beats) → judge confirms | warn → judge | chapter |
| `ST-END-01` Weak ending classifier | last paragraph classified `summary_reflection`/`mid_scene_fade` (no question, threat, decision, reveal, or cut) | warn → judge | last paragraph |
| `ST-END-02` Ending-type monotony | same ending type ≥ 3 chapters in a row (from contracts/judge) | warn | project window |
| `ST-EXP-01` Exposition run | consecutive narration sentences with no action verb/dialogue and ≥ 1 lore noun | 4 / 7 | run |
| `ST-EXP-02` New-term density | registry-term introductions per chapter | 6 / 10 | chapter |
| `ST-DLG-01` Dialogue ratio out of band | share of words inside dialogue | band ±0.05 / ±0.12 | chapter |
| `ST-MON-01` Monologue ratio out of band | share of words in italic inner monologue | band ±0.05 / ±0.12 | chapter |
| `ST-MON-02` Hindsight monologue over cap | regression overlays | 0.2 / 0.3 | chapter |
| `ST-CAD-01` Progression cadence | chapters since last progression event vs cadence target | target+1 / target+3 | project window |
| `ST-CAD-02` Satisfaction cadence / frustration streak | chapters since last satisfaction beat; frustration streak | target+1 / max streak | project window |
| `ST-SYS-01` Device grammar | status window / system message / leaderboard fails format grammar | fail | block |
| `ST-SYS-02` Device wall | block lines > 12 more than once per chapter | warn | block |
| `ST-PARA-01` Mobile paragraph rhythm | share of paragraphs > `paragraph.max_words` | 0.15 / 0.3 | chapter |

## 4. Dialogue-register check — `RG-*`

Pipeline: utterance → speaker & addressee (structured-draft annotations; heuristic fallback with
confidence) → **rendered register features** (title/address term used; contraction rate; imperative vs
request forms; hedging; first name vs surname; sir/ma'am) → **expected register** from the
Dialogue-Register Policy + relationship state at story time → compare.

| Rule | Condition | Starting severity |
| --- | --- | --- |
| `RG-01` Formality mismatch | rendered formality band differs from expected by ≥ 2 and no `intentional_shift` | major (blocking toward royalty/superiors in strict genres) |
| `RG-02` Address term/title mismatch | vocative or reference term ∉ allowed set for pair @ story time | major |
| `RG-03` Intimacy-milestone violation | first-name/pet-name usage before the relationship milestone, or reversion after it without public-variant context | major (also a hard-requirement violation if slow-burn constraints apply) |
| `RG-04` Public/private variant | private register used in a public scene where a public variant is defined | minor |
| `RG-05` Mixed register in one turn | formality features contradict within an utterance without shift tag | minor |
| `RG-06` Unresolved speaker | addressee unknown with confidence < 0.6 | note (judge asked to resolve) |

`intentional_shift` tags require a reason (`anger`, `intimacy_step`, `disguise`, `mockery`,
`public_formality`, `age_reveal`, `emotional_outburst`) and the Voice Judge verifies the reason is
supported by the scene.

## 5. Output & integration

- `LintReport` (schema `lint-report.schema.json`) stored per manuscript version with `prose_metrics`,
  `structure_metrics`, `register_metrics`, and violations tagged by dimension.
- Incremental: after a patch, only changed paragraphs ± 1 and chapter-level metrics recompute.
- Every threshold in this document is a starting value with `calibration_status=uncalibrated` until the
  contrast set and reviewer overrides tune it (ADR-0029). The fixture story seeds violations of every rule
  for tests.
