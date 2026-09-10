import {
  applyCompletion,
  deriveRevisitRecommendation,
  evaluateCompletion,
} from './recommendation';
import type { Attempt } from '../attempts/attempt';
import type { ActivityProgress } from '../progress/progressTypes';
import type { CompletionAssessment, LongTermRecommendation } from './recommendation';

/**
 * Phase J-5 Stage 2 — outcome observation and follow-up routing.
 * Thin pure orchestration over frozen J-3 semantics: no UI, no AI, no
 * network, no clock (callers inject `now`), no randomness, no persistence,
 * no scores, no new lifecycle states, no new interpretation.
 *
 * Ownership (frozen phases stay authoritative):
 * - J-3 owns completion and revisit derivation. Every verdict here comes
 *   from `evaluateCompletion`; every status change from `applyCompletion`;
 *   every revisit from `deriveRevisitRecommendation`. No predicate, signal
 *   reading, or identity rule is reimplemented.
 * - F3 owns progress interpretation. Signals and the independence facet are
 *   passed through untouched inside the frozen assessment object.
 * - D/F1/F2/G/H/I are not imported at all: observation reads only the
 *   recommendation/attempt/progress snapshots it is given and returns rows
 *   for the caller to persist via the existing J-3 store (whose terminal
 *   protection already guards races). Nothing here writes anything.
 */

export interface ObserveOutcomesInputs {
  /** Fresh recommendation snapshot (any statuses; terminal rows are reported untouched). */
  recommendations: LongTermRecommendation[];
  /** Fresh attempt snapshot. */
  attempts: Attempt[];
  /** Fresh F3 progress snapshot. */
  progress: ActivityProgress[];
  /** Explicit timestamp for J-3 transitions (injected, never clock-read). */
  now: string;
}

export interface OutcomeObservation {
  recommendationId: string;
  /** True only when completion was proven and applied in this pass. */
  completed: boolean;
  /**
   * Frozen J-3 ground when the row was evaluated; null when the row was
   * terminal and left untouched without evaluation.
   */
  ground: CompletionAssessment['ground'] | null;
  /** Derived revisit row, or null (not completed, not eligible, or terminal). */
  revisit: LongTermRecommendation | null;
}

export interface ObserveOutcomesResult {
  /** Rows now carrying status `completed` (post-`applyCompletion`). */
  completed: LongTermRecommendation[];
  /** Derived revisit rows (status `offered`, caller persists). */
  revisits: LongTermRecommendation[];
  /** Per-input-row report, including no-ops. */
  observations: OutcomeObservation[];
}

/**
 * Observe outcomes for one snapshot pass. Pure and idempotent: same inputs
 * always yield the same result; re-running over already-completed rows is a
 * no-op (terminal rows are never re-evaluated); duplicate input rows
 * collapse to a single observation. Inputs are never mutated.
 *
 * Only `offered`/`accepted` rows are evaluated — terminal rows
 * (`skipped`/`completed`/`superseded`) and `deferred` rows are reported
 * untouched, preserving frozen J-3 transition law (deferred has no edge to
 * completed; terminal states have no edges at all).
 */
export function observeOutcomes(inputs: ObserveOutcomesInputs): ObserveOutcomesResult {
  const completed: LongTermRecommendation[] = [];
  const revisits: LongTermRecommendation[] = [];
  const observations: OutcomeObservation[] = [];
  const seen = new Set<string>();
  for (const rec of inputs.recommendations) {
    if (seen.has(rec.recommendationId)) {
      continue;
    }
    seen.add(rec.recommendationId);
    if (rec.status !== 'offered' && rec.status !== 'accepted') {
      observations.push({ recommendationId: rec.recommendationId, completed: false, ground: null, revisit: null });
      continue;
    }
    const assessment = evaluateCompletion(rec, inputs.attempts, inputs.progress);
    if (!assessment.complete) {
      observations.push({ recommendationId: rec.recommendationId, completed: false, ground: assessment.ground, revisit: null });
      continue;
    }
    const done = applyCompletion(rec, assessment, inputs.now);
    const revisit = deriveRevisitRecommendation({ reinforcement: done, assessment, now: inputs.now });
    completed.push(done);
    if (revisit !== null) {
      revisits.push(revisit);
    }
    observations.push({ recommendationId: rec.recommendationId, completed: true, ground: assessment.ground, revisit });
  }
  return { completed, revisits, observations };
}
