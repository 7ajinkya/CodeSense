import { ACTIVITY_PLAN_TRANSITIONS } from './activityTypes';
import type { ActivityPlan, ActivityPlanStatus } from './activityTypes';
import type { Attempt } from '../attempts/attempt';

/**
 * Phase F2 activity lifecycle: pure status transitions plus the
 * plan↔attempt link. Invalid transitions throw (repo convention, cf.
 * `transitionGoalStatus` / `transitionAttemptState`) so misuse surfaces
 * loudly instead of silently corrupting plan state.
 *
 * A plan is never an attempt: linking records which attempt arose from
 * which plan; the attempt lifecycle stays authoritative for execution.
 */

export function transitionPlanStatus(plan: ActivityPlan, to: ActivityPlanStatus, now: string): ActivityPlan {
  const allowed = ACTIVITY_PLAN_TRANSITIONS[plan.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid activity plan transition: ${plan.status} → ${to} (plan ${plan.planId}).`);
  }
  return {
    ...plan,
    status: to,
    updatedAt: now,
    entityIds: [...plan.entityIds],
    expectedEvidenceTypes: [...plan.expectedEvidenceTypes],
    evidenceBasis: { ...plan.evidenceBasis, evidenceIds: [...plan.evidenceBasis.evidenceIds] },
    provenance: { ...plan.provenance },
  };
}

/** Surface a planned activity to the learner (planned → offered). */
export function offerPlan(plan: ActivityPlan, now: string): ActivityPlan {
  return transitionPlanStatus(plan, 'offered', now);
}

/** Learner begins the offered activity (offered → started). */
export function startPlan(plan: ActivityPlan, now: string): ActivityPlan {
  return transitionPlanStatus(plan, 'started', now);
}

/** Activity finished from the learner's side (started → completed). */
export function completePlan(plan: ActivityPlan, now: string): ActivityPlan {
  return transitionPlanStatus(plan, 'completed', now);
}

/** Learner skips the activity (offered/started → skipped). */
export function skipPlan(plan: ActivityPlan, now: string): ActivityPlan {
  return transitionPlanStatus(plan, 'skipped', now);
}

/** Planner/learner withdraws the activity (planned/offered/started → cancelled). */
export function cancelPlan(plan: ActivityPlan, now: string): ActivityPlan {
  return transitionPlanStatus(plan, 'cancelled', now);
}

/**
 * Link the attempt that arose from this plan. Validates the problem
 * match (mixed plan/attempt records are a corruption risk, so this
 * throws) and never touches the attempt itself — the attempt lifecycle
 * remains the single authority on execution state.
 */
export function linkAttemptToPlan(plan: ActivityPlan, attempt: Attempt, now: string): ActivityPlan {
  if (attempt.problemId !== plan.problemId) {
    throw new Error(
      `Cannot link attempt ${attempt.attemptId} (problem ${attempt.problemId}) to plan ${plan.planId} (problem ${plan.problemId}).`,
    );
  }
  return {
    ...plan,
    linkedAttemptId: attempt.attemptId,
    updatedAt: now,
    entityIds: [...plan.entityIds],
    expectedEvidenceTypes: [...plan.expectedEvidenceTypes],
    evidenceBasis: { ...plan.evidenceBasis, evidenceIds: [...plan.evidenceBasis.evidenceIds] },
    provenance: { ...plan.provenance },
  };
}
