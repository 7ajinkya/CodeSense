/**
 * Phase 1 AI-evaluation trigger engine (deterministic, time-based, pure).
 *
 * Exactly two qualifying conditions per active attempt (§28):
 *   1. idle >= 10 minutes (qualifying coding inactivity), OR
 *   2. attempt elapsed time >= 45 minutes (STRICT hard boundary since attempt
 *      start — activity never suppresses it, §29).
 *
 * Rules enforced here:
 * - No arbitrary cooldown: after a trigger, no time-based suppression.
 * - Consumption: each trigger instance fires exactly once. The 45-minute
 *   boundary is consumed via a flag; idle uses per-epoch watermarks so a NEW
 *   quiet period after fresh activity can fire again, but the same quiet
 *   period never refires every second/event (§30–§31).
 * - Lifecycle is per-attempt: ending a problem discards the state; the next
 *   attempt starts fresh (§32–§33).
 *
 * This module only DECIDES eligibility. Checkpoint creation, persistence and
 * notification live in the extension wiring.
 *
 * The idle threshold defaults to 10 minutes but can be overridden for
 * dogfooding via CODESENSE_IDLE_THRESHOLD_MS (see resolveIdleThresholdMs).
 * The 45-minute hard boundary is never configurable.
 */

export const IDLE_THRESHOLD_MS = 10 * 60 * 1000;
export const HARD_LIMIT_MS = 45 * 60 * 1000;

/** Environment override for the idle threshold, in milliseconds. */
export const IDLE_THRESHOLD_ENV_VAR = 'CODESENSE_IDLE_THRESHOLD_MS';

/**
 * Resolve the idle threshold: the env value when it parses to a positive
 * finite number of milliseconds, otherwise the 10-minute production
 * default. Takes the env record as a parameter so callers stay explicit
 * and tests stay hermetic (no process.env mutation needed).
 */
export function resolveIdleThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env[IDLE_THRESHOLD_ENV_VAR] ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) {
    return IDLE_THRESHOLD_MS;
  }
  return Math.floor(raw);
}

export type TriggerKind = 'idle' | 'hard45';

export interface TriggerEvaluation {
  eligible: boolean;
  kind: TriggerKind | null;
  /** Human-readable reason for logs/notifications. */
  reason: string;
}

/**
 * Mutable per-attempt trigger lifecycle. Owned by the active attempt;
 * discarded when the attempt ends.
 */
export interface AttemptTriggerState {
  attemptStartedAtMs: number;
  lastActivityAtMs: number;
  /** The 45-minute boundary fires once per attempt. */
  hard45Consumed: boolean;
  /**
   * Watermark of the activity epoch for which an idle trigger already fired.
   * `lastActivityAtMs` advancing starts a new epoch that may fire again.
   */
  idleConsumedForActivityAtMs: number | null;
}

export function createTriggerState(startedAtMs: number, nowMs?: number): AttemptTriggerState {
  const now = nowMs ?? Date.now();
  return {
    attemptStartedAtMs: startedAtMs,
    lastActivityAtMs: now,
    hard45Consumed: false,
    idleConsumedForActivityAtMs: null,
  };
}

/** Record qualifying activity (edits, saves, runs, tests, state changes...). */
export function recordTriggerActivity(state: AttemptTriggerState, nowMs: number): void {
  // Monotonic guard: clock adjustments backwards must not resurrect epochs.
  if (nowMs > state.lastActivityAtMs) {
    state.lastActivityAtMs = nowMs;
  }
}

/**
 * Evaluate eligibility at `nowMs`. Pure except for reading the state.
 * When both conditions hold, the strict 45-minute boundary is reported
 * (it is the stronger, non-negotiable signal). The idle threshold is a
 * parameter so dogfooding overrides stay at the call edge; it defaults to
 * the 10-minute production value and never affects the hard boundary.
 */
export function evaluateTriggers(
  state: AttemptTriggerState,
  nowMs: number,
  idleThresholdMs: number = IDLE_THRESHOLD_MS,
): TriggerEvaluation {
  const elapsed = nowMs - state.attemptStartedAtMs;
  if (!state.hard45Consumed && elapsed >= HARD_LIMIT_MS) {
    return {
      eligible: true,
      kind: 'hard45',
      reason: `45-minute hard boundary reached (${Math.floor(elapsed / 60000)}m since attempt start)`,
    };
  }
  const idleFor = nowMs - state.lastActivityAtMs;
  if (idleFor >= idleThresholdMs && state.idleConsumedForActivityAtMs !== state.lastActivityAtMs) {
    return {
      eligible: true,
      kind: 'idle',
      reason: `idle for ${Math.floor(idleFor / 60000)}m (threshold ${idleThresholdMs / 60000}m)`,
    };
  }
  return { eligible: false, kind: null, reason: 'no trigger condition met' };
}

/** Consume a fired trigger so the identical condition never refires. */
export function consumeTrigger(state: AttemptTriggerState, kind: TriggerKind): void {
  if (kind === 'hard45') {
    state.hard45Consumed = true;
  } else {
    state.idleConsumedForActivityAtMs = state.lastActivityAtMs;
  }
}

/**
 * Convenience: evaluate and consume in one step. Returns the evaluation
 * (with `eligible: true` exactly once per trigger instance).
 */
export function pollTriggers(
  state: AttemptTriggerState,
  nowMs: number,
  idleThresholdMs: number = IDLE_THRESHOLD_MS,
): TriggerEvaluation {
  const evaluation = evaluateTriggers(state, nowMs, idleThresholdMs);
  if (evaluation.eligible && evaluation.kind !== null) {
    consumeTrigger(state, evaluation.kind);
  }
  return evaluation;
}

/** Serialize for persistence alongside the attempt (optional; memory is fine). */
export function serializeTriggerState(state: AttemptTriggerState): Record<string, number | boolean | null> {
  return {
    attemptStartedAtMs: state.attemptStartedAtMs,
    lastActivityAtMs: state.lastActivityAtMs,
    hard45Consumed: state.hard45Consumed,
    idleConsumedForActivityAtMs: state.idleConsumedForActivityAtMs,
  };
}

export function parseTriggerState(raw: unknown, fallbackStartMs: number): AttemptTriggerState {
  const startedAtMs =
    typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).attemptStartedAtMs === 'number'
      ? ((raw as Record<string, unknown>).attemptStartedAtMs as number)
      : fallbackStartMs;
  const base = createTriggerState(startedAtMs, startedAtMs);
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>;
    if (typeof r.lastActivityAtMs === 'number') {
      base.lastActivityAtMs = r.lastActivityAtMs;
    }
    if (r.hard45Consumed === true) {
      base.hard45Consumed = true;
    }
    if (typeof r.idleConsumedForActivityAtMs === 'number') {
      base.idleConsumedForActivityAtMs = r.idleConsumedForActivityAtMs;
    }
  }
  return base;
}
