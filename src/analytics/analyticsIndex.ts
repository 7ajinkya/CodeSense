import type { AnalyticsSnapshot } from './analyticsTypes';

/**
 * Phase H V1 — in-memory derived index (IDs only, never persisted).
 *
 * Only indexes required by actual V1 queries are built. Values are stable
 * ID strings pointing into the snapshot arrays — records are never
 * duplicated. Rebuilt per invocation and discarded.
 */

export interface AnalyticsIndex {
  attemptsByProblem: Map<string, string[]>;
  evidenceByEntity: Map<string, string[]>;
  evidenceByAttempt: Map<string, string[]>;
  evidenceByProblem: Map<string, string[]>;
  plansByGoal: Map<string, string[]>;
  progressByGoal: Map<string, string[]>;
  progressByPlan: Map<string, string[]>;
  reflectionsByAttempt: Map<string, string>;
  reflectionsByGoal: Map<string, string[]>;
  reflectionsByProblem: Map<string, string[]>;
  evaluationsByAttempt: Map<string, string[]>;
  classificationsByProblem: Map<string, string>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function buildAnalyticsIndex(snapshot: AnalyticsSnapshot): AnalyticsIndex {
  const attemptsByProblem = new Map<string, string[]>();
  for (const attempt of snapshot.attempts) {
    push(attemptsByProblem, attempt.problemId, attempt.attemptId);
  }
  const evidenceByEntity = new Map<string, string[]>();
  const evidenceByAttempt = new Map<string, string[]>();
  const evidenceByProblem = new Map<string, string[]>();
  for (const record of snapshot.evidence) {
    for (const entityId of record.entityIds) {
      push(evidenceByEntity, entityId, record.evidenceId);
    }
    if (record.attemptId !== null) {
      push(evidenceByAttempt, record.attemptId, record.evidenceId);
    }
    if (record.problemId !== null) {
      push(evidenceByProblem, record.problemId, record.evidenceId);
    }
  }
  const plansByGoal = new Map<string, string[]>();
  for (const plan of snapshot.plans) {
    push(plansByGoal, plan.goalId, plan.planId);
  }
  const progressByGoal = new Map<string, string[]>();
  const progressByPlan = new Map<string, string[]>();
  for (const record of snapshot.progress) {
    push(progressByGoal, record.goalId, record.progressId);
    push(progressByPlan, record.planId, record.progressId);
  }
  const reflectionsByAttempt = new Map<string, string>();
  const reflectionsByGoal = new Map<string, string[]>();
  const reflectionsByProblem = new Map<string, string[]>();
  for (const reflection of snapshot.reflections) {
    reflectionsByAttempt.set(reflection.provenance.attemptId, reflection.reflectionId);
    if (reflection.provenance.goalId !== null) {
      push(reflectionsByGoal, reflection.provenance.goalId, reflection.reflectionId);
    }
    push(reflectionsByProblem, reflection.provenance.problemId, reflection.reflectionId);
  }
  const evaluationsByAttempt = new Map<string, string[]>();
  for (const evaluation of snapshot.evaluations) {
    push(evaluationsByAttempt, evaluation.attemptId, evaluation.evaluationId);
  }
  const classificationsByProblem = new Map<string, string>();
  for (const classification of snapshot.classifications) {
    classificationsByProblem.set(classification.problemId, classification.problemId);
  }
  for (const list of [
    attemptsByProblem,
    evidenceByEntity,
    evidenceByAttempt,
    evidenceByProblem,
    plansByGoal,
    progressByGoal,
    progressByPlan,
    reflectionsByGoal,
    reflectionsByProblem,
    evaluationsByAttempt,
  ]) {
    for (const ids of list.values()) {
      ids.sort();
    }
  }
  return {
    attemptsByProblem,
    evidenceByEntity,
    evidenceByAttempt,
    evidenceByProblem,
    plansByGoal,
    progressByGoal,
    progressByPlan,
    reflectionsByAttempt,
    reflectionsByGoal,
    reflectionsByProblem,
    evaluationsByAttempt,
    classificationsByProblem,
  };
}
