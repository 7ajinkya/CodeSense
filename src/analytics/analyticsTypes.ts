import type { Problem } from '../problems/problem';
import type { Attempt, AttemptState } from '../attempts/attempt';
import type { ProblemClassification } from '../knowledge/classification';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type {
  EvidenceConfidence,
  EvidenceDimension,
  EvidenceSource,
  EvidenceType,
  HelpLevel,
} from '../learner/learnerTypes';
import type { LearnerProfile } from '../learner/learnerModel';
import type { AIEvaluation } from '../ai/aiTypes';
import type { LearningGoal, GoalStatus, GoalSource } from '../goals/goalTypes';
import type { ActivityPlan, ActivityIntent, ActivityPurpose, ActivityPlanStatus } from '../practice/activityTypes';
import type { ActivityProgress, ProgressSignal } from '../progress/progressTypes';
import type { LearnerReflection, ReflectionCategory } from '../reflection/reflectionTypes';

/**
 * Phase H V1 — Learning Analytics types (read-only view shapes, no logic).
 *
 * Boundary notes (frozen phases stay authoritative):
 * - No mastery scores, skill scores, grades, or verdicts anywhere here.
 * - No new evidence/goal/plan/progress/reflection mutation shapes.
 * - Every derived number travels with its window/filter/provenance envelope.
 * - Three analytics families stay labeled: activity (what was done),
 *   evidence (what historical records exist), current D state (what D believes now).
 */

export const ANALYTICS_EXPORT_VERSION = 1;

/** Five distinct absence states. Never convert absence into a model claim. */
export type AbsenceKind =
  | 'no-record'
  | 'insufficient-evidence'
  | 'unknown-entity'
  | 'pruned-history'
  | 'current-state-note';

export const ABSENCE_KINDS: readonly AbsenceKind[] = [
  'no-record',
  'insufficient-evidence',
  'unknown-entity',
  'pruned-history',
  'current-state-note',
];

/** Which analytics family a view/aggregate belongs to (label, not logic). */
export type AnalyticsFamily = 'activity' | 'evidence' | 'current-model';

export const ANALYTICS_FAMILIES: readonly AnalyticsFamily[] = ['activity', 'evidence', 'current-model'];

/** Optional conjunctive (AND) filter. All fields optional; empty = full history. */
export interface AnalyticsFilter {
  problemIds?: string[];
  entityIds?: string[];
  goalIds?: string[];
  planIds?: string[];
  attemptIds?: string[];
  from?: string;
  to?: string;
  outcomes?: AttemptState[];
  evidenceTypes?: EvidenceType[];
  evidenceDimensions?: EvidenceDimension[];
  evidenceSources?: EvidenceSource[];
  evidenceConfidences?: EvidenceConfidence[];
  helpLevels?: HelpLevel[];
  progressSignals?: ProgressSignal[];
  reflectionCategories?: ReflectionCategory[];
  purposes?: ActivityPurpose[];
  intents?: ActivityIntent[];
  goalStatuses?: GoalStatus[];
  /** Matches problem.title, goal.description, reflection.freeText, evidence observation/interpretation. Never code snapshots. */
  textQuery?: string;
}

/** Per-attempt conversation volume (metadata only, never full text in V1). */
export interface ConversationCount {
  attemptId: string;
  coachMessages: number;
  learnerMessages: number;
}

/** Per-session summary (metadata only; event payloads stay in session store). */
export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  primaryLanguage?: string;
}

/** Snapshot completeness marker so partial/selective loads stay honest. */
export interface SnapshotCompleteness {
  complete: boolean;
  /** Human-readable scope description, e.g. "full history" or "goal X only". */
  scope: string;
  truncatedReasons: string[];
  /** Per-store load warnings (fail-open legs). Empty when every leg loaded. */
  loadWarnings: string[];
}

/**
 * AnalyticsSnapshot — in-memory transport shape only. Never persisted.
 * V1 is a full eager fresh-read; future selective sources return the same
 * shape with `completeness.complete=false` so query contracts do not change.
 */
export interface AnalyticsSnapshot {
  problems: Problem[];
  attempts: Attempt[];
  classifications: ProblemClassification[];
  evidence: LearnerEvidence[];
  profile: LearnerProfile | null;
  evaluations: AIEvaluation[];
  conversationCounts: ConversationCount[];
  goals: LearningGoal[];
  plans: ActivityPlan[];
  progress: ActivityProgress[];
  reflections: LearnerReflection[];
  sessions: SessionSummary[];
  ontologyVersion: string;
  aggregatorVersion: string;
  loadedAt: string;
  completeness: SnapshotCompleteness;
  /** Canonical IDs requested via filter that resolved to nothing. */
  unresolvedIds: string[];
}

/** Provenance envelope for every deterministic aggregate. */
export interface AggregateProvenance {
  window: { from: string | null; to: string | null };
  filterHash: string;
  sourceIds: string[];
  computedAt: string;
  ontologyVersion: string;
  aggregatorVersion: string;
}

/** One deterministic count with provenance. Value is a count, never a score. */
export interface AggregateCount {
  key: string;
  label: string;
  family: AnalyticsFamily;
  value: number;
  provenance: AggregateProvenance;
}

/** Joined attempt + problem + classification-status row (raw historical). */
export interface AttemptView {
  attempt: Attempt;
  problem: Problem | null;
  classificationStatus: 'classified' | 'partial' | 'unclassified';
}

/** Per-entity history: current D state pointer + chronological evidence + related records. */
export interface EntityHistoryView {
  entityId: string;
  knownInGraph: boolean;
  /** D current belief pointer (null when D tracks nothing for this entity). */
  currentState: {
    status: string;
    statusConfidence: string;
    updatedAt: string;
    profileUpdatedAt: string;
  } | null;
  evidence: LearnerEvidence[];
  reflectionIds: string[];
  progressIds: string[];
  absence: AbsenceKind | null;
}

/** Goal chain: goal + baseline pointer + plans + attempts + progress + reflections. */
export interface GoalChainView {
  goal: LearningGoal;
  goalSource: GoalSource;
  plans: ActivityPlan[];
  attemptIds: string[];
  progress: ActivityProgress[];
  reflectionIds: string[];
  /** Post-baseline goal-local evidence IDs (via goal-local split, not a copy). */
  postBaselineEvidenceIds: string[];
}

/** One progress timeline row for a goal (raw historical, newest last). */
export interface ProgressTimelineEntry {
  progress: ActivityProgress;
}

/** Raw reflection view preserving the three G layers separately. */
export interface ReflectionView {
  reflection: LearnerReflection;
}

export function emptyAnalyticsFilter(): AnalyticsFilter {
  return {};
}

export function isEmptyFilter(filter: AnalyticsFilter): boolean {
  return (
    (filter.problemIds ?? []).length === 0 &&
    (filter.entityIds ?? []).length === 0 &&
    (filter.goalIds ?? []).length === 0 &&
    (filter.planIds ?? []).length === 0 &&
    (filter.attemptIds ?? []).length === 0 &&
    (filter.outcomes ?? []).length === 0 &&
    (filter.evidenceTypes ?? []).length === 0 &&
    (filter.evidenceDimensions ?? []).length === 0 &&
    (filter.evidenceSources ?? []).length === 0 &&
    (filter.evidenceConfidences ?? []).length === 0 &&
    (filter.helpLevels ?? []).length === 0 &&
    (filter.progressSignals ?? []).length === 0 &&
    (filter.reflectionCategories ?? []).length === 0 &&
    (filter.purposes ?? []).length === 0 &&
    (filter.intents ?? []).length === 0 &&
    (filter.goalStatuses ?? []).length === 0 &&
    (filter.from ?? '') === '' &&
    (filter.to ?? '') === '' &&
    (filter.textQuery ?? '').trim() === ''
  );
}
