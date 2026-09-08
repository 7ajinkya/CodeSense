import type { LearnerEvidence } from './learnerEvidence';
import type {
  LearnerKnowledgeState,
  LearnerMistakePattern,
  LearnerProfile,
  TrajectoryEntry,
} from './learnerModel';
import { levelRank } from './learnerModelUpdater';

/**
 * Phase D consumer-facing retrieval API. Future Phase E reads learner
 * state through THESE functions — never raw store files — so storage can
 * evolve without breaking consumers. All functions are pure
 * (profile + evidence in, derived view out) and never throw on empty
 * input: a fresh learner simply yields nulls and empty lists.
 */

export function getLearnerKnowledge(
  profile: LearnerProfile,
  entityId: string,
): LearnerKnowledgeState | null {
  return profile.knowledgeStates.find((s) => s.entityId === entityId) ?? null;
}

export function getLearnerKnowledgeForEntities(
  profile: LearnerProfile,
  entityIds: string[],
): Array<LearnerKnowledgeState | null> {
  return entityIds.map((id) => getLearnerKnowledge(profile, id));
}

export function getEvidenceForEntity(
  evidence: LearnerEvidence[],
  entityId: string,
): LearnerEvidence[] {
  return evidence
    .filter((e) => e.entityIds.includes(entityId))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
}

export function getRecentEvidence(
  evidence: LearnerEvidence[],
  entityId: string | null,
  limit: number,
): LearnerEvidence[] {
  const scoped =
    entityId === null ? [...evidence] : evidence.filter((e) => e.entityIds.includes(entityId));
  return scoped
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.evidenceId.localeCompare(a.evidenceId))
    .slice(0, Math.max(0, limit));
}

export function getRecurringMistakes(
  profile: LearnerProfile,
  entityId?: string,
  includeResolved = false,
): LearnerMistakePattern[] {
  return profile.recurringMistakes.filter((m) => {
    if (m.status === 'single') {
      return false;
    }
    if (m.status === 'resolved' && !includeResolved) {
      return false;
    }
    if (entityId !== undefined && !m.relatedEntityIds.includes(entityId)) {
      return false;
    }
    return true;
  });
}

export interface LearnerTrajectory {
  entityId: string;
  state: LearnerKnowledgeState | null;
  /** Chronological state transitions for this entity. */
  entries: TrajectoryEntry[];
  /** The evidence backing those transitions, chronological. */
  evidence: LearnerEvidence[];
}

export function getLearnerTrajectory(
  profile: LearnerProfile,
  evidence: LearnerEvidence[],
  entityId: string,
): LearnerTrajectory {
  const state = getLearnerKnowledge(profile, entityId);
  return {
    entityId,
    state,
    entries: state ? [...state.trajectory] : [],
    evidence: getEvidenceForEntity(evidence, entityId),
  };
}

/**
 * Entities needing attention: flagged `struggling`/`mixed`, or carrying
 * low-confidence assessments despite evidence. Sorted deterministically
 * (status severity, then entity id) so consumers can render stably.
 */
export function getWeakOrUncertainEntities(profile: LearnerProfile): LearnerKnowledgeState[] {
  const out = profile.knowledgeStates.filter(
    (s) => s.status === 'struggling' || s.status === 'mixed' || s.statusConfidence === 'low',
  );
  const severity = (s: LearnerKnowledgeState): number => {
    if (s.status === 'struggling') {
      return 0;
    }
    if (s.status === 'mixed') {
      return 1;
    }
    return 2;
  };
  return out.sort((a, b) => severity(a) - severity(b) || a.entityId.localeCompare(b.entityId));
}

const STATUS_RANK: Record<LearnerKnowledgeState['status'], number> = {
  unknown: 0,
  exposed: 1,
  developing: 2,
  struggling: 2,
  mixed: 2,
  demonstrated: 3,
  strong: 4,
};

/**
 * Entities with an upward move strictly after `since` (ISO-8601): a level
 * rank increase in any dimension, or a status rank increase. Powers the
 * "is the learner improving?" question without any score.
 */
export function getRecentlyImprovedEntities(profile: LearnerProfile, since: string): string[] {
  const out: string[] = [];
  for (const state of profile.knowledgeStates) {
    let improved = false;
    for (const entry of state.trajectory) {
      if (entry.at.localeCompare(since) <= 0) {
        continue;
      }
      if (entry.dimension === 'status') {
        const before = STATUS_RANK[entry.from as LearnerKnowledgeState['status']] ?? -1;
        const after = STATUS_RANK[entry.to as LearnerKnowledgeState['status']] ?? -1;
        if (after > before) {
          improved = true;
          break;
        }
      } else {
        if (levelRank(entry.to as Parameters<typeof levelRank>[0]) > levelRank(entry.from as Parameters<typeof levelRank>[0])) {
          improved = true;
          break;
        }
      }
    }
    if (improved) {
      out.push(state.entityId);
    }
  }
  return out.sort();
}

export interface LearnerSummary {
  totalEvidence: number;
  entitiesTracked: number;
  byStatus: Record<LearnerKnowledgeState['status'], number>;
  recurringMistakeCount: number;
  resolvedMistakeCount: number;
  uncertainEntityCount: number;
  ontologyVersion: string;
  aggregatorVersion: string;
  updatedAt: string;
}

export function getLearnerSummary(profile: LearnerProfile): LearnerSummary {
  const byStatus: LearnerSummary['byStatus'] = {
    unknown: 0,
    exposed: 0,
    developing: 0,
    demonstrated: 0,
    strong: 0,
    struggling: 0,
    mixed: 0,
  };
  for (const state of profile.knowledgeStates) {
    byStatus[state.status] += 1;
  }
  return {
    totalEvidence: profile.totalEvidenceCount,
    entitiesTracked: profile.knowledgeStates.length,
    byStatus,
    recurringMistakeCount: profile.recurringMistakes.filter((m) => m.status === 'recurring').length,
    resolvedMistakeCount: profile.recurringMistakes.filter((m) => m.status === 'resolved').length,
    uncertainEntityCount: getWeakOrUncertainEntities(profile).length,
    ontologyVersion: profile.ontologyVersion,
    aggregatorVersion: profile.aggregatorVersion,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Bounded, uncertainty-preserving model digest for the AI coach context
 * (`LearnerContext.notes`). Factual and cited: every note names its
 * entity and evidence count; struggle notes name the pattern, never a
 * verdict. Notes cap keeps prompts bounded; an empty model yields [] so
 * the pre-Phase-D default (`{ notes: [] }`) is preserved exactly.
 */
export const MAX_LEARNER_NOTES = 8;
export const MAX_LEARNER_NOTE_CHARS = 160;

function clipNote(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_LEARNER_NOTE_CHARS) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_LEARNER_NOTE_CHARS - 1).trimEnd() + '…';
}

export function buildLearnerNotesForPrompt(profile: LearnerProfile): string[] {
  const notes: string[] = [];
  const weak = getWeakOrUncertainEntities(profile);
  for (const state of weak.slice(0, 4)) {
    const negatives = state.contradictingEvidenceIds.length;
    if (state.status === 'struggling') {
      notes.push(
        clipNote(
          `Repeated difficulty signal on ${state.entityId} (${negatives} difficulty evidence records). ` +
            `Treat as a hypothesis with rival explanations, not a verdict.`,
        ),
      );
    } else if (state.status === 'mixed') {
      notes.push(
        clipNote(
          `Mixed evidence on ${state.entityId} (${state.supportingEvidenceIds.length} supporting, ` +
            `${negatives} difficulty). Ask before assuming either way.`,
        ),
      );
    } else {
      notes.push(
        clipNote(
          `Limited evidence on ${state.entityId} (status ${state.status}, confidence ${state.statusConfidence}). ` +
            `Single encounters prove nothing durable.`,
        ),
      );
    }
  }
  const strong = profile.knowledgeStates
    .filter((s) => s.status === 'strong' || s.status === 'demonstrated')
    .sort((a, b) => a.entityId.localeCompare(b.entityId))
    .slice(0, 3);
  for (const state of strong) {
    notes.push(
      clipNote(
        `Sustained positive evidence on ${state.entityId} (${state.supportingEvidenceIds.length} records, ` +
          `status ${state.status}). Do not re-teach unprompted.`,
      ),
    );
  }
  const recurring = getRecurringMistakes(profile).slice(0, 2);
  for (const mistake of recurring) {
    notes.push(
      clipNote(
        `Recurring pattern "${mistake.category}" seen ${mistake.occurrences.length}× ` +
          `(${mistake.relatedEntityIds.join(', ')}). Watch for it; it may be situational.`,
      ),
    );
  }
  return notes.slice(0, MAX_LEARNER_NOTES);
}
