import {
  AIConversationMessage,
  AIEvaluation,
  AIReasoner,
  EvaluationTriggerKind,
  validateAIEvaluation,
} from './aiTypes';
import { coachMessage } from './reasoners';
import { AIContext } from '../context/aiContext';
import { Attempt } from '../attempts/attempt';
import { Problem } from '../problems/problem';

/**
 * AI evaluation lifecycle (TRANSPORT for the pedagogical decision).
 *
 *   Trigger fires (existing engine, consumed exactly once)
 *     -> verify the originating attempt is still the active one
 *     -> build scoped AIContext (caller-supplied; deterministic layer owns it)
 *     -> call AIReasoner with a timeout
 *     -> validate structured output (malformed => graceful failure)
 *     -> persist evaluation (+ coach message when intervening)
 *     -> display ONLY if the attempt is still current
 *
 * Failures (timeout / provider error / malformed output / ended attempt)
 * are explicit outcomes, never exceptions escaping to telemetry, and never
 * corrupt attempt state, history, checkpoints, or session lifecycle.
 */

export interface ActiveAttemptRef {
  attempt: Attempt;
  problem: Problem;
}

export interface EvaluationRequest {
  attemptId: string;
  triggerKind: EvaluationTriggerKind;
  reason: string;
}

/** vscode-free ports: the extension implements these with real stores/UI. */
export interface EvaluationPorts {
  nowIso(): string;
  /** Null when no attempt is currently active. */
  getActiveAttempt(): ActiveAttemptRef | null;
  buildContext(attempt: Attempt, problem: Problem): Promise<AIContext>;
  reasoner: AIReasoner;
  saveEvaluation(evaluation: AIEvaluation): Promise<void>;
  appendConversation(message: AIConversationMessage): Promise<void>;
  /** Re-checked after the model responds, before anything is displayed. */
  isAttemptStillActive(attemptId: string): boolean;
  timeoutMs: number;
}

export type EvaluationOutcome =
  | { status: 'evaluated'; evaluation: AIEvaluation; displayed: boolean }
  | { status: 'skipped'; reason: 'no-active-attempt' }
  | { status: 'failed'; reason: 'timeout' | 'provider-error' | 'malformed-response'; detail: string };

/**
 * Deterministic fallback check-in for the 45-minute hard boundary when the
 * model returns no intervention. States only what is definitionally true
 * (45 minutes of this attempt have elapsed) and invites conversation —
 * it invents no learner understanding or progress.
 */
export const HARD45_CHECKIN_MESSAGE =
  "You've reached the 45-minute mark on this attempt — this is a scheduled check-in, not a verdict. " +
  'Take a quick breather, re-check your approach against the examples, and keep going. ' +
  "If you're stuck on something specific, reply here and we'll work through it together.";

/**
 * Phase A proactive-notification decision (pure, no vscode dependency).
 *
 * True only when a TRIGGER-driven evaluation (idle or hard45) produced a
 * learner-facing intervention that is actually displayed: evaluated OK and
 * the originating attempt is still current (`displayed`). Everything else
 * stays silent: NONE/silent outcomes, reply conversational turns, manual
 * check-ins, failures, skips, and stale results for ended attempts.
 * Determined from existing evaluation/trigger metadata — never UI timing.
 */
export function shouldNotifyProactiveIntervention(
  triggerKind: EvaluationTriggerKind,
  outcome: EvaluationOutcome,
): boolean {
  if (triggerKind !== 'idle' && triggerKind !== 'hard45') {
    return false;
  }
  return outcome.status === 'evaluated' && outcome.displayed;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).then(
    (result) => {
      if (timer) {
        clearTimeout(timer);
      }
      return result as T;
    },
    (err: unknown) => {
      if (timer) {
        clearTimeout(timer);
      }
      throw err;
    },
  );
}

export async function runAiEvaluation(
  ports: EvaluationPorts,
  request: EvaluationRequest,
): Promise<EvaluationOutcome> {
  const active = ports.getActiveAttempt();
  if (!active || active.attempt.attemptId !== request.attemptId) {
    return { status: 'skipped', reason: 'no-active-attempt' };
  }
  const context = await ports.buildContext(active.attempt, active.problem);
  let raw: unknown;
  try {
    raw = await withTimeout(ports.reasoner.evaluate(context, {}), ports.timeoutMs);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('AI evaluation timed out')) {
      return { status: 'failed', reason: 'timeout', detail: err.message };
    }
    if (err instanceof SyntaxError) {
      return { status: 'failed', reason: 'malformed-response', detail: err.message };
    }
    return {
      status: 'failed',
      reason: 'provider-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const validated = validateAIEvaluation(raw, {
    attemptId: request.attemptId,
    triggerKind: request.triggerKind,
    timestamp: ports.nowIso(),
  });
  if (!validated) {
    return { status: 'failed', reason: 'malformed-response', detail: 'provider output failed schema validation' };
  }
  // hard45 invariant: a mandatory check-in ALWAYS produces a learner-facing
  // response. A model NONE is normalized to a minimal deterministic
  // ACKNOWLEDGE (never a hint); any real intervention type passes through
  // untouched, so the model stays free to choose intervention strength.
  // Idle evaluations keep the silent no-action path. The general validator
  // above is deliberately unchanged.
  const evaluation: AIEvaluation =
    request.triggerKind === 'hard45' && !validated.shouldIntervene
      ? {
          ...validated,
          shouldIntervene: true,
          interventionType: 'ACKNOWLEDGE',
          urgency: 'low',
          message: HARD45_CHECKIN_MESSAGE,
        }
      : validated;
  await ports.saveEvaluation(evaluation);
  if (evaluation.shouldIntervene && evaluation.message.length > 0) {
    await ports.appendConversation(
      coachMessage(request.attemptId, evaluation.message, {
        timestamp: evaluation.timestamp,
        evaluationId: evaluation.evaluationId,
      }),
    );
  }
  // Stale-evaluation protection: persisting for history is fine, but a
  // response that arrives after the learner moved on must never display
  // inside the new attempt.
  const stillActive = ports.isAttemptStillActive(request.attemptId);
  return { status: 'evaluated', evaluation, displayed: stillActive && evaluation.shouldIntervene };
}
