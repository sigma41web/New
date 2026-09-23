/**
 * Where every JSON prompt family's answer is described in `schemas/` (ADR-0057). Prompt output-shape
 * examples are generated from these schemas (`tools/ko_prompts/shapes.py`), CI validates the example of
 * every active version against them, and providers with native structured output receive the same schema.
 *
 * `workflowFilled` lists the fields the workflow completes after the call (ids, pins, offsets); the model's
 * answer omits them, so they are dropped from `required` in the model-answer view. Paths are dotted, with
 * `[]` for array items (`seasons[].id`).
 */
import { bundledSchema, shapeValidator, type ValidationResult } from '@yeonjae/domain';

export interface OutputShape {
  readonly schema: string;
  readonly def?: string | undefined;
  readonly workflowFilled: readonly string[];
  /**
   * Properties the answer carries that the persisted document does not (the workflow converts them, e.g.
   * entity names into ids). Keyed by path; values name a `$defs` entry of model-output.schema.json.
   */
  readonly answerProperties?: Readonly<Record<string, string>> | undefined;
}

const answer = (def: string): OutputShape => ({
  schema: 'model-output.schema.json',
  def,
  workflowFilled: [],
});

export const OUTPUT_SHAPES: Readonly<Record<string, OutputShape>> = {
  arc_planner: {
    schema: 'arc-plan.schema.json',
    workflowFilled: ['id', 'project_id', 'season_id'],
  },
  assumption_explainer: answer('assumption_explainer'),
  canon_extractor: {
    schema: 'canon-delta.schema.json',
    workflowFilled: [
      'project_id',
      'chapter_id',
      'manuscript_version_id',
      'base_canon_version',
      'stage',
      'extractor_call_id',
      'reconciliation',
    ],
  },
  chapter_comparator: {
    schema: 'comparison-verdict.schema.json',
    workflowFilled: ['judge_call_id'],
  },
  chapter_planner: {
    schema: 'chapter-contract.schema.json',
    workflowFilled: [
      'id',
      'project_id',
      'chapter_number',
      'version',
      'arc_id',
      'season_id',
      'timeline_id',
      'status',
      'pinned',
      'narrative_identity_version_id',
      'active_constraints_ref',
      'continuity_anchors',
    ],
  },
  concept_comparator: {
    schema: 'comparison-verdict.schema.json',
    workflowFilled: ['judge_call_id'],
  },
  concept_generator: {
    schema: 'concept.schema.json',
    workflowFilled: ['id', 'project_id', 'spec_version', 'status'],
  },
  continuity_checker: answer('continuity_checker'),
  contract_checker: answer('contract_checker'),
  factual_summarizer: answer('factual_summarizer'),
  genre_judge: answer('genre_judge'),
  knowledge_leak_checker: answer('knowledge_leak_checker'),
  promise_checker: answer('promise_checker'),
  prose_judge: answer('prose_judge'),
  repetition_judge: answer('repetition_judge'),
  requirement_interpreter: {
    schema: 'story-spec.schema.json',
    workflowFilled: ['project_id', 'version'],
  },
  scene_planner: answer('scene_planner'),
  story_architect: {
    schema: 'series-blueprint.schema.json',
    workflowFilled: [
      'project_id',
      'version',
      'pinned',
      'foreshadowing_register',
      'seasons[].id',
      'seasons[].ordinal',
      'protagonist_arc.entity_id',
      'character_arcs[].entity_id',
    ],
    answerProperties: {
      promises: 'blueprintPromise[]',
      'character_arcs[].entity_name': 'entityName',
    },
  },
  structure_judge: answer('structure_judge'),
  targeted_reviser: {
    schema: 'patch.schema.json',
    workflowFilled: [
      'id',
      'from_version_id',
      'issue_ids',
      'reviser_call_id',
      'dimension',
      'span.start',
      'span.end',
      'regression',
    ],
  },
  voice_judge: answer('voice_judge'),
};

/**
 * JSON families whose answer has no schema yet (bible design documents normalized by `design-output.ts`,
 * the assembler and the reconciler). The shape test reports them; this list may only shrink.
 */
export const UNSCHEMATIZED_FAMILIES: readonly string[] = [
  'chapter_assembler',
  'character_designer',
  'extraction_reconciler',
  'power_system_designer',
  'world_builder',
];

type Json = Record<string, unknown>;

const answerSchemas = new Map<string, Json | undefined>();

/** The self-contained schema of what the model returns for `family`, or undefined for text/unschematized roles. */
export function modelAnswerSchema(family: string): Json | undefined {
  if (answerSchemas.has(family)) return answerSchemas.get(family);
  const shape = OUTPUT_SHAPES[family];
  if (!shape) {
    answerSchemas.set(family, undefined);
    return undefined;
  }
  const schema = bundledSchema(shape.schema, shape.def);
  for (const path of shape.workflowFilled) dropRequired(schema, path.split('.'));
  for (const [path, def] of Object.entries(shape.answerProperties ?? {})) {
    const isArray = def.endsWith('[]');
    const sub = bundledSchema('model-output.schema.json', isArray ? def.slice(0, -2) : def);
    addProperty(schema, path.split('.'), isArray ? { type: 'array', items: sub } : sub);
  }
  answerSchemas.set(family, schema);
  return schema;
}

/** Declare an answer-only property at `path` (the leaf) on every object variant that owns the parent. */
function addProperty(node: Json, path: readonly string[], prop: Json): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    const target = variants(node).find((n) => n.properties) ?? node;
    target.properties = { ...(target.properties as Json | undefined), [head]: prop };
    return;
  }
  const isArray = head.endsWith('[]');
  const name = isArray ? head.slice(0, -2) : head;
  for (const n of variants(node)) {
    const child = (n.properties as Record<string, Json> | undefined)?.[name];
    if (!child) continue;
    for (const c of variants(child)) {
      const t = isArray ? (c.items as Json | undefined) : c;
      if (t && (t.properties || t.type === 'object')) addProperty(t, rest, prop);
    }
  }
}

/** Remove the leaf of `path` from `required` wherever the schema declares it (through allOf/anyOf/oneOf). */
function dropRequired(node: Json, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const isArray = head.endsWith('[]');
  const name = isArray ? head.slice(0, -2) : head;
  for (const n of variants(node)) {
    if (rest.length === 0 && Array.isArray(n.required))
      n.required = (n.required as string[]).filter((r) => r !== name);
    const props = n.properties as Record<string, Json> | undefined;
    const child = props?.[name];
    if (!child || rest.length === 0) continue;
    for (const c of variants(child)) {
      const target = isArray ? (c.items as Json | undefined) : c;
      if (target) dropRequired(target, rest);
    }
  }
}

function variants(node: Json): Json[] {
  const out: Json[] = [node];
  for (const k of ['allOf', 'anyOf', 'oneOf'] as const) {
    const list = node[k];
    if (Array.isArray(list)) for (const m of list as Json[]) out.push(...variants(m));
  }
  return out;
}

const validators = new Map<string, (x: unknown) => ValidationResult<unknown>>();

/** Shape validation of a model answer for `family` (formats unchecked; see `shapeValidator`). */
export function validateAnswerShape(family: string, answer: unknown): ValidationResult<unknown> {
  let fn = validators.get(family);
  if (!fn) {
    const schema = modelAnswerSchema(family);
    if (!schema) throw new Error(`${family} has no answer schema`);
    fn = shapeValidator(schema);
    validators.set(family, fn);
  }
  return fn(answer);
}

/**
 * Every `enum`/`const` value the answer schema allows at an instance path (through allOf/anyOf/oneOf,
 * `items` and `additionalProperties`). `undefined` when the location is unconstrained (free text).
 */
export function allowedValuesAt(
  family: string,
  path: readonly (string | number)[],
): Set<unknown> | undefined {
  const schema = modelAnswerSchema(family);
  if (!schema) return undefined;
  let nodes: Json[] = variants(schema);
  for (const step of path) {
    const next: Json[] = [];
    for (const n of nodes) {
      if (typeof step === 'number') {
        if (n.items && typeof n.items === 'object') next.push(n.items as Json);
        continue;
      }
      const props = n.properties as Record<string, Json> | undefined;
      if (props?.[step]) next.push(props[step]);
      else if (n.additionalProperties && typeof n.additionalProperties === 'object')
        next.push(n.additionalProperties as Json);
    }
    nodes = next.flatMap(variants);
    if (nodes.length === 0) return undefined;
  }
  const values = new Set<unknown>();
  for (const n of nodes) {
    if (Array.isArray(n.enum)) for (const v of n.enum as unknown[]) values.add(v);
    if ('const' in n) values.add(n.const);
  }
  return values.size > 0 ? values : undefined;
}
