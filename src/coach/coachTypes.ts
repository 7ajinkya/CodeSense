import type { InterventionType } from '../ai/aiTypes';
import type { DiagnosticConfidence } from '../ai/aiTypes';
import type { EvidenceConfidence, KnowledgeStatus } from '../learner/learnerTypes';

/**
 * Phase E coaching contracts: the personalized coach's working vocabulary.
 *
 * Responsibility split (frozen boundaries respected):
 * - Phase C OWNS "what knowledge does this problem require?"
 * - Phase D OWNS persisted evidence, aggregation, capability states.
 * - Phase E OWNS "what should CodeSense do/say for this learner right
 *   now?" — diagnosis assembly, intervention recommendation, short-lived
 *   coach state, outcome derivation, finalization packaging.
 *
 * Everything here is plain JSON-serializable data. Nothing in this module
 * persists anything: durable facts travel through the existing Phase D
 * evidence machinery, and ephemeral state is rebuilt per evaluation from
 * existing stores.
 */

export const COACH_CONTRACT_VERSION = 1;

/**
 * What kind of difficulty the current situation looks like. Mapped
 * deterministically from the AI's recommendedInteraction + attempt state
 * (see coachDecision); never parsed out of free text.
 */
export type DifficultyType =
  | 'conceptual'
  | 'implementation'
  | 'debugging'
  | 'recognition'
  | 'transfer'
  | 'tooling'
  | 'unknown';

export const DIFFICULTY_TYPES: readonly DifficultyType[] = [
  'conceptual',
  'implementation',
  'debugging',
  'recognition',
  'transfer',
  'tooling',
  'unknown',
];

export function isKnownDifficultyType(value: unknown): value is DifficultyType {
  return typeof value === 'string' && (DIFFICULTY_TYPES as readonly string[]).includes(value);
}

/**
 * What the next interaction is FOR. Small closed set on purpose: the
 * objective names the intent, the intervention type names the vehicle.
 */
export type PedagogicalObjective =
  | 'disambiguate'
  | 'target-gap'
  | 'consolidate'
  | 'unstick-debugging'
  | 'acknowledge-progress'
  | 'honor-request'
  | 'reconnect';

export const PEDAGOGICAL_OBJECTIVES: readonly PedagogicalObjective[] = [
  'disambiguate',
  'target-gap',
  'consolidate',
  'unstick-debugging',
  'acknowledge-progress',
  'honor-request',
  'reconnect',
];

/**
 * Interaction-scoped engagement signals, derived ONLY from conservative
 * observables on the latest learner message (explicit request phrasing,
 * question marks, reply length). These are coaching signals for THIS turn
 * — never traits, never persisted as learner state. Affect inference
 * beyond this (frustration, confidence) stays with the AI under prompt
 * rules that forbid trait-labeling.
 */
export interface LearnerSignals {
  /** Learner explicitly asked for the answer/solution in so many words. */
  asksForSolution: boolean;
  /** Learner explicitly asked for an explanation (not a hint). */
  asksForExplanation: boolean;
  /** Latest learner message ends with a question. */
  asksQuestion: boolean;
  /** Coarse reply-size bucket (verbosity is not understanding). */
  replyLengthBucket: 'none' | 'short' | 'medium' | 'long';
}

export function emptyLearnerSignals(): LearnerSignals {
  return { asksForSolution: false, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'none' };
}

/**
 * The learner-model slice relevant to ONE coaching decision: capability
 * states only for entities the current problem exercises (or is related
 * to), plus mistake patterns touching them. Bounded by construction —
 * never the whole profile, never raw history.
 */
export interface LearnerRelevance {
  entityId: string;
  status: KnowledgeStatus;
  statusConfidence: EvidenceConfidence;
  /** Dimensions with non-UNKNOWN levels, for targeted (not broad) claims. */
  activeDimensions: string[];
  /** Supporting minus contradicting weight sign: 'positive' | 'negative' | 'mixed' | 'none'. */
  evidenceBalance: 'positive' | 'negative' | 'mixed' | 'none';
}

/**
 * Phase E diagnosis: OBSERVED → HYPOTHESIS → CONFIDENCE → UNKNOWNS →
 * pedagogical objective. The hypothesis text stays the AI's own
 * explicitly-labeled interpretation (Phase B contract); Phase E adds the
 * deterministic grounding around it (learner relevance, difficulty type,
 * objective) without rewriting the model's words.
 */
export interface CoachDiagnosis {
  /** Concrete facts, traceable to telemetry/code/runs/learner words. */
  observed: string[];
  /** The AI's explicitly-labeled interpretation, quoted not endorsed. */
  hypothesis: string;
  /** Confidence in the hypothesis (capped combination, never learner mastery). */
  confidence: DiagnosticConfidence;
  /** Rival explanations and open questions, preserved not resolved. */
  unknowns: string[];
  difficultyType: DifficultyType;
  pedagogicalObjective: PedagogicalObjective;
  learnerRelevance: LearnerRelevance[];
}

/**
 * Deterministic intervention recommendation on the EXISTING
 * InterventionType vocabulary. Advisory to the model (briefed in
 * context), never an override — the frozen validator/runner keep final
 * say, which preserves learner agency and model judgment alike.
 */
export interface CoachDecision {
  proposed: InterventionType;
  /** Why this rung: cites inputs (learner state, confidence, history). */
  rationale: string[];
  /** True when learner-state evidence (not just current code) moved the needle. */
  usedLearnerState: boolean;
  /** True when the recommendation answers an explicit learner request. */
  honorsExplicitRequest: boolean;
}

/** The latest intervening evaluation on this attempt, if any. */
export interface PreviousIntervention {
  evaluationId: string;
  timestamp: string;
  interventionType: InterventionType;
  triggerKind: string;
  requiredResponse: boolean;
}

/**
 * Qualitative outcome of one intervention, derived ONLY from observables
 * after it: replies, state transitions, terminal states. No helpfulness
 * scores, no content judging — "progressed" requires an AC terminal AFTER
 * a reply, nothing weaker.
 */
export type InterventionOutcomeKind =
  | 'progressed'
  | 'no-progress'
  | 'abandoned'
  | 'unclear';

export interface InterventionOutcome {
  evaluationId: string;
  responded: boolean;
  responseLatencyMs: number | null;
  /** State transitions strictly after the intervention, oldest first. */
  transitionsAfter: Array<{ at: string; from: string; to: string }>;
  outcome: InterventionOutcomeKind;
}

/**
 * Short-lived coaching state for ONE attempt at ONE moment. Rebuilt per
 * evaluation from existing persisted stores — never stored itself. If a
 * future phase needs any of this durably, it routes through Phase D
 * evidence, not through this struct.
 */
export interface CoachState {
  contractVersion: number;
  attemptId: string;
  builtAt: string;
  diagnosis: CoachDiagnosis | null;
  decision: CoachDecision | null;
  signals: LearnerSignals;
  previousIntervention: PreviousIntervention | null;
  previousOutcome: InterventionOutcome | null;
  /** Consecutive abandonments on this problem (corroboration counter, not a verdict). */
  abandonmentStreak: number;
}

/**
 * Candidate evidence produced by coaching interactions. This is a
 * TRANSPORT envelope only: candidates MUST pass through the existing
 * Phase D validators/feeds (which re-check entity IDs, shapes, and
 * provenance) before anything is persisted. Phase E never writes the
 * learner model directly.
 */
export interface CandidateEvidence {
  /** Opaque payload destined for a Phase D extractor/validator. */
  payload: unknown;
  /** Which Phase D entry point accepts it (documents the routing). */
  route: 'mistake-report' | 'recognition' | 'reply-assessment' | 'records';
  /** Why this candidate exists (evaluation id, finalization, pattern). */
  reason: string;
}

/** One evidence excerpt cited in coaching context (bounded, read-only). */
export interface EvidenceExcerpt {
  entityId: string;
  evidenceType: string;
  confidence: string;
  timestamp: string;
  observation: string;
}

/**
 * Serializable coaching context for ONE evaluation turn. Composes the
 * learner-model slice relevant to the current problem with the
 * conversation/intervention situation. Built purely per evaluation,
 * attached to AIContext optionally, rendered as one bounded briefing
 * section. Never the whole history: entity states for the problem's
 * entities + a few recent excerpts per entity + touching patterns.
 */
export interface CoachContext {
  contractVersion: number;
  attemptId: string;
  problemId: string;
  triggerKind: string;
  /** Problem entity IDs considered, classification order, capped. */
  entityIds: string[];
  learnerRelevance: LearnerRelevance[];
  prerequisiteStatuses: Array<{ entityId: string; status: string; statusConfidence: string }>;
  activeMistakeCategories: string[];
  recentEvidence: EvidenceExcerpt[];
  previousIntervention: PreviousIntervention | null;
  previousOutcome: InterventionOutcome | null;
  priorInterventionCount: number;
  signals: LearnerSignals;
  abandonmentStreak: number;
}
