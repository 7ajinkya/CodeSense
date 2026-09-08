import type { EvidenceConfidence, EvidenceDimension } from '../learner/learnerTypes';

/**
 * Phase F1 goal-domain types: learning needs, goal proposals, and
 * learner-owned learning goals.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - Phase C owns knowledge: targets reference canonical entity IDs only,
 *   validated against the live graph. No duplicate topic/concept IDs.
 * - Phase D owns capability: dimensions reuse the frozen
 *   `EvidenceDimension` vocabulary; confidence reuses `EvidenceConfidence`.
 *   Goals store NO capability assessment — only references to D state.
 * - Phase E owns current-attempt coaching; F1 never duplicates it.
 *
 * Identity: single local learner, same as Phase D (`local-learner`).
 * Everything here is plain JSON-serializable data persisted local-first.
 */

export const GOAL_SCHEMA_VERSION = 1;

/** Where a goal came from. The two origins are never merged. */
export type GoalSource = 'evidence-derived' | 'learner-requested';

export const GOAL_SOURCES: readonly GoalSource[] = ['evidence-derived', 'learner-requested'];

export function isKnownGoalSource(value: unknown): value is GoalSource {
  return typeof value === 'string' && (GOAL_SOURCES as readonly string[]).includes(value);
}

/**
 * Goal lifecycle. Minimal for F1: a proposal awaits a learner decision;
 * an active goal can pause/resume or terminate as achieved/abandoned;
 * a rejected proposal is retained as dismissed (anti-spam provenance).
 * Terminal states carry no outgoing transitions.
 */
export type GoalStatus = 'proposed' | 'active' | 'paused' | 'achieved' | 'dismissed' | 'abandoned';

export const GOAL_STATUSES: readonly GoalStatus[] = [
  'proposed',
  'active',
  'paused',
  'achieved',
  'dismissed',
  'abandoned',
];

export function isKnownGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value);
}

/** Valid status transitions; terminal states map to no outgoing edges. */
export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  proposed: ['active', 'dismissed'],
  active: ['paused', 'achieved', 'abandoned'],
  paused: ['active', 'abandoned'],
  achieved: [],
  dismissed: [],
  abandoned: [],
};

/** Traceable pointer into Phase D state. References, never a copy. */
export interface NeedEvidenceBasis {
  /** Capped evidence IDs supporting this need, oldest first. */
  evidenceIds: string[];
  /** `LearnerProfile.updatedAt` of the snapshot this was derived from. */
  profileUpdatedAt: string;
  ontologyVersion: string;
  aggregatorVersion: string;
}

/**
 * A Learning Need: an actionable interpretation of existing learner-model
 * evidence — distinct from both the evidence and any goal. Needs are
 * DERIVED on demand (pure function of profile + evidence), never stored:
 * there is no staleness problem because there is no stored copy.
 * Needs are always evidence-derived; learner intent enters at the
 * proposal level, never disguised as a need.
 */
export interface LearningNeed {
  /** Stable id: `need_<hash(targetKey)>` so identical needs dedupe. */
  needId: string;
  /** Canonical Phase C entity IDs underpinning this need (sorted, non-empty). */
  entityIds: string[];
  /** Frozen Phase D dimension this need speaks to. */
  dimension: EvidenceDimension;
  /** Short human-readable statement of the capability worth improving. */
  description: string;
  /** Why this need exists, citing evidence counts (never a verdict). */
  rationale: string;
  /**
   * Rival interpretations, present only when the evidence does not single
   * out one dimension. Uncertainty preserved, not resolved by fiat.
   */
  ambiguity?: string[];
  confidence: EvidenceConfidence;
  evidenceBasis: NeedEvidenceBasis;
  observedAt: string;
}

/** Qualitative, evidence-oriented success criteria (never numeric mastery). */
export interface GoalSuccessCriteria {
  /** Learner-facing statement of what progress looks like. */
  summary: string;
  /** Which dimension future evidence should emphasize. */
  dimension: EvidenceDimension;
  /** Descriptive guidance on what counts (evidence types in prose). */
  guidance: string;
}

/**
 * Goal-local progress baseline: where the learner was when the goal
 * became active. A small snapshot of D state (dimension levels +
 * evidence-ID list), NOT a copy of the profile — later phases compare
 * post-baseline evidence against `capturedAt`/evidenceIds.
 */
export interface GoalProgressBaseline {
  capturedAt: string;
  profileUpdatedAt: string;
  entityStates: Array<{
    entityId: string;
    dimension: EvidenceDimension;
    level: string;
    confidence: string;
  }>;
  /** Evidence existing at capture (capped); later evidence is "after". */
  evidenceIds: string[];
}

/** Why the system believes a goal is relevant (or why the learner wants it). */
export interface GoalEvidenceBasis extends NeedEvidenceBasis {
  /** Null for pure learner-requested goals (honest about having no need). */
  needId: string | null;
  /** Verbatim learner request/modification (bounded), when applicable. */
  learnerStatement?: string;
  /** Pre-modification proposal description (edit provenance). */
  originalDescription?: string;
  /** Evidence fingerprint at dismissal time (anti-spam provenance). */
  dismissalFingerprint?: string;
}

/**
 * A Learning Goal: durable, learner-owned, lifecycle-managed. Active
 * status is reachable ONLY through an explicit learner decision
 * (accept/modify incl. direct creation); system derivation stops at
 * `proposed`. No capability assessment lives here — `progressBaseline`
 * references D state, and progress itself is future evidence.
 */
export interface LearningGoal {
  /** Stable id: `goal_<uuid>`. */
  goalId: string;
  /** Canonical dedup key: sorted entityIds joined with `+`, plus dimension. */
  targetKey: string;
  /** Canonical Phase C entity IDs (may be empty for dimension-only requests). */
  entityIds: string[];
  dimension: EvidenceDimension;
  /** Learner-facing statement (proposal text or learner-modified text). */
  description: string;
  source: GoalSource;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  evidenceBasis: GoalEvidenceBasis;
  successCriteria: GoalSuccessCriteria;
  /** Set exactly once, at activation. Null while proposed. */
  progressBaseline: GoalProgressBaseline | null;
  /** Set when the learner decides (accept/modify/reject). */
  decidedAt: string | null;
  decisionNote?: string;
}

/** Strict AI-candidate wording: description/success-criteria text ONLY. */
export interface GoalWordingCandidate {
  description?: string;
  successCriteriaSummary?: string;
}

/** Bounds keep stored goal text finite; validators reject over-long input. */
export const MAX_GOAL_TEXT_CHARS = 280;
export const MAX_GOAL_ENTITY_IDS = 12;
export const MAX_GOAL_EVIDENCE_IDS = 24;
export const MAX_GOAL_DESCRIPTION_CHARS = 280;
