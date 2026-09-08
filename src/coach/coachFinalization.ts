import type { AIConversationMessage, AIEvaluation } from '../ai/aiTypes';
import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import type { CandidateEvidence } from './coachTypes';

/**
 * Phase E end-of-attempt/session finalization.
 *
 * Reuses existing models/contracts only: the package below is assembled
 * from the attempt record, session events, evaluations, conversation,
 * classification, and the already-synced learner profile — no second
 * attempt-history system, no new persistence. Evidence updates flow
 * through the existing Phase D sync entry points (already wired on End
 * Problem; the deactivate path reuses the same helper).
 *
 * Abandonment semantics (hard rule): an abandonment is preserved as
 * observable facts plus an optional thresholded candidate note. It never
 * becomes a verdict, never a boolean trait, never a status mutation.
 * Candidates that WOULD be persisted must validate through the existing
 * Phase D validators first — see `candidateToRecords`, which only emits
 * shapes the Phase D feeds already accept.
 */

export interface AttemptFinalPackage {
  attemptId: string;
  problemId: string;
  finalState: string;
  startedAt: string;
  completedAt: string | null;
  /** Learner/system state trail, oldest first. */
  stateHistory: Array<{ at: string; from: string; to: string; source: string; note?: string }>;
  durationMs: number | null;
  /** Evaluations on this attempt, chronological (ids + kinds only). */
  interventions: Array<{ evaluationId: string; at: string; triggerKind: string; interventionType: string }>;
  /** Conversation counts by role (texts stay in the conversation store). */
  conversationCounts: { coach: number; learner: number };
  /** Learner replies (texts stay in the conversation store). */
  learnerReplies: number;
  classificationPresent: boolean;
  /** Evidence already synced for this attempt (ids only). */
  evidenceIds: string[];
  /** Thresholded behavioral note, or null. Briefing-grade, not a verdict. */
  abandonmentNote: string | null;
}

/** Consecutive abandonments that earn a coaching-tone note (still not evidence). */
export const ABANDONMENT_NOTE_THRESHOLD = 2;

export function buildAttemptFinalPackage(args: {
  attempt: Attempt;
  problem: Problem;
  classification: ProblemClassification | null | undefined;
  evaluations: AIEvaluation[];
  conversation: AIConversationMessage[];
  evidence: LearnerEvidence[];
  previousAttempts: Attempt[];
  nowMs?: number;
}): AttemptFinalPackage {
  const { attempt } = args;
  const startedMs = Date.parse(attempt.startedAt);
  const endMs = attempt.completedAt ? Date.parse(attempt.completedAt) : (args.nowMs ?? Date.now());
  const mine = args.evaluations
    .filter((e) => e.attemptId === attempt.attemptId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const mineConversation = args.conversation.filter((m) => m.attemptId === attempt.attemptId);
  const learnerReplies = mineConversation.filter((m) => m.role === 'learner').length;
  const evidenceIds = args.evidence
    .filter((e) => e.attemptId === attempt.attemptId)
    .map((e) => e.evidenceId)
    .sort();
  let streak = 0;
  if (attempt.currentState === 'Abandoned / Continue Later' && attempt.completedAt !== null) {
    streak = 1;
    const ordered = [...args.previousAttempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let i = ordered.length - 1; i >= 0; i--) {
      const prev = ordered[i];
      if (!prev || prev.completedAt === null) {
        break;
      }
      if (prev.currentState === 'Abandoned / Continue Later') {
        streak += 1;
      } else {
        break;
      }
    }
  }
  return {
    attemptId: attempt.attemptId,
    problemId: attempt.problemId,
    finalState: attempt.currentState,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    stateHistory: attempt.stateHistory.map((t) => ({
      at: t.timestamp,
      from: t.fromState,
      to: t.toState,
      source: t.source,
      ...(t.note !== undefined ? { note: t.note } : {}),
    })),
    durationMs: Number.isNaN(startedMs) || Number.isNaN(endMs) ? null : Math.max(0, endMs - startedMs),
    interventions: mine.map((e) => ({
      evaluationId: e.evaluationId,
      at: e.timestamp,
      triggerKind: e.triggerKind,
      interventionType: e.interventionType,
    })),
    conversationCounts: {
      coach: mineConversation.filter((m) => m.role === 'coach').length,
      learner: learnerReplies,
    },
    learnerReplies,
    classificationPresent: args.classification != null,
    evidenceIds,
    abandonmentNote:
      streak >= ABANDONMENT_NOTE_THRESHOLD
        ? `${streak} consecutive abandonments on this problem. Possible frustration, mismatch, or ineffective ` +
          `interventions — corroborate before acting; this is not a verdict. Prefer smaller steps and verify understanding.`
        : null,
  };
}

export interface SessionFinalPackage {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  problemIds: string[];
  /** Per-attempt final states (references existing attempt records). */
  attemptOutcomes: Array<{ attemptId: string; problemId: string; finalState: string; completedAt: string | null }>;
  /** Counts only — evidence itself is never duplicated at session level. */
  evaluationsCount: number;
  interventionsCount: number;
  abandonmentNote: string | null;
}

/**
 * Session finalization is a READ-ONLY rollup: it references attempt
 * records and counts evaluations, duplicating no evidence. Stale
 * interrupted attempts are finalized by the existing lifecycle first;
 * this package only describes what is already persisted.
 */
export function buildSessionFinalPackage(args: {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  attempts: Attempt[];
  evaluations: AIEvaluation[];
}): SessionFinalPackage {
  const ordered = [...args.attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const problemIds = [...new Set(ordered.map((a) => a.problemId))].sort();
  const abandoned = ordered.filter(
    (a) => a.completedAt !== null && a.currentState === 'Abandoned / Continue Later',
  ).length;
  return {
    sessionId: args.sessionId,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    problemIds,
    attemptOutcomes: ordered.map((a) => ({
      attemptId: a.attemptId,
      problemId: a.problemId,
      finalState: a.currentState,
      completedAt: a.completedAt,
    })),
    evaluationsCount: args.evaluations.length,
    interventionsCount: args.evaluations.filter((e) => e.shouldIntervene).length,
    abandonmentNote:
      abandoned >= ABANDONMENT_NOTE_THRESHOLD
        ? `${abandoned} abandoned attempts this session. Session-level pattern worth a gentle check-in, not a verdict.`
        : null,
  };
}

/**
 * Route a coaching candidate through EXISTING Phase D shapes. Today this
 * only validates/recognizes the mistake-report and recognition routes
 * (the only candidate kinds Phase E produces); anything else is refused
 * rather than smuggled into storage. Returns validated
 * `LearnerEvidence[]` ready for `syncRecordsToLearnerModel`, or [].
 */
export function candidateToRecords(
  candidate: CandidateEvidence,
  build: {
    mistakeReport: (payload: unknown) => LearnerEvidence | null;
    recognition: (payload: unknown) => LearnerEvidence | null;
    replyAssessment: (payload: unknown) => LearnerEvidence[];
    records: (payload: unknown) => LearnerEvidence[];
  },
): LearnerEvidence[] {
  switch (candidate.route) {
    case 'mistake-report': {
      const record = build.mistakeReport(candidate.payload);
      return record ? [record] : [];
    }
    case 'recognition': {
      const record = build.recognition(candidate.payload);
      return record ? [record] : [];
    }
    case 'reply-assessment': {
      return build.replyAssessment(candidate.payload);
    }
    case 'records': {
      return build.records(candidate.payload);
    }
    default:
      return [];
  }
}

/** Type-narrowed profile accessor for finalization summaries. */
export function profileEntitiesTracked(profile: LearnerProfile): number {
  return profile.knowledgeStates.length;
}
