import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { KnowledgeEntityType } from '../knowledge/ontologyTypes';
import type { Problem } from '../problems/problem';
import { isRecord } from '../persistence/storeFiles';

/**
 * Phase J-1 Problem Knowledge Record: the durable learner-controlled
 * knowledge/notes record attached to one canonical Problem.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - C owns canonical DSA knowledge. This record only REFERENCES canonical
 *   entity IDs (validated against the live graph); it never defines, edits,
 *   or extends the taxonomy. Unknown IDs fail closed — nothing is created.
 * - D owns learner evidence and the learner model. Saving or updating a
 *   knowledge record emits NO evidence and touches NO learner state. A note
 *   saying "I finally understood X" is a note, not an assessment.
 * - G owns structured reflections (per-attempt voice). This record is
 *   per-PROBLEM (one current record no matter how many attempts) and is a
 *   separate store, not a reflection.
 * - H owns analytics/export; J-0 owns derived attempt statistics. This
 *   record stores NO counters (`timesAttempted` etc. stay derived in J-0).
 * - No AI is required. J-1 write paths are deterministic and learner-driven.
 *   The `learner-confirmed` provenance value exists so a later stage can
 *   mark learner-accepted refinements; J-1 itself never calls any provider.
 */

export const PROBLEM_KNOWLEDGE_SCHEMA_VERSION = 1;
export const PROBLEM_KNOWLEDGE_ID_PREFIX = 'pk_';

/** Bounds mirror the reflection conventions (`MAX_REFLECTION_*`). */
export const MAX_KNOWLEDGE_ENTITY_IDS = 12;
export const MAX_KNOWLEDGE_TEXT_CHARS = 500;

/**
 * Where the record's content came from. J-1 write paths produce
 * `learner-authored` by default and accept an explicit `learner-confirmed`;
 * no AI-derived value exists yet (a later stage may extend this union —
 * nothing here requires AI).
 */
export type KnowledgeSource = 'learner-authored' | 'learner-confirmed';

export const KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = ['learner-authored', 'learner-confirmed'];

export function isKnownKnowledgeSource(value: unknown): value is KnowledgeSource {
  return value === 'learner-authored' || value === 'learner-confirmed';
}

export interface ProblemKnowledgeProvenance {
  source: KnowledgeSource;
}

/**
 * One current knowledge record per canonical problem. Identity is derived
 * from the canonical `problemId` (`pk_<problemId>`); updates keep the same
 * identity. Structured buckets reference canonical C entity IDs only;
 * free-text buckets are learner-authored notes (never taxonomy).
 */
export interface ProblemKnowledgeRecord {
  /** Deterministic identity: `pk_<canonicalProblemId>`. Never random. */
  recordId: string;
  /** Canonical problem identity (reused, never invented). */
  problemId: string;
  schemaVersion: number;
  /** Canonical C `concept` entity IDs (sorted, deduped). */
  conceptIds: string[];
  /** Canonical C `form` entity IDs (sorted, deduped). */
  formIds: string[];
  /** Canonical C `framework` entity IDs (sorted, deduped). */
  frameworkIds: string[];
  /** Canonical C `tactic` entity IDs (sorted, deduped). */
  tacticIds: string[];
  /** Learner debugging knowledge (free text, NOT a new C entity). */
  debugNotes: string | null;
  /** The crucial learner insight (free text). */
  keyInsight: string | null;
  /** Other learner-authored notes (free text). */
  learnerNotes: string | null;
  provenance: ProblemKnowledgeProvenance;
  createdAt: string;
  updatedAt: string;
}

/** Learner-supplied values for create/update (all optional except identity). */
export interface ProblemKnowledgeInput {
  conceptIds?: unknown;
  formIds?: unknown;
  frameworkIds?: unknown;
  tacticIds?: unknown;
  debugNotes?: unknown;
  keyInsight?: unknown;
  learnerNotes?: unknown;
  source?: unknown;
}

/** Deterministic record identity from the canonical problem identity. */
export function problemKnowledgeIdFor(problemId: string): string {
  return `${PROBLEM_KNOWLEDGE_ID_PREFIX}${problemId}`;
}

function toCleanIds(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid problem knowledge: "${field}" must be an array of C entity IDs.`);
  }
  if (value.length > MAX_KNOWLEDGE_ENTITY_IDS) {
    throw new Error(
      `Invalid problem knowledge: "${field}" holds ${value.length} IDs (max ${MAX_KNOWLEDGE_ENTITY_IDS}).`,
    );
  }
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`Invalid problem knowledge: "${field}" must contain only non-blank strings.`);
    }
    cleaned.push(entry.trim());
  }
  // Deterministic normalization (mirrors `cleanTopics`/`sortedUnique`):
  // exact-duplicate collapse, then sort. Case is preserved — C IDs are
  // case-sensitive stable identifiers.
  return [...new Set(cleaned)].sort();
}

function assertKnownTypedIds(
  ids: string[],
  expectedType: KnowledgeEntityType,
  graph: KnowledgeGraph,
  field: string,
): void {
  for (const id of ids) {
    const entity = graph.getEntity(id);
    if (entity === null) {
      throw new Error(`Invalid problem knowledge: "${field}" references unknown C entity "${id}".`);
    }
    if (entity.type !== expectedType) {
      throw new Error(
        `Invalid problem knowledge: "${field}" references "${id}" which is a ${entity.type}, not a ${expectedType}.`,
      );
    }
  }
}

/**
 * Text normalization contract: surrounding whitespace is trimmed, interior
 * content is preserved EXACTLY, whitespace-only/empty becomes null.
 * Over-long or non-string values throw (never truncated silently).
 */
function toCleanText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid problem knowledge: "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_KNOWLEDGE_TEXT_CHARS) {
    throw new Error(
      `Invalid problem knowledge: "${field}" holds ${trimmed.length} chars (max ${MAX_KNOWLEDGE_TEXT_CHARS}).`,
    );
  }
  return trimmed;
}

function toCleanSource(value: unknown): KnowledgeSource {
  if (value === undefined) {
    return 'learner-authored';
  }
  if (!isKnownKnowledgeSource(value)) {
    throw new Error('Invalid problem knowledge: "source" must be a known knowledge source.');
  }
  return value;
}

function buildRecord(args: {
  problem: Problem;
  input: ProblemKnowledgeInput;
  graph: KnowledgeGraph;
  createdAt: string;
  updatedAt: string;
}): ProblemKnowledgeRecord {
  const { problem, input, graph } = args;
  if (typeof problem.problemId !== 'string' || problem.problemId.trim().length === 0) {
    throw new Error('Invalid problem knowledge: a canonical problemId is required.');
  }
  const conceptIds = toCleanIds(input.conceptIds, 'conceptIds');
  const formIds = toCleanIds(input.formIds, 'formIds');
  const frameworkIds = toCleanIds(input.frameworkIds, 'frameworkIds');
  const tacticIds = toCleanIds(input.tacticIds, 'tacticIds');
  assertKnownTypedIds(conceptIds, 'concept', graph, 'conceptIds');
  assertKnownTypedIds(formIds, 'form', graph, 'formIds');
  assertKnownTypedIds(frameworkIds, 'framework', graph, 'frameworkIds');
  assertKnownTypedIds(tacticIds, 'tactic', graph, 'tacticIds');
  return {
    recordId: problemKnowledgeIdFor(problem.problemId),
    problemId: problem.problemId,
    schemaVersion: PROBLEM_KNOWLEDGE_SCHEMA_VERSION,
    conceptIds,
    formIds,
    frameworkIds,
    tacticIds,
    debugNotes: toCleanText(input.debugNotes, 'debugNotes'),
    keyInsight: toCleanText(input.keyInsight, 'keyInsight'),
    learnerNotes: toCleanText(input.learnerNotes, 'learnerNotes'),
    provenance: { source: toCleanSource(input.source) },
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
  };
}

/**
 * Create the knowledge record for a canonical problem. The caller supplies
 * the canonical `Problem` (identity is derived from it, never invented).
 * Strict: throws on any invalid value. No AI, no clock unless `now` is
 * omitted, no mutation of the problem or the graph.
 */
export function createProblemKnowledge(args: {
  problem: Problem;
  input?: ProblemKnowledgeInput;
  graph: KnowledgeGraph;
  now?: string;
}): ProblemKnowledgeRecord {
  const now = args.now ?? new Date().toISOString();
  return buildRecord({
    problem: args.problem,
    input: args.input ?? {},
    graph: args.graph,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Update the single current record for its problem. Identity (`recordId`,
 * `problemId`) and `createdAt` are preserved; every supplied field is
 * revalidated and `updatedAt` advances. Omitted fields are kept as-is;
 * explicitly passing `undefined` also keeps the current value. Never
 * mutates the input record — returns a new object.
 */
export function updateProblemKnowledge(
  existing: ProblemKnowledgeRecord,
  patch: ProblemKnowledgeInput,
  graph: KnowledgeGraph,
  now?: string,
): ProblemKnowledgeRecord {
  const merged: ProblemKnowledgeInput = {
    conceptIds: patch.conceptIds === undefined ? existing.conceptIds : patch.conceptIds,
    formIds: patch.formIds === undefined ? existing.formIds : patch.formIds,
    frameworkIds: patch.frameworkIds === undefined ? existing.frameworkIds : patch.frameworkIds,
    tacticIds: patch.tacticIds === undefined ? existing.tacticIds : patch.tacticIds,
    debugNotes: patch.debugNotes === undefined ? existing.debugNotes : patch.debugNotes,
    keyInsight: patch.keyInsight === undefined ? existing.keyInsight : patch.keyInsight,
    learnerNotes: patch.learnerNotes === undefined ? existing.learnerNotes : patch.learnerNotes,
    source: patch.source === undefined ? existing.provenance.source : patch.source,
  };
  const updated = buildRecord({
    problem: { problemId: existing.problemId } as Problem,
    input: merged,
    graph,
    createdAt: existing.createdAt,
    updatedAt: now ?? new Date().toISOString(),
  });
  return { ...updated, recordId: existing.recordId };
}

/**
 * Lenient shape check for persisted rows (mirrors `parseProblem` /
 * `parseReflection`): returns null for malformed data so one bad row never
 * breaks loading. Shape-only — entity existence is enforced at write time
 * with the live graph, not here (the catalog may evolve after persisting).
 */
export function parseProblemKnowledge(raw: unknown): ProblemKnowledgeRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  try {
    if (typeof raw.problemId !== 'string' || raw.problemId.trim().length === 0) {
      return null;
    }
    if (raw.schemaVersion !== PROBLEM_KNOWLEDGE_SCHEMA_VERSION) {
      return null;
    }
    const ids = (field: string): string[] | null => {
      if (raw[field] === undefined) {
        return [];
      }
      try {
        return toCleanIds(raw[field], field);
      } catch {
        return null;
      }
    };
    const conceptIds = ids('conceptIds');
    const formIds = ids('formIds');
    const frameworkIds = ids('frameworkIds');
    const tacticIds = ids('tacticIds');
    if (conceptIds === null || formIds === null || frameworkIds === null || tacticIds === null) {
      return null;
    }
    const text = (field: string): string | null | undefined => {
      if (raw[field] === undefined || raw[field] === null) {
        return null;
      }
      try {
        return toCleanText(raw[field], field);
      } catch {
        return undefined;
      }
    };
    const debugNotes = text('debugNotes');
    const keyInsight = text('keyInsight');
    const learnerNotes = text('learnerNotes');
    if (debugNotes === undefined || keyInsight === undefined || learnerNotes === undefined) {
      return null;
    }
    const provenance = isRecord(raw.provenance) ? raw.provenance : null;
    if (provenance === null || !isKnownKnowledgeSource(provenance.source)) {
      return null;
    }
    if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
      return null;
    }
    const recordId = problemKnowledgeIdFor(raw.problemId);
    if (typeof raw.recordId === 'string' && raw.recordId !== recordId) {
      return null;
    }
    return {
      recordId,
      problemId: raw.problemId,
      schemaVersion: PROBLEM_KNOWLEDGE_SCHEMA_VERSION,
      conceptIds,
      formIds,
      frameworkIds,
      tacticIds,
      debugNotes,
      keyInsight,
      learnerNotes,
      provenance: { source: provenance.source },
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}
