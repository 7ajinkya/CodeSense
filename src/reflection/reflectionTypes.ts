import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import {
  EvidenceConfidence,
  EvidenceDimension,
  EvidenceType,
  isKnownEvidenceConfidence,
  isKnownEvidenceDimension,
} from '../learner/learnerTypes';
import { isRecord } from '../persistence/storeFiles';

/**
 * Phase G structured reflection: explicit learner-owned input about a
 * completed attempt.
 *
 * A reflection answers ONLY: "What did the learner explicitly report after
 * this attempt?" It never answers mastery, never diagnoses, never plans.
 * Raw learner input (category + optional free text) is always preserved,
 * even when no validated interpretation or evidence follows.
 *
 * Separation of concerns (guardrail):
 * - AI/telemetry observation lives in attempts/evaluations/checkpoints.
 * - Explicit learner reflection lives HERE.
 * - Validated learner evidence lives in Phase D (`LearnerEvidence`,
 *   source `human-curated`). G maps into D through D's own validators;
 *   D never imports reflection concepts.
 */

export const REFLECTION_SCHEMA_VERSION = 1;
export const REFLECTION_ID_PREFIX = 'refl_';

export const MAX_REFLECTION_TEXT_CHARS = 500;
export const MAX_REFLECTION_ENTITY_IDS = 12;
export const MAX_REFLECTION_MISTAKE_CATEGORY_CHARS = 80;

/** Small fixed learner-facing taxonomy. NOT a second C taxonomy. */
export type ReflectionCategory =
  | 'knew-idea-struggled-implement'
  | 'did-not-recognize-pattern'
  | 'understood-after-hint'
  | 'debugging-mistake'
  | 'unsure-why-worked'
  | 'other';

export const REFLECTION_CATEGORIES: readonly ReflectionCategory[] = [
  'knew-idea-struggled-implement',
  'did-not-recognize-pattern',
  'understood-after-hint',
  'debugging-mistake',
  'unsure-why-worked',
  'other',
];

export function isKnownReflectionCategory(value: unknown): value is ReflectionCategory {
  return typeof value === 'string' && (REFLECTION_CATEGORIES as readonly string[]).includes(value);
}

/** Learner-facing labels (UI only; keys are the stable categories above). */
export const REFLECTION_CATEGORY_LABELS: Record<ReflectionCategory, string> = {
  'knew-idea-struggled-implement': 'I knew the idea but struggled to implement it',
  'did-not-recognize-pattern': "I didn't recognize the pattern",
  'understood-after-hint': 'I understood it after a hint',
  'debugging-mistake': 'I was debugging an implementation mistake',
  'unsure-why-worked': "I wasn't sure why the approach worked",
  other: 'Something else',
};

export type ReflectionStatus = 'offered' | 'responded' | 'dismissed' | 'evidence-emitted';

export const REFLECTION_STATUSES: readonly ReflectionStatus[] = [
  'offered',
  'responded',
  'dismissed',
  'evidence-emitted',
];

export function isKnownReflectionStatus(value: unknown): value is ReflectionStatus {
  return typeof value === 'string' && (REFLECTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Evidence types G may deterministically map into. Closed set: no new
 * `EvidenceType` is introduced by reflection. RECOGNITION is reserved for
 * future confirmed "I recognized it" interpretations; today the
 * deterministic path uses the other three.
 */
export const REFLECTION_EMITTABLE_EVIDENCE_TYPES: readonly EvidenceType[] = [
  'RECOGNITION',
  'CONCEPTUAL_SUCCESS',
  'CONCEPTUAL_CONFUSION',
  'RECURRING_MISTAKE',
];

export function isEmittableReflectionEvidenceType(value: unknown): value is EvidenceType {
  return (
    typeof value === 'string' &&
    (REFLECTION_EMITTABLE_EVIDENCE_TYPES as readonly string[]).includes(value)
  );
}

/** Validated structured reading of explicit learner input (not AI output). */
export interface ReflectionInterpretation {
  entityIds: string[];
  dimension: EvidenceDimension;
  evidenceType: EvidenceType;
  mistakeCategory?: string;
  confidence: EvidenceConfidence;
  /** True when any AI proposal contributed; requires learnerConfirmed. */
  aiAssisted: boolean;
  /** True only when the learner explicitly confirmed the interpretation. */
  learnerConfirmed: boolean;
}

export interface ReflectionProvenance {
  sessionId: string | null;
  /** Exact finalized attempt (mandatory; captured at offer time). */
  attemptId: string;
  /** Exact problem (mandatory; captured at offer time). */
  problemId: string;
  /** Display snapshot only — never used as a join key. */
  problemTitle: string | null;
  classificationStatus: 'classified' | 'partial' | 'unclassified';
  /** Context snapshots only (display/relevance, never authority). */
  goalId: string | null;
  planId: string | null;
  progressSignal: string | null;
  source: 'explicit-learner-reflection';
  offeredAt: string;
  respondedAt: string | null;
}

export interface LearnerReflection {
  reflectionId: string;
  schemaVersion: number;
  status: ReflectionStatus;
  /** Null until the learner responds. */
  category: ReflectionCategory | null;
  /** Optional learner free text (truncated, never inferred). */
  freeText: string | null;
  /** Null until deterministically validated. */
  interpretation: ReflectionInterpretation | null;
  /** D evidenceIds emitted from this reflection (empty until emitted). */
  evidenceIds: string[];
  provenance: ReflectionProvenance;
  createdAt: string;
  updatedAt: string;
}

/** Deterministic id: exactly one reflection row per attempt by construction. */
export function reflectionIdForAttempt(attemptId: string): string {
  return `${REFLECTION_ID_PREFIX}${attemptId}`;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidMistakeCategory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REFLECTION_MISTAKE_CATEGORY_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function truncateReflectionText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_REFLECTION_TEXT_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_REFLECTION_TEXT_CHARS - 1).trimEnd() + '…';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

// ---------------------------------------------------------------------------
// Pure lifecycle constructors (throw on invalid transitions, like F1/F2).
// ---------------------------------------------------------------------------

export interface ReflectionOfferArgs {
  attemptId: string;
  problemId: string;
  sessionId: string | null;
  problemTitle: string | null;
  classificationStatus: 'classified' | 'partial' | 'unclassified';
  goalId?: string | null;
  planId?: string | null;
  progressSignal?: string | null;
  now: string;
}

export function createReflectionOffer(args: ReflectionOfferArgs): LearnerReflection {
  if (!isNonBlankString(args.attemptId)) {
    throw new Error('Cannot create a reflection offer without an attemptId.');
  }
  if (!isNonBlankString(args.problemId)) {
    throw new Error('Cannot create a reflection offer without a problemId.');
  }
  if (!isNonBlankString(args.now)) {
    throw new Error('Cannot create a reflection offer without a timestamp.');
  }
  const reflectionId = reflectionIdForAttempt(args.attemptId);
  return {
    reflectionId,
    schemaVersion: REFLECTION_SCHEMA_VERSION,
    status: 'offered',
    category: null,
    freeText: null,
    interpretation: null,
    evidenceIds: [],
    provenance: {
      sessionId: args.sessionId ?? null,
      attemptId: args.attemptId,
      problemId: args.problemId,
      problemTitle: args.problemTitle ?? null,
      classificationStatus: args.classificationStatus,
      goalId: args.goalId ?? null,
      planId: args.planId ?? null,
      progressSignal: args.progressSignal ?? null,
      source: 'explicit-learner-reflection',
      offeredAt: args.now,
      respondedAt: null,
    },
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** offered -> responded. Preserves explicit input verbatim (truncated). */
export function respondToReflection(
  reflection: LearnerReflection,
  args: { category: ReflectionCategory; freeText?: string | null; now: string },
): LearnerReflection {
  if (reflection.status !== 'offered') {
    throw new Error(`Cannot respond to a reflection in status "${reflection.status}".`);
  }
  if (!isKnownReflectionCategory(args.category)) {
    throw new Error('Cannot record a reflection response with an unknown category.');
  }
  if (!isNonBlankString(args.now)) {
    throw new Error('Cannot record a reflection response without a timestamp.');
  }
  const rawText = typeof args.freeText === 'string' ? args.freeText.trim() : '';
  return {
    ...reflection,
    status: 'responded',
    category: args.category,
    freeText: rawText.length > 0 ? truncateReflectionText(rawText) : null,
    provenance: { ...reflection.provenance, respondedAt: args.now },
    updatedAt: args.now,
  };
}

/** offered -> dismissed. Dismissal is terminal and distinguishable. */
export function dismissReflection(reflection: LearnerReflection, now: string): LearnerReflection {
  if (reflection.status !== 'offered') {
    throw new Error(`Cannot dismiss a reflection in status "${reflection.status}".`);
  }
  if (!isNonBlankString(now)) {
    throw new Error('Cannot dismiss a reflection without a timestamp.');
  }
  return { ...reflection, status: 'dismissed', updatedAt: now };
}

/** responded -> evidence-emitted. Evidence ids may be empty (nothing valid to emit). */
export function markReflectionEmitted(
  reflection: LearnerReflection,
  args: { evidenceIds: string[]; interpretation: ReflectionInterpretation | null; now: string },
): LearnerReflection {
  if (reflection.status !== 'responded') {
    throw new Error(`Cannot emit evidence for a reflection in status "${reflection.status}".`);
  }
  if (!isNonBlankString(args.now)) {
    throw new Error('Cannot mark a reflection emitted without a timestamp.');
  }
  return {
    ...reflection,
    status: 'evidence-emitted',
    interpretation: args.interpretation,
    evidenceIds: [...args.evidenceIds],
    updatedAt: args.now,
  };
}

// ---------------------------------------------------------------------------
// Interpretation validation (deterministic gate; AI proposals end here).
// ---------------------------------------------------------------------------

/**
 * Strict validation for a structured interpretation of explicit learner
 * input. Graph-checked: every entity must be canonical. Confidence capped
 * at medium. AI-assisted interpretations require explicit learner
 * confirmation, otherwise they are rejected (never silently applied).
 */
export function validateReflectionInterpretation(
  raw: unknown,
  opts: { graph: KnowledgeGraph },
): ReflectionInterpretation | null {
  if (!isRecord(raw)) {
    return null;
  }
  const entityIds: unknown = raw.entityIds;
  if (
    !Array.isArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.length > MAX_REFLECTION_ENTITY_IDS ||
    entityIds.some((e: unknown) => typeof e !== 'string' || (e as string).trim().length === 0)
  ) {
    return null;
  }
  for (const id of entityIds as string[]) {
    if (!opts.graph.hasEntity(id)) {
      return null;
    }
  }
  if (!isKnownEvidenceDimension(raw.dimension) || raw.dimension === 'exposure') {
    return null;
  }
  if (!isEmittableReflectionEvidenceType(raw.evidenceType)) {
    return null;
  }
  // Confidence is interpretation-confidence, capped: reflection never claims high.
  if (!isKnownEvidenceConfidence(raw.confidence) || raw.confidence === 'high') {
    return null;
  }
  const mistakeCategory: unknown = raw.mistakeCategory;
  if (raw.evidenceType === 'RECURRING_MISTAKE') {
    if (!isValidMistakeCategory(mistakeCategory)) {
      return null;
    }
  } else if (mistakeCategory !== undefined) {
    return null;
  }
  if (typeof raw.aiAssisted !== 'boolean' || typeof raw.learnerConfirmed !== 'boolean') {
    return null;
  }
  if (raw.aiAssisted && !raw.learnerConfirmed) {
    return null;
  }
  return {
    entityIds: [...(entityIds as string[])],
    dimension: raw.dimension,
    evidenceType: raw.evidenceType,
    ...(typeof mistakeCategory === 'string' && isValidMistakeCategory(mistakeCategory)
      ? { mistakeCategory }
      : {}),
    confidence: raw.confidence,
    aiAssisted: raw.aiAssisted,
    learnerConfirmed: raw.learnerConfirmed,
  };
}

// ---------------------------------------------------------------------------
// Lenient storage parse (graph-agnostic; bad rows drop, never throw).
// ---------------------------------------------------------------------------

function parseInterpretationLenient(raw: unknown): ReflectionInterpretation | null {
  if (raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isStringArray(raw.entityIds) ||
    raw.entityIds.length === 0 ||
    !isKnownEvidenceDimension(raw.dimension) ||
    typeof raw.evidenceType !== 'string' ||
    !isKnownEvidenceConfidence(raw.confidence) ||
    typeof raw.aiAssisted !== 'boolean' ||
    typeof raw.learnerConfirmed !== 'boolean'
  ) {
    return null;
  }
  const out: ReflectionInterpretation = {
    entityIds: [...raw.entityIds],
    dimension: raw.dimension,
    evidenceType: raw.evidenceType as EvidenceType,
    confidence: raw.confidence,
    aiAssisted: raw.aiAssisted,
    learnerConfirmed: raw.learnerConfirmed,
  };
  if (typeof raw.mistakeCategory === 'string') {
    out.mistakeCategory = raw.mistakeCategory;
  }
  return out;
}

/** Lenient structural parse for STORAGE reads (never throws). */
export function parseReflection(raw: unknown): LearnerReflection | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!isNonBlankString(raw.reflectionId) || typeof raw.schemaVersion !== 'number') {
    return null;
  }
  if (!isKnownReflectionStatus(raw.status)) {
    return null;
  }
  if (raw.category !== null && !isKnownReflectionCategory(raw.category)) {
    return null;
  }
  if (raw.freeText !== null && typeof raw.freeText !== 'string') {
    return null;
  }
  const interpretation = parseInterpretationLenient(raw.interpretation);
  if (raw.interpretation !== null && interpretation === null) {
    return null;
  }
  if (!isStringArray(raw.evidenceIds)) {
    return null;
  }
  const provenance: unknown = raw.provenance;
  if (!isRecord(provenance)) {
    return null;
  }
  if (
    (provenance.sessionId !== null && typeof provenance.sessionId !== 'string') ||
    typeof provenance.attemptId !== 'string' ||
    typeof provenance.problemId !== 'string' ||
    (provenance.problemTitle !== null && typeof provenance.problemTitle !== 'string') ||
    (provenance.classificationStatus !== 'classified' &&
      provenance.classificationStatus !== 'partial' &&
      provenance.classificationStatus !== 'unclassified') ||
    (provenance.goalId !== null &&
      provenance.goalId !== undefined &&
      typeof provenance.goalId !== 'string') ||
    (provenance.planId !== null &&
      provenance.planId !== undefined &&
      typeof provenance.planId !== 'string') ||
    (provenance.progressSignal !== null &&
      provenance.progressSignal !== undefined &&
      typeof provenance.progressSignal !== 'string') ||
    provenance.source !== 'explicit-learner-reflection' ||
    typeof provenance.offeredAt !== 'string' ||
    (provenance.respondedAt !== null && typeof provenance.respondedAt !== 'string')
  ) {
    return null;
  }
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    return null;
  }
  return {
    reflectionId: raw.reflectionId,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : REFLECTION_SCHEMA_VERSION,
    status: raw.status,
    category: raw.category,
    freeText: raw.freeText,
    interpretation,
    evidenceIds: [...raw.evidenceIds],
    provenance: {
      sessionId: provenance.sessionId,
      attemptId: provenance.attemptId,
      problemId: provenance.problemId,
      problemTitle: provenance.problemTitle,
      classificationStatus: provenance.classificationStatus,
      goalId: (provenance.goalId as string | null | undefined) ?? null,
      planId: (provenance.planId as string | null | undefined) ?? null,
      progressSignal: (provenance.progressSignal as string | null | undefined) ?? null,
      source: 'explicit-learner-reflection',
      offeredAt: provenance.offeredAt,
      respondedAt: provenance.respondedAt,
    },
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
