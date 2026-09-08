import type { LearnerProfile } from '../learner/learnerModel';
import { dimensionStateOf } from '../learner/learnerModel';
import type { EvidenceDimension } from '../learner/learnerTypes';
import { GOAL_TRANSITIONS } from './goalTypes';
import type { GoalProgressBaseline, GoalStatus, LearningGoal } from './goalTypes';
import { MAX_GOAL_DESCRIPTION_CHARS, MAX_GOAL_EVIDENCE_IDS } from './goalTypes';

function truncateBounded(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Phase F1 goal lifecycle: pure status transitions plus the three
 * learner-ownership decisions. Invalid transitions throw (repo
 * convention, cf. `transitionAttemptState`) so misuse surfaces loudly
 * in tests and call sites instead of silently corrupting goal state.
 */
export function transitionGoalStatus(goal: LearningGoal, to: GoalStatus, now: string): LearningGoal {
  const allowed = GOAL_TRANSITIONS[goal.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid goal transition: ${goal.status} → ${to} (goal ${goal.goalId}).`);
  }
  return { ...goal, status: to, updatedAt: now, evidenceBasis: { ...goal.evidenceBasis } };
}

/**
 * Learner accepts a proposal: the ONLY path (besides modify and direct
 * creation) from `proposed` to `active`. Captures the progress baseline
 * at the moment of activation so later evidence is comparable.
 */
export function acceptGoal(
  proposal: LearningGoal,
  args: { profile: LearnerProfile; now: string; note?: string },
): LearningGoal {
  if (proposal.status !== 'proposed') {
    throw new Error(`Only a proposed goal can be accepted (goal ${proposal.goalId} is ${proposal.status}).`);
  }
  const activated = transitionGoalStatus(proposal, 'active', args.now);
  return {
    ...activated,
    decidedAt: args.now,
    ...(args.note !== undefined ? { decisionNote: truncateBounded(args.note, MAX_GOAL_DESCRIPTION_CHARS) } : {}),
    progressBaseline: captureBaseline(activated, args.profile, args.now),
  };
}

/**
 * Learner modifies a proposal: description (and only description) may
 * change, then the goal activates. Provenance is preserved three ways:
 * the original description, the verbatim learner statement when given,
 * and the untouched evidence-derived basis (need id, evidence ids stay).
 */
export function modifyGoal(
  proposal: LearningGoal,
  modification: { description?: string; learnerStatement?: string; note?: string },
  args: { profile: LearnerProfile; now: string },
): LearningGoal {
  if (proposal.status !== 'proposed') {
    throw new Error(`Only a proposed goal can be modified (goal ${proposal.goalId} is ${proposal.status}).`);
  }
  const nextDescription =
    typeof modification.description === 'string' && modification.description.trim().length > 0
      ? truncateBounded(modification.description, MAX_GOAL_DESCRIPTION_CHARS)
      : proposal.description;
  const learnerStatement =
    typeof modification.learnerStatement === 'string' && modification.learnerStatement.trim().length > 0
      ? truncateBounded(modification.learnerStatement, MAX_GOAL_DESCRIPTION_CHARS)
      : undefined;
  const edited: LearningGoal = {
    ...proposal,
    description: nextDescription,
    updatedAt: args.now,
    evidenceBasis: {
      ...proposal.evidenceBasis,
      originalDescription: proposal.description,
      ...(learnerStatement !== undefined ? { learnerStatement } : {}),
    },
    successCriteria: { ...proposal.successCriteria },
  };
  const activated = transitionGoalStatus(edited, 'active', args.now);
  return {
    ...activated,
    decidedAt: args.now,
    ...(modification.note !== undefined
      ? { decisionNote: truncateBounded(modification.note, MAX_GOAL_DESCRIPTION_CHARS) }
      : {}),
    progressBaseline: captureBaseline(activated, args.profile, args.now),
  };
}

/**
 * Learner rejects a proposal: `proposed` → `dismissed`, stamped with the
 * current evidence fingerprint so the SAME unchanged evidence cannot
 * immediately re-propose it. The record is retained (not deleted).
 */
export function rejectGoal(
  proposal: LearningGoal,
  args: { profileUpdatedAt: string; now: string; note?: string },
): LearningGoal {
  if (proposal.status !== 'proposed') {
    throw new Error(`Only a proposed goal can be rejected (goal ${proposal.goalId} is ${proposal.status}).`);
  }
  const dismissed = transitionGoalStatus(proposal, 'dismissed', args.now);
  return {
    ...dismissed,
    decidedAt: args.now,
    ...(args.note !== undefined ? { decisionNote: truncateBounded(args.note, MAX_GOAL_DESCRIPTION_CHARS) } : {}),
    evidenceBasis: {
      ...dismissed.evidenceBasis,
      dismissalFingerprint: evidenceFingerprint(dismissed.evidenceBasis.evidenceIds, args.profileUpdatedAt),
    },
  };
}

export function pauseGoal(goal: LearningGoal, now: string): LearningGoal {
  return transitionGoalStatus(goal, 'paused', now);
}

export function resumeGoal(goal: LearningGoal, now: string): LearningGoal {
  return transitionGoalStatus(goal, 'active', now);
}

export function completeGoal(goal: LearningGoal, now: string, note?: string): LearningGoal {
  const done = transitionGoalStatus(goal, 'achieved', now);
  return {
    ...done,
    decidedAt: now,
    ...(note !== undefined ? { decisionNote: truncateBounded(note, MAX_GOAL_DESCRIPTION_CHARS) } : {}),
  };
}

export function abandonGoal(goal: LearningGoal, now: string, note?: string): LearningGoal {
  const done = transitionGoalStatus(goal, 'abandoned', now);
  return {
    ...done,
    decidedAt: now,
    ...(note !== undefined ? { decisionNote: truncateBounded(note, MAX_GOAL_DESCRIPTION_CHARS) } : {}),
  };
}

/**
 * Evidence fingerprint for anti-spam: sorted basis evidence IDs plus the
 * profile snapshot marker. A dismissed proposal suppresses re-proposal
 * while the fingerprint is unchanged; new evidence changes it.
 */
export function evidenceFingerprint(evidenceIds: string[], profileUpdatedAt: string): string {
  return `${[...evidenceIds].sort().join(',')}@${profileUpdatedAt}`;
}

/**
 * Goal-local baseline snapshot: the goal dimension's level/confidence
 * per target entity plus the evidence IDs already seen. Small by design
 * (one row per target entity, not a profile copy) so later phases can
 * ask "what arrived after capture?" via existing evidence queries.
 */
export function captureBaseline(
  goal: LearningGoal,
  profile: LearnerProfile,
  now: string,
): GoalProgressBaseline {
  const entityStates = goal.entityIds.map((entityId) => {
    const state = profile.knowledgeStates.find((s) => s.entityId === entityId);
    const dim = state ? dimensionStateOf(state, goal.dimension) : null;
    return {
      entityId,
      dimension: goal.dimension,
      level: dim ? dim.level : 'UNKNOWN',
      confidence: dim ? dim.confidence : 'low',
    };
  });
  const seen = new Set<string>();
  const evidenceIds: string[] = [];
  for (const state of profile.knowledgeStates) {
    if (!goal.entityIds.includes(state.entityId)) {
      continue;
    }
    for (const id of [...state.supportingEvidenceIds, ...state.contradictingEvidenceIds]) {
      if (!seen.has(id)) {
        seen.add(id);
        evidenceIds.push(id);
      }
    }
  }
  return {
    capturedAt: now,
    profileUpdatedAt: profile.updatedAt,
    entityStates,
    evidenceIds: evidenceIds.slice(0, MAX_GOAL_EVIDENCE_IDS),
  };
}
