import type { AIConversationMessage, AIEvaluation } from '../ai/aiTypes';
import type { Attempt } from '../attempts/attempt';
import { COACH_CONTRACT_VERSION } from './coachTypes';
import type {
  CoachState,
  InterventionOutcome,
  LearnerSignals,
  PreviousIntervention,
} from './coachTypes';

/**
 * Phase E short-lived coach state, DERIVED — never stored.
 *
 * Every function here is pure over already-persisted inputs
 * (evaluations, conversation, attempt). Per-evaluation the extension
 * rebuilds the CoachState from stores, uses it for context/briefing,
 * then drops it. Durable facts already live where they belong
 * (evaluations, conversation, Phase D evidence); this module adds no
 * store, no file, no schema.
 */

/** Latest intervening evaluation on this attempt, if any. */
export function previousInterventionForAttempt(
  evaluations: AIEvaluation[],
  attemptId: string,
): PreviousIntervention | null {
  const mine = evaluations
    .filter((e) => e.attemptId === attemptId && e.shouldIntervene)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evaluationId.localeCompare(b.evaluationId));
  const last = mine[mine.length - 1] ?? null;
  if (!last) {
    return null;
  }
  return {
    evaluationId: last.evaluationId,
    timestamp: last.timestamp,
    interventionType: last.interventionType,
    triggerKind: last.triggerKind,
    requiredResponse: last.requiresLearnerResponse,
  };
}

const AC_TERMINALS = ['Got AC Independently', 'Got AC with Help'];
const ABANDONED_TERMINAL = 'Abandoned / Continue Later';

/**
 * Qualitative outcome of one intervention from observables only.
 * - `progressed`: learner replied AND the attempt later reached an AC
 *   terminal. Both required — a reply alone is engagement, an AC alone
 *   unattributed to this intervention is just an outcome.
 * - `abandoned`: attempt completed as Abandoned after the intervention.
 * - `no-progress`: replied but no AC terminal followed (still open or a
 *   non-AC terminal), i.e. the interaction did not visibly move the
 *   needle — used to change strategy, never to blame.
 * - `unclear`: no reply and no terminal after; nothing can be said yet.
 */
export function deriveInterventionOutcome(args: {
  evaluation: AIEvaluation;
  conversation: AIConversationMessage[];
  attempt: Attempt;
}): InterventionOutcome {
  const { evaluation, conversation, attempt } = args;
  const replies = conversation
    .filter((m) => m.role === 'learner' && m.timestamp.localeCompare(evaluation.timestamp) > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const responded = replies.length > 0;
  const responseLatencyMs =
    responded && replies[0]
      ? Math.max(0, Date.parse(replies[0].timestamp) - Date.parse(evaluation.timestamp))
      : null;
  const transitionsAfter = attempt.stateHistory
    .filter((t) => t.timestamp.localeCompare(evaluation.timestamp) > 0)
    .map((t) => ({ at: t.timestamp, from: t.fromState, to: t.toState }));
  const completedAfter =
    attempt.completedAt !== null && attempt.completedAt.localeCompare(evaluation.timestamp) > 0;
  const finalState = attempt.currentState;
  let outcome: InterventionOutcome['outcome'] = 'unclear';
  if (completedAfter && finalState === ABANDONED_TERMINAL) {
    outcome = 'abandoned';
  } else if (responded && completedAfter && (AC_TERMINALS as string[]).includes(finalState)) {
    outcome = 'progressed';
  } else if (responded) {
    outcome = 'no-progress';
  } else if (completedAfter && !(AC_TERMINALS as string[]).includes(finalState)) {
    // Ended without replying (e.g. silent WA→abandon path handled above,
    // otherwise a terminal the intervention did not visibly affect).
    outcome = finalState === ABANDONED_TERMINAL ? 'abandoned' : 'no-progress';
  }
  return {
    evaluationId: evaluation.evaluationId,
    responded,
    responseLatencyMs: Number.isNaN(responseLatencyMs) ? null : responseLatencyMs,
    transitionsAfter,
    outcome,
  };
}

const SOLUTION_REQUEST = /\b(give me (the )?answer|show me the (answer|solution)|just tell me|solve it for me|give up|tell me the answer)\b/i;
const EXPLANATION_REQUEST = /\b(explain|why does|why is|what does .* mean|i don't understand|i dont understand|confused about)\b/i;

/**
 * Conservative interaction signals from the latest learner message ONLY.
 * Deliberate limits: explicit-request phrasing, question marks, and reply
 * size. No affect mining (no "frustration detection" from word choice),
 * no trait inference — anything subtler stays with the AI under prompt
 * rules that require grounding and forbid labeling.
 */
export function detectLearnerSignals(conversation: AIConversationMessage[]): LearnerSignals {
  const learner = conversation
    .filter((m) => m.role === 'learner')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const last = learner[learner.length - 1];
  if (!last) {
    return { asksForSolution: false, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'none' };
  }
  const text = last.text;
  const len = text.length;
  return {
    asksForSolution: SOLUTION_REQUEST.test(text),
    asksForExplanation: !SOLUTION_REQUEST.test(text) && EXPLANATION_REQUEST.test(text),
    asksQuestion: text.includes('?'),
    replyLengthBucket: len < 40 ? 'short' : len < 300 ? 'medium' : 'long',
  };
}

/**
 * Consecutive 'Abandoned / Continue Later' terminals on ONE problem
 * (completed attempts only, newest last). A corroboration counter for
 * coaching tone — NOT evidence, NOT a trait. Callers decide thresholds;
 * the detector itself just counts honestly (0/1/2/…).
 */
export function abandonmentStreakForProblem(previousAttempts: Attempt[]): number {
  const ordered = [...previousAttempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let streak = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const attempt = ordered[i];
    if (!attempt || attempt.completedAt === null) {
      break;
    }
    if (attempt.currentState === ABANDONED_TERMINAL) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/** Assemble the short-lived state; pure, rebuilt per evaluation. */
export function summarizeCoachState(args: {
  attemptId: string;
  evaluations: AIEvaluation[];
  conversation: AIConversationMessage[];
  attempt: Attempt;
  previousAttempts: Attempt[];
  now: string;
}): CoachState {
  const previous = previousInterventionForAttempt(args.evaluations, args.attemptId);
  let previousOutcome: InterventionOutcome | null = null;
  if (previous) {
    const evaluation = args.evaluations.find((e) => e.evaluationId === previous.evaluationId);
    if (evaluation) {
      previousOutcome = deriveInterventionOutcome({ evaluation, conversation: args.conversation, attempt: args.attempt });
    }
  }
  return {
    contractVersion: COACH_CONTRACT_VERSION,
    attemptId: args.attemptId,
    builtAt: args.now,
    diagnosis: null,
    decision: null,
    signals: detectLearnerSignals(args.conversation),
    previousIntervention: previous,
    previousOutcome,
    abandonmentStreak: abandonmentStreakForProblem(args.previousAttempts),
  };
}
