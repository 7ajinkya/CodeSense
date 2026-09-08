import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { isKnownEvidenceDimension, isKnownHelpLevel } from '../learner/learnerTypes';
import { isKnownGoalSource } from '../goals/goalTypes';
import { isKnownActivityIntent, isKnownActivityPurpose } from '../practice/activityTypes';
import {
  isKnownProgressSignal,
  isKnownReassessmentSignal,
} from './progressTypes';
import type { ActivityProgress } from './progressTypes';

const PROGRESS_FILE = 'goal-progress.json';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

/** Lenient structural parse for STORAGE reads (never throws; bad rows drop). */
export function parseActivityProgress(raw: unknown): ActivityProgress | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isNonBlankString(raw.progressId) ||
    !isNonBlankString(raw.goalId) ||
    typeof raw.goalTargetKey !== 'string' ||
    !isNonBlankString(raw.planId) ||
    (raw.linkedAttemptId !== null && typeof raw.linkedAttemptId !== 'string') ||
    !isKnownGoalSource(raw.goalSource) ||
    !isKnownEvidenceDimension(raw.dimension) ||
    !isKnownProgressSignal(raw.progressSignal) ||
    !isKnownReassessmentSignal(raw.reassessment) ||
    typeof raw.explanation !== 'string' ||
    typeof raw.firstEvaluatedAt !== 'string' ||
    typeof raw.evaluatedAt !== 'string' ||
    typeof raw.evaluationCount !== 'number' ||
    !isNonBlankString(raw.evidenceFingerprint) ||
    !isStringArray(raw.activityEvidenceIds) ||
    !isStringArray(raw.weakEvidenceIds) ||
    !isStringArray(raw.goalRelevantNewIds) ||
    !isStringArray(raw.positiveNewIds) ||
    !isStringArray(raw.negativeNewIds) ||
    !Array.isArray(raw.entities) ||
    !Array.isArray(raw.signalHistory)
  ) {
    return null;
  }
  const activity: unknown = raw.activity;
  if (
    !isRecord(activity) ||
    !isKnownActivityIntent(activity.intent) ||
    !isKnownActivityPurpose(activity.purpose) ||
    !isStringArray(activity.entityIds) ||
    !isNonBlankString(activity.problemId) ||
    (activity.problemTitle !== null && typeof activity.problemTitle !== 'string')
  ) {
    return null;
  }
  const baselineRef: unknown = raw.baselineRef;
  if (
    !isRecord(baselineRef) ||
    typeof baselineRef.capturedAt !== 'string' ||
    typeof baselineRef.profileUpdatedAt !== 'string'
  ) {
    return null;
  }
  const independence: unknown = raw.independence;
  if (
    !isRecord(independence) ||
    typeof independence.independent !== 'boolean' ||
    typeof independence.helped !== 'boolean' ||
    !isStringArray(independence.helpLevels) ||
    !(independence.helpLevels as string[]).every((level) => isKnownHelpLevel(level)) ||
    !isStringArray(independence.independentEvidenceIds) ||
    !isStringArray(independence.helpEvidenceIds)
  ) {
    return null;
  }
  for (const item of raw.entities as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.entityId !== 'string' ||
      typeof item.baselineLevel !== 'string' ||
      typeof item.baselineConfidence !== 'string' ||
      (item.currentLevel !== null && typeof item.currentLevel !== 'string') ||
      (item.currentConfidence !== null && typeof item.currentConfidence !== 'string') ||
      !isStringArray(item.positiveNewIds) ||
      !isStringArray(item.negativeNewIds)
    ) {
      return null;
    }
  }
  for (const item of raw.signalHistory as unknown[]) {
    if (
      !isRecord(item) ||
      typeof item.evaluatedAt !== 'string' ||
      !isKnownProgressSignal(item.progressSignal) ||
      !isKnownReassessmentSignal(item.reassessment) ||
      typeof item.evidenceFingerprint !== 'string'
    ) {
      return null;
    }
  }
  const provenance: unknown = raw.provenance;
  if (
    !isRecord(provenance) ||
    typeof provenance.ontologyVersion !== 'string' ||
    typeof provenance.aggregatorVersion !== 'string'
  ) {
    return null;
  }
  return {
    progressId: raw.progressId,
    goalId: raw.goalId,
    goalTargetKey: raw.goalTargetKey,
    planId: raw.planId,
    linkedAttemptId: raw.linkedAttemptId,
    goalSource: raw.goalSource,
    dimension: raw.dimension,
    activity: {
      intent: activity.intent,
      purpose: activity.purpose,
      entityIds: [...activity.entityIds],
      problemId: activity.problemId,
      problemTitle: activity.problemTitle,
    },
    baselineRef: {
      capturedAt: baselineRef.capturedAt,
      profileUpdatedAt: baselineRef.profileUpdatedAt,
    },
    activityEvidenceIds: [...(raw.activityEvidenceIds as string[])],
    weakEvidenceIds: [...(raw.weakEvidenceIds as string[])],
    goalRelevantNewIds: [...(raw.goalRelevantNewIds as string[])],
    entities: (raw.entities as ActivityProgress['entities']).map((detail) => ({
      entityId: detail.entityId,
      baselineLevel: detail.baselineLevel,
      baselineConfidence: detail.baselineConfidence,
      currentLevel: detail.currentLevel,
      currentConfidence: detail.currentConfidence,
      positiveNewIds: [...detail.positiveNewIds],
      negativeNewIds: [...detail.negativeNewIds],
    })),
    independence: {
      independent: independence.independent as boolean,
      helped: independence.helped as boolean,
      helpLevels: [...(independence.helpLevels as ActivityProgress['independence']['helpLevels'])],
      independentEvidenceIds: [...(independence.independentEvidenceIds as string[])],
      helpEvidenceIds: [...(independence.helpEvidenceIds as string[])],
    },
    positiveNewIds: [...(raw.positiveNewIds as string[])],
    negativeNewIds: [...(raw.negativeNewIds as string[])],
    progressSignal: raw.progressSignal,
    reassessment: raw.reassessment,
    explanation: raw.explanation,
    firstEvaluatedAt: raw.firstEvaluatedAt,
    evaluatedAt: raw.evaluatedAt,
    evaluationCount: raw.evaluationCount,
    evidenceFingerprint: raw.evidenceFingerprint,
    signalHistory: (raw.signalHistory as ActivityProgress['signalHistory']).map((revision) => ({
      ...revision,
    })),
    provenance: {
      ontologyVersion: provenance.ontologyVersion,
      aggregatorVersion: provenance.aggregatorVersion,
    },
  };
}

export interface ProgressStore {
  upsertProgress(progress: ActivityProgress): Promise<void>;
  getProgress(progressId: string): Promise<ActivityProgress | null>;
  listProgress(): Promise<ActivityProgress[]>;
}

/**
 * Local-first durable progress storage. Entries are keyed by the
 * deterministic progress id (`goal|plan|attempt`), so reprocessing the
 * same completed attempt upserts the same record instead of duplicating
 * history. Writes validate strictly; reads stay lenient so one bad row
 * never breaks loading.
 */
export class LocalProgressStore implements ProgressStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): ActivityProgress[] {
    const out: ActivityProgress[] = [];
    for (const item of loadJsonArray<unknown>(PROGRESS_FILE, this.workspacePath)) {
      const parsed = parseActivityProgress(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async upsertProgress(progress: ActivityProgress): Promise<void> {
    if (parseActivityProgress(progress) === null) {
      throw new Error('Cannot persist a malformed activity progress record.');
    }
    const rest = this.loadAll().filter((p) => p.progressId !== progress.progressId);
    rest.push(progress);
    rest.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
    saveJsonArray(PROGRESS_FILE, rest, this.workspacePath);
  }

  async getProgress(progressId: string): Promise<ActivityProgress | null> {
    return this.loadAll().find((p) => p.progressId === progressId) ?? null;
  }

  async listProgress(): Promise<ActivityProgress[]> {
    return this.loadAll().sort(
      (a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId),
    );
  }
}
