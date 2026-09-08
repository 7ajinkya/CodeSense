import {
  ClassificationConfidence,
  ClassificationSource,
  CurriculumMappingStatus,
  KnowledgeEntityType,
  isKnownClassificationConfidence,
  isKnownClassificationSource,
  isKnownCurriculumMappingStatus,
} from './ontologyTypes';
import type { KnowledgeGraph } from './ontologyStore';
import type { Problem } from '../problems/problem';

/**
 * Phase C problem classification: Problem → knowledge requirements.
 *
 * FUNDAMENTAL BOUNDARY (machine-enforced in `validateClassificationPayload`):
 * classification answers "what knowledge does this problem exercise?".
 * It NEVER answers "how good is the learner at it" — no mastery, no
 * proficiency, no strengths/weaknesses, no learner-tactic usage, no
 * debugging-behavior claims. Those need attempt evidence and belong to
 * Phase D. Payloads carrying learner-model keys are REJECTED, not stored.
 *
 * Provenance/versioning: every record stamps the ontology version, the
 * classifier version, the producer, and the timestamp, so a problem
 * classified today keeps its semantics after the ontology evolves, and
 * future reclassification is explicit rather than silent overwriting.
 */

export const CLASSIFIER_VERSION = '1';

/** One canonical-entity claim with its own uncertainty preserved. */
export interface ClassifiedEntityRef {
  /** Stable ontology entity ID (never a display name). */
  entityId: string;
  confidence: ClassificationConfidence;
}

/** A curriculum-module claim for one problem (source hierarchy preserved). */
export interface ClassifiedCurriculumMapping {
  source: string;
  sourceCategory: string | null;
  sourceItem: string;
  /** Null exactly when status is `unknown` (unrecognized terminology). */
  entityId: string | null;
  status: CurriculumMappingStatus;
  confidence: ClassificationConfidence | null;
}

export interface ClassificationProvenance {
  source: ClassificationSource;
  classifierVersion: string;
  ontologyVersion: string;
  /** ISO-8601 UTC timestamp of classification. */
  classifiedAt: string;
  /** The problem URL the classification was derived from (reference only). */
  problemSourceUrl: string;
}

export interface ProblemClassification {
  problemId: string;
  ontologyVersion: string;
  classifierVersion: string;
  /** ISO-8601 UTC timestamp of classification. */
  classifiedAt: string;
  topics: ClassifiedEntityRef[];
  concepts: ClassifiedEntityRef[];
  frameworks: ClassifiedEntityRef[];
  forms: ClassifiedEntityRef[];
  patterns: ClassifiedEntityRef[];
  variants: ClassifiedEntityRef[];
  tactics: ClassifiedEntityRef[];
  prerequisites: ClassifiedEntityRef[];
  solutionFamilies: ClassifiedEntityRef[];
  curriculumMappings: ClassifiedCurriculumMapping[];
  /** Overall classification confidence (uncertainty preserved, not rounded). */
  confidence: ClassificationConfidence;
  provenance: ClassificationProvenance;
}

/**
 * Lifecycle state of a problem's knowledge (supporting infra, never a
 * prerequisite for coding — unclassified problems stay fully usable):
 * - `unclassified`: no classification record exists.
 * - `partial`: a record exists but overall confidence is low or no
 *   knowledge entity could be attached at all.
 * - `classified`: a record with usable entity claims exists.
 */
export type ClassificationStatus = 'unclassified' | 'partial' | 'classified';

const CLASSIFICATION_ENTITY_BUCKETS = [
  'topics',
  'concepts',
  'frameworks',
  'forms',
  'patterns',
  'variants',
  'tactics',
  'prerequisites',
  'solutionFamilies',
] as const;

export type ClassificationEntityBucket = (typeof CLASSIFICATION_ENTITY_BUCKETS)[number];

/**
 * Which entity types each classification bucket accepts. Tactics accept
 * `capability` IDs too, because relevant implementation capabilities
 * (e.g. queue APIs) are problem knowledge — while WHO used them and HOW
 * WELL remains Phase D evidence and never appears here.
 */
const BUCKET_ALLOWED_TYPES: Record<ClassificationEntityBucket, readonly KnowledgeEntityType[]> = {
  topics: ['topic'],
  concepts: ['concept'],
  frameworks: ['framework'],
  forms: ['form'],
  patterns: ['pattern'],
  variants: ['variant'],
  tactics: ['tactic', 'capability'],
  prerequisites: ['topic', 'concept', 'framework', 'form', 'pattern', 'variant', 'tactic', 'capability'],
  solutionFamilies: ['framework', 'concept', 'form', 'pattern'],
};

/** Bounds keep persisted records and prompts finite no matter the model. */
export const MAX_REFS_PER_BUCKET = 24;
export const MAX_CURRICULUM_MAPPINGS = 24;

/**
 * Learner-model keys that must NEVER appear in a classification payload.
 * Phase D owns these concepts; their presence here means the model
 * confused "what this problem exercises" with "how good the learner is",
 * and the payload is rejected rather than persisted.
 */
export const FORBIDDEN_CLASSIFICATION_KEYS: readonly string[] = [
  'mastery',
  'proficiency',
  'proficiencyScore',
  'weakness',
  'weaknesses',
  'strength',
  'strengths',
  'learnerModel',
  'learnerLevel',
  'learnerState',
  'learnerTactics',
  'learnerKnowledge',
  'debuggingBehavior',
  'usedTactics',
  'misconceptions',
  'adaptiveGoals',
  'personalizedPractice',
];

export function getClassificationStatus(
  classification: ProblemClassification | null | undefined,
): ClassificationStatus {
  if (!classification) {
    return 'unclassified';
  }
  if (classification.confidence === 'low') {
    return 'partial';
  }
  const claimed = CLASSIFICATION_ENTITY_BUCKETS.reduce(
    (count, bucket) => count + classification[bucket].length,
    0,
  );
  return claimed > 0 ? 'classified' : 'partial';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The model's knowledge claims BEFORE version/provenance stamping. */
export interface ClassificationPayload {
  topics: ClassifiedEntityRef[];
  concepts: ClassifiedEntityRef[];
  frameworks: ClassifiedEntityRef[];
  forms: ClassifiedEntityRef[];
  patterns: ClassifiedEntityRef[];
  variants: ClassifiedEntityRef[];
  tactics: ClassifiedEntityRef[];
  prerequisites: ClassifiedEntityRef[];
  solutionFamilies: ClassifiedEntityRef[];
  curriculumMappings: ClassifiedCurriculumMapping[];
  confidence: ClassificationConfidence;
}

function parseEntityRef(
  raw: unknown,
  bucket: ClassificationEntityBucket,
  graph: KnowledgeGraph,
): { ok: true; value: ClassifiedEntityRef } | { ok: false; reason: string; invalidEntity?: boolean } {
  if (!isRecord(raw)) {
    return { ok: false, reason: `bucket "${bucket}" entries must be objects` };
  }
  if (!isNonBlankString(raw.entityId)) {
    return { ok: false, reason: `bucket "${bucket}" entries need a non-blank entityId` };
  }
  if (!isKnownClassificationConfidence(raw.confidence)) {
    return { ok: false, reason: `bucket "${bucket}" entry "${String(raw.entityId)}" has invalid confidence` };
  }
  const entity = graph.getEntity(raw.entityId);
  if (!entity) {
    // Unknown entity IDs must never become canonical data.
    return { ok: false, reason: `unknown entity "${raw.entityId}"`, invalidEntity: true };
  }
  const allowed = BUCKET_ALLOWED_TYPES[bucket];
  if (!allowed.includes(entity.type)) {
    return {
      ok: false,
      reason: `entity "${raw.entityId}" is a ${entity.type}, not valid for bucket "${bucket}"`,
    };
  }
  return { ok: true, value: { entityId: raw.entityId, confidence: raw.confidence } };
}

function parseCurriculumMapping(
  raw: unknown,
  graph: KnowledgeGraph,
): { ok: true; value: ClassifiedCurriculumMapping } | { ok: false; reason: string; invalidEntity?: boolean } {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'curriculumMappings entries must be objects' };
  }
  if (!isNonBlankString(raw.source) || !isNonBlankString(raw.sourceItem)) {
    return { ok: false, reason: 'curriculumMappings entries need a source and sourceItem' };
  }
  if (raw.sourceCategory !== null && raw.sourceCategory !== undefined && typeof raw.sourceCategory !== 'string') {
    return { ok: false, reason: 'curriculumMappings sourceCategory must be a string or null' };
  }
  if (!isKnownCurriculumMappingStatus(raw.status)) {
    return { ok: false, reason: 'curriculumMappings entries need status mapped|unknown' };
  }
  if (raw.confidence !== null && raw.confidence !== undefined && !isKnownClassificationConfidence(raw.confidence)) {
    return { ok: false, reason: 'curriculumMappings entries need confidence high|medium|low|null' };
  }
  if (raw.status === 'mapped') {
    if (!isNonBlankString(raw.entityId) || !graph.hasEntity(raw.entityId)) {
      return { ok: false, reason: 'mapped curriculum entries need a known entityId', invalidEntity: true };
    }
    return {
      ok: true,
      value: {
        source: raw.source,
        sourceCategory: typeof raw.sourceCategory === 'string' ? raw.sourceCategory : null,
        sourceItem: raw.sourceItem,
        entityId: raw.entityId,
        status: 'mapped',
        confidence: isKnownClassificationConfidence(raw.confidence) ? raw.confidence : null,
      },
    };
  }
  if (raw.entityId !== null && raw.entityId !== undefined) {
    return { ok: false, reason: 'unknown curriculum entries must carry entityId null (no invented meaning)' };
  }
  return {
    ok: true,
    value: {
      source: raw.source,
      sourceCategory: typeof raw.sourceCategory === 'string' ? raw.sourceCategory : null,
      sourceItem: raw.sourceItem,
      entityId: null,
      status: 'unknown',
      confidence: isKnownClassificationConfidence(raw.confidence) ? raw.confidence : null,
    },
  };
}

export type ClassificationValidation =
  | { ok: true; value: ClassificationPayload }
  | { ok: false; reason: 'malformed-response' | 'invalid-entity'; detail: string };

/**
 * Strict validation of a raw classification payload (model output or any
 * untrusted producer). Returns the normalized payload — versions and
 * provenance are stamped later by `finalizeClassification`, never trusted
 * from the producer. Rejects:
 * - non-objects, unknown overall confidence, malformed buckets/entries
 * - unknown entity IDs or IDs of the wrong type for their bucket
 * - duplicate entityIds within one bucket
 * - malformed provenance-shaped or curriculum-mapping claims
 * - ANY learner-model key (Phase D separation — rejected, never stored)
 */
export function validateClassificationPayload(
  raw: unknown,
  opts: { graph: KnowledgeGraph },
): ClassificationValidation {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'malformed-response', detail: 'classification must be a JSON object' };
  }
  for (const forbidden of FORBIDDEN_CLASSIFICATION_KEYS) {
    if (raw[forbidden] !== undefined) {
      return {
        ok: false,
        reason: 'malformed-response',
        detail:
          `classification must not contain learner-model key "${forbidden}": ` +
          'problem knowledge (Phase C) is separate from learner state (Phase D)',
      };
    }
  }
  if (!isKnownClassificationConfidence(raw.confidence)) {
    return { ok: false, reason: 'malformed-response', detail: 'classification needs overall confidence high|medium|low' };
  }
  const payload: ClassificationPayload = {
    topics: [],
    concepts: [],
    frameworks: [],
    forms: [],
    patterns: [],
    variants: [],
    tactics: [],
    prerequisites: [],
    solutionFamilies: [],
    curriculumMappings: [],
    confidence: raw.confidence,
  };
  for (const bucket of CLASSIFICATION_ENTITY_BUCKETS) {
    const entries = raw[bucket] === undefined ? [] : raw[bucket];
    if (!Array.isArray(entries)) {
      return { ok: false, reason: 'malformed-response', detail: `bucket "${bucket}" must be an array` };
    }
    if (entries.length > MAX_REFS_PER_BUCKET) {
      return { ok: false, reason: 'malformed-response', detail: `bucket "${bucket}" exceeds ${MAX_REFS_PER_BUCKET} entries` };
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = parseEntityRef(entry, bucket, opts.graph);
      if (!parsed.ok) {
        return {
          ok: false,
          reason: parsed.invalidEntity === true ? 'invalid-entity' : 'malformed-response',
          detail: parsed.reason,
        };
      }
      if (seen.has(parsed.value.entityId)) {
        return {
          ok: false,
          reason: 'malformed-response',
          detail: `bucket "${bucket}" lists "${parsed.value.entityId}" twice`,
        };
      }
      seen.add(parsed.value.entityId);
      payload[bucket].push(parsed.value);
    }
  }
  const mappings = raw.curriculumMappings === undefined ? [] : raw.curriculumMappings;
  if (!Array.isArray(mappings)) {
    return { ok: false, reason: 'malformed-response', detail: 'curriculumMappings must be an array' };
  }
  if (mappings.length > MAX_CURRICULUM_MAPPINGS) {
    return { ok: false, reason: 'malformed-response', detail: `curriculumMappings exceeds ${MAX_CURRICULUM_MAPPINGS} entries` };
  }
  for (const entry of mappings) {
    const parsed = parseCurriculumMapping(entry, opts.graph);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.invalidEntity === true ? 'invalid-entity' : 'malformed-response',
        detail: parsed.reason,
      };
    }
    payload.curriculumMappings.push(parsed.value);
  }
  return { ok: true, value: payload };
}

/**
 * Stamp versions + provenance onto a validated payload. The caller supplies
 * every stamped field — producers never self-declare versions or timestamps.
 */
export function finalizeClassification(
  payload: ClassificationPayload,
  stamped: {
    problemId: string;
    ontologyVersion: string;
    classifierVersion: string;
    classifiedAt: string;
    problemSourceUrl: string;
    source: ClassificationSource;
  },
): ProblemClassification {
  return {
    problemId: stamped.problemId,
    ontologyVersion: stamped.ontologyVersion,
    classifierVersion: stamped.classifierVersion,
    classifiedAt: stamped.classifiedAt,
    topics: [...payload.topics],
    concepts: [...payload.concepts],
    frameworks: [...payload.frameworks],
    forms: [...payload.forms],
    patterns: [...payload.patterns],
    variants: [...payload.variants],
    tactics: [...payload.tactics],
    prerequisites: [...payload.prerequisites],
    solutionFamilies: [...payload.solutionFamilies],
    curriculumMappings: payload.curriculumMappings.map((m) => ({ ...m })),
    confidence: payload.confidence,
    provenance: {
      source: stamped.source,
      classifierVersion: stamped.classifierVersion,
      ontologyVersion: stamped.ontologyVersion,
      classifiedAt: stamped.classifiedAt,
      problemSourceUrl: stamped.problemSourceUrl,
    },
  };
}

/**
 * Lenient structural parse for STORAGE reads. Deliberately version- and
 * graph-agnostic: historical records keep their semantics (and their
 * possibly-evolved entity IDs) instead of failing to load after an
 * ontology update. Returns null for anything not structurally sound —
 * loading must never crash on old or hand-edited data.
 */
export function parseProblemClassification(raw: unknown): ProblemClassification | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isNonBlankString(raw.problemId) ||
    !isNonBlankString(raw.ontologyVersion) ||
    !isNonBlankString(raw.classifierVersion) ||
    !isNonBlankString(raw.classifiedAt) ||
    !isKnownClassificationConfidence(raw.confidence)
  ) {
    return null;
  }
  const refs = (value: unknown): ClassifiedEntityRef[] | null => {
    if (!Array.isArray(value)) {
      return null;
    }
    const out: ClassifiedEntityRef[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || !isNonBlankString(entry.entityId)) {
        return null;
      }
      out.push({
        entityId: entry.entityId,
        confidence: isKnownClassificationConfidence(entry.confidence) ? entry.confidence : 'low',
      });
    }
    return out;
  };
  const buckets: Record<ClassificationEntityBucket, ClassifiedEntityRef[] | null> = {
    topics: refs(raw.topics),
    concepts: refs(raw.concepts),
    frameworks: refs(raw.frameworks),
    forms: refs(raw.forms),
    patterns: refs(raw.patterns),
    variants: refs(raw.variants),
    tactics: refs(raw.tactics),
    prerequisites: refs(raw.prerequisites),
    solutionFamilies: refs(raw.solutionFamilies),
  };
  for (const bucket of CLASSIFICATION_ENTITY_BUCKETS) {
    if (buckets[bucket] === null) {
      return null;
    }
  }
  const mappingsRaw = raw.curriculumMappings;
  if (!Array.isArray(mappingsRaw)) {
    return null;
  }
  const curriculumMappings: ClassifiedCurriculumMapping[] = [];
  for (const entry of mappingsRaw) {
    if (!isRecord(entry) || !isNonBlankString(entry.source) || !isNonBlankString(entry.sourceItem)) {
      return null;
    }
    if (!isKnownCurriculumMappingStatus(entry.status)) {
      return null;
    }
    curriculumMappings.push({
      source: entry.source,
      sourceCategory: typeof entry.sourceCategory === 'string' ? entry.sourceCategory : null,
      sourceItem: entry.sourceItem,
      entityId: typeof entry.entityId === 'string' ? entry.entityId : null,
      status: entry.status,
      confidence: isKnownClassificationConfidence(entry.confidence) ? entry.confidence : null,
    });
  }
  const provenance = raw.provenance;
  if (
    !isRecord(provenance) ||
    !isKnownClassificationSource(provenance.source) ||
    !isNonBlankString(provenance.problemSourceUrl)
  ) {
    return null;
  }
  return {
    problemId: raw.problemId,
    ontologyVersion: raw.ontologyVersion,
    classifierVersion: raw.classifierVersion,
    classifiedAt: raw.classifiedAt,
    topics: buckets.topics as ClassifiedEntityRef[],
    concepts: buckets.concepts as ClassifiedEntityRef[],
    frameworks: buckets.frameworks as ClassifiedEntityRef[],
    forms: buckets.forms as ClassifiedEntityRef[],
    patterns: buckets.patterns as ClassifiedEntityRef[],
    variants: buckets.variants as ClassifiedEntityRef[],
    tactics: buckets.tactics as ClassifiedEntityRef[],
    prerequisites: buckets.prerequisites as ClassifiedEntityRef[],
    solutionFamilies: buckets.solutionFamilies as ClassifiedEntityRef[],
    curriculumMappings,
    confidence: raw.confidence,
    provenance: {
      source: provenance.source,
      classifierVersion: typeof provenance.classifierVersion === 'string' ? provenance.classifierVersion : raw.classifierVersion,
      ontologyVersion: typeof provenance.ontologyVersion === 'string' ? provenance.ontologyVersion : raw.ontologyVersion,
      classifiedAt: typeof provenance.classifiedAt === 'string' ? provenance.classifiedAt : raw.classifiedAt,
      problemSourceUrl: provenance.problemSourceUrl,
    },
  };
}

/**
 * Pure attach helper: returns a NEW Problem carrying this classification.
 * The problemId must match (mixed records are a corruption risk, so this
 * throws). Unrelated problem data is never touched — verified by tests via
 * deep comparison of every other field.
 */
export function attachClassificationToProblem(
  problem: Problem,
  classification: ProblemClassification,
): Problem {
  if (classification.problemId !== problem.problemId) {
    throw new Error(
      `Cannot attach classification for ${classification.problemId} to problem ${problem.problemId}.`,
    );
  }
  return { ...problem, classification };
}

export interface ResolvedEntityRef {
  ref: ClassifiedEntityRef;
  /** Null when the ID no longer resolves (ontology evolved past the record). */
  entity: { id: string; type: KnowledgeEntityType; name: string } | null;
}

export interface ResolvedProblemKnowledge {
  problemId: string;
  status: ClassificationStatus;
  topics: ResolvedEntityRef[];
  concepts: ResolvedEntityRef[];
  frameworks: ResolvedEntityRef[];
  forms: ResolvedEntityRef[];
  patterns: ResolvedEntityRef[];
  variants: ResolvedEntityRef[];
  tactics: ResolvedEntityRef[];
  prerequisites: ResolvedEntityRef[];
  solutionFamilies: ResolvedEntityRef[];
  /** Entity IDs in the record that no longer resolve against this graph. */
  unresolvedEntityIds: string[];
}

/**
 * Retrieval helper answering "what knowledge entities are associated with
 * this problem?" — resolves every bucket against the graph and reports
 * dangling IDs explicitly instead of dropping them silently.
 */
export function resolveProblemKnowledge(
  graph: KnowledgeGraph,
  classification: ProblemClassification | null | undefined,
): ResolvedProblemKnowledge | null {
  if (!classification) {
    return null;
  }
  const unresolved = new Set<string>();
  const resolveBucket = (refs: ClassifiedEntityRef[]): ResolvedEntityRef[] =>
    refs.map((ref) => {
      const entity = graph.getEntity(ref.entityId);
      if (!entity) {
        unresolved.add(ref.entityId);
        return { ref, entity: null };
      }
      return { ref, entity: { id: entity.id, type: entity.type, name: entity.name } };
    });
  return {
    problemId: classification.problemId,
    status: getClassificationStatus(classification),
    topics: resolveBucket(classification.topics),
    concepts: resolveBucket(classification.concepts),
    frameworks: resolveBucket(classification.frameworks),
    forms: resolveBucket(classification.forms),
    patterns: resolveBucket(classification.patterns),
    variants: resolveBucket(classification.variants),
    tactics: resolveBucket(classification.tactics),
    prerequisites: resolveBucket(classification.prerequisites),
    solutionFamilies: resolveBucket(classification.solutionFamilies),
    unresolvedEntityIds: [...unresolved].sort(),
  };
}
