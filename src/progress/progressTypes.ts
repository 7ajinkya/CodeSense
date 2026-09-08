import type { EvidenceDimension, HelpLevel } from '../learner/learnerTypes';
import type { GoalSource } from '../goals/goalTypes';
import type { ActivityIntent, ActivityPurpose } from '../practice/activityTypes';

/**
 * Phase F3 progress domain types: goal-relative interpretation of newly
 * produced evidence.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - Phase C owns knowledge: records reference canonical entity IDs only,
 *   validated against the live graph. No duplicate taxonomy.
 * - Phase D owns evidence and capability: polarity (positive/negative)
 *   is read from D's dimension lists, levels are compared with D's rank,
 *   help levels reuse D's vocabulary. F3 stores NO assessment of its own —
 *   only references to D records plus the derived transparent signal.
 * - Phase F1 owns goals and baselines: progress points at the goal's
 *   baseline, never copies or rewrites it. F3 never transitions goals.
 * - Phase F2 owns activity plans and planning: progress points at the
 *   plan, never re-plans. F2 remains the sole decider of what comes next.
 * - Phase E owns current-attempt coaching; F3 operates afterward, on the
 *   completed attempt, and never coaches.
 *
 * Identity: single local learner, same as Phase D/F1/F2 (`local-learner`).
 * Everything here is plain JSON-serializable data persisted local-first.
 */

export const PROGRESS_SCHEMA_VERSION = 1;
export const PROGRESS_ID_PREFIX = 'prog_';

/**
 * What the newly completed activity tells us relative to the goal.
 * Small, transparent, non-numeric — every member is explainable through
 * underlying D evidence. These are NOT mastery levels: the same label on
 * two goals never means "equal capability".
 */
export type ProgressSignal =
  | 'NO_NEW_EVIDENCE'
  | 'EVIDENCE_ADDED'
  | 'IMPROVING'
  | 'STILL_STRUGGLING'
  | 'MIXED_SIGNAL'
  | 'UNCERTAINTY_REDUCED'
  | 'REGRESSION_SIGNAL'
  | 'SUFFICIENT_EVIDENCE_FOR_REVIEW';

export const PROGRESS_SIGNALS: readonly ProgressSignal[] = [
  'NO_NEW_EVIDENCE',
  'EVIDENCE_ADDED',
  'IMPROVING',
  'STILL_STRUGGLING',
  'MIXED_SIGNAL',
  'UNCERTAINTY_REDUCED',
  'REGRESSION_SIGNAL',
  'SUFFICIENT_EVIDENCE_FOR_REVIEW',
];

export function isKnownProgressSignal(value: unknown): value is ProgressSignal {
  return typeof value === 'string' && (PROGRESS_SIGNALS as readonly string[]).includes(value);
}

/**
 * What should happen with the goal. Advisory to the learner (via surface)
 * and to F2 (via the digest seam) — F3 never transitions goals itself.
 * Learner-owned lifecycle stays F1's responsibility.
 */
export type ReassessmentSignal =
  | 'continue'
  | 'gather-more-evidence'
  | 'review-goal'
  | 'sufficient-evidence-for-review';

export const REASSESSMENT_SIGNALS: readonly ReassessmentSignal[] = [
  'continue',
  'gather-more-evidence',
  'review-goal',
  'sufficient-evidence-for-review',
];

export function isKnownReassessmentSignal(value: unknown): value is ReassessmentSignal {
  return typeof value === 'string' && (REASSESSMENT_SIGNALS as readonly string[]).includes(value);
}

/**
 * Why an evaluation could not produce a progress signal. Explicit and
 * conservative: missing linkage, unfinished work, or orphaned references
 * never become invented progress.
 */
export type ProgressPendingKind =
  | 'pending-evidence'
  | 'not-evaluable'
  | 'orphaned';

export const PROGRESS_PENDING_KINDS: readonly ProgressPendingKind[] = [
  'pending-evidence',
  'not-evaluable',
  'orphaned',
];

export function isKnownProgressPendingKind(value: unknown): value is ProgressPendingKind {
  return typeof value === 'string' && (PROGRESS_PENDING_KINDS as readonly string[]).includes(value);
}

/** Per-entity goal-dimension movement: baseline level vs current D level. */
export interface EntityProgressDetail {
  entityId: string;
  /** Baseline level name at goal activation (`UNKNOWN` when unobserved then). */
  baselineLevel: string;
  baselineConfidence: string;
  /** Current D level name, or null when D has no state for the entity. */
  currentLevel: string | null;
  currentConfidence: string | null;
  /** New activity-attributed positive goal-dimension evidence IDs. */
  positiveNewIds: string[];
  /** New activity-attributed negative goal-dimension evidence IDs. */
  negativeNewIds: string[];
}

/**
 * Independence facet of the evaluated activity, derived from D's own
 * help/independence records (INDEPENDENT_SUCCESS vs HELP_REQUIRED with
 * D help levels). Reported, never re-scored: helped success does not
 * establish independence.
 */
export interface IndependenceFacet {
  /** Activity produced independent-success evidence on a goal entity. */
  independent: boolean;
  /** Activity produced help-required evidence on a goal entity. */
  helped: boolean;
  /** D help levels observed (sorted, unique; empty when none). */
  helpLevels: HelpLevel[];
  independentEvidenceIds: string[];
  helpEvidenceIds: string[];
}

/** One revision of a progress entry (late-arriving evidence stays auditable). */
export interface ProgressRevision {
  evaluatedAt: string;
  progressSignal: ProgressSignal;
  reassessment: ReassessmentSignal;
  evidenceFingerprint: string;
}

/**
 * Goal-relative progress for one evaluated activity plan. Compact by
 * design: ID references, a per-entity movement sketch, the independence
 * facet, the two signals, and a deterministic explanation. Deliberately
 * absent: learner-model copies, baselines (referenced, not stored),
 * mastery scores, and any planning decision.
 */
export interface ActivityProgress {
  /** Stable id: `prog_<hash(goalId|planId|linkedAttemptId)>` — reprocessing upserts, never duplicates. */
  progressId: string;
  goalId: string;
  goalTargetKey: string;
  planId: string;
  linkedAttemptId: string | null;
  /** Goal origin, preserved so learner-requested progress never masquerades as diagnosed. */
  goalSource: GoalSource;
  /** Goal dimension this progress speaks to (the goal's dimension). */
  dimension: EvidenceDimension;
  /** The evaluated activity's targeting snapshot (bounded provenance, not a model copy). */
  activity: {
    intent: ActivityIntent;
    purpose: ActivityPurpose;
    entityIds: string[];
    problemId: string;
    problemTitle: string | null;
  };
  /** Pointer at the immutable F1 baseline (never a copy of it). */
  baselineRef: {
    capturedAt: string;
    profileUpdatedAt: string;
  };
  /** Strong attribution: linked-attempt records (sorted). */
  activityEvidenceIds: string[];
  /** Weak attribution: unlinked same-problem goal-local records (sorted). */
  weakEvidenceIds: string[];
  /** Post-baseline goal-local evidence IDs known at evaluation (sorted, capped). */
  goalRelevantNewIds: string[];
  entities: EntityProgressDetail[];
  independence: IndependenceFacet;
  /** New activity-attributed positive goal-dimension evidence IDs (sorted, capped). */
  positiveNewIds: string[];
  /** New activity-attributed negative goal-dimension evidence IDs (sorted, capped). */
  negativeNewIds: string[];
  progressSignal: ProgressSignal;
  reassessment: ReassessmentSignal;
  /** Deterministic learner-readable explanation citing real evidence IDs. */
  explanation: string;
  /** ISO-8601 UTC first-evaluation timestamp. */
  firstEvaluatedAt: string;
  /** ISO-8601 UTC latest-evaluation timestamp. */
  evaluatedAt: string;
  /** How many times this activity has been (re)evaluated. */
  evaluationCount: number;
  /** Sorted activity-evidence IDs + profile marker; unchanged input → unchanged entry. */
  evidenceFingerprint: string;
  /** Prior signals for this same activity (late evidence stays auditable, newest last, capped). */
  signalHistory: ProgressRevision[];
  provenance: {
    ontologyVersion: string;
    aggregatorVersion: string;
  };
}

/** Bounds keep stored progress finite; validators reject over-long input. */
export const MAX_PROGRESS_TEXT_CHARS = 280;
export const MAX_PROGRESS_EXPLANATION_CHARS = 600;
export const MAX_PROGRESS_EVIDENCE_IDS = 24;
export const MAX_PROGRESS_HISTORY_ENTRIES = 8;
