import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { GoalStatus, LearningGoal } from './goalTypes';
import { evidenceFingerprint } from './goalLifecycle';

/**
 * Phase F1 consumer-facing goal retrieval. Pure functions over goal
 * lists (and evidence where noted) — the same style as Phase D queries.
 * Never throws on empty input.
 */

export const MAX_GOAL_DIGEST_LINES = 4;
export const MAX_GOAL_DIGEST_CHARS = 160;

/** Goals currently guiding the learner (active only; paused listed separately). */
export function getActiveGoals(goals: LearningGoal[]): LearningGoal[] {
  return goals
    .filter((g) => g.status === 'active')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
}

export function getProposals(goals: LearningGoal[]): LearningGoal[] {
  return goals
    .filter((g) => g.status === 'proposed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
}

export function getGoal(goals: LearningGoal[], goalId: string): LearningGoal | null {
  return goals.find((g) => g.goalId === goalId) ?? null;
}

export function getGoalsByStatus(goals: LearningGoal[], status: GoalStatus): LearningGoal[] {
  return goals
    .filter((g) => g.status === status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
}

export function getGoalsForEntity(goals: LearningGoal[], entityId: string): LearningGoal[] {
  return goals
    .filter((g) => g.entityIds.includes(entityId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
}

const OCCUPIED_STATUSES: readonly GoalStatus[] = ['proposed', 'active', 'paused'];

/**
 * Structural duplicate prevention: a goal with the same canonical target
 * key may not be proposed/activated while one is already proposed,
 * active, or paused. Terminal states (achieved/dismissed/abandoned) do
 * not block — except dismissed, which is governed by suppression below.
 */
export function findConflictingGoal(goals: LearningGoal[], targetKey: string): LearningGoal | null {
  const found = goals
    .filter((g) => g.targetKey === targetKey && (OCCUPIED_STATUSES as readonly string[]).includes(g.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
  return found[0] ?? null;
}

/**
 * Anti-spam: suppress re-proposing a dismissed goal while the evidence
 * basis is unchanged. New evidence (different fingerprint) re-opens the
 * question honestly.
 */
export function shouldSuppressProposal(
  goals: LearningGoal[],
  targetKey: string,
  fingerprint: string,
): boolean {
  return goals.some(
    (g) =>
      g.targetKey === targetKey &&
      g.status === 'dismissed' &&
      g.evidenceBasis.dismissalFingerprint === fingerprint,
  );
}

/** Fingerprint for a candidate proposal's current evidence basis. */
export function proposalFingerprint(evidenceIds: string[], profileUpdatedAt: string): string {
  return evidenceFingerprint(evidenceIds, profileUpdatedAt);
}

function clipDigest(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_GOAL_DIGEST_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_GOAL_DIGEST_CHARS - 1).trimEnd()}…`;
}

/**
 * Bounded active-goal digest for the AI coach context (appended to the
 * existing learner-notes channel in extension wiring — zero changes to
 * Phase E files). Factual lines only: description + dimension + source.
 * Empty when no active goals exist (caller omits the section).
 */
export function summarizeGoalsForPrompt(goals: LearningGoal[]): string[] {
  const active = getActiveGoals(goals).slice(0, MAX_GOAL_DIGEST_LINES);
  return active.map((goal) =>
    clipDigest(
      `Active learning goal (${goal.source === 'learner-requested' ? 'learner-chosen' : 'accepted proposal'}): ` +
        `${goal.description} [focus: ${goal.dimension}]`,
    ),
  );
}

/**
 * Split evidence into before/after a goal's baseline capture, so later
 * phases can ask "what arrived after activation?" using existing queries.
 * Goal-local evidence (matching the goal's entities) is what counts.
 */
export function laterEvidenceForGoal(
  evidence: LearnerEvidence[],
  goal: LearningGoal,
): { before: LearnerEvidence[]; after: LearnerEvidence[] } {
  const before: LearnerEvidence[] = [];
  const after: LearnerEvidence[] = [];
  const capturedAt = goal.progressBaseline?.capturedAt ?? null;
  const baselineIds = new Set(goal.progressBaseline?.evidenceIds ?? []);
  for (const record of evidence) {
    if (!record.entityIds.some((id) => goal.entityIds.includes(id))) {
      continue;
    }
    if (capturedAt !== null && record.timestamp.localeCompare(capturedAt) > 0 && !baselineIds.has(record.evidenceId)) {
      after.push(record);
    } else {
      before.push(record);
    }
  }
  const byTime = (a: LearnerEvidence, b: LearnerEvidence): number =>
    a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId);
  before.sort(byTime);
  after.sort(byTime);
  return { before, after };
}
