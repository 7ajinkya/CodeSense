import {
  acceptRecommendation,
  deferRecommendation,
  skipRecommendation,
} from './recommendation';
import type { LongTermRecommendation } from './recommendation';
import type { LongTermPriority } from './prioritization';

/**
 * Phase J-5 Stage 1 — learner-choice resolution over frozen J-3/J-4 state.
 * Pure domain layer: no UI, no AI, no network, no clock (callers inject
 * `now`), no randomness, no persistence, no scores.
 *
 * Ownership (frozen phases stay authoritative):
 * - J-3 owns the recommendation lifecycle. Every disposition here delegates
 *   to an existing J-3 transition, whose validation (including terminal
 *   states) is preserved untouched. No transition is reimplemented.
 * - J-4 owns prioritization and agenda reasons. `isActionable` consumes a
 *   freshly derived agenda verbatim; J-5 never re-ranks and never inspects D.
 * - F2 owns activity planning. 'another' returns the minimum planning
 *   request the existing F2 seam needs — the declined problem ID for
 *   `LearnerPreference.excludeProblemIds` plus the copied goal reference.
 *   J-5 never constructs an ActivityPlan, never selects a replacement
 *   problem, never generates anything, and never calls F2/I itself.
 * - D owns evidence. This module has no D imports at all (not even a
 *   writer handle exists to misuse): choice can never become evidence.
 */

export type LearnerChoiceAction = 'start' | 'another' | 'later' | 'skip' | 'why';

export const LEARNER_CHOICE_ACTIONS: readonly LearnerChoiceAction[] = [
  'start',
  'another',
  'later',
  'skip',
  'why',
];

export function isKnownLearnerChoiceAction(value: unknown): value is LearnerChoiceAction {
  return typeof value === 'string' && (LEARNER_CHOICE_ACTIONS as readonly string[]).includes(value);
}

export interface ChoiceInputs {
  /** Selected J-4 agenda item (its reason is surfaced by 'why'). */
  priority: LongTermPriority;
  /** Corresponding J-3 recommendation (the only row ever transitioned). */
  recommendation: LongTermRecommendation;
  action: LearnerChoiceAction;
  /** Explicit timestamp for J-3 transitions (injected, never clock-read). */
  now: string;
}

/**
 * Minimum F2 planning request for 'another'. Shaped 1:1 onto the existing
 * F2 seam: `excludeProblemIds` feeds `LearnerPreference.excludeProblemIds`
 * and `goalId` identifies the goal the caller already holds for
 * `planNextActivity`. Null goalId propagates honestly — J-5 never invents
 * a goal to plan against.
 */
export interface AlternativeActivityRequest {
  goalId: string | null;
  excludeProblemIds: string[];
}

export interface ChoiceResult {
  /** Updated recommendation (identical reference for 'why'). */
  recommendation: LongTermRecommendation;
  /** Set only for 'another'; the caller invokes F2, never J-5. */
  alternativeRequest: AlternativeActivityRequest | null;
  /** Stored J-3 explanation (plus agenda reason for 'why'). */
  explanation: string;
}

/**
 * Resolve one learner action on one agenda item. Pure: same inputs always
 * yield the same result; inputs are never mutated.
 *
 * - start   → J-3 accept (disposition only, never completion).
 * - skip    → J-3 skip (terminal; structurally incapable of evidence).
 * - later   → J-3 defer (terminal disposition; resurfaces only via derivation).
 * - another → J-3 skip on the current row + minimum F2 request excluding
 *             the declined problem. The underlying need is preserved because
 *             nothing about D/F1/J-2 state is touched.
 * - why     → strictly read-only: stored explanation + agenda reason.
 *
 * Illegal actions and illegal lifecycle transitions throw, following
 * existing J-3 conventions (fail loudly, never invent behavior).
 */
export function resolveChoice(inputs: ChoiceInputs): ChoiceResult {
  if (!isKnownLearnerChoiceAction(inputs.action)) {
    throw new Error(`Unknown learner choice action: ${String(inputs.action)}.`);
  }
  if (inputs.priority === null || inputs.priority === undefined) {
    throw new Error('Cannot resolve a learner choice without the selected agenda item.');
  }
  if (inputs.recommendation === null || inputs.recommendation === undefined) {
    throw new Error('Cannot resolve a learner choice without the corresponding recommendation.');
  }
  const { priority, recommendation, action, now } = inputs;
  switch (action) {
    case 'start':
      return {
        recommendation: acceptRecommendation(recommendation, now),
        alternativeRequest: null,
        explanation: recommendation.explanation,
      };
    case 'skip':
      return {
        recommendation: skipRecommendation(recommendation, now),
        alternativeRequest: null,
        explanation: recommendation.explanation,
      };
    case 'later':
      return {
        recommendation: deferRecommendation(recommendation, now),
        alternativeRequest: null,
        explanation: recommendation.explanation,
      };
    case 'another': {
      const declinedProblemId =
        recommendation.role === 'reinforcement'
          ? recommendation.reinforcementProblemId
          : recommendation.sourceProblemId;
      return {
        recommendation: skipRecommendation(recommendation, now),
        alternativeRequest: {
          goalId: recommendation.goalId,
          excludeProblemIds: [declinedProblemId],
        },
        explanation: recommendation.explanation,
      };
    }
    case 'why':
      return {
        recommendation,
        alternativeRequest: null,
        explanation: `${recommendation.explanation}\n\nAgenda context: ${priority.reason}`,
      };
  }
}

/**
 * A persisted recommendation is actionable only if its ID is represented in
 * the freshly derived J-4 agenda. Persistence alone never suffices — an
 * obsolete recommendation stays stored but not actionable. Null-safe
 * predicate (null inputs simply mean "not actionable").
 */
export function isActionable(args: {
  recommendation: LongTermRecommendation | null;
  agenda: LongTermPriority[] | null;
}): boolean {
  if (args.recommendation === null || args.recommendation === undefined) {
    return false;
  }
  if (!Array.isArray(args.agenda)) {
    return false;
  }
  return args.agenda.some((item) => item !== null && item !== undefined && item.recommendationId === args.recommendation!.recommendationId);
}
