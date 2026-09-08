import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { isKnownEvidenceDimension, isKnownEvidenceType } from '../learner/learnerTypes';
import type { EvidenceType } from '../learner/learnerTypes';
import {
  isKnownActivityIntent,
  isKnownActivityKind,
  isKnownActivityPlanStatus,
  isKnownActivityPurpose,
} from './activityTypes';
import type { ActivityPlan } from './activityTypes';

const ACTIVITY_PLANS_FILE = 'activity-plans.json';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

/** Lenient structural parse for STORAGE reads (never throws; bad rows drop). */
export function parseActivityPlan(raw: unknown): ActivityPlan | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    !isNonBlankString(raw.planId) ||
    !isNonBlankString(raw.goalId) ||
    typeof raw.goalTargetKey !== 'string' ||
    !isKnownActivityKind(raw.activityKind) ||
    !isNonBlankString(raw.problemId) ||
    (raw.problemTitle !== null && typeof raw.problemTitle !== 'string') ||
    !isKnownActivityIntent(raw.intent) ||
    !isKnownActivityPurpose(raw.purpose) ||
    !isStringArray(raw.entityIds) ||
    raw.entityIds.length === 0 ||
    !isKnownEvidenceDimension(raw.dimension) ||
    typeof raw.rationale !== 'string' ||
    typeof raw.expectedEvidence !== 'string' ||
    !isStringArray(raw.expectedEvidenceTypes) ||
    !(raw.expectedEvidenceTypes as string[]).every((t) => isKnownEvidenceType(t)) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    !isKnownActivityPlanStatus(raw.status) ||
    typeof raw.position !== 'number' ||
    typeof raw.sequenceLength !== 'number' ||
    !isNonBlankString(raw.sequenceId) ||
    (raw.linkedAttemptId !== null && typeof raw.linkedAttemptId !== 'string')
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
    (basis.needId !== null && typeof basis.needId !== 'string') ||
    (basis.goalSource !== 'evidence-derived' && basis.goalSource !== 'learner-requested')
  ) {
    return null;
  }
  const provenance: unknown = raw.provenance;
  if (
    !isRecord(provenance) ||
    typeof provenance.ontologyVersion !== 'string' ||
    typeof provenance.aggregatorVersion !== 'string' ||
    typeof provenance.catalogSize !== 'number'
  ) {
    return null;
  }
  return {
    planId: raw.planId,
    goalId: raw.goalId,
    goalTargetKey: raw.goalTargetKey,
    activityKind: raw.activityKind,
    problemId: raw.problemId,
    problemTitle: raw.problemTitle,
    intent: raw.intent,
    purpose: raw.purpose,
    entityIds: [...raw.entityIds],
    dimension: raw.dimension,
    rationale: raw.rationale,
    evidenceBasis: {
      evidenceIds: [...basis.evidenceIds],
      profileUpdatedAt: basis.profileUpdatedAt,
      ontologyVersion: basis.ontologyVersion,
      aggregatorVersion: basis.aggregatorVersion,
      needId: basis.needId,
      goalSource: basis.goalSource,
    },
    expectedEvidence: raw.expectedEvidence,
    expectedEvidenceTypes: [...(raw.expectedEvidenceTypes as EvidenceType[])],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    status: raw.status,
    position: raw.position,
    sequenceLength: raw.sequenceLength,
    sequenceId: raw.sequenceId,
    linkedAttemptId: raw.linkedAttemptId,
    provenance: {
      ontologyVersion: provenance.ontologyVersion,
      aggregatorVersion: provenance.aggregatorVersion,
      catalogSize: provenance.catalogSize,
    },
  };
}

export interface ActivityPlanStore {
  upsertPlan(plan: ActivityPlan): Promise<void>;
  getPlan(planId: string): Promise<ActivityPlan | null>;
  listPlans(): Promise<ActivityPlan[]>;
}

/**
 * Local-first durable plan storage. Plans survive restart/session/problem
 * boundaries (unlike short-lived Phase E coach state). Writes validate
 * strictly; reads stay lenient so one bad row never breaks loading.
 */
export class LocalActivityPlanStore implements ActivityPlanStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): ActivityPlan[] {
    const out: ActivityPlan[] = [];
    for (const item of loadJsonArray<unknown>(ACTIVITY_PLANS_FILE, this.workspacePath)) {
      const parsed = parseActivityPlan(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async upsertPlan(plan: ActivityPlan): Promise<void> {
    if (parseActivityPlan(plan) === null) {
      throw new Error('Cannot persist a malformed activity plan.');
    }
    const rest = this.loadAll().filter((p) => p.planId !== plan.planId);
    rest.push(plan);
    rest.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
    saveJsonArray(ACTIVITY_PLANS_FILE, rest, this.workspacePath);
  }

  async getPlan(planId: string): Promise<ActivityPlan | null> {
    return this.loadAll().find((p) => p.planId === planId) ?? null;
  }

  async listPlans(): Promise<ActivityPlan[]> {
    return this.loadAll().sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId),
    );
  }
}
