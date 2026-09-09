import { createAsyncQueue } from '../util/asyncQueue';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { LearnerModelStore } from '../learner/learnerModelStore';
import { detectLearningNeeds } from './needDetection';
import { proposeGoalFromNeed } from './goalProposal';
import { findConflictingGoal, proposalFingerprint, shouldSuppressProposal } from './goalQueries';
import { isProposalFresh } from './goalFreshness';
import type { GoalStore } from './goalStore';
import type { LearningGoal } from './goalTypes';

/**
 * Post-problem goal-proposal chain (F1 host orchestration, extracted for
 * testability — no vscode dependency).
 *
 * Runs the exact historical sequence — read fresh profile/goals, detect
 * needs, persist the first non-conflicting, non-suppressed proposal —
 * with two hardening rules that the inline host version lacked:
 *
 * - Single-flight: concurrent endProblem chains serialize through an
 *   internal queue, so check-then-act (list goals → decide → upsert)
 *   cannot interleave into duplicate proposals. The queue holds no data;
 *   every task re-reads the stores.
 * - Stale proposals neither suppress nor conflict-block: only *fresh*
 *   pending proposals (need still detects now, or learner-owned requests)
 *   occupy the proposal slot. An outdated pending suggestion can neither
 *   veto a legitimate new proposal nor be mistaken for current advice.
 *
 * Pure orchestration over injected stores: never throws (fail-open
 * `{ action: 'none' }`), never surfaces UI — the host decides what, if
 * anything, to show from the returned outcome.
 */

export type GoalChainResult =
  | { action: 'proposed'; proposal: LearningGoal }
  | { action: 'suppressed-pending'; proposal: LearningGoal }
  | { action: 'none'; reason: 'no-profile' | 'no-need' | 'all-blocked' | 'error' };

export interface GoalChainPorts {
  goalStore: GoalStore;
  modelStore: LearnerModelStore;
  graph: KnowledgeGraph;
  nowIso(): string;
}

const chainQueue = createAsyncQueue();

/** Serialized entry point: concurrent callers queue behind each other. */
export function proposeGoalForAttemptEnd(ports: GoalChainPorts): Promise<GoalChainResult> {
  return chainQueue.enqueue(() => runGoalChain(ports));
}

async function runGoalChain(ports: GoalChainPorts): Promise<GoalChainResult> {
  try {
    const [profile, goals] = await Promise.all([
      ports.modelStore.loadProfile().catch(() => null),
      ports.goalStore.listGoals().catch(() => []),
    ]);
    if (!profile) {
      return { action: 'none', reason: 'no-profile' };
    }
    const now = ports.nowIso();
    const needs = detectLearningNeeds({ profile, graph: ports.graph, now, limit: 3 });
    // Freshness view: stale pendings are invisible to suppression and
    // conflict checks, but stay persisted for the learner to decide on.
    const effective = goals.filter(
      (goal) => goal.status !== 'proposed' || isProposalFresh(goal, needs),
    );
    const pendingFresh = effective
      .filter((goal) => goal.status === 'proposed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
    if (pendingFresh.length > 0 && pendingFresh[0] !== undefined) {
      return { action: 'suppressed-pending', proposal: pendingFresh[0] };
    }
    for (const need of needs) {
      const proposal = proposeGoalFromNeed(need, { graph: ports.graph, now });
      if (!proposal) {
        continue;
      }
      if (findConflictingGoal(effective, proposal.targetKey)) {
        continue;
      }
      const fingerprint = proposalFingerprint(proposal.evidenceBasis.evidenceIds, profile.updatedAt);
      if (shouldSuppressProposal(goals, proposal.targetKey, fingerprint)) {
        continue;
      }
      await ports.goalStore.upsertGoal(proposal);
      return { action: 'proposed', proposal };
    }
    return { action: 'none', reason: needs.length === 0 ? 'no-need' : 'all-blocked' };
  } catch {
    return { action: 'none', reason: 'error' };
  }
}
