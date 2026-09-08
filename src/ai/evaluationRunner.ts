import {
  AIConversationMessage,
  AIEvaluation,
  AIReasoner,
  EvaluationTriggerKind,
  validateAIEvaluation,
} from './aiTypes';
import { coachMessage, HttpProviderError } from './reasoners';
import { parseRetryAfterDelayMs } from './rateLimit';
import { AIContext } from '../context/aiContext';
import { Attempt } from '../attempts/attempt';
import { Problem } from '../problems/problem';
import { randomUUID } from 'crypto';
import type { AITraceStage } from './aiTrace';

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
  /**
   * Phase E developer-trace sink (optional; additive). Invoked at each
   * pipeline stage with secret-free summaries. A throwing sink must never
   * break evaluation — emissions are guarded.
   */
  onTrace?: (event: {
    traceId: string;
    stage: AITraceStage;
    attemptId: string | null;
    evaluationId: string | null;
    triggerKind: string | null;
    summary: string;
    preview?: string;
  }) => void;
}

export type EvaluationOutcome =
  | { status: 'evaluated'; evaluation: AIEvaluation; displayed: boolean }
  | { status: 'skipped'; reason: 'no-active-attempt' }
  | {
      status: 'failed';
      reason: 'timeout' | 'provider-error' | 'malformed-response' | 'rate-limited';
      detail: string;
      /** Provider-supplied retry delay for rate limits; absent/unusable without Retry-After. */
      retryAfterMs?: number;
    };

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
  const traceId = 'trace_' + randomUUID();
  const emit = (
    stage: AITraceStage,
    summary: string,
    extra: { attemptId?: string | null; evaluationId?: string | null; triggerKind?: string | null; preview?: string } = {},
  ): void => {
    try {
      ports.onTrace?.({
        traceId,
        stage,
        attemptId: extra.attemptId ?? request.attemptId,
        evaluationId: extra.evaluationId ?? null,
        triggerKind: extra.triggerKind ?? request.triggerKind,
        summary,
        ...(extra.preview !== undefined ? { preview: extra.preview } : {}),
      });
    } catch {
      // Trace sinks are debug aids; they must never break evaluation.
    }
  };
  const active = ports.getActiveAttempt();
  if (!active || active.attempt.attemptId !== request.attemptId) {
    return { status: 'skipped', reason: 'no-active-attempt' };
  }
  const context = await ports.buildContext(active.attempt, active.problem);
  emit('context-assembled', `AIContext v${context.version} assembled for ${request.triggerKind}`);
  let raw: unknown;
  try {
    emit('request-sent', 'Provider request dispatched (headers/keys never traced)');
    raw = await withTimeout(ports.reasoner.evaluate(context, {}), ports.timeoutMs);
    emit('response-received', 'Provider response received, parsing envelope');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('AI evaluation timed out')) {
      emit('completed', 'Evaluation failed: timeout');
      return { status: 'failed', reason: 'timeout', detail: err.message };
    }
    if (err instanceof SyntaxError) {
      emit('completed', 'Evaluation failed: malformed-response');
      return { status: 'failed', reason: 'malformed-response', detail: err.message };
    }
    // Rate limiting is classified here at the transport edge: only HTTP 429
    // becomes 'rate-limited'. Every other provider failure keeps the generic
    // 'provider-error' outcome, and timeouts/malformed output above are
    // untouched. Nothing is persisted for any failure either way.
    if (err instanceof HttpProviderError && err.status === 429) {
      const retryAfterMs = parseRetryAfterDelayMs(err.retryAfter);
      emit('completed', 'Evaluation failed: rate-limited');
      return {
        status: 'failed',
        reason: 'rate-limited',
        detail: err.message,
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      };
    }
    emit('completed', 'Evaluation failed: provider-error');
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
    emit('validation-failed', 'Provider output failed schema validation');
    return { status: 'failed', reason: 'malformed-response', detail: 'provider output failed schema validation' };
  }
  emit(
    'validation-passed',
    validated.shouldIntervene ? `Intervening as ${validated.interventionType}` : 'Silent look, no intervention',
    { evaluationId: validated.evaluationId },
  );
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
  const displayed = stillActive && evaluation.shouldIntervene;
  emit('completed', displayed ? 'Evaluated and displayed' : 'Evaluated without display', {
    evaluationId: evaluation.evaluationId,
  });
  return { status: 'evaluated', evaluation, displayed };
}
