import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { ActivityProgress, ProgressSignal, ReassessmentSignal } from './progressTypes';

/**
 * Phase F3 consumer-facing progress retrieval. Pure functions over
 * progress lists — the same style as Phase D/F1/F2 queries. Never throws
 * on empty input.
 *
 * The F2 seam lives here: `buildPlannerDigest` compacts the latest
 * goal-relative picture into bounded, reference-only input a future
 * planning call can read. F3 never selects the next activity — F2 does.
 */

export const MAX_PROGRESS_DIGEST_CHARS = 200;

export function getProgress(progresses: ActivityProgress[], progressId: string): ActivityProgress | null {
  return progresses.find((p) => p.progressId === progressId) ?? null;
}

/** Chronological progress history for one goal (one entry per evaluated activity, oldest first). */
export function getProgressHistoryForGoal(progresses: ActivityProgress[], goalId: string): ActivityProgress[] {
  return progresses
    .filter((p) => p.goalId === goalId)
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
}

export function getProgressForPlan(progresses: ActivityProgress[], planId: string): ActivityProgress[] {
  return progresses
    .filter((p) => p.planId === planId)
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
}

/** Latest evaluated progress for a goal, if any. */
export function getLatestProgressForGoal(
  progresses: ActivityProgress[],
  goalId: string,
): ActivityProgress | null {
  const history = getProgressHistoryForGoal(progresses, goalId);
  if (history.length === 0) {
    return null;
  }
  return history[history.length - 1] ?? null;
}

export interface PlannerDigest {
  goalId: string;
  /** Latest progress signal for the goal (null when nothing evaluated yet). */
  latestSignal: ProgressSignal | null;
  /** Latest reassessment for the goal (null when nothing evaluated yet). */
  latestReassessment: ReassessmentSignal | null;
  /** Distinct activities evaluated for this goal. */
  evaluatedActivities: number;
  /** Distinct activities with positive-only new goal-dimension evidence. */
  positiveActivities: number;
  /** Distinct activities with struggle-consistent new evidence. */
  strugglingActivities: number;
  /** Latest evaluation timestamp (null when nothing evaluated yet). */
  lastEvaluatedAt: string | null;
  /** Evidence IDs behind the latest entry (bounded, sorted). */
  latestEvidenceIds: string[];
}

/**
 * Compact F2 input: what the last activities taught us about this goal,
 * as counts and the latest signal — never a capability score, never a
 * planning decision. F2 combines this with the goal, D state, and prior
 * plans to choose what comes next.
 */
export function buildPlannerDigest(progresses: ActivityProgress[], goalId: string): PlannerDigest {
  const history = getProgressHistoryForGoal(progresses, goalId);
  const latest = history.length > 0 ? history[history.length - 1] ?? null : null;
  const distinctPlans = new Set(history.map((entry) => entry.planId));
  const positivePlans = new Set(
    history
      .filter((entry) => entry.positiveNewIds.length > 0 && entry.negativeNewIds.length === 0)
      .map((entry) => entry.planId),
  );
  const strugglingPlans = new Set(
    history
      .filter((entry) => entry.progressSignal === 'STILL_STRUGGLING')
      .map((entry) => entry.planId),
  );
  return {
    goalId,
    latestSignal: latest ? latest.progressSignal : null,
    latestReassessment: latest ? latest.reassessment : null,
    evaluatedActivities: distinctPlans.size,
    positiveActivities: positivePlans.size,
    strugglingActivities: strugglingPlans.size,
    lastEvaluatedAt: latest ? latest.evaluatedAt : null,
    latestEvidenceIds: latest
      ? [...latest.activityEvidenceIds, ...latest.weakEvidenceIds].sort().slice(0, 24)
      : [],
  };
}

export interface LearnerFacingProgress {
  /** Which goal this progress belongs to (caller-supplied description). */
  goalDescription: string | null;
  /** What happened, in learner words (bounded explanation). */
  summary: string;
  /** The transparent signal name (never a percentage or score). */
  signal: ProgressSignal;
  /** What CodeSense suggests happens next (advisory — the learner decides goals). */
  nextStep: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function nextStepFor(reassessment: ReassessmentSignal): string {
  switch (reassessment) {
    case 'continue':
      return 'Keep practicing this goal — the next activity builds on this.';
    case 'gather-more-evidence':
      return 'More practice is needed before judging progress on this goal.';
    case 'review-goal':
      return 'Worth reviewing this goal together — the evidence points somewhere unexpected.';
    case 'sufficient-evidence-for-review':
      return 'Enough encouraging evidence to ask whether this goal is addressed — your call.';
  }
}

/**
 * Learner-facing progress summary: what the completed activity taught us
 * about the goal and what is suggested next. Pure view-model — the
 * underlying record already carries everything the UI needs.
 */
export function summarizeProgressForLearner(
  progress: ActivityProgress,
  args: { goalDescription?: string },
): LearnerFacingProgress {
  return {
    goalDescription:
      args.goalDescription !== undefined ? clip(args.goalDescription, MAX_PROGRESS_DIGEST_CHARS) : null,
    summary: clip(progress.explanation, MAX_PROGRESS_DIGEST_CHARS),
    signal: progress.progressSignal,
    nextStep: nextStepFor(progress.reassessment),
  };
}

/** Evidence IDs cited across a goal's progress history (audit helper, sorted, unique). */
export function citedEvidenceForGoal(progresses: ActivityProgress[], goalId: string): string[] {
  const out = new Set<string>();
  for (const entry of getProgressHistoryForGoal(progresses, goalId)) {
    for (const id of [...entry.activityEvidenceIds, ...entry.weakEvidenceIds]) {
      out.add(id);
    }
  }
  return [...out].sort();
}

/** Verify every evidence ID a progress entry cites actually exists (traceability check). */
export function progressEvidenceIsTraceable(entry: ActivityProgress, evidence: LearnerEvidence[]): boolean {
  const known = new Set(evidence.map((record) => record.evidenceId));
  return [...entry.activityEvidenceIds, ...entry.weakEvidenceIds].every((id) => known.has(id));
}
