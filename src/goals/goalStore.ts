import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { isKnownEvidenceDimension } from '../learner/learnerTypes';
import { isKnownGoalSource, isKnownGoalStatus } from './goalTypes';
import type { GoalProgressBaseline, LearningGoal } from './goalTypes';

const GOALS_FILE = 'learning-goals.json';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function parseBaseline(raw: unknown): GoalProgressBaseline | null {
  if (raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.capturedAt !== 'string' ||
    typeof raw.profileUpdatedAt !== 'string' ||
    !Array.isArray(raw.entityStates) ||
    !isStringArray(raw.evidenceIds)
  ) {
    return null;
  }
  const entityStates: GoalProgressBaseline['entityStates'] = [];
  for (const item of raw.entityStates) {
    if (
      !isRecord(item) ||
      typeof item.entityId !== 'string' ||
      !isKnownEvidenceDimension(item.dimension) ||
      typeof item.level !== 'string' ||
      typeof item.confidence !== 'string'
    ) {
      return null;
    }
    entityStates.push({
      entityId: item.entityId,
      dimension: item.dimension,
      level: item.level,
      confidence: item.confidence,
    });
  }
  return {
    capturedAt: raw.capturedAt,
    profileUpdatedAt: raw.profileUpdatedAt,
    entityStates,
    evidenceIds: [...raw.evidenceIds],
  };
}

/** Lenient structural parse for STORAGE reads (never throws; bad rows drop). */
export function parseLearningGoal(raw: unknown): LearningGoal | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isNonBlankString(raw.goalId) ||
    typeof raw.targetKey !== 'string' ||
    !isStringArray(raw.entityIds) ||
    !isKnownEvidenceDimension(raw.dimension) ||
    typeof raw.description !== 'string' ||
    !isKnownGoalSource(raw.source) ||
    !isKnownGoalStatus(raw.status) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string'
  ) {
    return null;
  }
  const basis: unknown = raw.evidenceBasis;
  if (
    !isRecord(basis) ||
    !isStringArray(basis.evidenceIds) ||
    typeof basis.profileUpdatedAt !== 'string' ||
    typeof basis.ontologyVersion !== 'string' ||
    typeof basis.aggregatorVersion !== 'string' ||
    (basis.needId !== null && typeof basis.needId !== 'string')
  ) {
    return null;
  }
  const criteria: unknown = raw.successCriteria;
  if (
    !isRecord(criteria) ||
    typeof criteria.summary !== 'string' ||
    !isKnownEvidenceDimension(criteria.dimension) ||
    typeof criteria.guidance !== 'string'
  ) {
    return null;
  }
  const baseline = parseBaseline(raw.progressBaseline);
  if (raw.progressBaseline !== null && baseline === null) {
    return null;
  }
  if (raw.decidedAt !== null && typeof raw.decidedAt !== 'string') {
    return null;
  }
  return {
    goalId: raw.goalId,
    targetKey: raw.targetKey,
    entityIds: [...raw.entityIds],
    dimension: raw.dimension,
    description: raw.description,
    source: raw.source,
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    evidenceBasis: {
      evidenceIds: [...basis.evidenceIds],
      profileUpdatedAt: basis.profileUpdatedAt,
      ontologyVersion: basis.ontologyVersion,
      aggregatorVersion: basis.aggregatorVersion,
      needId: basis.needId,
      ...(typeof basis.learnerStatement === 'string' ? { learnerStatement: basis.learnerStatement } : {}),
      ...(typeof basis.originalDescription === 'string'
        ? { originalDescription: basis.originalDescription }
        : {}),
      ...(typeof basis.dismissalFingerprint === 'string'
        ? { dismissalFingerprint: basis.dismissalFingerprint }
        : {}),
    },
    successCriteria: {
      summary: criteria.summary,
      dimension: criteria.dimension,
      guidance: criteria.guidance,
    },
    progressBaseline: baseline,
    decidedAt: raw.decidedAt,
    ...(typeof raw.decisionNote === 'string' ? { decisionNote: raw.decisionNote } : {}),
  };
}

export interface GoalStore {
  upsertGoal(goal: LearningGoal): Promise<void>;
  getGoal(goalId: string): Promise<LearningGoal | null>;
  listGoals(): Promise<LearningGoal[]>;
}

/**
 * Local-first durable goal storage. Goals survive restart/session/problem
 * boundaries (unlike short-lived Phase E coach state). Writes validate
 * strictly; reads stay lenient so one bad row never breaks loading.
 */
export class LocalGoalStore implements GoalStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): LearningGoal[] {
    const out: LearningGoal[] = [];
    for (const item of loadJsonArray<unknown>(GOALS_FILE, this.workspacePath)) {
      const parsed = parseLearningGoal(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async upsertGoal(goal: LearningGoal): Promise<void> {
    if (parseLearningGoal(goal) === null) {
      throw new Error('Cannot persist a malformed learning goal.');
    }
    const rest = this.loadAll().filter((g) => g.goalId !== goal.goalId);
    rest.push(goal);
    rest.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId));
    saveJsonArray(GOALS_FILE, rest, this.workspacePath);
  }

  async getGoal(goalId: string): Promise<LearningGoal | null> {
    return this.loadAll().find((g) => g.goalId === goalId) ?? null;
  }

  async listGoals(): Promise<LearningGoal[]> {
    return this.loadAll().sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId),
    );
  }
}
