import { randomUUID } from 'crypto';

/**
 * Phase 1 Attempt model.
 *
 * Problem = WHAT is being solved (reusable). Attempt = THIS solving occasion.
 * A problem may have many attempts; activity is linked to the ACTIVE attempt,
 * never permanently to a file (the same file may serve many problems).
 */

/** Learner-reported outcome/state. Interpretation belongs to the future AI layer. */
export type AttemptState =
  | 'In Progress'
  | 'Got Error / Compilation Error'
  | 'Got WA'
  | 'Got TLE'
  | 'Got MLE'
  | 'Got AC with Help'
  | 'Got AC Independently'
  | 'Got Stuck'
  | 'Abandoned / Continue Later';

export const ATTEMPT_STATES: readonly AttemptState[] = [
  'In Progress',
  'Got Error / Compilation Error',
  'Got WA',
  'Got TLE',
  'Got MLE',
  'Got AC with Help',
  'Got AC Independently',
  'Got Stuck',
  'Abandoned / Continue Later',
];

export const INITIAL_ATTEMPT_STATE: AttemptState = 'In Progress';

/** Only `In Progress` blocks ending — every other state is a meaningful record. */
export function canEndAttempt(state: AttemptState): boolean {
  return state !== INITIAL_ATTEMPT_STATE;
}

export function isKnownAttemptState(value: string): value is AttemptState {
  return (ATTEMPT_STATES as readonly string[]).includes(value);
}

/** Append-only state transition; current state derives from the latest one. */
export interface AttemptStateTransition {
  attemptId: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  fromState: AttemptState;
  toState: AttemptState;
  /** Who reported the transition. */
  source: 'learner' | 'system';
  note?: string;
}

export interface Attempt {
  attemptId: string;
  problemId: string;
  sessionId: string;
  startedAt: string;
  /** Null while the attempt is active. */
  completedAt: string | null;
  /** VS Code languageId most recently observed (informational only). */
  language?: string;
  currentState: AttemptState;
  /** Append-only; never rewritten. */
  stateHistory: AttemptStateTransition[];
}

export function generateAttemptId(): string {
  return 'att_' + randomUUID();
}

export function createAttempt(opts: {
  attemptId?: string;
  problemId: string;
  sessionId: string;
  startedAt?: string;
  language?: string;
}): Attempt {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const attemptId = opts.attemptId ?? generateAttemptId();
  const initial: AttemptStateTransition = {
    attemptId,
    timestamp: startedAt,
    fromState: INITIAL_ATTEMPT_STATE,
    toState: INITIAL_ATTEMPT_STATE,
    source: 'system',
    note: 'attempt started',
  };
  const attempt: Attempt = {
    attemptId,
    problemId: opts.problemId,
    sessionId: opts.sessionId,
    startedAt,
    completedAt: null,
    currentState: INITIAL_ATTEMPT_STATE,
    stateHistory: [initial],
  };
  if (opts.language !== undefined) {
    attempt.language = opts.language;
  }
  return attempt;
}

export function isAttemptActive(attempt: Attempt): boolean {
  return attempt.completedAt === null;
}

/**
 * Record a learner/system state transition (append-only). Any transition is
 * allowed — states are learner-reported context, not validated pedagogy.
 * Returns the recorded transition. Throws for unknown states.
 */
export function transitionAttemptState(
  attempt: Attempt,
  toState: AttemptState,
  source: 'learner' | 'system',
  opts: { note?: string; timestamp?: string } = {},
): AttemptStateTransition {
  if (!isKnownAttemptState(toState)) {
    throw new Error(`Unknown attempt state: ${String(toState)}`);
  }
  const transition: AttemptStateTransition = {
    attemptId: attempt.attemptId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    fromState: attempt.currentState,
    toState,
    source,
  };
  if (opts.note !== undefined) {
    transition.note = opts.note;
  }
  attempt.stateHistory.push(transition);
  attempt.currentState = toState;
  return transition;
}

/**
 * Complete an attempt. Throws when the current state is still `In Progress`
 * (the learner must first pick a meaningful outcome — §19).
 */
export function completeAttempt(attempt: Attempt, completedAt?: string): void {
  if (!canEndAttempt(attempt.currentState)) {
    throw new Error(
      `Cannot end the problem while it is still marked "${INITIAL_ATTEMPT_STATE}". ` +
        'Please select the current outcome/state first.',
    );
  }
  attempt.completedAt = completedAt ?? new Date().toISOString();
}

/** Derive the current state from history (cached `currentState` must match). */
export function deriveCurrentState(attempt: Attempt): AttemptState {
  if (attempt.stateHistory.length === 0) {
    return INITIAL_ATTEMPT_STATE;
  }
  return attempt.stateHistory[attempt.stateHistory.length - 1].toState;
}

/**
 * Host-driven interruption for an attempt that is still open when its
 * session/host goes away. Uses only existing states (no model redesign):
 * an `In Progress` attempt becomes system-reported
 * `Abandoned / Continue Later` (explicitly resumable later as a new
 * attempt); an already-terminal learner state is preserved as-is. Always
 * completes the attempt so history never shows it as currently active after
 * reload. Already-completed attempts are untouched.
 */
export function interruptAttempt(attempt: Attempt, completedAt?: string): { interrupted: boolean } {
  if (attempt.completedAt !== null) {
    return { interrupted: false };
  }
  let interrupted = false;
  if (attempt.currentState === INITIAL_ATTEMPT_STATE) {
    transitionAttemptState(attempt, 'Abandoned / Continue Later', 'system', {
      note: 'interrupted: session/host ended with attempt still open',
    });
    interrupted = true;
  }
  // Safe: `In Progress` is impossible here, so `completeAttempt` cannot throw.
  completeAttempt(attempt, completedAt);
  return { interrupted };
}
