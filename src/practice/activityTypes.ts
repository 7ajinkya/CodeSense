import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import type { GoalSource } from '../goals/goalTypes';

/**
 * Phase F2 activity-plan domain types: targeted practice planning.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - Phase C owns knowledge: plans reference canonical entity IDs only,
 *   validated against the live graph. No duplicate topic/concept IDs.
 * - Phase D owns capability: dimensions reuse the frozen
 *   `EvidenceDimension` vocabulary; expected evidence reuses the frozen
 *   `EvidenceType` vocabulary. Plans store NO capability assessment —
 *   only references to D state and evidence IDs.
 * - Phase F1 owns needs/goals: plans reference a goal ID + target key,
 *   never re-derive needs. Only `active` goals yield plans.
 * - Phase E owns current-attempt coaching; F2 never duplicates it.
 * - Attempts own execution: a plan is never an attempt. When the learner
 *   begins a problem, the existing attempt lifecycle stays authoritative
 *   and the plan only records the resulting `linkedAttemptId`.
 *
 * Identity: single local learner, same as Phase D/F1 (`local-learner`).
 * Everything here is plain JSON-serializable data persisted local-first.
 */

export const PRACTICE_SCHEMA_VERSION = 1;
export const PRACTICE_PLAN_ID_PREFIX = 'plan_';
export const PRACTICE_SEQUENCE_ID_PREFIX = 'seq_';

/**
 * What kind of learning action this is. `coding-problem` is the only
 * populated kind in this slice: every candidate comes from an existing
 * Problem (never generated). The union stays extensible so future
 * recognition/debugging micro-activities can plug in without a rewrite —
 * but no second activity taxonomy is created here.
 */
export type ActivityKind = 'coding-problem';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['coding-problem'];

export function isKnownActivityKind(value: unknown): value is ActivityKind {
  return value === 'coding-problem';
}

/**
 * Why this activity is being assigned (pedagogical role). A closed union
 * on purpose — never a free-form string. Each member maps to exactly one
 * frozen D dimension (except `reinforcement`, the consolidation role for
 * already-demonstrated capability), so dimension targeting stays explicit
 * and testable instead of stringly-typed.
 */
export type ActivityIntent =
  | 'recognition-practice'
  | 'conceptual-practice'
  | 'implementation-practice'
  | 'debugging-practice'
  | 'transfer-practice'
  | 'independence-practice'
  | 'reinforcement';

export const ACTIVITY_INTENTS: readonly ActivityIntent[] = [
  'recognition-practice',
  'conceptual-practice',
  'implementation-practice',
  'debugging-practice',
  'transfer-practice',
  'independence-practice',
  'reinforcement',
];

export function isKnownActivityIntent(value: unknown): value is ActivityIntent {
  return typeof value === 'string' && (ACTIVITY_INTENTS as readonly string[]).includes(value);
}

/** Which D dimension an intent serves (`reinforcement` serves demonstrated strength). */
export function intentDimension(intent: ActivityIntent): EvidenceDimension | 'reinforcement' {
  switch (intent) {
    case 'recognition-practice':
      return 'recognition';
    case 'conceptual-practice':
      return 'conceptual';
    case 'implementation-practice':
      return 'implementation';
    case 'debugging-practice':
      return 'debugging';
    case 'transfer-practice':
      return 'transfer';
    case 'independence-practice':
      return 'independence';
    case 'reinforcement':
      return 'reinforcement';
  }
}

/** Default intent for a goal dimension (learner preference may refine it). */
export function intentForDimension(dimension: EvidenceDimension): ActivityIntent {
  switch (dimension) {
    case 'recognition':
      return 'recognition-practice';
    case 'conceptual':
      return 'conceptual-practice';
    case 'implementation':
      return 'implementation-practice';
    case 'debugging':
      return 'debugging-practice';
    case 'transfer':
      return 'transfer-practice';
    case 'independence':
      return 'independence-practice';
    case 'exposure':
      return 'reinforcement';
  }
}

/**
 * Whether the activity exists primarily to LEARN about the learner
 * (`diagnostic`) or to IMPROVE a corroborated capability
 * (`instructional`). Orthogonal to intent: a recognition-practice
 * activity can be either, depending on uncertainty. Never inferred from
 * free text — decided deterministically from D confidence (see planner).
 */
export type ActivityPurpose = 'diagnostic' | 'instructional';

export const ACTIVITY_PURPOSES: readonly ActivityPurpose[] = ['diagnostic', 'instructional'];

export function isKnownActivityPurpose(value: unknown): value is ActivityPurpose {
  return value === 'diagnostic' || value === 'instructional';
}

/**
 * Plan lifecycle. A plan is proposed by the deterministic planner
 * (`planned`), surfaced to the learner (`offered`), acted upon
 * (`started`), and resolved (`completed`/`skipped`/`cancelled`).
 * Terminal states carry no outgoing transitions. This lifecycle never
 * replaces the attempt lifecycle — see `linkedAttemptId`.
 */
export type ActivityPlanStatus =
  | 'planned'
  | 'offered'
  | 'started'
  | 'completed'
  | 'skipped'
  | 'cancelled';

export const ACTIVITY_PLAN_STATUSES: readonly ActivityPlanStatus[] = [
  'planned',
  'offered',
  'started',
  'completed',
  'skipped',
  'cancelled',
];

export function isKnownActivityPlanStatus(value: unknown): value is ActivityPlanStatus {
  return typeof value === 'string' && (ACTIVITY_PLAN_STATUSES as readonly string[]).includes(value);
}

/** Valid status transitions; terminal states map to no outgoing edges. */
export const ACTIVITY_PLAN_TRANSITIONS: Record<ActivityPlanStatus, readonly ActivityPlanStatus[]> = {
  planned: ['offered', 'cancelled'],
  offered: ['started', 'skipped', 'cancelled'],
  started: ['completed', 'skipped', 'cancelled'],
  completed: [],
  skipped: [],
  cancelled: [],
};

/** Traceable pointer into Phase D/F1 state. References, never a copy. */
export interface ActivityEvidenceBasis {
  /** Capped real evidence IDs this plan was chosen from (oldest first). May be empty for pure learner requests. */
  evidenceIds: string[];
  /** `LearnerProfile.updatedAt` of the snapshot this was derived from. */
  profileUpdatedAt: string;
  ontologyVersion: string;
  aggregatorVersion: string;
  /** F1 need behind the goal, when the goal is evidence-derived. */
  needId: string | null;
  /** Goal origin, preserved so learner-requested plans never masquerade as diagnosed. */
  goalSource: GoalSource;
}

/**
 * An Activity Plan: one concrete learning action serving one active goal.
 * Every field is either an ID reference, a frozen-vocabulary value, or
 * bounded display text. Deliberately absent: mastery scores, capability
 * levels, weights, trajectories, or any second learner model.
 */
export interface ActivityPlan {
  /** Stable id: `plan_<uuid>`. */
  planId: string;
  /** The active F1 goal this serves (association preserved for later attribution). */
  goalId: string;
  /** The goal's canonical dedup key at plan time (traceability, not identity). */
  goalTargetKey: string;
  activityKind: ActivityKind;
  /** Existing problem identity (never generated, never invented). */
  problemId: string;
  problemTitle: string | null;
  intent: ActivityIntent;
  purpose: ActivityPurpose;
  /** Canonical Phase C entity IDs this activity targets (subset of the goal's, non-empty). */
  entityIds: string[];
  /** Frozen Phase D dimension this activity targets (the goal's dimension). */
  dimension: EvidenceDimension;
  /** Why this activity, citing goal + evidence (bounded, learner-readable). */
  rationale: string;
  evidenceBasis: ActivityEvidenceBasis;
  /** What future D evidence this activity is expected to produce (prose, bounded). */
  expectedEvidence: string;
  /** Which frozen evidence types would count (routing hint for the D seam, never a prediction). */
  expectedEvidenceTypes: EvidenceType[];
  /** ISO-8601 UTC creation timestamp. */
  createdAt: string;
  /** ISO-8601 UTC last-transition timestamp. */
  updatedAt: string;
  status: ActivityPlanStatus;
  /** Zero-based position within its sequence (0 for single-activity plans). */
  position: number;
  /** Length of the sequence this belongs to (1 for single-activity plans). */
  sequenceLength: number;
  /** Groups the plans of one planning call (`seq_<uuid>`; shared by the sequence). */
  sequenceId: string;
  /** The attempt started from this plan, once one exists. Null until linked. */
  linkedAttemptId: string | null;
  provenance: {
    ontologyVersion: string;
    aggregatorVersion: string;
    /** Catalog size at plan time (bounded provenance, not a candidate dump). */
    catalogSize: number;
  };
}

/** Strict AI-candidate wording: rationale/expected-evidence text ONLY. */
export interface ActivityWordingCandidate {
  rationale?: string;
  expectedEvidence?: string;
}

/** Bounds keep stored plan text finite; validators reject over-long input. */
export const MAX_PLAN_TEXT_CHARS = 280;
export const MAX_PLAN_RATIONALE_CHARS = 500;
export const MAX_PLAN_EVIDENCE_IDS = 12;
export const MAX_PLAN_SEQUENCE_LENGTH = 3;
export const MAX_PLAN_TITLE_CHARS = 160;
