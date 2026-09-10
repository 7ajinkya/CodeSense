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
 * What kind of learning action this is. `coding-problem` covers practice
 * on an existing Problem (never generated, in Stage 0). `debugging-task`
 * covers a code-artifact debugging activity: the learner edits and runs
 * code exactly like a coding problem, so the existing attempt lifecycle,
 * telemetry, D evidence feeds, F3 attribution, and H history all apply
 * unchanged — only the task payload differs (broken code + reference fix
 * + tests instead of a problem statement). No second activity taxonomy is
 * created here; `micro-task` and any other kind remain rejected.
 */
export type ActivityKind = 'coding-problem' | 'debugging-task';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['coding-problem', 'debugging-task'];

export function isKnownActivityKind(value: unknown): value is ActivityKind {
  return value === 'coding-problem' || value === 'debugging-task';
}

/**
 * Kind-specific payload for `debugging-task` plans. The broken code is an
 * artifact to diagnose (not learner-authored evidence); the reference fix
 * and tests define what "fixed" means for future validation. Bounded like
 * every other stored plan field; validators reject over-long input.
 */
export interface DebuggingTaskPayload {
  /** The broken code the learner must diagnose (artifact, never evidence). */
  brokenSnapshot: string;
  /** Optional open-vocabulary fault label (`off-by-one`, ...). */
  faultKind?: string;
  /** Reference fixed code defining the accepted outcome. */
  referenceFix: string;
  /** Test descriptions defining what "fixed" means (prose, bounded). */
  tests: string[];
}

/** Bounds keep debugging payloads finite; validators reject over-long input. */
export const MAX_DEBUG_SNAPSHOT_CHARS = 6000;
export const MAX_DEBUG_TEXT_CHARS = 280;
export const MAX_DEBUG_TESTS = 24;
export const MAX_DEBUG_TEST_CHARS = 500;

function isNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isFaultKind(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEBUG_TEXT_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

/**
 * Strict validation for debugging-task payloads (store writes and future
 * generation seams). Returns the normalized payload or null — callers drop
 * invalid payloads loudly, never persist half-shaped plans. Pure function.
 */
export function validateDebuggingTaskPayload(raw: unknown): DebuggingTaskPayload | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!isNonBlankBounded(record.brokenSnapshot, MAX_DEBUG_SNAPSHOT_CHARS)) {
    return null;
  }
  if (!isNonBlankBounded(record.referenceFix, MAX_DEBUG_SNAPSHOT_CHARS)) {
    return null;
  }
  const tests: unknown = record.tests;
  if (
    !Array.isArray(tests) ||
    tests.length === 0 ||
    tests.length > MAX_DEBUG_TESTS ||
    tests.some((t: unknown) => !isNonBlankBounded(t, MAX_DEBUG_TEST_CHARS))
  ) {
    return null;
  }
  if (record.faultKind !== undefined && !isFaultKind(record.faultKind)) {
    return null;
  }
  return {
    brokenSnapshot: record.brokenSnapshot as string,
    ...(typeof record.faultKind === 'string' ? { faultKind: record.faultKind as string } : {}),
    referenceFix: record.referenceFix as string,
    tests: [...(tests as string[])],
  };
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
  /**
   * Problem context identity (never generated, never invented). For
   * `coding-problem` this is the practiced problem; for `debugging-task`
   * this is the problem whose code is being debugged, so the existing
   * `linkedAttemptId` problem-match validation applies unchanged.
   */
  problemId: string;
  problemTitle: string | null;
  /**
   * Kind-specific payload. Required exactly when `activityKind` is
   * `debugging-task`; forbidden on `coding-problem` (mirrors the frozen
   * conditional-field pattern, e.g. D `helpLevel`/`mistakeCategory`).
   */
  debugPayload?: DebuggingTaskPayload;
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
  /**
   * I-generation artifact filling this slot, when F2's request was served
   * by generation. Absent for catalog-selected activities. Attached only
   * via the I-4 seam (I-3-passed, execution-unverified candidates only);
   * the plan lifecycle and ownership stay entirely F2's.
   */
  generatedArtifact?: GeneratedArtifact;
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

/**
 * I-generation artifact attached to an F2 plan slot. Identity triple
 * (candidate/spec/request) plus the presentation content a future attempt
 * flow needs; debugging-task code content additionally mirrors into the
 * plan-native `debugPayload` so existing consumers see a normal debugging
 * plan. The artifact never duplicates plan ownership: kind must equal the
 * plan kind, and only an I-3-passed, execution-unverified candidate may be
 * attached (enforced by the I-4 seam, not here).
 */
export interface GeneratedArtifact {
  candidateId: string;
  specId: string;
  requestId: string;
  kind: ActivityKind;
  title: string;
  taskDescription: string;
}

/** Bounds keep generated artifacts finite; validators reject over-long input. */
export const MAX_GENERATED_ID_CHARS = 120;
export const MAX_GENERATED_TITLE_CHARS = 280;
export const MAX_GENERATED_STATEMENT_CHARS = 6000;

function isArtifactNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/**
 * Strict validation for a generated artifact against its plan kind.
 * Returns the normalized artifact or null. Pure function.
 */
export function validateGeneratedArtifact(raw: unknown, planKind: ActivityKind): GeneratedArtifact | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!isArtifactNonBlankBounded(record.candidateId, MAX_GENERATED_ID_CHARS)) {
    return null;
  }
  if (!isArtifactNonBlankBounded(record.specId, MAX_GENERATED_ID_CHARS)) {
    return null;
  }
  if (!isArtifactNonBlankBounded(record.requestId, MAX_GENERATED_ID_CHARS)) {
    return null;
  }
  if (record.kind !== planKind) {
    return null;
  }
  if (!isArtifactNonBlankBounded(record.title, MAX_GENERATED_TITLE_CHARS)) {
    return null;
  }
  if (!isArtifactNonBlankBounded(record.taskDescription, MAX_GENERATED_STATEMENT_CHARS)) {
    return null;
  }
  return {
    candidateId: record.candidateId as string,
    specId: record.specId as string,
    requestId: record.requestId as string,
    kind: planKind,
    title: record.title as string,
    taskDescription: record.taskDescription as string,
  };
}

/** Bounds keep stored plan text finite; validators reject over-long input. */
export const MAX_PLAN_TEXT_CHARS = 280;
export const MAX_PLAN_RATIONALE_CHARS = 500;
export const MAX_PLAN_EVIDENCE_IDS = 12;
export const MAX_PLAN_SEQUENCE_LENGTH = 3;
export const MAX_PLAN_TITLE_CHARS = 160;
