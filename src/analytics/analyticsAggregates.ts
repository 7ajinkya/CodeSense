import type {
  AggregateCount,
  AggregateProvenance,
  AnalyticsFilter,
  AnalyticsSnapshot,
} from './analyticsTypes';

/**
 * Phase H V1 — deterministic aggregates (pure counts with provenance).
 *
 * Family labels are load-bearing:
 * - activity: what the learner did (attempts/week, activity streaks, ...).
 * - evidence: what historical records exist (evidence/progress signals, ...).
 * - current-model: reused D rollups only (H never recomputes belief).
 *
 * Banned here: mastery %, skill scores, grades, verdict adjectives.
 * Coverage is "practice/exposure coverage", streaks are "activity streaks",
 * diagnostic/instructional counts describe F2 intent, never ability.
 */

function stableFilterHash(filter: AnalyticsFilter): string {
  const normalized = {
    problemIds: [...(filter.problemIds ?? [])].sort(),
    entityIds: [...(filter.entityIds ?? [])].sort(),
    goalIds: [...(filter.goalIds ?? [])].sort(),
    planIds: [...(filter.planIds ?? [])].sort(),
    attemptIds: [...(filter.attemptIds ?? [])].sort(),
    from: filter.from ?? null,
    to: filter.to ?? null,
    outcomes: [...(filter.outcomes ?? [])].sort(),
    evidenceTypes: [...(filter.evidenceTypes ?? [])].sort(),
    evidenceDimensions: [...(filter.evidenceDimensions ?? [])].sort(),
    evidenceSources: [...(filter.evidenceSources ?? [])].sort(),
    evidenceConfidences: [...(filter.evidenceConfidences ?? [])].sort(),
    helpLevels: [...(filter.helpLevels ?? [])].sort(),
    progressSignals: [...(filter.progressSignals ?? [])].sort(),
    reflectionCategories: [...(filter.reflectionCategories ?? [])].sort(),
    purposes: [...(filter.purposes ?? [])].sort(),
    intents: [...(filter.intents ?? [])].sort(),
    goalStatuses: [...(filter.goalStatuses ?? [])].sort(),
    textQuery: (filter.textQuery ?? '').trim(),
  };
  return JSON.stringify(normalized);
}

function provenanceFor(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  sourceIds: string[],
  now: string,
): AggregateProvenance {
  return {
    window: { from: filter.from ?? null, to: filter.to ?? null },
    filterHash: stableFilterHash(filter),
    sourceIds: [...sourceIds].sort(),
    computedAt: now,
    ontologyVersion: snapshot.ontologyVersion,
    aggregatorVersion: snapshot.aggregatorVersion,
  };
}

function inWindow(timestamp: string, filter: AnalyticsFilter): boolean {
  if (filter.from !== undefined && filter.from !== '' && timestamp.localeCompare(filter.from) < 0) {
    return false;
  }
  if (filter.to !== undefined && filter.to !== '' && timestamp.localeCompare(filter.to) > 0) {
    return false;
  }
  return true;
}

/** Activity: completed attempts by learner-reported outcome (raw counts). */
export function countAttemptsByOutcome(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const scoped = snapshot.attempts.filter(
    (attempt) =>
      attempt.completedAt !== null &&
      inWindow(attempt.startedAt, filter) &&
      ((filter.problemIds ?? []).length === 0 || (filter.problemIds as string[]).includes(attempt.problemId)) &&
      ((filter.attemptIds ?? []).length === 0 || (filter.attemptIds as string[]).includes(attempt.attemptId)),
  );
  const byOutcome = new Map<string, { count: number; ids: string[] }>();
  for (const attempt of scoped) {
    const entry = byOutcome.get(attempt.currentState) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(attempt.attemptId);
    byOutcome.set(attempt.currentState, entry);
  }
  return [...byOutcome.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([outcome, entry]) => ({
      key: `attempts.by-outcome.${outcome}`,
      label: `Completed attempts with outcome "${outcome}" (activity)`,
      family: 'activity' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}

/** Evidence: historical evidence records by EvidenceType (counts, not ability). */
export function countEvidenceByType(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const scoped = snapshot.evidence.filter((record) => inWindow(record.timestamp, filter));
  const byType = new Map<string, { count: number; ids: string[] }>();
  for (const record of scoped) {
    const entry = byType.get(record.evidenceType) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(record.evidenceId);
    byType.set(record.evidenceType, entry);
  }
  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, entry]) => ({
      key: `evidence.by-type.${type}`,
      label: `Historical evidence records of type ${type} (evidence)`,
      family: 'evidence' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}

/** Evidence: progress signals observed per goal history (counts, not mastery). */
export function countProgressBySignal(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const scoped = snapshot.progress.filter((record) => inWindow(record.evaluatedAt, filter));
  const bySignal = new Map<string, { count: number; ids: string[] }>();
  for (const record of scoped) {
    const entry = bySignal.get(record.progressSignal) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(record.progressId);
    bySignal.set(record.progressSignal, entry);
  }
  return [...bySignal.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([signal, entry]) => ({
      key: `progress.by-signal.${signal}`,
      label: `Progress evaluations with signal ${signal} (evidence)`,
      family: 'evidence' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}

/** Activity: reflections offered/responded/dismissed/emitted (response volume, not insight volume). */
export function countReflectionsByStatus(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const scoped = snapshot.reflections.filter((reflection) => inWindow(reflection.createdAt, filter));
  const byStatus = new Map<string, { count: number; ids: string[] }>();
  for (const reflection of scoped) {
    const entry = byStatus.get(reflection.status) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(reflection.reflectionId);
    byStatus.set(reflection.status, entry);
  }
  return [...byStatus.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, entry]) => ({
      key: `reflections.by-status.${status}`,
      label: `Reflection records with status ${status} (activity)`,
      family: 'activity' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}

/** Activity: plans by F2 purpose (intent distribution, never ability). */
export function countPlansByPurpose(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const scoped = snapshot.plans.filter((plan) => inWindow(plan.createdAt, filter));
  const byPurpose = new Map<string, { count: number; ids: string[] }>();
  for (const plan of scoped) {
    const entry = byPurpose.get(plan.purpose) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(plan.planId);
    byPurpose.set(plan.purpose, entry);
  }
  return [...byPurpose.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([purpose, entry]) => ({
      key: `plans.by-purpose.${purpose}`,
      label: `F2 activity plans with ${purpose} intent (activity)`,
      family: 'activity' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}

/** Activity: distinct active days + longest activity streak (calendar days with ≥1 completed attempt). */
export function activityFrequency(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const days = new Set<string>();
  const completedIds: string[] = [];
  for (const attempt of snapshot.attempts) {
    if (attempt.completedAt === null || !inWindow(attempt.startedAt, filter)) {
      continue;
    }
    days.add(attempt.startedAt.slice(0, 10));
    completedIds.push(attempt.attemptId);
  }
  const sortedDays = [...days].sort();
  let longestStreak = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sortedDays) {
    if (previous !== null) {
      const expected = new Date(`${previous}T00:00:00.000Z`);
      expected.setUTCDate(expected.getUTCDate() + 1);
      const expectedDay = expected.toISOString().slice(0, 10);
      run = day === expectedDay ? run + 1 : 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  return [
    {
      key: 'activity.active-days',
      label: 'Active days with at least one completed attempt (activity)',
      family: 'activity',
      value: sortedDays.length,
      provenance: provenanceFor(snapshot, filter, completedIds, now),
    },
    {
      key: 'activity.longest-streak-days',
      label: 'Longest activity streak in days (activity)',
      family: 'activity',
      value: longestStreak,
      provenance: provenanceFor(snapshot, filter, completedIds, now),
    },
  ];
}

/** Evidence: practice/exposure coverage — distinct entity IDs ever referenced (not competence). */
export function practiceCoverage(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const entities = new Set<string>();
  const sourceIds: string[] = [];
  for (const record of snapshot.evidence) {
    if (!inWindow(record.timestamp, filter)) {
      continue;
    }
    for (const id of record.entityIds) {
      entities.add(id);
    }
    sourceIds.push(record.evidenceId);
  }
  return [
    {
      key: 'practice.distinct-entities',
      label: 'Distinct canonical entities referenced by historical evidence (practice/exposure coverage)',
      family: 'evidence',
      value: entities.size,
      provenance: provenanceFor(snapshot, filter, sourceIds, now),
    },
  ];
}

/** Evidence: help/independence facet counts from D evidence vocabulary (reported, never re-scored). */
export function helpLevelBreakdown(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsFilter,
  now: string,
): AggregateCount[] {
  const byHelp = new Map<string, { count: number; ids: string[] }>();
  for (const record of snapshot.evidence) {
    if (!inWindow(record.timestamp, filter)) {
      continue;
    }
    if (record.evidenceType !== 'HELP_REQUIRED' && record.evidenceType !== 'INDEPENDENT_SUCCESS') {
      continue;
    }
    const key = record.evidenceType === 'INDEPENDENT_SUCCESS' ? 'none' : (record.helpLevel ?? 'unknown');
    const entry = byHelp.get(key) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(record.evidenceId);
    byHelp.set(key, entry);
  }
  return [...byHelp.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([help, entry]) => ({
      key: `evidence.help-level.${help}`,
      label: `Historical help/independence records at help level ${help} (evidence)`,
      family: 'evidence' as const,
      value: entry.count,
      provenance: provenanceFor(snapshot, filter, entry.ids, now),
    }));
}
