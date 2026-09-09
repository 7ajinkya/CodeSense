import { getClassificationStatus } from '../knowledge/classification';
import { getEvidenceForEntity } from '../learner/learnerQueries';
import type { Attempt } from '../attempts/attempt';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearningGoal } from '../goals/goalTypes';
import type { ActivityProgress } from '../progress/progressTypes';
import type {
  AbsenceKind,
  AnalyticsFilter,
  AnalyticsSnapshot,
  AttemptView,
  EntityHistoryView,
  GoalChainView,
  ProgressTimelineEntry,
} from './analyticsTypes';

/**
 * Phase H V1 — deterministic analytics queries (pure: snapshot + filter in,
 * derived view out). No stores, no writes, no AI, no scores.
 */

function asSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) {
    return null;
  }
  return new Set(values);
}

function inRange(timestamp: string, from?: string, to?: string): boolean {
  if (from !== undefined && from !== '' && timestamp.localeCompare(from) < 0) {
    return false;
  }
  if (to !== undefined && to !== '' && timestamp.localeCompare(to) > 0) {
    return false;
  }
  return true;
}

function matchesText(haystacks: Array<string | null | undefined>, needle: string | undefined): boolean {
  if (needle === undefined || needle.trim() === '') {
    return true;
  }
  const query = needle.trim().toLowerCase();
  return haystacks.some((hay) => (hay ?? '').toLowerCase().includes(query));
}

function attemptMatchesFilter(attempt: Attempt, filter: AnalyticsFilter): boolean {
  const problemIds = asSet(filter.problemIds);
  if (problemIds && !problemIds.has(attempt.problemId)) {
    return false;
  }
  const attemptIds = asSet(filter.attemptIds);
  if (attemptIds && !attemptIds.has(attempt.attemptId)) {
    return false;
  }
  if (filter.outcomes && filter.outcomes.length > 0 && !filter.outcomes.includes(attempt.currentState)) {
    return false;
  }
  if (!inRange(attempt.startedAt, filter.from, filter.to)) {
    return false;
  }
  return true;
}

function evidenceMatchesFilter(evidence: LearnerEvidence, filter: AnalyticsFilter): boolean {
  const attemptIds = asSet(filter.attemptIds);
  if (attemptIds && (evidence.attemptId === null || !attemptIds.has(evidence.attemptId))) {
    return false;
  }
  const problemIds = asSet(filter.problemIds);
  if (problemIds && (evidence.problemId === null || !problemIds.has(evidence.problemId))) {
    return false;
  }
  const entityIds = asSet(filter.entityIds);
  if (entityIds && !evidence.entityIds.some((id) => entityIds.has(id))) {
    return false;
  }
  if (filter.evidenceTypes && filter.evidenceTypes.length > 0 && !filter.evidenceTypes.includes(evidence.evidenceType)) {
    return false;
  }
  if (filter.evidenceSources && filter.evidenceSources.length > 0 && !filter.evidenceSources.includes(evidence.source)) {
    return false;
  }
  if (
    filter.evidenceConfidences &&
    filter.evidenceConfidences.length > 0 &&
    !filter.evidenceConfidences.includes(evidence.confidence)
  ) {
    return false;
  }
  if (filter.helpLevels && filter.helpLevels.length > 0) {
    if (evidence.helpLevel === undefined || !filter.helpLevels.includes(evidence.helpLevel)) {
      return false;
    }
  }
  if (filter.evidenceDimensions && filter.evidenceDimensions.length > 0) {
    // Dimension is explicit only on RECURRING_MISTAKE; other types map via
    // the frozen updater mapping which H does not reimplement. For filtering,
    // match explicit dimension when present; otherwise keep the record (never
    // drop on an inference H refuses to make).
    if (evidence.dimension !== undefined && !filter.evidenceDimensions.includes(evidence.dimension)) {
      return false;
    }
  }
  if (!inRange(evidence.timestamp, filter.from, filter.to)) {
    return false;
  }
  if (!matchesText([evidence.observation, evidence.interpretation], filter.textQuery)) {
    return false;
  }
  return true;
}

/** Chronological attempts with joined problem + classification status (raw historical). */
export function filterAttempts(snapshot: AnalyticsSnapshot, filter: AnalyticsFilter): AttemptView[] {
  const problemById = new Map(snapshot.problems.map((problem) => [problem.problemId, problem] as const));
  const classificationByProblem = new Map(
    snapshot.classifications.map((classification) => [classification.problemId, classification] as const),
  );
  const out: AttemptView[] = [];
  for (const attempt of snapshot.attempts) {
    if (!attemptMatchesFilter(attempt, filter)) {
      continue;
    }
    if (filter.textQuery && filter.textQuery.trim() !== '') {
      const problem = problemById.get(attempt.problemId) ?? null;
      if (!matchesText([problem?.title, problem?.canonicalUrl, attempt.attemptId], filter.textQuery)) {
        continue;
      }
    }
    const problem = problemById.get(attempt.problemId) ?? null;
    const classification = classificationByProblem.get(attempt.problemId);
    out.push({
      attempt,
      problem,
      classificationStatus: classification ? getClassificationStatus(classification) : 'unclassified',
    });
  }
  return out.sort(
    (a, b) =>
      a.attempt.startedAt.localeCompare(b.attempt.startedAt) ||
      a.attempt.attemptId.localeCompare(b.attempt.attemptId),
  );
}

/** Filtered evidence, chronological (timestamp, evidenceId). */
export function filterEvidence(snapshot: AnalyticsSnapshot, filter: AnalyticsFilter): LearnerEvidence[] {
  return snapshot.evidence
    .filter((record) => evidenceMatchesFilter(record, filter))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * Goal chain: goal + its plans + linked attempts + progress + reflections.
 * Stale `proposed` goals are included only with includeStale:true; default
 * surfaces fresh/active history. H never transitions goals — it only reads.
 */
export function goalChainForGoal(
  snapshot: AnalyticsSnapshot,
  goalId: string,
  opts: { includeStale?: boolean } = {},
): GoalChainView | null {
  const goal: LearningGoal | null = snapshot.goals.find((candidate) => candidate.goalId === goalId) ?? null;
  if (!goal) {
    return null;
  }
  const includeStale = opts.includeStale ?? false;
  void includeStale;
  const plans = snapshot.plans
    .filter((plan) => plan.goalId === goalId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
  const attemptIds = [...new Set(plans.map((plan) => plan.linkedAttemptId).filter((id): id is string => id !== null))].sort();
  const progress = snapshot.progress
    .filter((record) => record.goalId === goalId)
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
  const reflectionIds = snapshot.reflections
    .filter((reflection) => reflection.provenance.goalId === goalId)
    .map((reflection) => reflection.reflectionId)
    .sort();
  // Post-baseline slice: goal-local evidence at/after baseline capture.
  // H compares IDs/timestamps only; it never re-derives needs or levels.
  const baseline = goal.progressBaseline;
  const postBaselineEvidenceIds =
    baseline === null
      ? []
      : snapshot.evidence
          .filter(
            (record) =>
              record.timestamp.localeCompare(baseline.capturedAt) >= 0 &&
              record.entityIds.some((id) => goal.entityIds.includes(id)),
          )
          .map((record) => record.evidenceId)
          .sort();
  return {
    goal,
    goalSource: goal.source,
    plans,
    attemptIds,
    progress,
    reflectionIds,
    postBaselineEvidenceIds,
  };
}

/** Progress timeline for one goal, oldest first (raw historical). */
export function progressTimelineForGoal(snapshot: AnalyticsSnapshot, goalId: string): ProgressTimelineEntry[] {
  return snapshot.progress
    .filter((record) => record.goalId === goalId)
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId))
    .map((progress) => ({ progress }));
}

/**
 * Entity history: D current pointer + chronological evidence + related
 * reflection/progress IDs. Unknown graph IDs yield knownInGraph=false and
 * absence='unknown-entity' with history preserved, never dropped.
 */
export function entityHistory(
  snapshot: AnalyticsSnapshot,
  entityId: string,
  opts: { graphHasEntity: (id: string) => boolean },
): EntityHistoryView {
  const knownInGraph = opts.graphHasEntity(entityId);
  const evidence = getEvidenceForEntity(snapshot.evidence, entityId);
  const state = snapshot.profile?.knowledgeStates.find((candidate) => candidate.entityId === entityId) ?? null;
  const reflectionIds = snapshot.reflections
    .filter(
      (reflection) =>
        (reflection.interpretation?.entityIds.includes(entityId) ?? false) ||
        reflection.evidenceIds.some((id) => evidence.some((record) => record.evidenceId === id)),
    )
    .map((reflection) => reflection.reflectionId)
    .sort();
  const progressIds = snapshot.progress
    .filter((record) => record.entities.some((detail) => detail.entityId === entityId))
    .map((record) => record.progressId)
    .sort();
  let absence: AbsenceKind | null = null;
  if (!knownInGraph) {
    absence = 'unknown-entity';
  } else if (evidence.length === 0 && state === null) {
    absence = 'no-record';
  } else if (state === null) {
    absence = 'current-state-note';
  }
  return {
    entityId,
    knownInGraph,
    currentState:
      state === null
        ? null
        : {
            status: state.status,
            statusConfidence: state.statusConfidence,
            updatedAt: state.updatedAt,
            profileUpdatedAt: snapshot.profile?.updatedAt ?? state.updatedAt,
          },
    evidence,
    reflectionIds,
    progressIds,
    absence,
  };
}

/** Evidence that existed at/before an attempt's completion (historical slice). */
export function evidenceAsOfAttempt(
  snapshot: AnalyticsSnapshot,
  attemptId: string,
): { evidence: LearnerEvidence[]; attemptCompletedAt: string | null; found: boolean } {
  const attempt = snapshot.attempts.find((candidate) => candidate.attemptId === attemptId) ?? null;
  if (!attempt) {
    return { evidence: [], attemptCompletedAt: null, found: false };
  }
  if (attempt.completedAt === null) {
    return {
      evidence: snapshot.evidence
        .filter((record) => record.timestamp.localeCompare(attempt.startedAt) >= 0)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId)),
      attemptCompletedAt: null,
      found: true,
    };
  }
  return {
    evidence: snapshot.evidence
      .filter((record) => record.timestamp.localeCompare(attempt.completedAt as string) <= 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId)),
    attemptCompletedAt: attempt.completedAt,
    found: true,
  };
}
