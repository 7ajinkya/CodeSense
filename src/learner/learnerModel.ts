import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { isRecord } from '../persistence/storeFiles';
import {
  AGGREGATOR_VERSION,
  DimensionLevel,
  EvidenceConfidence,
  EvidenceDimension,
  KnowledgeStatus,
  LEARNER_MODEL_VERSION,
  MistakeStatus,
} from './learnerTypes';

/**
 * Phase D derived learner state: what CodeSense currently has reason to
 * believe, with every belief pointing at its evidence. Rebuilt
 * deterministically from the append-only evidence history
 * (`rebuildLearnerModel`), so the stored profile is a cache with
 * provenance — never the source of truth.
 */

/** Displayed-trajectory cap per entity (oldest transitions drop first). */
export const MAX_TRAJECTORY_ENTRIES = 200;
/** Per-list evidence-id caps inside one knowledge state (newest kept). */
export const MAX_STATE_EVIDENCE_REFS = 200;

export interface DimensionState {
  level: DimensionLevel;
  /** Confidence in this assessment (UNKNOWN/EXPOSED with no signal → low). */
  confidence: EvidenceConfidence;
  positiveEvidenceIds: string[];
  negativeEvidenceIds: string[];
  positiveWeight: number;
  negativeWeight: number;
  lastUpdatedAt: string | null;
}

export interface TrajectoryEntry {
  at: string;
  /** Which dimension moved, or `status` for the entity rollup. */
  dimension: EvidenceDimension | 'status';
  from: string;
  to: string;
  evidenceIds: string[];
}

export interface LearnerKnowledgeState {
  entityId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  evidenceCount: number;
  exposure: DimensionState;
  recognition: DimensionState;
  conceptual: DimensionState;
  implementation: DimensionState;
  debugging: DimensionState;
  transfer: DimensionState;
  independence: DimensionState;
  status: KnowledgeStatus;
  statusConfidence: EvidenceConfidence;
  /** Positive evidence across dimensions (newest-first, capped). */
  supportingEvidenceIds: string[];
  /** Negative evidence across dimensions (newest-first, capped). */
  contradictingEvidenceIds: string[];
  /** Chronological level/status transitions (capped, oldest dropped). */
  trajectory: TrajectoryEntry[];
  updatedAt: string;
}

export interface MistakeOccurrence {
  evidenceId: string;
  attemptId: string | null;
  timestamp: string;
}

export interface LearnerMistakePattern {
  mistakeId: string;
  category: string;
  relatedEntityIds: string[];
  occurrences: MistakeOccurrence[];
  firstObservedAt: string;
  lastObservedAt: string;
  status: MistakeStatus;
  resolvedAt: string | null;
  confidence: EvidenceConfidence;
  evidenceIds: string[];
}

export interface LearnerProfile {
  schemaVersion: number;
  /** Local-first identity. No auth, no accounts: exactly one learner. */
  learnerId: string;
  createdAt: string;
  updatedAt: string;
  ontologyVersion: string;
  aggregatorVersion: string;
  /** Only entities WITH evidence. Unknown genuinely means "no record". */
  knowledgeStates: LearnerKnowledgeState[];
  recurringMistakes: LearnerMistakePattern[];
  totalEvidenceCount: number;
}

export const LOCAL_LEARNER_ID = 'local-learner';

export function emptyDimensionState(): DimensionState {
  return {
    level: 'UNKNOWN',
    confidence: 'low',
    positiveEvidenceIds: [],
    negativeEvidenceIds: [],
    positiveWeight: 0,
    negativeWeight: 0,
    lastUpdatedAt: null,
  };
}

/** Exhaustive, cast-free accessor so the updater never indexes by string. */
export function dimensionStateOf(
  state: LearnerKnowledgeState,
  dimension: EvidenceDimension,
): DimensionState {
  switch (dimension) {
    case 'exposure':
      return state.exposure;
    case 'recognition':
      return state.recognition;
    case 'conceptual':
      return state.conceptual;
    case 'implementation':
      return state.implementation;
    case 'debugging':
      return state.debugging;
    case 'transfer':
      return state.transfer;
    case 'independence':
      return state.independence;
  }
}

export function emptyKnowledgeState(entityId: string, at: string): LearnerKnowledgeState {
  return {
    entityId,
    firstObservedAt: at,
    lastObservedAt: at,
    evidenceCount: 0,
    exposure: emptyDimensionState(),
    recognition: emptyDimensionState(),
    conceptual: emptyDimensionState(),
    implementation: emptyDimensionState(),
    debugging: emptyDimensionState(),
    transfer: emptyDimensionState(),
    independence: emptyDimensionState(),
    status: 'unknown',
    statusConfidence: 'low',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    trajectory: [],
    updatedAt: at,
  };
}

export function emptyLearnerProfile(now: string, graph: KnowledgeGraph): LearnerProfile {
  return {
    schemaVersion: LEARNER_MODEL_VERSION,
    learnerId: LOCAL_LEARNER_ID,
    createdAt: now,
    updatedAt: now,
    ontologyVersion: graph.ontologyVersion,
    aggregatorVersion: AGGREGATOR_VERSION,
    knowledgeStates: [],
    recurringMistakes: [],
    totalEvidenceCount: 0,
  };
}

function isDimensionState(raw: unknown): raw is DimensionState {
  if (!isRecord(raw)) {
    return false;
  }
  return (
    (raw.level === 'UNKNOWN' ||
      raw.level === 'EXPOSED' ||
      raw.level === 'EMERGING' ||
      raw.level === 'DEMONSTRATED' ||
      raw.level === 'STRONG') &&
    (raw.confidence === 'low' || raw.confidence === 'medium' || raw.confidence === 'high') &&
    Array.isArray(raw.positiveEvidenceIds) &&
    Array.isArray(raw.negativeEvidenceIds) &&
    typeof raw.positiveWeight === 'number' &&
    typeof raw.negativeWeight === 'number' &&
    (raw.lastUpdatedAt === null || typeof raw.lastUpdatedAt === 'string')
  );
}

function parseKnowledgeState(raw: unknown): LearnerKnowledgeState | null {
  if (!isRecord(raw) || typeof raw.entityId !== 'string') {
    return null;
  }
  const dims: EvidenceDimension[] = [
    'exposure',
    'recognition',
    'conceptual',
    'implementation',
    'debugging',
    'transfer',
    'independence',
  ];
  for (const d of dims) {
    if (!isDimensionState(raw[d])) {
      return null;
    }
  }
  if (
    typeof raw.firstObservedAt !== 'string' ||
    typeof raw.lastObservedAt !== 'string' ||
    typeof raw.evidenceCount !== 'number' ||
    typeof raw.updatedAt !== 'string'
  ) {
    return null;
  }
  if (
    raw.status !== 'unknown' &&
    raw.status !== 'exposed' &&
    raw.status !== 'developing' &&
    raw.status !== 'demonstrated' &&
    raw.status !== 'strong' &&
    raw.status !== 'struggling' &&
    raw.status !== 'mixed'
  ) {
    return null;
  }
  if (raw.statusConfidence !== 'low' && raw.statusConfidence !== 'medium' && raw.statusConfidence !== 'high') {
    return null;
  }
  if (!Array.isArray(raw.supportingEvidenceIds) || !Array.isArray(raw.contradictingEvidenceIds)) {
    return null;
  }
  if (!Array.isArray(raw.trajectory)) {
    return null;
  }
  return raw as unknown as LearnerKnowledgeState;
}

function parseMistakePattern(raw: unknown): LearnerMistakePattern | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.mistakeId !== 'string' ||
    typeof raw.category !== 'string' ||
    !Array.isArray(raw.relatedEntityIds) ||
    !Array.isArray(raw.occurrences) ||
    typeof raw.firstObservedAt !== 'string' ||
    typeof raw.lastObservedAt !== 'string' ||
    (raw.status !== 'single' && raw.status !== 'recurring' && raw.status !== 'resolved') ||
    (raw.resolvedAt !== null && typeof raw.resolvedAt !== 'string') ||
    (raw.confidence !== 'low' && raw.confidence !== 'medium' && raw.confidence !== 'high') ||
    !Array.isArray(raw.evidenceIds)
  ) {
    return null;
  }
  return raw as unknown as LearnerMistakePattern;
}

/** Lenient parse for STORAGE reads (never throws; corrupt file → null). */
export function parseLearnerProfile(raw: unknown): LearnerProfile | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.schemaVersion !== 'number' ||
    typeof raw.learnerId !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    typeof raw.ontologyVersion !== 'string' ||
    typeof raw.aggregatorVersion !== 'string' ||
    typeof raw.totalEvidenceCount !== 'number'
  ) {
    return null;
  }
  if (!Array.isArray(raw.knowledgeStates) || !Array.isArray(raw.recurringMistakes)) {
    return null;
  }
  const knowledgeStates: LearnerKnowledgeState[] = [];
  for (const item of raw.knowledgeStates) {
    const parsed = parseKnowledgeState(item);
    if (parsed === null) {
      return null;
    }
    knowledgeStates.push(parsed);
  }
  const recurringMistakes: LearnerMistakePattern[] = [];
  for (const item of raw.recurringMistakes) {
    const parsed = parseMistakePattern(item);
    if (parsed === null) {
      return null;
    }
    recurringMistakes.push(parsed);
  }
  return {
    schemaVersion: raw.schemaVersion,
    learnerId: raw.learnerId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ontologyVersion: raw.ontologyVersion,
    aggregatorVersion: raw.aggregatorVersion,
    knowledgeStates,
    recurringMistakes,
    totalEvidenceCount: raw.totalEvidenceCount,
  };
}
