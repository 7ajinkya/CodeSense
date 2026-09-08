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

export type EvaluationTriggerKind = TriggerKind | 'manual' | 'reply';

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

/**
 * Phase B structured diagnosis: the coach's explicit reasoning chain.
 *
 * Epistemic levels stay separate: `observedEvidence` holds only concrete
 * facts traceable to telemetry/code/execution/explicit learner messages,
 * while `hypothesis` is the explicitly-labeled interpretation. `confidence`
 * is confidence in the hypothesis — never confidence in the learner, never
 * a mastery score. `recommendedInteraction` reuses the existing intervention
 * vocabulary for what should happen next (it may legitimately differ from
 * this evaluation's own interventionType, e.g. hint now, nothing next).
 */
export type DiagnosticConfidence = 'low' | 'medium' | 'high';

export function isKnownDiagnosticConfidence(value: string): value is DiagnosticConfidence {
  return value === 'low' || value === 'medium' || value === 'high';
}

export interface AIDiagnosis {
  observedEvidence: string[];
  hypothesis: string;
  confidence: DiagnosticConfidence;
  unknowns: string[];
  recommendedInteraction: InterventionType;
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
  /** Phase B explicit reasoning chain (see AIDiagnosis). */
  diagnosis: AIDiagnosis;
  /**
   * Phase B explicit response expectation, deliberately SEPARATE from
   * interventionType: a HINT may still ask a question the learner
   * should answer, while an EXPLANATION may expect nothing back.
   * Always false for the coerced no-action (NONE) shape.
   */
  requiresLearnerResponse: boolean;
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
 * an empty message and requiresLearnerResponse=false, so downstream code
 * has exactly one "no action" shape.
 *
 * Phase B additions (same philosophy): the diagnosis block is required and
 * strictly shaped; an intervening evaluation must ground itself in at least
 * one non-blank observed fact (a hint with zero evidence is exactly the
 * hallucination pattern); requiresLearnerResponse must be an explicit
 * boolean and is coerced to false for the no-action shape. Uncertainty is
 * expressed through low confidence + unknowns — never by inventing facts,
 * which the evidence requirement structurally blocks.
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
  if (typeof r.requiresLearnerResponse !== 'boolean') {
    return null;
  }
  const diagnosis = validateAIDiagnosis(r.diagnosis, r.shouldIntervene);
  if (!diagnosis) {
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
    diagnosis,
    requiresLearnerResponse: shouldIntervene ? r.requiresLearnerResponse : false,
  };
}

/**
 * Strict validation of the Phase B diagnosis block. `intervening` mirrors
 * the raw shouldIntervene flag: an evaluation that acts must cite at least
 * one concrete observed fact; a silent look may carry empty evidence but
 * any entries it does carry must still be well-formed strings.
 */
export function validateAIDiagnosis(diagnosis: unknown, intervening: boolean): AIDiagnosis | null {
  if (typeof diagnosis !== 'object' || diagnosis === null) {
    return null;
  }
  const d = diagnosis as Record<string, unknown>;
  const observedEvidence: unknown = d.observedEvidence;
  const hypothesis: unknown = d.hypothesis;
  const confidence: unknown = d.confidence;
  const unknowns: unknown = d.unknowns;
  const recommendedInteraction: unknown = d.recommendedInteraction;
  if (
    !Array.isArray(observedEvidence) ||
    observedEvidence.some((e: unknown) => typeof e !== 'string' || e.trim().length === 0) ||
    (intervening && observedEvidence.length === 0)
  ) {
    return null;
  }
  if (typeof hypothesis !== 'string' || (intervening && hypothesis.trim().length === 0)) {
    return null;
  }
  if (typeof confidence !== 'string' || !isKnownDiagnosticConfidence(confidence)) {
    return null;
  }
  if (
    !Array.isArray(unknowns) ||
    unknowns.some((u: unknown) => typeof u !== 'string' || u.trim().length === 0)
  ) {
    return null;
  }
  if (typeof recommendedInteraction !== 'string' || !isKnownInterventionType(recommendedInteraction)) {
    return null;
  }
  return {
    observedEvidence: [...(observedEvidence as string[])],
    hypothesis,
    confidence,
    unknowns: [...(unknowns as string[])],
    recommendedInteraction,
  };
}
