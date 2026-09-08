import { randomUUID } from 'crypto';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceConfidence,
  EvidenceDimension,
  EvidenceSource,
  EvidenceType,
  HelpLevel,
  isKnownEvidenceConfidence,
  isKnownEvidenceDimension,
  isKnownEvidenceSource,
  isKnownEvidenceType,
  isKnownHelpLevel,
} from './learnerTypes';
import { isRecord } from '../persistence/storeFiles';

/**
 * Phase D durable evidence: one append-oriented, traceable fact.
 *
 * The observation/interpretation split is the whole point:
 * - `observation`: what actually happened (attempt ended WA; coach gave a
 *   hint; learner replied X). Checkable against stored artifacts.
 * - `interpretation`: what CodeSense believes it means, with `confidence`
 *   in THAT inference. Never a verdict about the person.
 *
 * Bounds (`MAX_*`) keep records finite; builders truncate, validators
 * reject over-long input so no producer can smuggle essays into storage.
 */

export const MAX_EVIDENCE_TEXT_CHARS = 500;
export const MAX_ENTITY_IDS_PER_EVIDENCE = 24;
export const MAX_MISTAKE_CATEGORY_CHARS = 80;

export interface EvidenceProvenance {
  /** Which pipeline produced this record. */
  source: EvidenceSource;
  /**
   * Id of the originating artifact: evaluationId, messageId, attemptId, or
   * null when there is no single artifact (e.g. aggregated exposure note).
   * Never a secret, never source code.
   */
  sourceId: string | null;
}

export interface LearnerEvidence {
  evidenceId: string;
  schemaVersion: number;
  /** ISO-8601 UTC timestamp of the observed moment (not the write time). */
  timestamp: string;
  sessionId: string | null;
  attemptId: string | null;
  problemId: string | null;
  /** Canonical Phase C ontology IDs this evidence speaks to (non-empty). */
  entityIds: string[];
  evidenceType: EvidenceType;
  source: EvidenceSource;
  /** What actually happened. Must be statable without inference. */
  observation: string;
  /** What CodeSense believes it means (with `confidence` in this claim). */
  interpretation: string;
  confidence: EvidenceConfidence;
  /**
   * Help involved, for HELP_REQUIRED (required there) and
   * INDEPENDENT_SUCCESS (always `none`). Forbidden elsewhere so help
   * semantics stay in exactly one place.
   */
  helpLevel?: HelpLevel;
  /**
   * Open-vocabulary mistake category (`forgot-visited-marking`,
   * `off-by-one`, ...). Required on RECURRING_MISTAKE; allowed only on
   * RECURRING_MISTAKE, IMPLEMENTATION_FAILURE, DEBUGGING_FAILURE.
   * Deliberately NOT an enum — future detectors/reflection extend it
   * without a taxonomy rewrite.
   */
  mistakeCategory?: string;
  /**
   * Explicit dimension, meaningful ONLY on RECURRING_MISTAKE (the
   * extractor knows whether the pattern is conceptual, implementation,
   * or debugging shaped). Every other type maps to a fixed dimension.
   */
  dimension?: EvidenceDimension;
  provenance: EvidenceProvenance;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidMistakeCategory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MISTAKE_CATEGORY_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function generateEvidenceId(): string {
  return 'ev_' + randomUUID();
}

/**
 * Strict validation for WRITES (feeds, tests, future reflection input).
 * Entity IDs are checked against the live graph: evidence may only speak
 * to canonical knowledge, never invented IDs. Returns the normalized
 * record or null (→ caller drops it loudly, never persists half-shaped).
 */
export function validateLearnerEvidence(
  raw: unknown,
  opts: { graph: KnowledgeGraph },
): LearnerEvidence | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!isNonBlankString(raw.evidenceId) || raw.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return null;
  }
  if (!isNonBlankString(raw.timestamp)) {
    return null;
  }
  for (const key of ['sessionId', 'attemptId', 'problemId'] as const) {
    const v: unknown = raw[key];
    if (v !== null && typeof v !== 'string') {
      return null;
    }
  }
  const entityIds: unknown = raw.entityIds;
  if (
    !Array.isArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.length > MAX_ENTITY_IDS_PER_EVIDENCE ||
    entityIds.some((e: unknown) => typeof e !== 'string' || e.trim().length === 0)
  ) {
    return null;
  }
  for (const id of entityIds as string[]) {
    if (!opts.graph.hasEntity(id)) {
      return null;
    }
  }
  if (!isKnownEvidenceType(raw.evidenceType) || !isKnownEvidenceSource(raw.source)) {
    return null;
  }
  if (
    !isNonBlankString(raw.observation) ||
    raw.observation.length > MAX_EVIDENCE_TEXT_CHARS ||
    !isNonBlankString(raw.interpretation) ||
    raw.interpretation.length > MAX_EVIDENCE_TEXT_CHARS
  ) {
    return null;
  }
  if (!isKnownEvidenceConfidence(raw.confidence)) {
    return null;
  }
  const helpLevel: unknown = raw.helpLevel;
  if (raw.evidenceType === 'HELP_REQUIRED') {
    if (!isKnownHelpLevel(helpLevel) || helpLevel === 'none') {
      return null;
    }
  } else if (raw.evidenceType === 'INDEPENDENT_SUCCESS') {
    if (helpLevel !== undefined && helpLevel !== 'none') {
      return null;
    }
  } else if (helpLevel !== undefined) {
    return null;
  }
  const mistakeCategory: unknown = raw.mistakeCategory;
  if (raw.evidenceType === 'RECURRING_MISTAKE') {
    if (!isValidMistakeCategory(mistakeCategory)) {
      return null;
    }
  } else if (
    raw.evidenceType === 'IMPLEMENTATION_FAILURE' ||
    raw.evidenceType === 'DEBUGGING_FAILURE'
  ) {
    if (mistakeCategory !== undefined && !isValidMistakeCategory(mistakeCategory)) {
      return null;
    }
  } else if (mistakeCategory !== undefined) {
    return null;
  }
  const dimension: unknown = raw.dimension;
  if (raw.evidenceType === 'RECURRING_MISTAKE') {
    if (!isKnownEvidenceDimension(dimension) || dimension === 'exposure') {
      return null;
    }
  } else if (dimension !== undefined) {
    return null;
  }
  const provenance: unknown = raw.provenance;
  if (!isRecord(provenance) || !isKnownEvidenceSource(provenance.source)) {
    return null;
  }
  if (provenance.sourceId !== null && typeof provenance.sourceId !== 'string') {
    return null;
  }
  const help = raw.evidenceType === 'HELP_REQUIRED' && isKnownHelpLevel(helpLevel) ? helpLevel : undefined;
  const evidence: LearnerEvidence = {
    evidenceId: raw.evidenceId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    timestamp: raw.timestamp,
    sessionId: raw.sessionId as string | null,
    attemptId: raw.attemptId as string | null,
    problemId: raw.problemId as string | null,
    entityIds: [...(entityIds as string[])],
    evidenceType: raw.evidenceType,
    source: raw.source,
    observation: raw.observation,
    interpretation: raw.interpretation,
    confidence: raw.confidence,
    ...(help !== undefined ? { helpLevel: help } : {}),
    ...(typeof mistakeCategory === 'string' && isValidMistakeCategory(mistakeCategory)
      ? { mistakeCategory }
      : {}),
    ...(isKnownEvidenceDimension(dimension) && raw.evidenceType === 'RECURRING_MISTAKE'
      ? { dimension }
      : {}),
    provenance: {
      source: provenance.source,
      sourceId: provenance.sourceId,
    },
  };
  return evidence;
}

/**
 * Lenient structural parse for STORAGE reads. Deliberately graph-agnostic
 * (mirrors `parseProblemClassification`): historical evidence survives
 * ontology evolution instead of failing to load. Anything not
 * structurally sound is dropped (never throws).
 */
export function parseLearnerEvidence(raw: unknown): LearnerEvidence | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!isNonBlankString(raw.evidenceId) || typeof raw.schemaVersion !== 'number') {
    return null;
  }
  if (!isNonBlankString(raw.timestamp)) {
    return null;
  }
  for (const key of ['sessionId', 'attemptId', 'problemId'] as const) {
    const v: unknown = raw[key];
    if (v !== null && typeof v !== 'string') {
      return null;
    }
  }
  const entityIds: unknown = raw.entityIds;
  if (
    !Array.isArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.some((e: unknown) => typeof e !== 'string' || (e as string).trim().length === 0)
  ) {
    return null;
  }
  if (!isKnownEvidenceType(raw.evidenceType) || !isKnownEvidenceSource(raw.source)) {
    return null;
  }
  if (!isNonBlankString(raw.observation) || !isNonBlankString(raw.interpretation)) {
    return null;
  }
  if (!isKnownEvidenceConfidence(raw.confidence)) {
    return null;
  }
  const provenance: unknown = raw.provenance;
  if (!isRecord(provenance) || !isKnownEvidenceSource(provenance.source)) {
    return null;
  }
  if (provenance.sourceId !== null && typeof provenance.sourceId !== 'string') {
    return null;
  }
  const evidence: LearnerEvidence = {
    evidenceId: raw.evidenceId,
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : EVIDENCE_SCHEMA_VERSION,
    timestamp: raw.timestamp,
    sessionId: raw.sessionId as string | null,
    attemptId: raw.attemptId as string | null,
    problemId: raw.problemId as string | null,
    entityIds: [...(entityIds as string[])],
    evidenceType: raw.evidenceType,
    source: raw.source,
    observation: raw.observation,
    interpretation: raw.interpretation,
    confidence: raw.confidence,
    provenance: { source: provenance.source, sourceId: provenance.sourceId },
  };
  if (isKnownHelpLevel(raw.helpLevel)) {
    evidence.helpLevel = raw.helpLevel;
  }
  if (typeof raw.mistakeCategory === 'string') {
    evidence.mistakeCategory = raw.mistakeCategory;
  }
  if (isKnownEvidenceDimension(raw.dimension)) {
    evidence.dimension = raw.dimension;
  }
  return evidence;
}

export function truncateEvidenceText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_EVIDENCE_TEXT_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_EVIDENCE_TEXT_CHARS - 1).trimEnd() + '…';
}
