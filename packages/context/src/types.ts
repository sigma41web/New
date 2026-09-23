/**
 * Shared context-pack types (docs/04-memory-canon/04). An `Item` is one candidate piece of context with its
 * source, provenance label, tier and rendered text; the assembler turns items into sections, sections into
 * a rendered prompt, and everything into a manifest that is a pure function of the pinned inputs.
 */
import { type Generated, type StoryClock } from '@yeonjae/domain';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

export type Manifest = Generated.ContextPackManifestSchema.ContextPackManifest;
export type ManifestItem = Manifest['items'][number];
export type ItemKind = ManifestItem['kind'];
export type Provenance = NonNullable<ManifestItem['provenance']>;
export type SourceRef = NonNullable<ManifestItem['source']>;
export type Compression = NonNullable<ManifestItem['compression']>;
export type ChapterContract = Generated.ChapterContractSchema.ChapterContract;
export type Requirement = Generated.StorySpecSchema.Requirement;
export type StorySpec = Generated.StorySpecSchema.StorySpec;

export type SourceKind = SourceRef['kind'];

/** One candidate piece of context. `text` is the exact rendered line(s) that will appear in the prompt. */
export interface Item {
  readonly kind: ItemKind;
  /** Stable id: `<kind>:<source id>[#key]`; used for dedupe, manifests and dependency edges. */
  readonly id: string;
  readonly section: string;
  readonly tier: Tier;
  readonly provenance: Provenance;
  readonly source: SourceRef;
  readonly text: string;
  /** Materiality of the dependency edge this item would create (ADR-0032). */
  readonly materiality: 'material' | 'contextual';
  /** Alternative, shorter renderings the degradation ladder may switch to (lossless per §2.4). */
  readonly compressed?: { readonly method: Compression; readonly text: string } | undefined;
  /** Ranking signals for T2 items (documented in templates.ts); T0/T1 items carry none. */
  readonly signals?: Readonly<Record<string, number | undefined>> | undefined;
  /** Entity ids the item concerns; used for diversity caps and dedupe. */
  readonly entityIds?: readonly string[] | undefined;
  /** Dedupe key: items sharing a key with a T1 item are dropped from T2 ("already implied by T1"). */
  readonly dedupeKey?: string | undefined;
}

export interface PreviousChapterInfo {
  readonly chapterNo: number;
  readonly manuscriptVersionId: string;
  readonly versionNo: number;
  readonly contentHash: string;
  readonly acceptedCanonVersion: number;
  readonly tail: {
    readonly text: string;
    readonly startCp: number;
    readonly endCp: number;
    readonly words: number;
  };
  readonly tailFloor: {
    readonly text: string;
    readonly startCp: number;
    readonly endCp: number;
    readonly words: number;
  };
  readonly summaryL1: string | undefined;
  readonly endingHook: string | undefined;
  readonly committedItemCount: number;
  /** Latest story clock among the committed items of k−1 (for elapsed story time). */
  readonly endClock: StoryClock | undefined;
}

export interface RetrievalStatus {
  readonly lexical: 'ok' | 'unavailable' | 'not_configured' | 'timeout';
  readonly vector: 'ok' | 'unavailable' | 'not_configured' | 'timeout';
  readonly notes: readonly string[];
}

/** Everything the assembler consumes. Produced by `fetchContext` (db) or built by hand in unit tests. */
export interface AssemblyInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly role: string;
  readonly contract: ChapterContract;
  readonly clockStart: StoryClock;
  readonly items: readonly Item[];
  /**
   * The project's manuscript language. Section titles and the token estimator follow it even for packs
   * that carry no identity block (checker, extractor), so a Korean pack is Korean throughout (ADR-0059).
   */
  readonly language?: 'en' | 'ko' | undefined;
  readonly narrativeBlock:
    | {
        readonly text: string;
        readonly hash: string;
        readonly identityVersionId: string;
        readonly roleVariant: string;
        readonly outputLanguage: 'en' | 'ko';
        readonly outputLanguageContractHash: string;
        readonly traditionContractHash: string;
        readonly droppedSections: readonly string[];
        readonly identityTail: string | undefined;
      }
    | undefined;
  readonly activeConstraintSet: {
    readonly id: string;
    readonly contentHash: string;
    readonly renderedText: string;
    /** The hard block: rendered byte-for-byte in T0 and re-found by validation. */
    readonly hardText: string;
    readonly tokenCount: number;
    readonly hardCount: number;
    readonly softCount: number;
    readonly assumptionCount: number;
    readonly conflictCount: number;
    readonly specVersion: number;
  };
  readonly previousChapter: PreviousChapterInfo | undefined;
  readonly pins: {
    readonly canonVersion: number;
    readonly specVersion: number;
    readonly bibleVersion: number | undefined;
    readonly narrativeIdentityVersionId: string;
    readonly productionPolicyVersion: string;
    readonly promptSetId: string | undefined;
  };
  readonly policyContext: {
    readonly previous_tail_words: number;
    readonly previous_tail_floor_words: number;
    readonly active_constraints_cap_tokens: number;
    readonly writer_input_budget_tokens?: number | undefined;
    readonly l1_summary_max_words?: number | undefined;
    readonly input_budget_tokens?: Readonly<Record<string, number | undefined>> | undefined;
  };
  readonly retrieval: RetrievalStatus;
  readonly queryPlanHash: string;
  /** Job-scoped text the template allows as `chapter_text` / `scene_text` (never a stored draft). */
  readonly jobInputs?: Readonly<Record<string, string>> | undefined;
  readonly jobId?: string | undefined;
}
