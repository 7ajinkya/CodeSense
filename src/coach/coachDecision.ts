import type { DiagnosticConfidence, InterventionType } from '../ai/aiTypes';
import type {
  CoachDecision,
  DifficultyType,
  LearnerRelevance,
  LearnerSignals,
  PreviousIntervention,
} from './coachTypes';
import type { InterventionOutcome } from './coachTypes';

/**
 * Phase E deterministic intervention recommendation.
 *
 * Pure function: same inputs → same recommendation, fully unit-testable
 * without a model. It advises on the EXISTING InterventionType vocabulary
 * and is briefed to the model as a starting point, never enforced —
 * the frozen validator/runner keep final say. Rationale strings cite the
 * inputs that moved the needle so tests (and future debugging) can see
 * WHY a rung was proposed.
 *
 * Hard invariants encoded here:
 * - High uncertainty → ask, don't teach (§5 hard rule).
 * - Known strengths are never retaught; gaps are targeted by entity.
 * - Explicit learner requests are honored within bounds (never force a
 *   hint when an explanation was asked; solution only on explicit
 *   request + corroborated struggle).
 * - Previous no-progress changes strategy (escalate one rung, capped
 *   below a full solution unless explicitly requested); previous
 *   progress is acknowledged, not piled onto.
 * - The ladder is guidance, not a script: rules jump rungs when the
 *   evidence justifies it, and urgency can add at most one rung — never
 *   up to a full solution on its own.
 */

export interface DecisionInput {
  difficultyType: DifficultyType;
  diagnosticConfidence: DiagnosticConfidence;
  /** True when the diagnosis lists rival explanations / open questions. */
  hasUnknowns: boolean;
  learnerRelevance: LearnerRelevance[];
  /** Prerequisite entity statuses (from classification prerequisites). */
  prerequisiteStatuses: Array<{ entityId: string; status: string; statusConfidence: string }>;
  /** Recurring (unresolved) mistake categories touching current entities. */
  activeMistakeCategories: string[];
  signals: LearnerSignals;
  previousIntervention: PreviousIntervention | null;
  previousOutcome: InterventionOutcome | null;
  /** Intervening evaluations so far on this attempt (ladder position). */
  priorInterventionCount: number;
  urgency: 'low' | 'medium' | 'high';
  /** Current attempt state (e.g. 'Got Stuck' sharpens escalation). */
  attemptState: string;
  /** Consecutive abandonments on this problem (tone guard, not verdict). */
  abandonmentStreak: number;
}

/** Ladder rungs for escalation math. Off-ladder types map to -1. */
export function ladderRank(type: InterventionType): number {
  switch (type) {
    case 'SOCRATIC_QUESTION':
      return 0;
    case 'HINT':
      return 1;
    case 'EXPLANATION':
    case 'CONCEPT_REVIEW':
    case 'DEBUGGING_HELP':
      return 2;
    case 'SOLUTION_GUIDANCE':
      return 3;
    case 'NONE':
    case 'ACKNOWLEDGE':
    default:
      return -1;
  }
}

function allStrong(relevance: LearnerRelevance[]): boolean {
  return (
    relevance.length > 0 &&
    relevance.every((r) => r.status === 'strong' || r.status === 'demonstrated')
  );
}

function corroboratedStruggle(input: DecisionInput): boolean {
  if (input.attemptState === 'Got Stuck') {
    return true;
  }
  if (input.previousOutcome && (input.previousOutcome.outcome === 'no-progress' || input.previousOutcome.outcome === 'abandoned')) {
    return true;
  }
  if (input.abandonmentStreak >= 1 && input.previousIntervention !== null) {
    return true;
  }
  return input.priorInterventionCount >= 2;
}

export function recommendIntervention(input: DecisionInput): CoachDecision {
  const rationale: string[] = [];
  let usedLearnerState = false;
  // Rule 1: explicit solution request + corroborated struggle → guidance.
  // Agency respected, but never a cold open: the request alone is not
  // enough without evidence the learner is actually stuck.
  if (input.signals.asksForSolution && corroboratedStruggle(input)) {
    rationale.push('Learner explicitly asked for the solution while stuck/struggling; honoring with guidance, not a bare answer dump.');
    return { proposed: 'SOLUTION_GUIDANCE', rationale, usedLearnerState: true, honorsExplicitRequest: true };
  }
  // Rule 2: explicit explanation request → explanation, never a forced hint.
  if (input.signals.asksForExplanation) {
    rationale.push('Learner explicitly asked for an explanation; answering directly instead of forcing a hint.');
    return { proposed: 'EXPLANATION', rationale, usedLearnerState: false, honorsExplicitRequest: true };
  }
  // Rule 3 (HARD): high uncertainty → targeted question, not teaching.
  if (input.diagnosticConfidence === 'low' && input.hasUnknowns) {
    rationale.push('Diagnostic confidence is low with open alternatives; asking first rather than assuming a weakness.');
    return { proposed: 'SOCRATIC_QUESTION', rationale, usedLearnerState: false, honorsExplicitRequest: false };
  }
  // Rule 4: known strengths everywhere → do not reteach.
  if (allStrong(input.learnerRelevance)) {
    usedLearnerState = true;
    if (input.difficultyType === 'unknown') {
      rationale.push('Relevant knowledge shows sustained positive evidence; acknowledging rather than reteaching.');
      return { proposed: 'ACKNOWLEDGE', rationale, usedLearnerState, honorsExplicitRequest: false };
    }
    rationale.push('Core knowledge is strong; probing the specific difficulty with a challenge question instead of reteaching.');
    return { proposed: 'SOCRATIC_QUESTION', rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  // Rule 5: missing prerequisite + conceptual difficulty → teach the gap.
  const prereqGap = input.prerequisiteStatuses.find(
    (p) => (p.status === 'exposed' || p.status === 'unknown' || p.status === 'developing') && p.statusConfidence !== 'high',
  );
  if (prereqGap && (input.difficultyType === 'conceptual' || input.difficultyType === 'recognition')) {
    usedLearnerState = true;
    rationale.push(`Prerequisite ${prereqGap.entityId} lacks solid evidence; targeting the gap instead of the current topic.`);
    return { proposed: 'EXPLANATION', rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  // Rule 6: recurring mistake pattern → surface the habit, not the algorithm.
  if (
    input.activeMistakeCategories.length > 0 &&
    (input.difficultyType === 'debugging' ||
      input.difficultyType === 'implementation' ||
      input.difficultyType === 'unknown')
  ) {
    usedLearnerState = true;
    rationale.push(
      `Recurring pattern "${input.activeMistakeCategories[0]}" matches this situation; naming the habit instead of reteaching the algorithm.`,
    );
    return { proposed: 'DEBUGGING_HELP', rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  // Rule 7: previous outcome moves strategy.
  if (input.previousOutcome && input.previousIntervention) {
    usedLearnerState = true;
    const prev = input.previousIntervention.interventionType;
    if (input.previousOutcome.outcome === 'progressed') {
      rationale.push('Previous intervention visibly helped; acknowledging progress rather than piling on.');
      return { proposed: 'ACKNOWLEDGE', rationale, usedLearnerState, honorsExplicitRequest: false };
    }
    if (input.previousOutcome.outcome === 'no-progress' || input.previousOutcome.outcome === 'abandoned') {
      const escalated = escalateOneRung(prev);
      // Cap: escalation alone never reaches a full solution — that rung
      // requires an explicit learner request (Rule 1). At the top of the
      // ladder without one, step back to re-disambiguate instead.
      if (escalated && (escalated !== 'SOLUTION_GUIDANCE' || input.signals.asksForSolution)) {
        rationale.push(`Previous ${prev} did not visibly move things; stepping up one rung to ${escalated}.`);
        return {
          proposed: escalated,
          rationale,
          usedLearnerState,
          honorsExplicitRequest: input.signals.asksForSolution && escalated === 'SOLUTION_GUIDANCE',
        };
      }
      if (escalated) {
        rationale.push(
          `Previous ${prev} did not visibly move things, but no solution was requested; ` +
            'stepping back to re-disambiguate instead of jumping to a full solution.',
        );
        return { proposed: 'SOCRATIC_QUESTION', rationale, usedLearnerState, honorsExplicitRequest: false };
      }
    }
    // 'unclear' (or un-escalatable): hold the rung, gather more signal.
    rationale.push('Previous outcome is unclear; holding strategy and gathering more signal instead of escalating blindly.');
    return { proposed: prev, rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  // Rule 8: abandonment streak → start small, reconnect first.
  if (input.abandonmentStreak >= 2) {
    usedLearnerState = true;
    rationale.push('Consecutive abandonments on this problem; reconnecting with a small step, not rapid escalation.');
    return { proposed: 'ACKNOWLEDGE', rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  // Rule 9/10: difficulty defaults (urgency may add at most one rung,
  // never reaching a full solution on its own).
  let proposed = defaultForDifficulty(input.difficultyType);
  if (input.urgency === 'high' && ladderRank(proposed) >= 0 && ladderRank(proposed) < 2) {
    const bumped = escalateOneRung(proposed);
    if (bumped && ladderRank(bumped) < 3) {
      rationale.push('High urgency adds one rung; still short of solution-level guidance.');
      proposed = bumped;
    }
  }
  if (proposed !== defaultForDifficulty(input.difficultyType)) {
    return { proposed, rationale, usedLearnerState, honorsExplicitRequest: false };
  }
  rationale.push(`Default rung for ${input.difficultyType} difficulty at ${input.diagnosticConfidence} confidence.`);
  return { proposed, rationale, usedLearnerState, honorsExplicitRequest: false };
}

function defaultForDifficulty(difficulty: DifficultyType): InterventionType {
  switch (difficulty) {
    case 'debugging':
      return 'DEBUGGING_HELP';
    case 'implementation':
      return 'HINT';
    case 'conceptual':
      return 'EXPLANATION';
    case 'recognition':
    case 'transfer':
    case 'tooling':
      return 'SOCRATIC_QUESTION';
    case 'unknown':
    default:
      return 'SOCRATIC_QUESTION';
  }
}

/** One rung up the ladder; null when already at/above the top or off-ladder. */
function escalateOneRung(current: InterventionType): InterventionType | null {
  switch (current) {
    case 'SOCRATIC_QUESTION':
      return 'HINT';
    case 'HINT':
      return 'EXPLANATION';
    case 'EXPLANATION':
    case 'CONCEPT_REVIEW':
    case 'DEBUGGING_HELP':
      return 'SOLUTION_GUIDANCE';
    case 'SOLUTION_GUIDANCE':
    case 'ACKNOWLEDGE':
    case 'NONE':
    default:
      return null;
  }
}
