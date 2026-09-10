import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { ActivityPlan } from '../practice/activityTypes';
import { getPlansByStatus } from '../practice/activityQueries';
import type { LearnerProfile } from '../learner/learnerModel';
import { isRecord } from '../persistence/storeFiles';
import type { ProblemKnowledgeRecord } from './problemKnowledge';
import { knowledgeSetFor } from './reinforcementCandidate';

/**
 * Phase J-4 retrieval detection: "previously demonstrated/strong knowledge
 * that has not been retrieved recently." Pure, read-only, deterministic —
 * no store, no AI, no clock (callers inject `nowIso`), no randomness.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - D owns capability truth. Retrieval candidacy reads D's CURRENT status
 *   (`demonstrated`/`strong` with medium/high confidence) and D's
 *   `lastObservedAt` — the authoritative latest semantics. No polarity is
 *   re-derived, no second model is built, and nothing is persisted: "needs
 *   retrieval" is derived on every call.
 * - Retrieval is NOT weakness. Statuses `struggling`/`mixed`, low-confidence
 *   assessments, and entities without any D state are never retrieval
 *   candidates here (they belong to remediation/uncertainty handling in the
 *   agenda builder, or to silence — never to retrieval).
 * - Recent coverage (an in-flight F2 plan or a recent attempt on a problem
 *   exercising the entity) suppresses candidacy: retrieval already happened.
 *   Plan-activity semantics reuse F2's own `getPlansByStatus` vocabulary;
 *   problem→entity coverage reuses J-2's frozen `knowledgeSetFor`.
 */

export const RETRIEVAL_SCHEMA_VERSION = 1;

/**
 * Staleness window in days. Policy placeholder, NOT pedagogical truth: no
 * frozen contract determines this number. 21 days ≈ three practice weeks —
 * longer than a weekly cadence (weekly learners are not nagged) yet short
 * enough to matter within a term. Tune via this constant or the
 * `staleAfterDays` override; tests pin the seam, never the value.
 */
export const STALE_AFTER_DAYS = 21;

/** Per-need cited-evidence cap (mirrors `MAX_REASON_EVIDENCE_IDS`). */
export const MAX_RETRIEVAL_EVIDENCE_IDS = 12;

export interface RetrievalNeed {
  entityId: string;
  status: 'demonstrated' | 'strong';
  statusConfidence: 'medium' | 'high';
  lastObservedAt: string;
  /** Sorted supporting D evidence IDs (capped). */
  supportingEvidenceIds: string[];
}

export interface RetrievalInputs {
  /** Current D profile (null when unavailable — detection yields []). */
  profile: LearnerProfile | null;
  /** All F2 plans (in-flight ones suppress candidacy). */
  plans: ActivityPlan[];
  /** Full attempt history (recent coverage suppresses candidacy). */
  attempts: Attempt[];
  /** All canonical problems (coverage join key). */
  problems: Problem[];
  /** All classifications (coverage join key; latest per problem wins). */
  classifications: ProblemClassification[];
  /** All J-1 records (coverage join key). */
  knowledgeRecords: ProblemKnowledgeRecord[];
  /** Deterministic reference time (ISO-8601 UTC, caller-supplied). */
  nowIso: string;
  /** Override for `STALE_AFTER_DAYS` (tests/policy tuning). */
  staleAfterDays?: number;
}

/**
 * Deterministic cutoff: entities observed strictly before this instant are
 * stale. Pure function of its inputs. Throws on an unparseable reference
 * time (caller contract, mirroring repo fail-loud conventions).
 */
export function cutoffIso(nowIso: string, days: number): string {
  const ms = Date.parse(nowIso);
  if (Number.isNaN(ms)) {
    throw new Error('Cannot compute a retrieval cutoff from an invalid reference time.');
  }
  return new Date(ms - days * 86_400_000).toISOString();
}

function latestClassificationFor(
  classifications: ProblemClassification[],
  problemId: string,
): ProblemClassification | null {
  let best: ProblemClassification | null = null;
  for (const classification of classifications) {
    if (classification.problemId !== problemId) {
      continue;
    }
    if (best === null || classification.classifiedAt.localeCompare(best.classifiedAt) >= 0) {
      best = classification;
    }
  }
  return best;
}

/** True when the entity was already retrieved at/after the cutoff. */
function hasRecentCoverage(
  entityId: string,
  inputs: Pick<RetrievalInputs, 'plans' | 'attempts' | 'problems' | 'classifications' | 'knowledgeRecords'>,
  cutoff: string,
): boolean {
  // In-flight F2 activity already covers the entity (F2's own active vocabulary).
  const inFlight = [
    ...getPlansByStatus(inputs.plans, 'planned'),
    ...getPlansByStatus(inputs.plans, 'offered'),
    ...getPlansByStatus(inputs.plans, 'started'),
  ];
  if (inFlight.some((plan) => plan.entityIds.includes(entityId))) {
    return true;
  }
  // A recent attempt on a problem exercising the entity already retrieved it.
  const knowledgeByProblem = new Map<string, ProblemKnowledgeRecord>();
  for (const record of inputs.knowledgeRecords) {
    knowledgeByProblem.set(record.problemId, record);
  }
  const seenAttempts = new Set<string>();
  for (const attempt of inputs.attempts) {
    if (seenAttempts.has(attempt.attemptId)) {
      continue;
    }
    seenAttempts.add(attempt.attemptId);
    if (attempt.startedAt.localeCompare(cutoff) <= 0) {
      continue;
    }
    const set = knowledgeSetFor(
      latestClassificationFor(inputs.classifications, attempt.problemId),
      knowledgeByProblem.get(attempt.problemId) ?? null,
    );
    if (set.all.includes(entityId)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect stale-demonstrated entities. Pure: same inputs always yield the
 * same needs, ordered stalest-first (then entity ID). Malformed D rows are
 * skipped leniently (mirroring frozen lenient-read conventions); inputs are
 * never mutated.
 */
export function detectRetrievalNeeds(inputs: RetrievalInputs): RetrievalNeed[] {
  const cutoff = cutoffIso(inputs.nowIso, inputs.staleAfterDays ?? STALE_AFTER_DAYS);
  if (inputs.profile === null) {
    return [];
  }
  const out: RetrievalNeed[] = [];
  for (const raw of inputs.profile.knowledgeStates) {
    if (!isRecord(raw)) {
      continue;
    }
    const state = raw as unknown as {
      entityId: unknown;
      status: unknown;
      statusConfidence: unknown;
      lastObservedAt: unknown;
      supportingEvidenceIds: unknown;
    };
    if (typeof state.entityId !== 'string' || state.entityId.length === 0) {
      continue;
    }
    if (state.status !== 'demonstrated' && state.status !== 'strong') {
      continue;
    }
    if (state.statusConfidence !== 'medium' && state.statusConfidence !== 'high') {
      continue;
    }
    if (typeof state.lastObservedAt !== 'string' || state.lastObservedAt.length === 0) {
      continue;
    }
    if (state.lastObservedAt.localeCompare(cutoff) >= 0) {
      continue;
    }
    if (hasRecentCoverage(state.entityId, inputs, cutoff)) {
      continue;
    }
    const supporting = Array.isArray(state.supportingEvidenceIds)
      ? [...new Set(state.supportingEvidenceIds.filter((id): id is string => typeof id === 'string'))].sort()
      : [];
    out.push({
      entityId: state.entityId,
      status: state.status as 'demonstrated' | 'strong',
      statusConfidence: state.statusConfidence as 'medium' | 'high',
      lastObservedAt: state.lastObservedAt,
      supportingEvidenceIds: supporting.slice(0, MAX_RETRIEVAL_EVIDENCE_IDS),
    });
  }
  return out.sort(
    (a, b) => a.lastObservedAt.localeCompare(b.lastObservedAt) || a.entityId.localeCompare(b.entityId),
  );
}
