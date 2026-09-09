import { ANALYTICS_EXPORT_VERSION } from './analyticsTypes';
import type { AnalyticsFilter, AnalyticsSnapshot } from './analyticsTypes';
import {
  activityFrequency,
  countAttemptsByOutcome,
  countEvidenceByType,
  countPlansByPurpose,
  countProgressBySignal,
  countReflectionsByStatus,
  helpLevelBreakdown,
  practiceCoverage,
} from './analyticsAggregates';

/**
 * Phase H V1 — export (JSON + Markdown only).
 *
 * Exports clearly separate persisted/raw historical records from
 * deterministic derived analytics. Stable IDs and provenance preserved.
 * No code snapshots, no full conversation text in V1 exports.
 */

export interface LearningHistoryExport {
  exportVersion: number;
  exportedAt: string;
  filter: AnalyticsFilter;
  completeness: AnalyticsSnapshot['completeness'];
  ontologyVersion: string;
  aggregatorVersion: string;
  raw: {
    problems: AnalyticsSnapshot['problems'];
    attempts: AnalyticsSnapshot['attempts'];
    classifications: AnalyticsSnapshot['classifications'];
    evidence: AnalyticsSnapshot['evidence'];
    goals: AnalyticsSnapshot['goals'];
    plans: AnalyticsSnapshot['plans'];
    progress: AnalyticsSnapshot['progress'];
    reflections: AnalyticsSnapshot['reflections'];
    evaluations: AnalyticsSnapshot['evaluations'];
    conversationCounts: AnalyticsSnapshot['conversationCounts'];
    sessions: AnalyticsSnapshot['sessions'];
    profile: AnalyticsSnapshot['profile'];
  };
  derived: {
    aggregates: ReturnType<typeof countAttemptsByOutcome>;
    note: string;
  };
  unresolvedIds: string[];
}

export function exportAnalyticsJson(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): LearningHistoryExport {
  const aggregates = [
    ...countAttemptsByOutcome(snapshot, filter, now),
    ...countEvidenceByType(snapshot, filter, now),
    ...countProgressBySignal(snapshot, filter, now),
    ...countReflectionsByStatus(snapshot, filter, now),
    ...countPlansByPurpose(snapshot, filter, now),
    ...activityFrequency(snapshot, filter, now),
    ...practiceCoverage(snapshot, filter, now),
    ...helpLevelBreakdown(snapshot, filter, now),
  ];
  return {
    exportVersion: ANALYTICS_EXPORT_VERSION,
    exportedAt: now,
    filter,
    completeness: snapshot.completeness,
    ontologyVersion: snapshot.ontologyVersion,
    aggregatorVersion: snapshot.aggregatorVersion,
    raw: {
      problems: snapshot.problems,
      attempts: snapshot.attempts,
      classifications: snapshot.classifications,
      evidence: snapshot.evidence,
      goals: snapshot.goals,
      plans: snapshot.plans,
      progress: snapshot.progress,
      reflections: snapshot.reflections,
      evaluations: snapshot.evaluations,
      conversationCounts: snapshot.conversationCounts,
      sessions: snapshot.sessions,
      profile: snapshot.profile,
    },
    derived: {
      aggregates,
      note: 'Derived analytics are deterministic counts over the raw records above (same window/filter). They are not learner-model assessments.',
    },
    unresolvedIds: [...snapshot.unresolvedIds],
  };
}

/** Every exported fact traceable: IDs + ISO timestamps cited inline. */
export function exportAnalyticsMarkdown(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): string {
  const exported = exportAnalyticsJson(snapshot, filter, now);
  const lines: string[] = [];
  lines.push('# CodeSense Learning History Export');
  lines.push('');
  lines.push(`Exported at: ${exported.exportedAt}`);
  lines.push(`Ontology: ${exported.ontologyVersion} | Aggregator: ${exported.aggregatorVersion}`);
  lines.push(`Scope: ${exported.completeness.scope} | Complete: ${exported.completeness.complete ? 'yes' : 'no'}`);
  if (exported.completeness.loadWarnings.length > 0) {
    lines.push(`Load warnings: ${exported.completeness.loadWarnings.join('; ')}`);
  }
  lines.push('');
  lines.push('## Historical records (persisted, as stored)');
  lines.push('');
  lines.push(`Problems: ${exported.raw.problems.length}`);
  for (const problem of exported.raw.problems) {
    lines.push(`- ${problem.problemId} — ${problem.title ?? problem.canonicalUrl} (${problem.canonicalUrl})`);
  }
  lines.push('');
  lines.push(`Attempts: ${exported.raw.attempts.length}`);
  for (const attempt of exported.raw.attempts) {
    lines.push(
      `- ${attempt.attemptId} — problem ${attempt.problemId} — ${attempt.currentState} — started ${attempt.startedAt} — completed ${attempt.completedAt ?? 'active'}`,
    );
  }
  lines.push('');
  lines.push(`Evidence records: ${exported.raw.evidence.length}`);
  for (const record of exported.raw.evidence) {
    lines.push(
      `- ${record.evidenceId} — ${record.evidenceType} — entities ${record.entityIds.join(', ')} — ${record.timestamp} — attempt ${record.attemptId ?? 'n/a'} (observation: ${record.observation})`,
    );
  }
  lines.push('');
  lines.push(`Goals: ${exported.raw.goals.length}`);
  for (const goal of exported.raw.goals) {
    lines.push(`- ${goal.goalId} — [${goal.status}/${goal.source}] ${goal.description} (target ${goal.targetKey})`);
  }
  lines.push('');
  lines.push(`Activity plans: ${exported.raw.plans.length}`);
  for (const plan of exported.raw.plans) {
    lines.push(
      `- ${plan.planId} — goal ${plan.goalId} — ${plan.purpose}/${plan.intent} — [${plan.status}] — problem ${plan.problemId} — linked attempt ${plan.linkedAttemptId ?? 'none'}`,
    );
  }
  lines.push('');
  lines.push(`Progress evaluations: ${exported.raw.progress.length}`);
  for (const record of exported.raw.progress) {
    lines.push(
      `- ${record.progressId} — goal ${record.goalId} — signal ${record.progressSignal} — reassessment ${record.reassessment} — evaluated ${record.evaluatedAt} (attempt ${record.linkedAttemptId ?? 'none'})`,
    );
  }
  lines.push('');
  lines.push(`Reflections: ${exported.raw.reflections.length}`);
  for (const reflection of exported.raw.reflections) {
    lines.push(
      `- ${reflection.reflectionId} — [${reflection.status}] category ${reflection.category ?? 'none'} — attempt ${reflection.provenance.attemptId} — evidence ${reflection.evidenceIds.length === 0 ? 'none' : reflection.evidenceIds.join(', ')}${reflection.freeText ? ` — "${reflection.freeText}"` : ''}`,
    );
  }
  lines.push('');
  lines.push('## Derived analytics (deterministic counts, same window/filter)');
  lines.push('');
  lines.push(exported.derived.note);
  for (const aggregate of exported.derived.aggregates) {
    lines.push(`- ${aggregate.label}: ${aggregate.value} (sources: ${aggregate.provenance.sourceIds.length})`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Export carries provenance when every aggregate cites at least its computation inputs. */
export function validateExportProvenance(exported: LearningHistoryExport): boolean {
  for (const aggregate of exported.derived.aggregates) {
    if (!aggregate.provenance || aggregate.provenance.sourceIds === undefined) {
      return false;
    }
    if (aggregate.provenance.ontologyVersion !== exported.ontologyVersion) {
      return false;
    }
  }
  return true;
}
