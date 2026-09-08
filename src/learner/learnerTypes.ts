/**
 * Phase D learner-model domain types.
 *
 * Core principle — evidence first, inference second:
 *   Observed attempt → Evidence → interpretation → belief + confidence.
 * Mastery is never directly observed, so the model stores *beliefs with
 * provenance*, never scores. There is deliberately no numeric "mastery"
 * field anywhere in this module.
 *
 * Identity: local-first single learner (`local-learner`). No auth, no
 * accounts, no cloud — see `LearnerProfile.learnerId`.
 */

export const LEARNER_MODEL_VERSION = 1;
export const EVIDENCE_SCHEMA_VERSION = 1;
/** Version of the deterministic aggregation rules in `learnerModel.ts`. */
export const AGGREGATOR_VERSION = '1';

/**
 * What kind of learner-relevant fact one evidence record carries.
 * Kept as an explicit union (like `AttemptState`): small, reviewable,
 * and extendable without migrations for additive members.
 */
export type EvidenceType =
  | 'EXPOSURE'
  | 'RECOGNITION'
  | 'CONCEPTUAL_SUCCESS'
  | 'CONCEPTUAL_CONFUSION'
  | 'IMPLEMENTATION_SUCCESS'
  | 'IMPLEMENTATION_FAILURE'
  | 'DEBUGGING_SUCCESS'
  | 'DEBUGGING_FAILURE'
  | 'TRANSFER_SUCCESS'
  | 'TRANSFER_FAILURE'
  | 'RECURRING_MISTAKE'
  | 'HELP_REQUIRED'
  | 'INDEPENDENT_SUCCESS';

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'EXPOSURE',
  'RECOGNITION',
  'CONCEPTUAL_SUCCESS',
  'CONCEPTUAL_CONFUSION',
  'IMPLEMENTATION_SUCCESS',
  'IMPLEMENTATION_FAILURE',
  'DEBUGGING_SUCCESS',
  'DEBUGGING_FAILURE',
  'TRANSFER_SUCCESS',
  'TRANSFER_FAILURE',
  'RECURRING_MISTAKE',
  'HELP_REQUIRED',
  'INDEPENDENT_SUCCESS',
];

export function isKnownEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

/** Where an evidence record came from. `human-curated` is reserved for
 *  future reflection input (Phase G plugs into the same pipeline). */
export type EvidenceSource =
  | 'attempt-outcome'
  | 'ai-diagnosis'
  | 'conversation'
  | 'mistake-report'
  | 'human-curated';

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  'attempt-outcome',
  'ai-diagnosis',
  'conversation',
  'mistake-report',
  'human-curated',
];

export function isKnownEvidenceSource(value: unknown): value is EvidenceSource {
  return typeof value === 'string' && (EVIDENCE_SOURCES as readonly string[]).includes(value);
}

/**
 * Which facet of learning an evidence record speaks to. The updater maps
 * each `EvidenceType` to exactly one dimension (see `EVIDENCE_DIMENSION`),
 * except RECURRING_MISTAKE which carries its dimension explicitly.
 */
export type EvidenceDimension =
  | 'exposure'
  | 'recognition'
  | 'conceptual'
  | 'implementation'
  | 'debugging'
  | 'transfer'
  | 'independence';

export const EVIDENCE_DIMENSIONS: readonly EvidenceDimension[] = [
  'exposure',
  'recognition',
  'conceptual',
  'implementation',
  'debugging',
  'transfer',
  'independence',
];

export function isKnownEvidenceDimension(value: unknown): value is EvidenceDimension {
  return typeof value === 'string' && (EVIDENCE_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Confidence in the *interpretation*, never a mastery score. A single
 * observed success is `low` confidence for "can implement"; repeated
 * agreeing evidence raises it. Contradictions cap it.
 */
export type EvidenceConfidence = 'low' | 'medium' | 'high';

export const EVIDENCE_CONFIDENCES: readonly EvidenceConfidence[] = ['low', 'medium', 'high'];

export function isKnownEvidenceConfidence(value: unknown): value is EvidenceConfidence {
  return typeof value === 'string' && (EVIDENCE_CONFIDENCES as readonly string[]).includes(value);
}

/** Position on the existing coaching help ladder (plus `unknown`/`none`). */
export type HelpLevel = 'none' | 'socratic' | 'hint' | 'explanation' | 'solution' | 'unknown';

export const HELP_LEVELS: readonly HelpLevel[] = [
  'none',
  'socratic',
  'hint',
  'explanation',
  'solution',
  'unknown',
];

export function isKnownHelpLevel(value: unknown): value is HelpLevel {
  return typeof value === 'string' && (HELP_LEVELS as readonly string[]).includes(value);
}

/**
 * Evidence-backed attainment per dimension. Deliberately asymmetric: there
 * is no "WEAK" rung. Difficulty is recorded in `negativeEvidenceIds` and
 * surfaced via `KnowledgeStatus`, so a single failure can never render as
 * a verdict — only repeated, majority-negative evidence flags `struggling`.
 */
export type DimensionLevel = 'UNKNOWN' | 'EXPOSED' | 'EMERGING' | 'DEMONSTRATED' | 'STRONG';

export const DIMENSION_LEVELS: readonly DimensionLevel[] = [
  'UNKNOWN',
  'EXPOSED',
  'EMERGING',
  'DEMONSTRATED',
  'STRONG',
];

/** Coarse per-entity rollup. `struggling`/`mixed` require repeated negative
 *  evidence (see the updater rules); anything weaker stays `developing`. */
export type KnowledgeStatus =
  | 'unknown'
  | 'exposed'
  | 'developing'
  | 'demonstrated'
  | 'strong'
  | 'struggling'
  | 'mixed';

export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = [
  'unknown',
  'exposed',
  'developing',
  'demonstrated',
  'strong',
  'struggling',
  'mixed',
];

/** Lifecycle of one mistake pattern: one sighting is a fact, two is a
 *  pattern, sustained clean work in the area resolves it (reopenable). */
export type MistakeStatus = 'single' | 'recurring' | 'resolved';

export const MISTAKE_STATUSES: readonly MistakeStatus[] = ['single', 'recurring', 'resolved'];

export function isKnownMistakeStatus(value: unknown): value is MistakeStatus {
  return typeof value === 'string' && (MISTAKE_STATUSES as readonly string[]).includes(value);
}
