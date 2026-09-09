import type { AnalyticsSnapshot, AnalyticsFilter } from './analyticsTypes';
import { filterAttempts, filterEvidence, goalChainForGoal } from './analyticsQueries';
import {
  activityFrequency,
  countAttemptsByOutcome,
  countEvidenceByType,
  countPlansByPurpose,
  countProgressBySignal,
  countReflectionsByStatus,
} from './analyticsAggregates';

/**
 * Phase H V1 — deterministic presentation builders (text only, no AI).
 * Every line cites stable IDs. Banned vocabulary (mastery %, scores,
 * grades, "advanced/beginner", "weak at") never appears here.
 */

function problemTitle(snapshot: AnalyticsSnapshot, problemId: string): string {
  return snapshot.problems.find((problem) => problem.problemId === problemId)?.title ?? problemId;
}

export function renderLearningHistory(snapshot: AnalyticsSnapshot, filter: AnalyticsFilter, now: string): string {
  const lines: string[] = [];
  lines.push('CodeSense Learning History');
  lines.push(`Scope: ${snapshot.completeness.scope} | Loaded at: ${snapshot.loadedAt}`);
  if (!snapshot.completeness.complete) {
    lines.push(`Note: partial history — ${snapshot.completeness.loadWarnings.join('; ')}`);
  }
  if (snapshot.attempts.length === 0 && snapshot.evidence.length === 0 && snapshot.goals.length === 0) {
    lines.push('No learning history yet. Start a problem to begin building history.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('--- Activity analytics (what was done) ---');
  for (const aggregate of [...countAttemptsByOutcome(snapshot, filter, now), ...activityFrequency(snapshot, filter, now)]) {
    lines.push(`- ${aggregate.label}: ${aggregate.value}`);
  }
  const attempts = filterAttempts(snapshot, filter);
  lines.push(`Completed attempts shown: ${attempts.filter((view) => view.attempt.completedAt !== null).length}`);
  for (const view of attempts.slice(0, 50)) {
    lines.push(
      `  - ${view.attempt.attemptId} — ${problemTitle(snapshot, view.attempt.problemId)} — ${view.attempt.currentState} — started ${view.attempt.startedAt} — knowledge: ${view.classificationStatus}`,
    );
  }
  lines.push('');
  lines.push('--- Learning/evidence analytics (what historical records exist) ---');
  for (const aggregate of [...countEvidenceByType(snapshot, filter, now), ...countProgressBySignal(snapshot, filter, now)]) {
    lines.push(`- ${aggregate.label}: ${aggregate.value}`);
  }
  const evidence = filterEvidence(snapshot, filter);
  if (evidence.length === 0) {
    lines.push('No evidence found for this filter.');
  } else {
    lines.push(`Evidence records shown: ${evidence.length}`);
    for (const record of evidence.slice(0, 50)) {
      lines.push(`  - ${record.evidenceId} — ${record.evidenceType} — ${record.entityIds.join(', ')} — ${record.timestamp}`);
    }
  }
  lines.push('');
  lines.push('--- Current learner-model state (what D currently believes) ---');
  if (!snapshot.profile) {
    lines.push('D has no stored learner-model profile yet (no current state to show).');
  } else {
    lines.push(`D profile updated at: ${snapshot.profile.updatedAt} | entities tracked: ${snapshot.profile.knowledgeStates.length}`);
    for (const state of snapshot.profile.knowledgeStates.slice(0, 20)) {
      lines.push(`  - ${state.entityId}: status ${state.status} (confidence ${state.statusConfidence}) — evidence ${state.evidenceCount}`);
    }
  }
  lines.push('');
  lines.push('--- F2 activity intent (plan distribution, not ability) ---');
  for (const aggregate of countPlansByPurpose(snapshot, filter, now)) {
    lines.push(`- ${aggregate.label}: ${aggregate.value}`);
  }
  lines.push('');
  lines.push('--- Reflection activity (response volume) ---');
  for (const aggregate of countReflectionsByStatus(snapshot, filter, now)) {
    lines.push(`- ${aggregate.label}: ${aggregate.value}`);
  }
  return lines.join('\n');
}

export function renderGoalProgress(snapshot: AnalyticsSnapshot, goalId: string): string {
  const chain = goalChainForGoal(snapshot, goalId);
  if (!chain) {
    return `No record found for goal ${goalId}.`;
  }
  const lines: string[] = [];
  lines.push(`Goal progress: ${chain.goal.description}`);
  lines.push(`Goal ${chain.goal.goalId} — [${chain.goal.status}/${chain.goalSource}] — dimension ${chain.goal.dimension} — target ${chain.goal.targetKey}`);
  if (chain.goal.progressBaseline) {
    lines.push(`Baseline captured at: ${chain.goal.progressBaseline.capturedAt} (profile ${chain.goal.progressBaseline.profileUpdatedAt})`);
  } else {
    lines.push('Baseline: none yet (goal has not been activated).');
  }
  lines.push(`Activity plans: ${chain.plans.length}`);
  for (const plan of chain.plans) {
    lines.push(
      `  - ${plan.planId} — ${plan.purpose}/${plan.intent} — [${plan.status}] — ${problemTitle(snapshot, plan.problemId)} — linked attempt ${plan.linkedAttemptId ?? 'none'} (created ${plan.createdAt})`,
    );
  }
  lines.push(`Progress evaluations: ${chain.progress.length}`);
  for (const record of chain.progress) {
    lines.push(
      `  - ${record.progressId} — signal ${record.progressSignal} — reassessment ${record.reassessment} — evaluated ${record.evaluatedAt} — explanation: ${record.explanation}`,
    );
  }
  if (chain.progress.length === 0) {
    lines.push('No progress evaluations recorded for this goal yet.');
  }
  lines.push(`Reflections linked to this goal: ${chain.reflectionIds.length === 0 ? 'none' : chain.reflectionIds.join(', ')}`);
  lines.push(`Post-baseline goal-local evidence records: ${chain.postBaselineEvidenceIds.length}`);
  return lines.join('\n');
}

export function renderEntityHistory(
  snapshot: AnalyticsSnapshot,
  entityId: string,
  graphHasEntity: (id: string) => boolean,
): string {
  const known = graphHasEntity(entityId);
  const evidence = snapshot.evidence
    .filter((record) => record.entityIds.includes(entityId))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
  const state = snapshot.profile?.knowledgeStates.find((candidate) => candidate.entityId === entityId) ?? null;
  const lines: string[] = [];
  lines.push(`Concept history: ${entityId}`);
  if (!known) {
    lines.push('Unknown in the current knowledge graph — historical records below are preserved as stored, not interpreted.');
  }
  lines.push('--- Current learner-model state (what D currently believes) ---');
  if (!state) {
    lines.push('D has no current state for this entity (distinct from no history — see evidence list).');
  } else {
    lines.push(`Status ${state.status} (confidence ${state.statusConfidence}) — updated ${state.updatedAt} — evidence ${state.evidenceCount}`);
  }
  lines.push('--- Historical evidence (chronological) ---');
  if (evidence.length === 0) {
    lines.push('No evidence found for this entity.');
  } else {
    for (const record of evidence) {
      lines.push(`  - ${record.evidenceId} — ${record.evidenceType} — ${record.timestamp} — attempt ${record.attemptId ?? 'n/a'} — ${record.observation}`);
    }
  }
  return lines.join('\n');
}

export function searchLearningHistory(
  snapshot: AnalyticsSnapshot,
  query: string,
): { problems: string[]; goals: string[]; reflections: string[]; evidence: string[] } {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return { problems: [], goals: [], reflections: [], evidence: [] };
  }
  return {
    problems: snapshot.problems
      .filter((problem) => (problem.title ?? '').toLowerCase().includes(needle) || problem.canonicalUrl.toLowerCase().includes(needle))
      .map((problem) => problem.problemId),
    goals: snapshot.goals
      .filter((goal) => goal.description.toLowerCase().includes(needle))
      .map((goal) => goal.goalId),
    reflections: snapshot.reflections
      .filter((reflection) => (reflection.freeText ?? '').toLowerCase().includes(needle))
      .map((reflection) => reflection.reflectionId),
    evidence: snapshot.evidence
      .filter(
        (record) =>
          record.observation.toLowerCase().includes(needle) || record.interpretation.toLowerCase().includes(needle),
      )
      .map((record) => record.evidenceId),
  };
}
