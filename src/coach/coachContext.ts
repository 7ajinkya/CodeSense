import type { AIConversationMessage, AIEvaluation, InterventionType } from '../ai/aiTypes';
import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { getDefaultKnowledgeGraph } from '../knowledge/ontologyStore';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import {
  getEvidenceForEntity,
  getLearnerKnowledge,
  getRecentEvidence,
  getRecurringMistakes,
} from '../learner/learnerQueries';
import { COACH_CONTRACT_VERSION } from './coachTypes';
import type {
  CoachContext,
  CoachDecision,
  CoachDiagnosis,
  DifficultyType,
  LearnerRelevance,
  PedagogicalObjective,
} from './coachTypes';
import { recommendIntervention } from './coachDecision';
import {
  abandonmentStreakForProblem,
  deriveInterventionOutcome,
  detectLearnerSignals,
  previousInterventionForAttempt,
} from './coachState';

/**
 * Phase E coach context: the bounded, deterministic learner-aware slice
 * assembled per evaluation turn.
 *
 * Selectiveness rules (so future retrieval stays bounded):
 * - Entities: the current problem's classified IDs in bucket order
 *   (frameworks → forms → concepts → patterns → variants → topics →
 *   tactics → prerequisites → solutionFamilies), deduped, capped.
 * - Evidence: at most N recent records per considered entity — excerpts
 *   (type/confidence/time/observation), never full text dumps.
 * - Mistakes: unresolved patterns touching considered entities only.
 * - Everything else (previous intervention/outcome, signals, streak) is
 *   derived from already-loaded stores, no new I/O shape.
 *
 * Pure: same inputs → same context. Fail-open at the call site (a null
 * return is never used — callers pass empty inputs instead and still get
 * a valid, merely sparse context).
 */

export const MAX_COACH_ENTITIES = 12;
export const MAX_COACH_EVIDENCE_PER_ENTITY = 3;
export const MAX_COACH_EVIDENCE_CHARS = 300;
export const MAX_COACH_MISTAKES = 3;
export const COACH_CONTEXT_VERSION = COACH_CONTRACT_VERSION;

function classificationEntityIds(classification: ProblemClassification | null | undefined): string[] {
  if (!classification) {
    return [];
  }
  const buckets = [
    'frameworks',
    'forms',
    'concepts',
    'patterns',
    'variants',
    'topics',
    'tactics',
    'prerequisites',
    'solutionFamilies',
  ] as const;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const ref of classification[bucket]) {
      if (typeof ref.entityId === 'string' && ref.entityId.length > 0 && !seen.has(ref.entityId)) {
        seen.add(ref.entityId);
        out.push(ref.entityId);
      }
    }
  }
  return out.slice(0, MAX_COACH_ENTITIES);
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

export interface BuildCoachContextArgs {
  attempt: Attempt;
  problem: Problem;
  classification: ProblemClassification | null | undefined;
  profile: LearnerProfile | null;
  evidence: LearnerEvidence[];
  evaluations: AIEvaluation[];
  conversation: AIConversationMessage[];
  previousAttempts: Attempt[];
  triggerKind: string;
  graph?: KnowledgeGraph;
}

export function buildCoachContext(args: BuildCoachContextArgs): CoachContext {
  const graph = args.graph ?? getDefaultKnowledgeGraph();
  void graph;
  const entityIds = classificationEntityIds(args.classification);
  const learnerRelevance: LearnerRelevance[] = [];
  if (args.profile) {
    for (const entityId of entityIds) {
      const state = getLearnerKnowledge(args.profile, entityId);
      if (!state) {
        continue;
      }
      const activeDimensions = (
        ['recognition', 'conceptual', 'implementation', 'debugging', 'transfer', 'independence'] as const
      )
        .filter((d) => state[d].level !== 'UNKNOWN')
        .map((d) => `${d}:${state[d].level.toLowerCase()}`);
      const supporting = state.supportingEvidenceIds.length;
      const contradicting = state.contradictingEvidenceIds.length;
      learnerRelevance.push({
        entityId,
        status: state.status,
        statusConfidence: state.statusConfidence,
        activeDimensions,
        evidenceBalance: supporting > 0 && contradicting > 0 ? 'mixed' : supporting > 0 ? 'positive' : contradicting > 0 ? 'negative' : 'none',
      });
    }
  }
  const prerequisiteStatuses = (args.classification?.prerequisites ?? []).map((ref) => {
    const state = args.profile ? getLearnerKnowledge(args.profile, ref.entityId) : null;
    return {
      entityId: ref.entityId,
      status: state ? state.status : 'unknown',
      statusConfidence: state ? state.statusConfidence : 'low',
    };
  });
  const activeMistakeCategories = args.profile
    ? [
        ...new Set(
          getRecurringMistakes(args.profile)
            .filter((m) => m.relatedEntityIds.some((id) => entityIds.includes(id)))
            .map((m) => m.category),
        ),
      ].slice(0, MAX_COACH_MISTAKES)
    : [];
  const recentEvidence: CoachContext['recentEvidence'] = [];
  for (const entityId of entityIds) {
    for (const record of getRecentEvidence(args.evidence, entityId, MAX_COACH_EVIDENCE_PER_ENTITY)) {
      recentEvidence.push({
        entityId,
        evidenceType: record.evidenceType,
        confidence: record.confidence,
        timestamp: record.timestamp,
        observation: clip(record.observation, MAX_COACH_EVIDENCE_CHARS),
      });
    }
  }
  const previousIntervention = previousInterventionForAttempt(args.evaluations, args.attempt.attemptId);
  let previousOutcome: CoachContext['previousOutcome'] = null;
  if (previousIntervention) {
    const evaluation = args.evaluations.find((e) => e.evaluationId === previousIntervention.evaluationId);
    if (evaluation) {
      previousOutcome = deriveInterventionOutcome({ evaluation, conversation: args.conversation, attempt: args.attempt });
    }
  }
  const priorInterventionCount = args.evaluations.filter(
    (e) => e.attemptId === args.attempt.attemptId && e.shouldIntervene,
  ).length;
  return {
    contractVersion: COACH_CONTEXT_VERSION,
    attemptId: args.attempt.attemptId,
    problemId: args.problem.problemId,
    triggerKind: args.triggerKind,
    entityIds,
    learnerRelevance,
    prerequisiteStatuses,
    activeMistakeCategories,
    recentEvidence,
    previousIntervention,
    previousOutcome,
    priorInterventionCount,
    signals: detectLearnerSignals(args.conversation),
    abandonmentStreak: abandonmentStreakForProblem(args.previousAttempts),
  };
}

/** Map the AI's recommended next interaction to a difficulty shape. */
export function difficultyForInteraction(
  recommended: InterventionType,
  evaluationIntervention: InterventionType,
): DifficultyType {
  const next = recommended !== 'NONE' ? recommended : evaluationIntervention;
  switch (next) {
    case 'DEBUGGING_HELP':
      return 'debugging';
    case 'CONCEPT_REVIEW':
    case 'EXPLANATION':
    case 'SOLUTION_GUIDANCE':
      return 'conceptual';
    case 'HINT':
      return 'implementation';
    case 'SOCRATIC_QUESTION':
    case 'ACKNOWLEDGE':
    case 'NONE':
    default:
      return 'unknown';
  }
}

function objectiveFor(
  difficulty: DifficultyType,
  confidence: CoachDiagnosis['confidence'],
  context: CoachContext,
  signals: CoachContext['signals'],
): PedagogicalObjective {
  if (signals.asksForSolution || signals.asksForExplanation) {
    return 'honor-request';
  }
  if (context.previousOutcome?.outcome === 'progressed') {
    return 'acknowledge-progress';
  }
  if (context.abandonmentStreak >= 2) {
    return 'reconnect';
  }
  if (difficulty === 'unknown' || confidence === 'low') {
    return 'disambiguate';
  }
  if (difficulty === 'debugging') {
    return 'unstick-debugging';
  }
  const allStrong =
    context.learnerRelevance.length > 0 &&
    context.learnerRelevance.every((r) => r.status === 'strong' || r.status === 'demonstrated');
  if (allStrong) {
    return 'consolidate';
  }
  return 'target-gap';
}

/**
 * Post-evaluation synthesis: attach the AI's own diagnosis to the
 * deterministic grounding and run the recommendation policy. Used for
 * the trace, for tests of the full loop, and to brief the NEXT turn.
 * The AI's hypothesis text is quoted, never rewritten or endorsed.
 */
export function summarizeCoachingTurn(args: {
  evaluation: AIEvaluation;
  coachContext: CoachContext;
  attemptState: string;
}): { diagnosis: CoachDiagnosis; decision: CoachDecision } {
  const { evaluation, coachContext } = args;
  const difficultyType = difficultyForInteraction(
    evaluation.diagnosis.recommendedInteraction,
    evaluation.interventionType,
  );
  const diagnosis: CoachDiagnosis = {
    observed: [...evaluation.diagnosis.observedEvidence],
    hypothesis: evaluation.diagnosis.hypothesis,
    confidence: evaluation.diagnosis.confidence,
    unknowns: [...evaluation.diagnosis.unknowns],
    difficultyType,
    pedagogicalObjective: objectiveFor(difficultyType, evaluation.diagnosis.confidence, coachContext, coachContext.signals),
    learnerRelevance: coachContext.learnerRelevance,
  };
  const decision = recommendIntervention({
    difficultyType,
    diagnosticConfidence: evaluation.diagnosis.confidence,
    hasUnknowns: evaluation.diagnosis.unknowns.length > 0,
    learnerRelevance: coachContext.learnerRelevance,
    prerequisiteStatuses: coachContext.prerequisiteStatuses,
    activeMistakeCategories: coachContext.activeMistakeCategories,
    signals: coachContext.signals,
    previousIntervention: coachContext.previousIntervention,
    previousOutcome: coachContext.previousOutcome,
    urgency: evaluation.urgency,
    attemptState: args.attemptState,
    abandonmentStreak: coachContext.abandonmentStreak,
    priorInterventionCount: coachContext.priorInterventionCount,
  });
  return { diagnosis, decision };
}

/** Chronological evidence behind one entity's trajectory (for deep dives). */
export function trajectoryEvidence(
  evidence: LearnerEvidence[],
  entityId: string,
  limit = MAX_COACH_EVIDENCE_PER_ENTITY * 2,
): LearnerEvidence[] {
  return getEvidenceForEntity(evidence, entityId).slice(-limit);
}
