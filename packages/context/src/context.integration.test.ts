/**
 * Postgres integration: the fixture story seeded through the real canon boundary (migrations 0001–0003,
 * `canon.commit_delta`), then packs built through `buildPack`. Chapter 9's accepted text plays chapter k−1
 * for a chapter-10 contract derived from the ch.12 fixture contract, so every previous-chapter assertion runs
 * against real accepted bytes, real evidence spans and a real acceptance commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  acceptedChapter,
  approveManuscriptVersion,
  commitDelta,
  createChapter,
  createEntity,
  createManuscriptVersion,
  createPool,
  createProject,
  createPromise,
  createTimeline,
  createWorkspace,
  indexAcceptedVersion,
  lexicalSearch,
  quarantineVersion,
  searchDocumentCount,
  searchDocumentsContaining,
  setChapterStatus,
  upsertL1Summary,
  withTransaction,
  type Pool,
} from '@yeonjae/db';
import { requirePolicy } from '@yeonjae/domain';
import { composeIdentity, ProfileStore } from '@yeonjae/narrative';
import { quoteHash, segmentParagraphs, toNfcText } from '@yeonjae/prose';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { buildPack } from './build.js';
import { ContextError } from './errors.js';
import { FailingRetriever, PgLexicalRetriever } from './retrievers.js';
import { previousTail } from './tail.js';
import { type ChapterContract, type StorySpec } from './types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CH09 = readFileSync(`${ROOT}examples/fixture/manuscripts/ch09.accepted.txt`, 'utf8');
const REJECTED = readFileSync(
  `${ROOT}examples/fixture/manuscripts/ch09.rejected-draft.txt`,
  'utf8',
);
const CONTRACT = JSON.parse(
  readFileSync(`${ROOT}examples/fixture/chapter-contract.ch12.json`, 'utf8'),
) as ChapterContract;
const SPEC = JSON.parse(
  readFileSync(`${ROOT}examples/fixture/story-spec.v3.json`, 'utf8'),
) as StorySpec;
const POISON = 'left arm was severed';
const policy = requirePolicy('policy/standard@1');
const identity = composeIdentity(
  ProfileStore.fromDirectory(),
  'project/0191b2a0-0000-7000-8000-000000000001@1',
  '0191b2a0-0000-7000-8000-000000060001',
);

const clock = (chapter_no: number, ordinal: number, world_date?: string) => ({
  chapter_no,
  ordinal,
  precision: 'exact' as const,
  ...(world_date ? { calendar: 'relative_days', world_date } : {}),
});

function evidenceFor(versionId: string, text: string, quote: string, chapterNo = 9) {
  const nfc = toNfcText(text);
  const utf16 = nfc.text.indexOf(quote);
  if (utf16 < 0) throw new Error(`quote not found: ${quote}`);
  const start = Array.from(nfc.text.slice(0, utf16)).length;
  const end = start + Array.from(quote).length;
  const para = segmentParagraphs(nfc).find((p) => p.start <= start && start < p.end);
  return {
    manuscript_version_id: versionId,
    chapter_no: chapterNo,
    paragraph_id: para?.id,
    start,
    end,
    quote,
    quote_hash: quoteHash(quote),
  };
}

const item = (
  local_id: string,
  type: string,
  op: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  local_id,
  type,
  op,
  frame: 'canonical',
  confidence: 1,
  importance: 'major',
  evidence: [],
  payload,
  ...extra,
});

const run = databaseUrl() ? describe : describe.skip;

run('context packs over the real canon (Postgres integration)', () => {
  let pool: Pool;
  let ws: string;
  let project: string;
  let main: string;
  let prior: string;
  const E: Record<string, string> = {};
  const P: Partial<Record<'p1' | 'p2' | 'p3' | 'p5' | 'p7', string>> = {};
  let ch9: string;
  let ch9Version: string;
  let ch10: string;
  let compassPromise: string;
  let daughterPromise: string;
  let contract10: ChapterContract;
  let spec: StorySpec;
  let canonVersion: number;

  beforeAll(async () => {
    pool = await freshDatabase();
    ws = await createWorkspace(pool, 'ctx-test');
    ({ projectId: project, mainTimelineId: main } = await createProject(pool, {
      workspaceId: ws,
      title: 'Second Awakening',
    }));
    prior = await createTimeline(pool, {
      workspaceId: ws,
      projectId: project,
      name: 'prior_loop_1',
      kind: 'prior_loop',
      parentTimelineId: main,
      divergenceClock: clock(1, 0),
    });
    const mk = async (
      key: string,
      type: string,
      name: string,
      shortForms: string[] = [],
      aliases: string[] = [],
    ) => {
      E[key] = await createEntity(pool, {
        workspaceId: ws,
        projectId: project,
        type,
        displayName: name,
        shortForms,
        aliases,
      });
    };
    await mk('doyoon', 'character', 'Kang Do-yoon', ['Do-yoon']);
    await mk('seoha', 'character', 'Lee Seo-ha', ['Seo-ha']);
    await mk('mujin', 'character', 'Park Mu-jin', ['Mu-jin']);
    await mk('hyunseok', 'character', 'Choi Hyun-seok', ['Hyun-seok']);
    await mk('yuri', 'character', 'Han Yu-ri', ['Yu-ri']);
    await mk('hall', 'location', 'Association measurement hall');
    await mk('dungeon', 'location', 'Poison Fog Dungeon');
    await mk('apartment', 'location', "Mu-jin's studio apartment");
    await mk('compass', 'item', 'old compass', ['the compass']);
    await mk('rank', 'term', 'Association rank scale');

    // Bible commit (v1): locked rank fact, world rule, secrets, prior-loop facts, relationships, knowledge.
    const bible = await commitDelta(pool, {
      projectId: project,
      parentVersion: 0,
      source: 'bible',
      delta: {
        items: [
          item(
            'rank',
            'fact',
            'assert',
            {
              entity_id: E.doyoon,
              attribute: 'power.rank',
              value: 'E',
              value_text: 'E-rank (ch.8 re-measurement)',
              valid_from: clock(8, 0),
              valid_to: null,
              locked: true,
            },
            { importance: 'core' },
          ),
          item('rule', 'fact', 'assert', {
            entity_id: E.rank,
            attribute: 'rule.scale',
            value: 'F-S',
            value_text:
              'Ranks run F through S and are read from measurement devices; no status windows',
            valid_from: clock(0, 0),
            valid_to: null,
          }),
          item('loc', 'fact', 'assert', {
            entity_id: E.mujin,
            attribute: 'status.location',
            value: 'seoul',
            value_text: 'Seoul',
            valid_from: clock(1, 0),
            valid_to: null,
          }),
          item(
            'p1',
            'proposition',
            'create',
            {
              statement: 'Kang Do-yoon is a regressor.',
              kind: 'secret',
              entity_ids: [E.doyoon],
              secret: {
                owner_ids: [E.doyoon],
                allowed_knower_ids: [],
                reader_may_know: true,
                reveal_not_before_chapter: 58,
              },
              truth: [{ timeline_id: main, value: 'true' }],
            },
            { importance: 'core' },
          ),
          item(
            'p2',
            'proposition',
            'create',
            {
              statement: "Lee Seo-ha is Chairman Lee Tae-san's illegitimate daughter.",
              kind: 'secret',
              entity_ids: [E.seoha],
              secret: {
                owner_ids: [E.seoha],
                allowed_knower_ids: [],
                reader_may_know: true,
                reveal_not_before_chapter: 72,
              },
              truth: [{ timeline_id: main, value: 'true' }],
            },
            { importance: 'core' },
          ),
          item('p3', 'proposition', 'create', {
            statement: 'Kang Do-yoon sells raid intelligence to brokers.',
            kind: 'intent',
            entity_ids: [E.doyoon],
            truth: [{ timeline_id: main, value: 'false' }],
          }),
          item(
            'p5',
            'proposition',
            'create',
            {
              statement: 'The Gangnam gate break happens on March 14 with 200 casualties.',
              kind: 'event',
              entity_ids: [],
              truth: [{ timeline_id: prior, value: 'true' }],
            },
            { importance: 'core' },
          ),
          item('p7', 'proposition', 'create', {
            statement: 'The old compass points to hidden gates.',
            kind: 'world_rule',
            entity_ids: [E.compass],
            truth: [{ timeline_id: main, value: 'true' }],
          }),
          item(
            'pl-death',
            'fact',
            'assert',
            {
              entity_id: E.mujin,
              attribute: 'status.alive',
              value: false,
              value_text: 'Died shielding Do-yoon in the Collapse (first life)',
              timeline_id: prior,
              valid_from: clock(0, 500),
              valid_to: null,
            },
            { frame: 'prior_loop', importance: 'core' },
          ),
          item('r-md', 'relationship_state', 'assert', {
            from_entity_id: E.mujin,
            to_entity_id: E.doyoon,
            type: 'mentor',
            axes: { trust: 1, affection: 1, respect: 1, hostility: 0, dependency: 0 },
            power_dynamic: 'from_dominant',
            register: {
              formality: 1,
              deference: 0,
              familiarity: 2,
              directness: 4,
              contractions: 'free',
              address_terms: ['kid', 'Mister'],
            },
            valid_from: clock(2, 0),
            valid_to: null,
          }),
          item('r-dm', 'relationship_state', 'assert', {
            from_entity_id: E.doyoon,
            to_entity_id: E.mujin,
            type: 'mentor',
            axes: { trust: 2, affection: 1, respect: 2, hostility: 0, dependency: 0 },
            power_dynamic: 'to_dominant',
            register: {
              formality: 3,
              deference: 3,
              familiarity: 1,
              directness: 2,
              contractions: 'neutral',
              address_terms: ['Mister Park', 'old man'],
            },
            valid_from: clock(1, 0),
            valid_to: null,
          }),
          item('r-ds', 'relationship_state', 'assert', {
            from_entity_id: E.doyoon,
            to_entity_id: E.seoha,
            type: 'colleague',
            register: {
              formality: 4,
              deference: 2,
              familiarity: 1,
              contractions: 'avoid',
              address_terms: ['Miss Lee'],
            },
            valid_from: clock(4, 0),
            valid_to: null,
          }),
          item('r-sd', 'relationship_state', 'assert', {
            from_entity_id: E.seoha,
            to_entity_id: E.doyoon,
            type: 'colleague',
            register: {
              formality: 4,
              deference: 2,
              familiarity: 1,
              contractions: 'avoid',
              address_terms: ['Mr. Kang'],
            },
            valid_from: clock(4, 0),
            valid_to: null,
          }),
        ],
      },
    });
    P.p1 = bible.item_ids.p1;
    P.p2 = bible.item_ids.p2;
    P.p3 = bible.item_ids.p3;
    P.p5 = bible.item_ids.p5;
    P.p7 = bible.item_ids.p7;
    // Knowledge (v2): Do-yoon knows P1 from prior-loop memory; Seo-ha unaware of P1; Seo-ha knows her own secret P2;
    // Do-yoon unaware of P2; Seo-ha believes_false P3 (the lie); Do-yoon knows P5 from prior loop.
    await commitDelta(pool, {
      projectId: project,
      parentVersion: 1,
      source: 'user_correction',
      justification: 'seed knowledge ledger',
      delta: {
        items: [
          item('k1', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.doyoon },
            proposition_id: P.p1,
            stance: 'knows',
            source: {
              kind: 'prior_loop_memory',
              chapter_id: '0191b2a0-0000-7000-8000-000000020009',
            },
            valid_from: clock(1, 0),
            valid_to: null,
          }),
          item('k2', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.seoha },
            proposition_id: P.p1,
            stance: 'unaware',
            source: { kind: 'narration', chapter_id: '0191b2a0-0000-7000-8000-000000020009' },
            valid_from: clock(4, 0),
            valid_to: null,
          }),
          item('k3', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.seoha },
            proposition_id: P.p2,
            stance: 'knows',
            source: { kind: 'remembered', chapter_id: '0191b2a0-0000-7000-8000-000000020009' },
            valid_from: clock(0, 0),
            valid_to: null,
          }),
          item('k4', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.doyoon },
            proposition_id: P.p2,
            stance: 'unaware',
            source: { kind: 'narration', chapter_id: '0191b2a0-0000-7000-8000-000000020009' },
            valid_from: clock(4, 0),
            valid_to: null,
          }),
          item('k5', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.seoha },
            proposition_id: P.p3,
            stance: 'believes_false',
            believed_value: 'true',
            source: {
              kind: 'told',
              informer_id: E.hyunseok,
              chapter_id: '0191b2a0-0000-7000-8000-000000020009',
            },
            valid_from: clock(7, 0),
            valid_to: null,
          }),
          item('k6', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.doyoon },
            proposition_id: P.p5,
            stance: 'knows',
            source: {
              kind: 'prior_loop_memory',
              chapter_id: '0191b2a0-0000-7000-8000-000000020009',
            },
            valid_from: clock(1, 0),
            valid_to: null,
          }),
          item('k7', 'knowledge_state', 'assert', {
            knower: { kind: 'character', entity_id: E.mujin },
            proposition_id: P.p1,
            stance: 'unaware',
            source: { kind: 'narration', chapter_id: '0191b2a0-0000-7000-8000-000000020009' },
            valid_from: clock(2, 0),
            valid_to: null,
          }),
        ],
      },
    });
    compassPromise = await createPromise(pool, {
      workspaceId: ws,
      projectId: project,
      type: 'chekhov',
      statement: 'The old compass will lead to a hidden gate.',
      importance: 'core',
      status: 'open',
      dueMinChapter: 55,
      dueMaxChapter: 70,
      relatedEntityIds: [E.doyoon, E.compass],
    });
    daughterPromise = await createPromise(pool, {
      workspaceId: ws,
      projectId: project,
      type: 'character_goal',
      statement: "Mu-jin's estranged daughter.",
      importance: 'major',
      status: 'planned',
      dueMaxChapter: 100,
      relatedEntityIds: [E.mujin],
    });

    // Distant accepted chapter 3 (the compass purchase) so lexical recall has something far away to find.
    const ch3 = await createChapter(pool, { workspaceId: ws, projectId: project, number: 3 });
    const ch3Text = [
      'The vendor near Gangnam gate had a folding table and no licence.',
      '“Fifty thousand,” he said, and Do-yoon paid it without arguing, which made the man suspicious.',
      'The old compass had a cracked glass face and a needle that did not point north. Do-yoon knew where it pointed. He put it in his inner pocket and did not look at it again until the fog.',
    ].join('\n\n');
    const v3 = await createManuscriptVersion(pool, {
      workspaceId: ws,
      projectId: project,
      chapterId: ch3,
      origin: 'assembled',
      text: ch3Text,
    });
    await setChapterStatus(pool, ch3, 'review_pending');
    await approveManuscriptVersion(pool, v3.id, 'tester');
    const c3 = await commitDelta(pool, {
      projectId: project,
      parentVersion: 2,
      source: 'chapter_acceptance',
      chapterId: ch3,
      manuscriptVersionId: v3.id,
      clockMax: clock(3, 999),
      delta: {
        items: [
          item(
            'ev3',
            'event',
            'assert',
            {
              type: 'acquisition',
              summary: 'Do-yoon buys the old compass from an unlicensed vendor near Gangnam gate.',
              participants: [{ entity_id: E.doyoon, role: 'agent' }],
              importance: 'major',
            },
            {
              story_clock: clock(3, 20),
              evidence: [evidenceFor(v3.id, ch3Text, 'Do-yoon paid it without arguing', 3)],
            },
          ),
          item(
            'f3',
            'fact',
            'assert',
            {
              entity_id: E.doyoon,
              attribute: 'inventory.item',
              key: 'old_compass',
              value: { item: 'old compass' },
              value_text: 'Holds the old compass',
              valid_from: clock(3, 20),
              valid_to: null,
            },
            {
              story_clock: clock(3, 20),
              evidence: [evidenceFor(v3.id, ch3Text, 'He put it in his inner pocket', 3)],
            },
          ),
          item(
            'pr3',
            'promise_event',
            'open',
            { promise_id: compassPromise, kind: 'opened', note: 'Compass acquired' },
            {
              story_clock: clock(3, 20),
              evidence: [evidenceFor(v3.id, ch3Text, 'a needle that did not point north', 3)],
            },
          ),
        ],
      },
    });
    await withTransaction(pool, async (c) => {
      await upsertL1Summary(c, {
        workspaceId: ws,
        projectId: project,
        manuscriptVersionId: v3.id,
        chapterNo: 3,
        text: 'Do-yoon buys the old compass from a vendor near Gangnam gate and keeps it hidden.',
        endingHook: 'He did not look at it again until the fog.',
        canonVersion: c3.version,
      });
      await indexAcceptedVersion(c, v3.id);
    });

    // Chapter 9: the fixture text, its rejected draft (quarantined), acceptance with the fixture delta shape.
    ch9 = await createChapter(pool, { workspaceId: ws, projectId: project, number: 9 });
    const draft = await createManuscriptVersion(pool, {
      workspaceId: ws,
      projectId: project,
      chapterId: ch9,
      origin: 'assembled',
      text: REJECTED,
    });
    await quarantineVersion(pool, draft.id, 'T16: wrong injury');
    const v9 = await createManuscriptVersion(pool, {
      workspaceId: ws,
      projectId: project,
      chapterId: ch9,
      origin: 'revision',
      text: CH09,
    });
    ch9Version = v9.id;
    await setChapterStatus(pool, ch9, 'review_pending');
    await approveManuscriptVersion(pool, v9.id, 'tester');
    const locFact = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1 AND attribute = 'status.location' AND valid_to_ord IS NULL`,
      [E.mujin],
    );
    const relFact = await pool.query<{ id: string }>(
      `SELECT id FROM relationship_states WHERE from_entity_id = $1 AND to_entity_id = $2 AND valid_to_ord IS NULL`,
      [E.mujin, E.doyoon],
    );
    const c9 = await commitDelta(pool, {
      projectId: project,
      parentVersion: 3,
      source: 'chapter_acceptance',
      chapterId: ch9,
      manuscriptVersionId: v9.id,
      clockMax: clock(9, 999),
      delta: {
        items: [
          item(
            'ev-1',
            'event',
            'assert',
            {
              type: 'injury',
              summary:
                'On the second floor of the Poison Fog Dungeon, Mu-jin shoves Do-yoon clear and takes a fog-beast tendril in the left calf; the venom spreads.',
              location_id: E.dungeon,
              participants: [
                { entity_id: E.mujin, role: 'patient' },
                { entity_id: E.doyoon, role: 'witness' },
              ],
              importance: 'core',
            },
            {
              story_clock: clock(9, 46, 'D+35'),
              importance: 'core',
              evidence: [evidenceFor(v9.id, CH09, 'Black venom was climbing Mu-jin’s left calf.')],
            },
          ),
          item(
            'f-1',
            'fact',
            'assert',
            {
              entity_id: E.mujin,
              attribute: 'status.injury',
              key: 'left_leg_venom',
              value: { part: 'left calf', kind: 'beast venom', severity: 'serious' },
              value_text: 'Beast venom in the left calf (serious)',
              valid_from: clock(9, 46, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 46, 'D+35'),
              importance: 'core',
              evidence: [evidenceFor(v9.id, CH09, 'Black venom was climbing Mu-jin’s left calf.')],
            },
          ),
          item(
            'f-2',
            'fact',
            'supersede',
            {
              entity_id: E.mujin,
              attribute: 'status.location',
              value: 'poison_fog_2f',
              value_text: 'Poison Fog Dungeon, second floor',
              valid_from: clock(9, 6, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 6, 'D+35'),
              supersedes_ref: locFact.rows[0]?.id,
              evidence: [
                evidenceFor(
                  v9.id,
                  CH09,
                  'Past the second-floor stairs the fog rose to their knees.',
                ),
              ],
            },
          ),
          item(
            'k-1',
            'knowledge_state',
            'assert',
            {
              knower: { kind: 'character', entity_id: E.mujin },
              proposition_id: P.p7,
              stance: 'unaware',
              source: { kind: 'narration', chapter_id: ch9 },
              valid_from: clock(9, 57, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 57, 'D+35'),
              evidence: [evidenceFor(v9.id, CH09, 'Mu-jin glanced at the old compass')],
            },
          ),
          item(
            'r-1',
            'relationship_state',
            'supersede',
            {
              from_entity_id: E.mujin,
              to_entity_id: E.doyoon,
              type: 'mentor',
              axes: { trust: 3, affection: 2, respect: 2, hostility: 0, dependency: 1 },
              power_dynamic: 'from_dominant',
              register: {
                formality: 1,
                deference: 0,
                familiarity: 3,
                intimacy: 1,
                directness: 4,
                contractions: 'free',
                address_terms: ['kid', 'Do-yoon', 'son'],
                titles: [],
              },
              valid_from: clock(9, 80, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 80, 'D+35'),
              supersedes_ref: relFact.rows[0]?.id,
              evidence: [
                evidenceFor(v9.id, CH09, '“If it weren’t for you, son, I’d have died first.'),
              ],
            },
          ),
          item(
            'pr-1',
            'promise_event',
            'advance',
            {
              promise_id: compassPromise,
              kind: 'advanced',
              note: 'The compass needle trembled in the fog (hidden-gate setup advanced)',
            },
            {
              story_clock: clock(9, 58, 'D+35'),
              evidence: [evidenceFor(v9.id, CH09, 'The compass needle trembled in the fog.')],
            },
          ),
          item(
            'f-3',
            'fact',
            'assert',
            {
              entity_id: E.doyoon,
              attribute: 'inventory.item',
              key: 'mana_stone',
              value: { item: 'mana stone', qty: 2 },
              value_text: 'Two C-grade mana stones (sealed, payout pending)',
              valid_from: clock(9, 76, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 76, 'D+35'),
              evidence: [evidenceFor(v9.id, CH09, '“Two,” he said.')],
            },
          ),
        ],
      },
    });
    canonVersion = c9.version;
    await withTransaction(pool, async (c) => {
      await upsertL1Summary(c, {
        workspaceId: ws,
        projectId: project,
        manuscriptVersionId: v9.id,
        chapterNo: 9,
        text: 'Poison Fog Dungeon, second floor. A fog beast ambushes them; Mu-jin shoves Do-yoon clear and takes venom in his left calf. Do-yoon recovers a second mana stone. The compass needle trembles; Mu-jin notices nothing. At the gate tent Do-yoon gets Mu-jin onto a stretcher. The venom reaches Mu-jin’s knee.',
        endingHook: 'Outside the gate, the black venom had climbed to Mu-jin’s knee.',
        canonVersion,
      });
      await indexAcceptedVersion(c, v9.id);
    });

    // Chapter 10 = the "k" of the test: the ch.12 fixture contract re-pinned to chapter 10 / this project's ids.
    ch10 = await createChapter(pool, { workspaceId: ws, projectId: project, number: 10 });
    const remap: Record<string, string> = {
      '0191b2a0-0000-7000-8000-0000000c0001': E.doyoon ?? '',
      '0191b2a0-0000-7000-8000-0000000c0002': E.seoha ?? '',
      '0191b2a0-0000-7000-8000-0000000c0003': E.mujin ?? '',
      '0191b2a0-0000-7000-8000-0000000c0004': E.hyunseok ?? '',
      '0191b2a0-0000-7000-8000-0000000c0005': E.yuri ?? '',
      '0191b2a0-0000-7000-8000-000000010001': E.hall ?? '',
      '0191b2a0-0000-7000-8000-000000010005': E.apartment ?? '',
      '0191b2a0-0000-7000-8000-0000000b0001': P.p1 ?? '',
      '0191b2a0-0000-7000-8000-0000000b0002': P.p2 ?? '',
      '0191b2a0-0000-7000-8000-0000000b0006': P.p3 ?? '',
      '0191b2a0-0000-7000-8000-0000000d0002': daughterPromise,
      '0191b2a0-0000-7000-8000-000000050001': main,
      '0191b2a0-0000-7000-8000-000000000001': project,
    };
    const injuryFact = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1 AND attribute = 'status.injury'`,
      [E.mujin],
    );
    const rankFact = await pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE entity_id = $1 AND attribute = 'power.rank'`,
      [E.doyoon],
    );
    remap['0191b2a0-0000-7000-8000-000000040001'] = injuryFact.rows[0]?.id ?? '';
    remap['0191b2a0-0000-7000-8000-000000040002'] = rankFact.rows[0]?.id ?? '';
    remap['0191b2a0-0000-7000-8000-000000040003'] =
      (
        await pool.query<{ id: string }>(
          `SELECT id FROM facts WHERE entity_id = $1 AND key = 'old_compass'`,
          [E.doyoon],
        )
      ).rows[0]?.id ?? '';
    let json = JSON.stringify(CONTRACT);
    for (const [from, to] of Object.entries(remap)) json = json.split(from).join(to);
    contract10 = JSON.parse(json) as ChapterContract;
    contract10 = {
      ...contract10,
      chapter_number: 10,
      story_time: {
        start: clock(10, 0, 'D+36'),
        end: clock(10, 99, 'D+36'),
        elapsed_since_previous: 'The morning after chapter 9',
      },
      pinned: { ...contract10.pinned, canon_version: canonVersion },
      continuity_anchors: contract10.continuity_anchors.map((a) => ({
        ...a,
        evidence: a.evidence?.map((e) => ({ ...e, manuscript_version_id: v9.id })),
      })),
    };
    let specJson = JSON.stringify(SPEC);
    for (const [from, to] of Object.entries(remap)) specJson = specJson.split(from).join(to);
    spec = JSON.parse(specJson) as StorySpec;
  });

  afterAll(async () => {
    await pool.end();
  });

  const build = (role: string, extra: Partial<Parameters<typeof buildPack>[1]> = {}) =>
    buildPack(pool, {
      projectId: project,
      role,
      contract: contract10,
      spec,
      policy,
      identity,
      promptSetId: 'set:test',
      lexical: new PgLexicalRetriever(pool),
      persist: true,
      ...extra,
    });

  it('accepted-only reads: the quarantined draft is not indexed, not summarizable, not retrievable', async () => {
    expect(await searchDocumentsContaining(pool, project, POISON)).toBe(0);
    expect(await searchDocumentCount(pool, project)).toBeGreaterThan(20);
    const hits = await lexicalSearch(pool, { projectId: project, query: 'severed arm' });
    expect(hits.some((h) => h.text.includes(POISON))).toBe(false);
    // A working version can be neither summarized nor indexed (trigger), so async indexing after acceptance
    // can never pick up a draft.
    const ch11 = await createChapter(pool, { workspaceId: ws, projectId: project, number: 11 });
    const working = await createManuscriptVersion(pool, {
      workspaceId: ws,
      projectId: project,
      chapterId: ch11,
      origin: 'assembled',
      text: 'Working draft text that must never be indexed.',
    });
    await expect(indexAcceptedVersion(pool, working.id)).rejects.toMatchObject({
      code: 'SEARCH_SOURCE_NOT_ACCEPTED',
    });
    await expect(
      upsertL1Summary(pool, {
        workspaceId: ws,
        projectId: project,
        manuscriptVersionId: working.id,
        chapterNo: 11,
        text: 'x',
        canonVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'SUMMARY_SOURCE_NOT_ACCEPTED' });
    await expect(
      pool.query(
        `INSERT INTO search_documents (workspace_id, project_id, kind, ref_kind, ref_id, ref_key, text, manuscript_version_id, canon_version_added) VALUES ($1, $2, 'chapter_paragraph', 'manuscript_version', $3, 'p1', 'x', $3, 1)`,
        [ws, project, working.id],
      ),
    ).rejects.toMatchObject({ hint: 'SEARCH_SOURCE_NOT_ACCEPTED' });
    expect(await searchDocumentsContaining(pool, project, 'must never be indexed')).toBe(0);
    // Indexing is idempotent.
    const n1 = await indexAcceptedVersion(pool, ch9Version);
    const n2 = await indexAcceptedVersion(pool, ch9Version);
    expect(n1).toBe(n2);
    expect(await searchDocumentCount(pool, project)).toBeGreaterThan(20);
  });

  it('chapter k receives chapter k−1: L1 summary, verbatim tail, ending hook, committed deltas, version + canon pins', async () => {
    const { pack, fetch } = await build('scene_writer');
    expect(pack.validation.ok, pack.validation.failures.join('; ')).toBe(true);
    const prev = pack.sections.find((s) => s.name === 'previous_chapter');
    expect(prev).toBeDefined();
    const tail = previousTail(
      CH09,
      policy.context.previous_tail_words,
      policy.context.previous_tail_extend_to_scene_below_words ?? 0,
    );
    expect(prev?.text).toContain(tail.text);
    expect(prev?.text).toContain('Chapter 9 factual summary (L1, from the accepted version v2)');
    expect(prev?.text).toContain(
      'Chapter 9 ending hook: “Outside the gate, the black venom had climbed to Mu-jin’s knee.”',
    );
    expect(prev?.text).toContain(
      'Committed from chapter 9 (canon v4): fact/assert @ ch.9.46 (D+35): Park Mu-jin · status.injury[left_leg_venom] = Beast venom in the left calf (serious)',
    );
    expect(prev?.text).toContain('knowledge_state/assert');
    expect(prev?.text).toContain('relationship_state/supersede');
    expect(prev?.text).toContain('promise_event/advance');
    expect(pack.manifest.previous_chapter).toMatchObject({
      chapter_no: 9,
      manuscript_version_id: ch9Version,
      version_no: 2,
      accepted_canon_version: canonVersion,
      committed_item_count: 7,
      tail_words: tail.words,
    });
    expect(fetch.input.previousChapter?.endClock).toMatchObject({ chapter_no: 9, ordinal: 80 });
    expect(pack.sections.find((s) => s.name === 'timeline')?.text).toContain(
      'Elapsed since chapter 9: The morning after chapter 9 (1 day of story time (D+35 → D+36))',
    );
    // The states section carries the current facts at the start of chapter 10 with evidence from the accepted version.
    const states = pack.sections.find((s) => s.name === 'states');
    expect(states?.text).toContain(
      'status.injury[left_leg_venom] = Beast venom in the left calf (serious)',
    );
    expect(states?.text).toContain(
      'evidence: ch.9 p46 “Black venom was climbing Mu-jin’s left calf.”',
    );
    expect(states?.text).toContain('CONTINUITY ANCHOR');
    expect(pack.sections.find((s) => s.name === 'locked_facts')?.text).toContain(
      'power.rank = E-rank',
    );
    // Persisted manifest + ACS.
    const stored = await pool.query<{ pack_hash: string; canon_version: number }>(
      'SELECT pack_hash, canon_version FROM context_packs WHERE id = $1',
      [pack.id],
    );
    expect(stored.rows[0]).toMatchObject({ pack_hash: pack.hash, canon_version: canonVersion });
    const acs = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM active_constraint_sets WHERE id = $1',
      [fetch.constraints.id],
    );
    expect(acs.rows[0]?.content_hash).toBe(fetch.constraints.contentHash);
  });

  it('is deterministic over the real database: two builds give identical bytes and hashes; persistence is idempotent', async () => {
    const a = await build('scene_writer');
    const b = await build('scene_writer');
    expect(a.pack.hash).toBe(b.pack.hash);
    expect(a.pack.renderedUser).toBe(b.pack.renderedUser);
    expect(a.pack.renderedSystem).toBe(b.pack.renderedSystem);
    expect(JSON.stringify(a.pack.manifest)).toBe(JSON.stringify(b.pack.manifest));
    expect(b.stored).toBe(false);
    const rows = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM context_packs WHERE pack_hash = $1',
      [a.pack.hash],
    );
    expect(rows.rows[0]?.n).toBe('1');
  });

  it('knowledge is knower-specific and secrets never leak: Seo-ha unaware of P1, Do-yoon unaware of P2; guards are hard T0', async () => {
    const { pack } = await build('scene_writer');
    const knowledge = pack.sections.find((s) => s.name === 'knowledge')?.text ?? '';
    expect(knowledge).toContain('Lee Seo-ha — UNAWARE: “Kang Do-yoon is a regressor.”');
    expect(knowledge).toContain(
      'Kang Do-yoon — KNOWS: “Kang Do-yoon is a regressor.” [channel: prior_loop_memory',
    );
    expect(knowledge).toContain(
      "Kang Do-yoon — UNAWARE: “Lee Seo-ha is Chairman Lee Tae-san's illegitimate daughter.”",
    );
    expect(knowledge).toContain(
      "Lee Seo-ha — KNOWS: “Lee Seo-ha is Chairman Lee Tae-san's illegitimate daughter.”",
    );
    expect(knowledge).toContain(
      'Lee Seo-ha — BELIEVES_FALSE (believes: true): “Kang Do-yoon sells raid intelligence to brokers.” [channel: told by Choi Hyun-seok',
    );
    expect(knowledge).not.toMatch(/Lee Seo-ha — KNOWS: “Kang Do-yoon is a regressor/);
    expect(knowledge).not.toMatch(/Han Yu-ri — KNOWS/);
    const guards = pack.sections.find((s) => s.name === 'knowledge_guards');
    expect(guards?.tier).toBe('T0');
    expect(guards?.text).toContain(
      'Lee Seo-ha must NOT know (or speak/act as if knowing): “Kang Do-yoon is a regressor.”',
    );
    expect(guards?.text).toContain(
      "Han Yu-ri must NOT know (or speak/act as if knowing): “Lee Seo-ha is Chairman Lee Tae-san's illegitimate daughter.”",
    );
    // Secret proposition lines name the owner and allowed knowers so the writer sees the restriction.
    expect(knowledge).toContain(
      'SECRET (owners: Kang Do-yoon; allowed knowers: none; reveal not before ch.58)',
    );
  });

  it('relationships are directional and time-correct: Mu-jin→Do-yoon carries the ch.9 register, Do-yoon→Mu-jin its own', async () => {
    const { pack } = await build('scene_writer');
    const rel = pack.sections.find((s) => s.name === 'relationships')?.text ?? '';
    expect(rel).toContain(
      'Park Mu-jin → Kang Do-yoon: mentor (from_dominant); axes: affection 2, dependency 1, hostility 0, respect 2, trust 3; register: formality 1; deference 0; familiarity 3; intimacy 1; directness 4; contractions free; address terms: "kid", "Do-yoon", "son"; since ch.9.80',
    );
    expect(rel).toContain('Kang Do-yoon → Park Mu-jin: mentor (to_dominant)');
    expect(rel).toContain('address terms: "Mister Park", "old man"');
    expect(rel).not.toContain('address terms: "kid", "Mister"'); // the superseded ch.2 state is not current at ch.10
    // As of chapter 5 the older state is the current one.
    const early = await buildPack(pool, {
      projectId: project,
      role: 'scene_writer',
      contract: {
        ...contract10,
        chapter_number: 4,
        story_time: { start: clock(4, 0), end: clock(4, 99) },
      },
      spec,
      policy,
      identity,
    });
    expect(early.pack.sections.find((s) => s.name === 'relationships')?.text).toContain(
      'address terms: "kid", "Mister"; since ch.2.0',
    );
  });

  it('prior-loop facts stay off the main timeline: Mu-jin is alive on main; Do-yoon’s memory is labeled, not stated as fact', async () => {
    const { pack } = await build('scene_writer');
    const all = pack.renderedUser;
    expect(pack.sections.find((s) => s.name === 'states')?.text).not.toContain(
      'status.alive = false',
    );
    expect(all).not.toMatch(/\[FACT[^\n]*Died shielding Do-yoon/);
    const knowledge = pack.sections.find((s) => s.name === 'knowledge')?.text ?? '';
    expect(knowledge).toContain(
      'Kang Do-yoon — KNOWS: “The Gangnam gate break happens on March 14 with 200 casualties.” [channel: prior_loop_memory',
    );
    expect(knowledge).toContain(
      'remembered from prior_loop_1 (prior_loop) where it is TRUE; NOT a fact of this timeline',
    );
    expect(knowledge).toContain(
      '“The Gangnam gate break happens on March 14 with 200 casualties.” (event) — objectively UNKNOWN on this timeline',
    );
    expect(pack.sections.find((s) => s.name === 'timeline')?.text).toContain(
      'Other timelines in this project: prior_loop_1 (prior_loop, diverged at ch.1.0)',
    );
    for (const it of pack.manifest.items.filter(
      (i) => i.included && i.source?.kind === 'canon' && i.source.timeline_id,
    )) {
      expect(it.source?.timeline_id, it.id).toBe(main);
    }
  });

  it('distant accepted events are recovered through lexical retrieval with evidence and provenance; the writer sees ch.3 in T2', async () => {
    const { pack } = await build('scene_writer');
    const retrieved = pack.sections.find((s) => s.name === 'retrieved');
    expect(retrieved).toBeDefined();
    expect(retrieved?.text).toMatch(
      /\[EVENT · lexical_index:[0-9a-f-]+@3\] ch\.3 event: Do-yoon buys the old compass/,
    );
    const compassItems = pack.manifest.items.filter(
      (i) => i.included && i.source?.kind === 'lexical_index' && (i.source.chapter_no ?? 0) === 3,
    );
    expect(compassItems.length).toBeGreaterThan(0);
    for (const it of compassItems) {
      expect(it.source?.version).toBe('3');
      expect(it.signals?.lexical_relevance).toBeGreaterThan(0);
      expect(it.materiality).toBe('contextual');
    }
    // Nothing retrieved may come from chapter k or later, and nothing from a non-accepted version.
    for (const it of pack.manifest.items.filter((i) => i.source?.kind === 'lexical_index')) {
      expect(it.source?.chapter_no ?? 0).toBeLessThan(10);
      if (it.source?.manuscript_status) expect(it.source.manuscript_status).toBe('accepted');
    }
    expect(pack.manifest.degradation).toMatchObject({
      lexical: 'ok',
      vector: 'not_configured',
      structured: 'ok',
    });
  });

  it('optional retrieval failure degrades safely: lexical and vector outages omit T2 items and flag the manifest', async () => {
    const { pack } = await build('scene_writer', {
      lexical: new FailingRetriever('lexical-down'),
      vector: new FailingRetriever('vector-down'),
    });
    expect(pack.validation.ok).toBe(true);
    expect(pack.manifest.degraded).toBe(true);
    expect(pack.manifest.degradation).toMatchObject({
      lexical: 'unavailable',
      vector: 'unavailable',
      structured: 'ok',
    });
    expect(pack.manifest.degradation_notes?.some((n) => n.includes('lexical-down'))).toBe(true);
    expect(pack.manifest.items.some((i) => i.source?.kind === 'lexical_index')).toBe(false);
    // Structured content is untouched.
    expect(pack.sections.find((s) => s.name === 'states')?.text).toContain('left_leg_venom');
    expect(pack.sections.find((s) => s.name === 'previous_chapter')).toBeDefined();
  });

  it('authoritative structured retrieval failure blocks generation with STRUCTURED_RETRIEVAL_UNAVAILABLE', async () => {
    const dead = createPool({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/nope',
      max: 1,
    });
    try {
      await expect(
        buildPack(dead, {
          projectId: project,
          role: 'scene_writer',
          contract: contract10,
          spec,
          policy,
          identity,
        }),
      ).rejects.toMatchObject({ code: 'STRUCTURED_RETRIEVAL_UNAVAILABLE' });
    } finally {
      await dead.end();
    }
  });

  it('chapter k−1 not accepted: the writer pack fails with PREVIOUS_CHAPTER_NOT_ACCEPTED and never substitutes a draft', async () => {
    // Chapter 11 exists with only a working draft (created in the isolation test); chapter 12 needs it.
    const contract12 = {
      ...contract10,
      chapter_number: 12,
      story_time: { start: clock(12, 0), end: clock(12, 99) },
    };
    let err: unknown;
    try {
      await buildPack(pool, {
        projectId: project,
        role: 'scene_writer',
        contract: contract12,
        spec,
        policy,
        identity,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContextError);
    expect((err as ContextError).code).toBe('PREVIOUS_CHAPTER_NOT_ACCEPTED');
    expect((err as ContextError).message).toMatch(
      /chapter 11 is planned \(latest version working\)/,
    );
    expect((err as ContextError).message).toMatch(/a draft is never substituted/);
    // A missing chapter is reported distinctly.
    const contract40 = {
      ...contract10,
      chapter_number: 40,
      story_time: { start: clock(40, 0), end: clock(40, 99) },
    };
    await expect(
      buildPack(pool, {
        projectId: project,
        role: 'scene_writer',
        contract: contract40,
        spec,
        policy,
        identity,
      }),
    ).rejects.toMatchObject({ code: 'PREVIOUS_CHAPTER_NOT_ACCEPTED' });
    // Checkers do not require k−1 and still never see the draft.
    const lookup = await acceptedChapter(pool, project, 11);
    expect(lookup.state).toBe('not_accepted');
  });

  it('long-story memory (ADR-0061): an overdue promise, the story so far and first meetings reach the writer', async () => {
    // Overdue since chapter 6 and sharing no participant with chapter 10: invisible before ADR-0061.
    await createPromise(pool, {
      workspaceId: ws,
      projectId: project,
      type: 'mystery',
      statement: 'Who forged the gate permit in the Association archive?',
      importance: 'major',
      status: 'open',
      dueMinChapter: 4,
      dueMaxChapter: 6,
      relatedEntityIds: [],
    });
    const writer = await build('scene_writer', { persist: false });
    const text = writer.pack.renderedUser;
    expect(text).toContain('Who forged the gate permit in the Association archive?');
    expect(text).toMatch(/Who forged the gate permit[^\n]*OVERDUE by 4 chapters/);
    // Chapter 3 is accepted and older than the previous chapter (9): it reaches the story-so-far digest.
    const story = writer.pack.sections.find((s) => s.name === 'story_so_far')?.text ?? '';
    expect(story).toMatch(/Chapters 3–3\nCh\.3: /);
    // Mu-jin and Do-yoon first shared a canonical event in chapter 9 (the fog-beast injury).
    const meetings = writer.pack.sections.find((s) => s.name === 'first_meetings')?.text ?? '';
    expect(meetings).toMatch(
      /(Park Mu-jin ↔ Kang Do-yoon|Kang Do-yoon ↔ Park Mu-jin): first appeared together in chapter 9\./,
    );
    expect(writer.pack.manifest.template_version).toMatch(/^1\.1\.0\+/);
  });

  it('rollback de-accepts chapter 9 and removes its search documents and summary in the same transaction', async () => {
    // Chapter 10 is now unbuildable (k−1 no longer accepted); then re-accepting restores it.
    const before = await searchDocumentCount(pool, project);
    await withTransaction(pool, async (c) => {
      await c.query('SELECT canon.rollback_latest($1, $2::jsonb)', [project, '{}']);
    });
    const afterRollback = await searchDocumentCount(pool, project);
    expect(afterRollback).toBeLessThan(before);
    expect(await searchDocumentsContaining(pool, project, 'Black venom')).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM summaries WHERE manuscript_version_id = $1', [ch9Version]))
        .rowCount,
    ).toBe(0);
    await expect(build('scene_writer')).rejects.toMatchObject({
      code: 'PREVIOUS_CHAPTER_NOT_ACCEPTED',
    });
  });

  it('checker and extractor packs use job-scoped text from an approval-locked version and refuse a working draft', async () => {
    // Re-accept chapter 9 (approved after rollback) with a minimal delta so k−1 exists again.
    const proj = await pool.query<{ canon_version: number }>(
      'SELECT canon_version FROM projects WHERE id = $1',
      [project],
    );
    const re = await commitDelta(pool, {
      projectId: project,
      parentVersion: proj.rows[0]?.canon_version ?? 0,
      source: 'chapter_acceptance',
      chapterId: ch9,
      manuscriptVersionId: ch9Version,
      clockMax: clock(9, 999),
      delta: {
        items: [
          item(
            'f-1b',
            'fact',
            'assert',
            {
              entity_id: E.mujin,
              attribute: 'status.injury',
              key: 'left_leg_venom',
              value: { part: 'left calf' },
              value_text: 'Beast venom in the left calf (serious)',
              valid_from: clock(9, 46, 'D+35'),
              valid_to: null,
            },
            {
              story_clock: clock(9, 46, 'D+35'),
              importance: 'core',
              evidence: [
                evidenceFor(ch9Version, CH09, 'Black venom was climbing Mu-jin’s left calf.'),
              ],
            },
          ),
        ],
      },
    });
    await withTransaction(pool, async (c) => {
      await upsertL1Summary(c, {
        workspaceId: ws,
        projectId: project,
        manuscriptVersionId: ch9Version,
        chapterNo: 9,
        text: 'Re-accepted summary.',
        endingHook: 'Outside the gate, the black venom had climbed to Mu-jin’s knee.',
        canonVersion: re.version,
      });
      await indexAcceptedVersion(c, ch9Version);
    });
    const c10 = { ...contract10, pinned: { ...contract10.pinned, canon_version: re.version } };
    const working = await createManuscriptVersion(pool, {
      workspaceId: ws,
      projectId: project,
      chapterId: ch10,
      origin: 'assembled',
      text: '“You have to take one rookie,” the clerk said.\n\nDo-yoon did not want a rookie.',
    });
    // Continuity checker may evaluate a working draft (job-scoped), labeled as a draft, not canon.
    const checker = await buildPack(pool, {
      projectId: project,
      role: 'continuity_checker',
      contract: c10,
      spec,
      policy,
      identity: undefined,
      chapterText: { versionId: working.id },
    });
    expect(checker.pack.validation.ok, checker.pack.validation.failures.join('; ')).toBe(true);
    expect(checker.pack.renderedSystem).toBe('');
    const text = checker.pack.sections.find((s) => s.name === 'chapter_text');
    expect(text?.text).toContain('[DRAFT · job_input:');
    expect(text?.text).toContain('[p1] “You have to take one rookie,” the clerk said.');
    expect(
      checker.pack.manifest.items.find((i) => i.kind === 'chapter_text')?.source?.manuscript_status,
    ).toBe('working');
    // After the rollback the ch.9 events were retracted; the re-accepted fact is current state again.
    expect(checker.pack.sections.find((s) => s.name === 'states')?.text).toContain(
      'left_leg_venom',
    );
    expect(checker.pack.sections.find((s) => s.name === 'previous_chapter')?.text).toContain(
      'Re-accepted summary.',
    );
    // The extractor reads approval-locked text only.
    await expect(
      buildPack(pool, {
        projectId: project,
        role: 'canon_extractor',
        contract: c10,
        spec,
        policy,
        identity: undefined,
        chapterText: { versionId: working.id },
      }),
    ).rejects.toMatchObject({ code: 'PROHIBITED_SOURCE' });
    await setChapterStatus(pool, ch10, 'review_pending');
    await approveManuscriptVersion(pool, working.id, 'tester');
    const extractor = await buildPack(pool, {
      projectId: project,
      role: 'canon_extractor',
      contract: c10,
      spec,
      policy,
      identity: undefined,
      chapterText: { versionId: working.id },
    });
    expect(extractor.pack.validation.ok, extractor.pack.validation.failures.join('; ')).toBe(true);
    expect(extractor.pack.sections.find((s) => s.name === 'hypotheses')?.text).toContain('PLANNED');
    expect(extractor.pack.sections.find((s) => s.name === 'registry')?.text).toContain(
      'Park Mu-jin (character; id',
    );
    expect(extractor.pack.variables.chapter_text).toContain('approval-locked');
    // A quarantined id is unknown to the reader: rejected drafts cannot even be evaluated.
    const q = await pool.query<{ id: string }>(
      'SELECT id FROM quarantine_versions WHERE project_id = $1',
      [project],
    );
    await expect(
      buildPack(pool, {
        projectId: project,
        role: 'continuity_checker',
        contract: c10,
        spec,
        policy,
        identity: undefined,
        chapterText: { versionId: q.rows[0]?.id ?? '' },
      }),
    ).rejects.toMatchObject({ code: 'PROHIBITED_SOURCE' });
  });
});
