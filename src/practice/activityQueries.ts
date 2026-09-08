import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { ActivityPlan, ActivityPlanStatus } from './activityTypes';
import { evidenceForPlan } from './activityPlanner';

/**
 * Phase F2 consumer-facing plan retrieval. Pure functions over plan
 * lists (and evidence where noted) — the same style as Phase D/F1
 * queries. Never throws on empty input.
 */

export const MAX_PLAN_DIGEST_CHARS = 200;

export function getPlan(plans: ActivityPlan[], planId: string): ActivityPlan | null {
  return plans.find((p) => p.planId === planId) ?? null;
}

export function getPlansForGoal(plans: ActivityPlan[], goalId: string): ActivityPlan[] {
  return plans
    .filter((p) => p.goalId === goalId)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

export function getPlansByStatus(plans: ActivityPlan[], status: ActivityPlanStatus): ActivityPlan[] {
  return plans
    .filter((p) => p.status === status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
}

/** Plans still in flight for a goal (planned/offered/started). */
export function getActivePlansForGoal(plans: ActivityPlan[], goalId: string): ActivityPlan[] {
  return plans
    .filter(
      (p) =>
        p.goalId === goalId && (p.status === 'planned' || p.status === 'offered' || p.status === 'started'),
    )
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

/** Latest plan for a goal, if any (by creation time, then position). */
export function getLatestPlanForGoal(plans: ActivityPlan[], goalId: string): ActivityPlan | null {
  const mine = getPlansForGoal(plans, goalId);
  if (mine.length === 0) {
    return null;
  }
  return mine[mine.length - 1] ?? null;
}

export interface LearnerFacingPlan {
  /** What are we doing? */
  title: string;
  /** Why are we doing it? (the plan rationale, bounded). */
  why: string;
  /** Diagnostic or instructional, in learner words. */
  purposeLabel: string;
  /** Which goal this supports (caller-supplied description). */
  goalDescription: string | null;
  /** How many activities are planned, when known. */
  positionLabel: string;
  /** What comes next, when known (next plan's title or null). */
  nextPreview: string | null;
  /** What evidence this activity is expected to produce (prose). */
  expectedSignal: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Learner-facing summary answering what/why/diagnostic-or-instructional/
 * goal/next. Pure view-model over one plan + its siblings + the goal
 * description — the underlying plan already carries everything the UI
 * needs, so adaptive behavior stays visible instead of arbitrary.
 */
export function summarizePlanForLearner(
  plan: ActivityPlan,
  args: { goalDescription?: string; siblingPlans?: ActivityPlan[] },
): LearnerFacingPlan {
  const title = plan.problemTitle ?? plan.problemId;
  const purposeLabel =
    plan.purpose === 'diagnostic'
      ? 'Diagnostic — checking what is actually going on'
      : 'Instructional — targeted practice for the goal';
  const positionLabel =
    plan.sequenceLength > 1 ? `Step ${plan.position + 1} of ${plan.sequenceLength}` : 'Single activity';
  let nextPreview: string | null = null;
  const siblings = (args.siblingPlans ?? []).filter(
    (p) => p.sequenceId === plan.sequenceId && p.planId !== plan.planId && p.position === plan.position + 1,
  );
  if (siblings.length > 0) {
    const next = siblings[0];
    if (next) {
      nextPreview = next.problemTitle ?? next.problemId;
    }
  }
  return {
    title: clip(title, MAX_PLAN_DIGEST_CHARS),
    why: clip(plan.rationale, MAX_PLAN_DIGEST_CHARS),
    purposeLabel,
    goalDescription: args.goalDescription !== undefined ? clip(args.goalDescription, MAX_PLAN_DIGEST_CHARS) : null,
    positionLabel,
    nextPreview: nextPreview !== null ? clip(nextPreview, MAX_PLAN_DIGEST_CHARS) : null,
    expectedSignal: clip(plan.expectedEvidence, MAX_PLAN_DIGEST_CHARS),
  };
}

/** One-line digest list for an active goal (bounded, stable order). */
export function summarizePlansForGoal(
  plans: ActivityPlan[],
  goalId: string,
  goalDescription?: string,
): LearnerFacingPlan[] {
  return getPlansForGoal(plans, goalId).map((plan) =>
    summarizePlanForLearner(plan, { goalDescription, siblingPlans: plans }),
  );
}

/** Re-export the plan↔evidence seam for callers that only import queries. */
export { evidenceForPlan };

/** Evidence produced through a plan (delegates to the planner seam). */
export function getEvidenceForPlan(evidence: LearnerEvidence[], plan: ActivityPlan): LearnerEvidence[] {
  return evidenceForPlan(evidence, plan);
}
