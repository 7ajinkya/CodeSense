import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import { isKnownEvidenceDimension, isKnownEvidenceType } from '../learner/learnerTypes';
import { identifyLanguage } from '../util/languages';
import {
  isKnownActivityIntent,
  isKnownActivityKind,
  isKnownActivityPurpose,
} from './activityTypes';
import type { ActivityIntent, ActivityKind, ActivityPurpose } from './activityTypes';

/**
 * Phase F2 GenerationRequest: the frozen F2→I contract (additive seam).
 *
 * F2 owns what activity slot should exist next. When no existing catalog
 * activity suits the slot, F2 issues a GenerationRequest describing what
 * must be generated. I transcribes it read-only into a
 * GenerationSpecification (never reinterpreting, retargeting, resequencing,
 * or weakening it). The request is immutable for I and bound to exactly
 * one F2 plan slot via `planId`.
 *
 * Everything here is plain JSON-serializable data with bounded text;
 * validators reject over-long or malformed input so no producer can
 * smuggle essays, invented kinds, or second taxonomies through the seam.
 */

/** Whether the generated activity should feel familiar or novel. */
export type GenerationSurfaceForm = 'familiar' | 'unfamiliar';

export const GENERATION_SURFACE_FORMS: readonly GenerationSurfaceForm[] = ['familiar', 'unfamiliar'];

export function isKnownSurfaceForm(value: unknown): value is GenerationSurfaceForm {
  return value === 'familiar' || value === 'unfamiliar';
}

/** Execution/resource bounds for the future artifact (never a scheduler). */
export interface GenerationRequestConstraints {
  /** Wall-clock limit in milliseconds, when applicable. */
  timeLimitMs?: number;
  /** Memory/resource note, when applicable. */
  memoryNote?: string;
  /** Languages the artifact must support (telemetry-observable subset). */
  languageScope: string[];
}

/** What future evidence the activity should make observable (a wish, never a record). */
export interface GenerationDiscriminatingEvidence {
  /** Frozen D evidence types the activity is intended to route toward. */
  evidenceTypes: EvidenceType[];
  /** The discriminating question the activity should help answer. */
  question: string;
  /** Observable learner behavior the activity should elicit, when known. */
  observableBehavior?: string;
}

/** One artifact-level acceptance predicate (machine-checkable later, prose now). */
export interface RequestAcceptanceCriterion {
  /** Stable kebab-case id for this criterion. */
  criterionId: string;
  /** What must hold of the generated artifact. */
  description: string;
}

/**
 * Why generation was requested. Exactly one origin — learner intent is
 * never disguised as diagnosis and diagnosis is never invented for
 * requests. Provenance only; nothing here is learner evidence.
 */
export type GenerationRequestBasis =
  | { basisKind: 'f2-need'; needId: string }
  | { basisKind: 'learner-requested'; statement: string }
  | { basisKind: 'established-need'; needId: string; summary: string }
  | { basisKind: 'diagnostic'; hypothesisKinds: string[]; basisEvidenceIds: string[] };

/** Generation budget (limits only; never a scheduler or queue). */
export interface GenerationRequestBudget {
  /** Maximum candidate count for this request. */
  maxCandidates: number;
  /** ISO-8601 UTC expiry; requests at/after expiry must be refused. */
  expiresAt?: string;
}

export interface GenerationRequest {
  /** Stable id assigned by F2 (`genreq_…` by convention). */
  requestId: string;
  /** The exactly-one F2 plan slot this request fills. */
  planId: string;
  /** The active F1 goal being served. */
  goalId: string;
  activityKind: ActivityKind;
  intent: ActivityIntent;
  purpose: ActivityPurpose;
  /** Canonical Phase C entity IDs (non-empty, graph-validated at transcription). */
  targetEntityIds: string[];
  /** Frozen Phase D dimensions (non-empty). */
  targetDimensions: EvidenceDimension[];
  surfaceForm: GenerationSurfaceForm;
  /** Transfer demand, when the surface form must differ meaningfully. */
  transferRequirement?: string;
  constraints: GenerationRequestConstraints;
  /** Observable anti-template requirements (never a score). */
  forbiddenShortcuts: string[];
  discriminatingEvidence: GenerationDiscriminatingEvidence;
  /** Non-empty: a spec with nothing to check cannot be validated later. */
  acceptanceCriteria: RequestAcceptanceCriterion[];
  requestBasis: GenerationRequestBasis;
  /** Required when F2 flags same-form repetition concern (preserved verbatim). */
  repetitionJustification?: string;
  /**
   * Optional pointer to the motivating attempt (ID only, never code).
   * Permitted on `debugging-task` (whose broken code lives there);
   * forbidden on `coding-problem` (whose context is its problemId).
   */
  debugContext?: { brokenAttemptId: string };
  budget: GenerationRequestBudget;
  /** ISO-8601 UTC issue timestamp. */
  issuedAt: string;
  provenance: {
    ontologyVersion: string;
    aggregatorVersion: string;
  };
}

/** Bounds keep requests finite; validators reject over-long input. */
export const MAX_REQUEST_TEXT_CHARS = 280;
export const MAX_REQUEST_PROSE_CHARS = 500;
export const MAX_REQUEST_ENTITY_IDS = 12;
export const MAX_REQUEST_CRITERIA = 12;
export const MAX_REQUEST_SHORTCUTS = 12;
export const MAX_REQUEST_EVIDENCE_IDS = 24;
export const MAX_REQUEST_ID_CHARS = 120;
export const MAX_CRITERION_ID_CHARS = 80;
export const MAX_REQUEST_HYPOTHESIS_KINDS = 8;
export const MAX_GENERATION_CANDIDATES = 10;

function isNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isKebab(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

/**
 * Strict validation for generation constraints (shared with Stage 2
 * candidate validation so both layers enforce the identical shape).
 */
export function validateRequestConstraints(raw: unknown): GenerationRequestConstraints | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.timeLimitMs !== undefined) {
    if (typeof record.timeLimitMs !== 'number' || !Number.isInteger(record.timeLimitMs) || record.timeLimitMs <= 0) {
      return null;
    }
  }
  if (record.memoryNote !== undefined && !isNonBlankBounded(record.memoryNote, MAX_REQUEST_TEXT_CHARS)) {
    return null;
  }
  const scope: unknown = record.languageScope;
  if (!isStringArray(scope) || scope.length === 0 || scope.some((lang) => identifyLanguage(lang) === undefined)) {
    return null;
  }
  return {
    ...(typeof record.timeLimitMs === 'number' ? { timeLimitMs: record.timeLimitMs as number } : {}),
    ...(typeof record.memoryNote === 'string' ? { memoryNote: record.memoryNote as string } : {}),
    languageScope: [...(scope as string[])],
  };
}

function validateDiscriminatingEvidence(raw: unknown): GenerationDiscriminatingEvidence | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const types: unknown = record.evidenceTypes;
  if (
    !isStringArray(types) ||
    types.length === 0 ||
    !(types as string[]).every((t) => isKnownEvidenceType(t))
  ) {
    return null;
  }
  if (!isNonBlankBounded(record.question, MAX_REQUEST_PROSE_CHARS)) {
    return null;
  }
  if (record.observableBehavior !== undefined && !isNonBlankBounded(record.observableBehavior, MAX_REQUEST_PROSE_CHARS)) {
    return null;
  }
  return {
    evidenceTypes: [...(types as EvidenceType[])],
    question: record.question as string,
    ...(typeof record.observableBehavior === 'string'
      ? { observableBehavior: record.observableBehavior as string }
      : {}),
  };
}

function validateCriteria(raw: unknown): RequestAcceptanceCriterion[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REQUEST_CRITERIA) {
    return null;
  }
  const seen = new Set<string>();
  const out: RequestAcceptanceCriterion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (!isKebab(record.criterionId, MAX_CRITERION_ID_CHARS)) {
      return null;
    }
    if (!isNonBlankBounded(record.description, MAX_REQUEST_PROSE_CHARS)) {
      return null;
    }
    if (seen.has(record.criterionId as string)) {
      return null;
    }
    seen.add(record.criterionId as string);
    out.push({ criterionId: record.criterionId as string, description: record.description as string });
  }
  return out;
}

function validateBasis(raw: unknown): GenerationRequestBasis | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  switch (record.basisKind) {
    case 'f2-need':
      if (!isNonBlankBounded(record.needId, MAX_REQUEST_ID_CHARS)) {
        return null;
      }
      return { basisKind: 'f2-need', needId: record.needId as string };
    case 'learner-requested':
      if (!isNonBlankBounded(record.statement, MAX_REQUEST_TEXT_CHARS)) {
        return null;
      }
      return { basisKind: 'learner-requested', statement: record.statement as string };
    case 'established-need':
      if (!isNonBlankBounded(record.needId, MAX_REQUEST_ID_CHARS)) {
        return null;
      }
      if (!isNonBlankBounded(record.summary, MAX_REQUEST_TEXT_CHARS)) {
        return null;
      }
      return { basisKind: 'established-need', needId: record.needId as string, summary: record.summary as string };
    case 'diagnostic': {
      const kinds: unknown = record.hypothesisKinds;
      const evidenceIds: unknown = record.basisEvidenceIds;
      if (
        !isStringArray(kinds) ||
        kinds.length === 0 ||
        kinds.length > MAX_REQUEST_HYPOTHESIS_KINDS ||
        kinds.some((k) => !isNonBlankBounded(k, MAX_REQUEST_ID_CHARS))
      ) {
        return null;
      }
      if (
        !isStringArray(evidenceIds) ||
        (evidenceIds as string[]).length > MAX_REQUEST_EVIDENCE_IDS
      ) {
        return null;
      }
      return {
        basisKind: 'diagnostic',
        hypothesisKinds: [...(kinds as string[])],
        basisEvidenceIds: [...(evidenceIds as string[])],
      };
    }
    default:
      return null;
  }
}

function validateBudget(raw: unknown): GenerationRequestBudget | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.maxCandidates !== 'number' ||
    !Number.isInteger(record.maxCandidates) ||
    record.maxCandidates < 1 ||
    record.maxCandidates > MAX_GENERATION_CANDIDATES
  ) {
    return null;
  }
  if (record.expiresAt !== undefined && !isIsoTimestamp(record.expiresAt)) {
    return null;
  }
  return {
    maxCandidates: record.maxCandidates as number,
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt as string } : {}),
  };
}

/**
 * Strict validation for F2 GenerationRequests (store writes and the I
 * transcription seam). Returns the normalized request or null — callers
 * refuse invalid requests loudly, never repair them. Pure function.
 * Graph-dependent checks (canonical entities) happen at transcription,
 * where the live graph is available.
 */
export function validateGenerationRequest(raw: unknown): GenerationRequest | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!isNonBlankBounded(record.requestId, MAX_REQUEST_ID_CHARS)) {
    return null;
  }
  if (!isNonBlankBounded(record.planId, MAX_REQUEST_ID_CHARS)) {
    return null;
  }
  if (!isNonBlankBounded(record.goalId, MAX_REQUEST_ID_CHARS)) {
    return null;
  }
  if (!isKnownActivityKind(record.activityKind)) {
    return null;
  }
  if (!isKnownActivityIntent(record.intent)) {
    return null;
  }
  if (!isKnownActivityPurpose(record.purpose)) {
    return null;
  }
  const entityIds: unknown = record.targetEntityIds;
  if (
    !isStringArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.length > MAX_REQUEST_ENTITY_IDS ||
    (entityIds as string[]).some((id) => id.trim().length === 0)
  ) {
    return null;
  }
  const dimensions: unknown = record.targetDimensions;
  if (
    !isStringArray(dimensions) ||
    dimensions.length === 0 ||
    !(dimensions as string[]).every((d) => isKnownEvidenceDimension(d))
  ) {
    return null;
  }
  if (!isKnownSurfaceForm(record.surfaceForm)) {
    return null;
  }
  if (record.transferRequirement !== undefined && !isNonBlankBounded(record.transferRequirement, MAX_REQUEST_PROSE_CHARS)) {
    return null;
  }
  const constraints = validateRequestConstraints(record.constraints);
  if (constraints === null) {
    return null;
  }
  const shortcuts: unknown = record.forbiddenShortcuts;
  if (
    !Array.isArray(shortcuts) ||
    shortcuts.length > MAX_REQUEST_SHORTCUTS ||
    shortcuts.some((s: unknown) => !isNonBlankBounded(s, MAX_REQUEST_TEXT_CHARS))
  ) {
    return null;
  }
  const discriminatingEvidence = validateDiscriminatingEvidence(record.discriminatingEvidence);
  if (discriminatingEvidence === null) {
    return null;
  }
  const acceptanceCriteria = validateCriteria(record.acceptanceCriteria);
  if (acceptanceCriteria === null) {
    return null;
  }
  const requestBasis = validateBasis(record.requestBasis);
  if (requestBasis === null) {
    return null;
  }
  if (record.repetitionJustification !== undefined && !isNonBlankBounded(record.repetitionJustification, MAX_REQUEST_PROSE_CHARS)) {
    return null;
  }
  // Exclusivity: only debugging tasks may point at a motivating attempt;
  // a coding problem's context is its problemId (no second pointer).
  if (record.activityKind === 'debugging-task') {
    const context: unknown = record.debugContext;
    if (context !== undefined) {
      if (typeof context !== 'object' || context === null) {
        return null;
      }
      const brokenAttemptId: unknown = (context as Record<string, unknown>).brokenAttemptId;
      if (!isNonBlankBounded(brokenAttemptId, MAX_REQUEST_ID_CHARS)) {
        return null;
      }
    }
  } else if (record.debugContext !== undefined) {
    return null;
  }
  const budget = validateBudget(record.budget);
  if (budget === null) {
    return null;
  }
  if (!isIsoTimestamp(record.issuedAt)) {
    return null;
  }
  const provenance: unknown = record.provenance;
  if (
    typeof provenance !== 'object' ||
    provenance === null ||
    !isNonBlankBounded((provenance as Record<string, unknown>).ontologyVersion, MAX_REQUEST_ID_CHARS) ||
    !isNonBlankBounded((provenance as Record<string, unknown>).aggregatorVersion, MAX_REQUEST_ID_CHARS)
  ) {
    return null;
  }
  const provenanceRecord = provenance as Record<string, unknown>;
  return {
    requestId: record.requestId as string,
    planId: record.planId as string,
    goalId: record.goalId as string,
    activityKind: record.activityKind as ActivityKind,
    intent: record.intent as ActivityIntent,
    purpose: record.purpose as ActivityPurpose,
    targetEntityIds: [...(entityIds as string[])],
    targetDimensions: [...(dimensions as EvidenceDimension[])],
    surfaceForm: record.surfaceForm as GenerationSurfaceForm,
    ...(typeof record.transferRequirement === 'string'
      ? { transferRequirement: record.transferRequirement as string }
      : {}),
    constraints,
    forbiddenShortcuts: [...(shortcuts as string[])],
    discriminatingEvidence,
    acceptanceCriteria,
    requestBasis,
    ...(typeof record.repetitionJustification === 'string'
      ? { repetitionJustification: record.repetitionJustification as string }
      : {}),
    ...(record.activityKind === 'debugging-task' && record.debugContext !== undefined
      ? {
          debugContext: {
            brokenAttemptId: (record.debugContext as Record<string, unknown>).brokenAttemptId as string,
          },
        }
      : {}),
    budget,
    issuedAt: record.issuedAt as string,
    provenance: {
      ontologyVersion: provenanceRecord.ontologyVersion as string,
      aggregatorVersion: provenanceRecord.aggregatorVersion as string,
    },
  };
}
