import { randomUUID } from 'crypto';
import { AIContext } from '../context/aiContext';
import { TriggerKind } from '../triggers/triggerEngine';

/**
 * AI Layer V1 types: the contract between CodeSense telemetry/history and
 * any language-model provider.
 *
 * Layer separation (strict):
 *   Telemetry        -> what happened?
 *   History          -> what exactly was the code?
 *   Trigger Engine   -> when should AI look?
 *   AI Context       -> what relevant information should AI see?
 *   AIReasoner       -> what does this behavior suggest? (this module's input side)
 *   AIEvaluation     -> pedagogical decision (this module's output side)
 *   Learner          -> what happens next?
 *
 * The rest of CodeSense depends only on `AIReasoner`, never on a vendor.
 */

export type EvaluationTriggerKind = TriggerKind | 'manual';

export type InterventionType =
  | 'NONE'
  | 'ACKNOWLEDGE'
  | 'SOCRATIC_QUESTION'
  | 'HINT'
  | 'EXPLANATION'
  | 'DEBUGGING_HELP'
  | 'CONCEPT_REVIEW'
  | 'SOLUTION_GUIDANCE';

export const INTERVENTION_TYPES: readonly InterventionType[] = [
  'NONE',
  'ACKNOWLEDGE',
  'SOCRATIC_QUESTION',
  'HINT',
  'EXPLANATION',
  'DEBUGGING_HELP',
  'CONCEPT_REVIEW',
  'SOLUTION_GUIDANCE',
];

export function isKnownInterventionType(value: string): value is InterventionType {
  return (INTERVENTION_TYPES as readonly string[]).includes(value);
}

export type InterventionUrgency = 'low' | 'medium' | 'high';

export function isKnownUrgency(value: string): value is InterventionUrgency {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Concise structured conclusions/evidence — NOT hidden chain-of-thought.
 * Short factual summaries the coach is willing to stand behind.
 */
export interface ReasoningSignals {
  observedApproach: string | null;
  suspectedIssue: string | null;
  /** 0..1 or null when the coach is explicitly uncertain. */
  confidence: number | null;
  relevantEvidence: string[];
}

export interface AIEvaluation {
  evaluationId: string;
  attemptId: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  triggerKind: EvaluationTriggerKind;
  /** False means "looked, no intervention needed" — a fully valid outcome. */
  shouldIntervene: boolean;
  interventionType: InterventionType;
  urgency: InterventionUrgency;
  /** Learner-facing message; empty unless an intervention is requested. */
  message: string;
  reasoningSignals: ReasoningSignals;
}

export type ConversationRole = 'coach' | 'learner';

export interface AIConversationMessage {
  messageId: string;
  attemptId: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  role: ConversationRole;
  text: string;
  /** Set on coach messages produced by an evaluation. */
  evaluationId?: string;
}

export function generateEvaluationId(): string {
  return 'eval_' + randomUUID();
}

export function generateConversationMessageId(): string {
  return 'amsg_' + randomUUID();
}

/** Provider-independent reasoner. Implementations must not throw for
 *  validation concerns — return raw parsed JSON and let the runner validate.
 *  Transport failures (network/HTTP/timeout) SHOULD throw. */
export interface AIReasoner {
  readonly name: string;
  evaluate(context: AIContext, opts: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * Strict validation of raw provider output. Returns a normalized evaluation
 * or null (→ graceful failure, never a crash, never a guessed intervention).
 * Normalization: non-intervening evaluations are coerced to type NONE with
 * an empty message so downstream code has exactly one "no action" shape.
 */
export function validateAIEvaluation(
  raw: unknown,
  opts: { attemptId: string; triggerKind: EvaluationTriggerKind; timestamp: string },
): AIEvaluation | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.shouldIntervene !== 'boolean') {
    return null;
  }
  if (typeof r.interventionType !== 'string' || !isKnownInterventionType(r.interventionType)) {
    return null;
  }
  if (typeof r.urgency !== 'string' || !isKnownUrgency(r.urgency)) {
    return null;
  }
  if (typeof r.message !== 'string') {
    return null;
  }
  const signalsRaw: unknown = r.reasoningSignals;
  if (typeof signalsRaw !== 'object' || signalsRaw === null) {
    return null;
  }
  const signals = signalsRaw as Record<string, unknown>;
  const observedApproach = signals.observedApproach;
  const suspectedIssue = signals.suspectedIssue;
  const confidence = signals.confidence;
  const evidence = signals.relevantEvidence;
  if (
    (observedApproach !== null && typeof observedApproach !== 'string') ||
    (suspectedIssue !== null && typeof suspectedIssue !== 'string') ||
    (confidence !== null &&
      (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))) ||
    !Array.isArray(evidence) ||
    evidence.some((e: unknown) => typeof e !== 'string')
  ) {
    return null;
  }
  if (r.shouldIntervene && r.message.trim().length === 0) {
    return null;
  }
  if (r.interventionType === 'NONE' && r.shouldIntervene) {
    return null;
  }
  const shouldIntervene = r.shouldIntervene && r.interventionType !== 'NONE';
  return {
    evaluationId: generateEvaluationId(),
    attemptId: opts.attemptId,
    timestamp: opts.timestamp,
    triggerKind: opts.triggerKind,
    shouldIntervene,
    interventionType: shouldIntervene ? r.interventionType : 'NONE',
    urgency: r.urgency,
    message: shouldIntervene ? r.message : '',
    reasoningSignals: {
      observedApproach: observedApproach as string | null,
      suspectedIssue: suspectedIssue as string | null,
      confidence: confidence as number | null,
      relevantEvidence: [...(evidence as string[])],
    },
  };
}
