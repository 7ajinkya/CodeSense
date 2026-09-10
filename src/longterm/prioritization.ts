import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import { getActiveGoals } from '../goals/goalQueries';
import type { LearningGoal } from '../goals/goalTypes';
import type { ActivityPlan } from '../practice/activityTypes';
import type { ActivityProgress, ProgressSignal } from '../progress/progressTypes';
import { getLatestProgressForGoal } from '../progress/progressQueries';
import type { LearnerReflection } from '../reflection/reflectionTypes';
import { isRecord } from '../persistence/storeFiles';
import type { ProblemKnowledgeRecord } from './problemKnowledge';
import { isSolvedAttempt } from './problemStats';
import { detectReinforcementNeed } from './reinforcementNeed';
import type { LongTermRecommendation } from './recommendation';
import { needFingerprintFor } from './recommendation';
import { STALE_AFTER_DAYS, detectRetrievalNeeds } from './retrieval';

/**
 * Phase J-4 cross-goal prioritization: one deterministic long-term agenda
 * from existing remediation / reinforcement / retrieval / review signals.
 * Pure, read-only, deterministic — no store, no AI, no clock (callers
 * inject `nowIso`), no randomness, no numeric weights or scores.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - Class order is policy, not measurement: remediation > reinforcement >
 *   retrieval > review. A stale entity can never outrank an active
 *   struggle however long it has been stale; retrieval is additionally
 *   quota-capped (`RETRIEVAL_CAP`) so it cannot starve remediation.
 * - Remediation membership reuses D/F3 verdicts only: D `struggling`/`mixed`
 *   statuses, `recurring` mistake overlap, and F3 struggle signals on the
 *   entity's latest touching progress. Low-confidence-but-unstruggling
 *   states are deliberately NOT remediation (uncertainty is not difficulty),
 *   and recent-negative recency/counting is NOT re-read: the frozen D
 *   updater already folds all evidence into status, so re-reading it here
 *   would duplicate D.
 * - Reinforcement reuses frozen J-2 (`detectReinforcementNeed` per solved
 *   problem — never reimplemented) and J-3 chain states (live chains are
 *   referenced, terminal same-need chains suppress duplicates; skipping or
 *   deferring is never treated as weakness).
 * - Retrieval reuses `detectRetrievalNeeds`; entities already claimed by
 *   remediation are excluded so the classes stay disjoint.
 * - Review reuses F3's `SUFFICIENT_EVIDENCE_FOR_REVIEW` verdict on active
 *   goals only.
 * - G contributes only responded-but-unemitted learner voice as reason
 *   enrichment: emitted reflections already live in D evidence, so counting
 *   them structurally would double-count. H aggregates and I-0 hypotheses
 *   are presentation/planning-layer concerns (recency is read directly from
 *   attempts/plans arrays — the same underlying facts, unaggregated).
 */

export const PRIORITIZATION_SCHEMA_VERSION = 1;

/**
 * Retrieval quota: at most this many retrieval items per agenda, so
 * retrieval can never dominate even when remediation is quiet. Named policy
 * with a test seam (`retrievalCap` override), not a tuned constant.
 */
export const RETRIEVAL_CAP = 3;

/** Per-priority cited-ID caps (mirror frozen `MAX_*_EVIDENCE_IDS` = 12). */
export const MAX_PRIORITY_EVIDENCE_IDS = 12;
export const MAX_PRIORITY_PROGRESS_IDS = 12;

export type PriorityKind = 'remediation' | 'reinforcement' | 'retrieval' | 'review';

export const PRIORITY_KINDS: readonly PriorityKind[] = ['remediation', 'reinforcement', 'retrieval', 'review'];

export function isKnownPriorityKind(value: unknown): value is PriorityKind {
  return typeof value === 'string' && (PRIORITY_KINDS as readonly string[]).includes(value);
}

export interface LongTermPriority {
  /** 1-based position in the emitted agenda (ordering is the ranking). */
  rank: number;
  kind: PriorityKind;
  /** Canonical C entity IDs (targets, singletons, or goal entities). */
  entityIds: string[];
  /** Source problem for reinforcement (null otherwise). */
  problemId: string | null;
  /** Linked active goal where one exists (null otherwise). */
  goalId: string | null;
  /** Live J-3 recommendation this priority points at, if any (never created here). */
  recommendationId: string | null;
  /** Deterministic templated reason citing structured facts only. */
  reason: string;
  /** D evidence IDs, all present in the input snapshot (sorted, capped). */
  evidenceIds: string[];
  /** F3 progress IDs, all present in the input snapshot (sorted, capped). */
  progressIds: string[];
  /** Retrieval reference time (lastObservedAt) or null when N/A. */
  observedAt: string | null;
}

export interface AgendaInputs {
  nowIso: string;
  profile: LearnerProfile | null;
  evidence: LearnerEvidence[];
  goals: LearningGoal[];
  plans: ActivityPlan[];
  progress: ActivityProgress[];
  reflections: LearnerReflection[];
  attempts: Attempt[];
  problems: Problem[];
  classifications: ProblemClassification[];
  knowledgeRecords: ProblemKnowledgeRecord[];
  recommendations: LongTermRecommendation[];
  staleAfterDays?: number;
  retrievalCap?: number;
}

/** F3 signals read as ongoing struggle (F3's own vocabulary, not re-derived). */
const STRUGGLE_SIGNALS: readonly ProgressSignal[] = ['STILL_STRUGGLING', 'MIXED_SIGNAL', 'REGRESSION_SIGNAL'];

/** J-3 statuses with a live, actionable chain (mirrors J-3 lifecycle). */
const LIVE_RECOMMENDATION_STATUSES: ReadonlyArray<LongTermRecommendation['status']> = [
  'offered',
  'accepted',
  'deferred',
];

function capSorted(ids: string[], max: number): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort().slice(0, max);
}

/** Lenient string-list read for defensively-handled historical rows. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function latestClassificationFor(
  classifications: ProblemClassification[],
  problemId: string,
): ProblemClassification | null {
  let best: ProblemClassification | null = null;
  for (const classification of classifications) {
    if (classification.problemId !== problemId) {
      continue;
    }
    if (best === null || classification.classifiedAt.localeCompare(best.classifiedAt) >= 0) {
      best = classification;
    }
  }
  return best;
}

function knowledgeFor(
  knowledgeRecords: ProblemKnowledgeRecord[],
  problemId: string,
): ProblemKnowledgeRecord | null {
  return knowledgeRecords.find((record) => record.problemId === problemId) ?? null;
}

function activeGoalForEntity(goals: LearningGoal[], entityId: string): string | null {
  const match = getActiveGoals(goals)
    .filter((goal) => goal.entityIds.includes(entityId))
    .sort((a, b) => a.goalId.localeCompare(b.goalId));
  return match.length > 0 && match[0] ? match[0].goalId : null;
}

interface RemediationAccumulator {
  severity: number;
  mistakeCategories: string[];
  evidenceIds: string[];
  progressIds: string[];
  struggleSignals: string[];
}

function severityOf(status: string): number {
  if (status === 'struggling') {
    return 0;
  }
  if (status === 'mixed') {
    return 1;
  }
  return 2;
}

function buildRemediation(inputs: AgendaInputs): Omit<LongTermPriority, 'rank'>[] {
  if (inputs.profile === null) {
    return [];
  }
  const acc = new Map<string, RemediationAccumulator>();
  const ensure = (entityId: string): RemediationAccumulator => {
    const existing = acc.get(entityId);
    if (existing) {
      return existing;
    }
    const fresh: RemediationAccumulator = {
      severity: 2,
      mistakeCategories: [],
      evidenceIds: [],
      progressIds: [],
      struggleSignals: [],
    };
    acc.set(entityId, fresh);
    return fresh;
  };
  for (const raw of inputs.profile.knowledgeStates) {
    if (!isRecord(raw)) {
      continue;
    }
    const state = raw as { entityId: unknown; status: unknown; supportingEvidenceIds: unknown; contradictingEvidenceIds: unknown };
    if (typeof state.entityId !== 'string' || state.entityId.length === 0) {
      continue;
    }
    if (state.status !== 'struggling' && state.status !== 'mixed') {
      continue;
    }
    const entry = ensure(state.entityId);
    entry.severity = Math.min(entry.severity, severityOf(state.status as string));
    entry.evidenceIds.push(...stringList(state.supportingEvidenceIds), ...stringList(state.contradictingEvidenceIds));
  }
  for (const rawMistake of inputs.profile.recurringMistakes) {
    if (!isRecord(rawMistake)) {
      continue;
    }
    const mistake = rawMistake as { status: unknown; relatedEntityIds: unknown; category: unknown; evidenceIds: unknown };
    if (mistake.status !== 'recurring') {
      continue;
    }
    for (const entityId of stringList(mistake.relatedEntityIds)) {
      const entry = ensure(entityId);
      if (typeof mistake.category === 'string' && mistake.category.length > 0) {
        entry.mistakeCategories.push(mistake.category);
      }
      entry.evidenceIds.push(...stringList(mistake.evidenceIds));
    }
  }
  const latestSignalByEntity = new Map<string, { signal: ProgressSignal; progressId: string; evaluatedAt: string }>();
  for (const raw of inputs.progress) {
    if (!isRecord(raw)) {
      continue;
    }
    const record = raw as { progressSignal: unknown; entities: unknown; evaluatedAt: unknown; progressId: unknown };
    if (!(STRUGGLE_SIGNALS as readonly string[]).includes(record.progressSignal as string)) {
      continue;
    }
    if (typeof record.evaluatedAt !== 'string' || typeof record.progressId !== 'string') {
      continue;
    }
    for (const detailRaw of Array.isArray(record.entities) ? record.entities : []) {
      if (!isRecord(detailRaw)) {
        continue;
      }
      const detail = detailRaw as { entityId: unknown };
      if (typeof detail.entityId !== 'string' || detail.entityId.length === 0) {
        continue;
      }
      const current = latestSignalByEntity.get(detail.entityId);
      if (
        current === undefined ||
        record.evaluatedAt.localeCompare(current.evaluatedAt) > 0 ||
        (record.evaluatedAt === current.evaluatedAt && record.progressId.localeCompare(current.progressId) > 0)
      ) {
        latestSignalByEntity.set(detail.entityId, {
          signal: record.progressSignal as ProgressSignal,
          progressId: record.progressId,
          evaluatedAt: record.evaluatedAt,
        });
      }
    }
  }
  for (const [entityId, latest] of latestSignalByEntity) {
    const entry = ensure(entityId);
    entry.progressIds.push(latest.progressId);
    entry.struggleSignals.push(latest.signal);
  }
  // Learner voice enrichment only: responded-but-unemitted reflections carry
  // information absent from D; emitted ones are already D evidence and are
  // therefore never counted again here.
  const voiceByEntity = new Map<string, string[]>();
  for (const rawReflection of inputs.reflections) {
    if (!isRecord(rawReflection)) {
      continue;
    }
    const reflection = rawReflection as {
      status: unknown;
      interpretation: unknown;
      category: unknown;
      reflectionId: unknown;
    };
    if (reflection.status !== 'responded' || !isRecord(reflection.interpretation)) {
      continue;
    }
    const interpretation = reflection.interpretation as { entityIds: unknown };
    if (typeof reflection.reflectionId !== 'string' || reflection.reflectionId.length === 0) {
      continue;
    }
    for (const entityId of stringList(interpretation.entityIds)) {
      if (!acc.has(entityId)) {
        continue;
      }
      const list = voiceByEntity.get(entityId) ?? [];
      list.push(`${typeof reflection.category === 'string' ? reflection.category : 'other'} (${reflection.reflectionId})`);
      voiceByEntity.set(entityId, list);
    }
  }
  const out: Omit<LongTermPriority, 'rank'>[] = [];
  for (const [entityId, entry] of acc) {
    const state = inputs.profile.knowledgeStates.find((s) => s.entityId === entityId) ?? null;
    const status = state ? state.status : 'unobserved-in-model';
    const confidence = state ? state.statusConfidence : 'n/a';
    const mistakes =
      entry.mistakeCategories.length > 0
        ? `, recurring ${[...new Set(entry.mistakeCategories)].sort().join(', ')}`
        : '';
    const struggle =
      entry.struggleSignals.length > 0
        ? `, F3 ${[...new Set(entry.struggleSignals)].sort().join(', ')}`
        : '';
    const voices = voiceByEntity.get(entityId);
    const voice =
      voices && voices.length > 0 ? ` Learner voice: ${[...new Set(voices)].sort().join('; ')}.` : '';
    const goalId = activeGoalForEntity(inputs.goals, entityId);
    out.push({
      kind: 'remediation',
      entityIds: [entityId],
      problemId: null,
      goalId,
      recommendationId: null,
      reason:
        `Recent activity shows repeated struggle with ${entityId} ` +
        `(D status ${status}, ${confidence} confidence${mistakes}${struggle}` +
        `${goalId ? `, active goal ${goalId}` : ''}).${voice}`,
      evidenceIds: capSorted(entry.evidenceIds, MAX_PRIORITY_EVIDENCE_IDS),
      progressIds: capSorted(entry.progressIds, MAX_PRIORITY_PROGRESS_IDS),
      observedAt: null,
    });
  }
  return out.sort((a, b) => {
    const severityA = severityOf(
      inputs.profile?.knowledgeStates.find((s) => s.entityId === a.entityIds[0])?.status ?? '',
    );
    const severityB = severityOf(
      inputs.profile?.knowledgeStates.find((s) => s.entityId === b.entityIds[0])?.status ?? '',
    );
    return severityA - severityB || (a.entityIds[0] ?? '').localeCompare(b.entityIds[0] ?? '');
  });
}

function sameEvidenceSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

function buildReinforcement(inputs: AgendaInputs): Omit<LongTermPriority, 'rank'>[] {
  const seenProblems = new Set<string>();
  const solvedProblemIds: string[] = [];
  const seenAttempts = new Set<string>();
  for (const attempt of inputs.attempts) {
    if (seenAttempts.has(attempt.attemptId)) {
      continue;
    }
    seenAttempts.add(attempt.attemptId);
    if (!isSolvedAttempt(attempt) || seenProblems.has(attempt.problemId)) {
      continue;
    }
    seenProblems.add(attempt.problemId);
    solvedProblemIds.push(attempt.problemId);
  }
  solvedProblemIds.sort();
  const problemsById = new Map(inputs.problems.map((problem) => [problem.problemId, problem]));
  const out: Omit<LongTermPriority, 'rank'>[] = [];
  for (const problemId of solvedProblemIds) {
    const problem = problemsById.get(problemId);
    if (!problem) {
      continue;
    }
    const decision = detectReinforcementNeed({
      problem,
      attempts: inputs.attempts,
      evidence: inputs.evidence,
      profile: inputs.profile,
      progress: inputs.progress,
      classification: latestClassificationFor(inputs.classifications, problemId),
      knowledge: knowledgeFor(inputs.knowledgeRecords, problemId),
    });
    if (decision.outcome !== 'reinforcement-indicated' || decision.need === null) {
      continue;
    }
    const need = decision.need;
    const chains = inputs.recommendations
      .filter((rec) => rec.sourceProblemId === problemId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.recommendationId.localeCompare(b.recommendationId));
    const live = chains.filter((rec) => (LIVE_RECOMMENDATION_STATUSES as readonly string[]).includes(rec.status));
    if (live.length > 0 && live[0]) {
      const rec = live[0];
      out.push({
        kind: 'reinforcement',
        entityIds: [...need.targetEntityIds].sort(),
        problemId,
        goalId: rec.goalId,
        recommendationId: rec.recommendationId,
        reason:
          `A recent solve of ${problemId} shows insufficient consolidation ` +
          `(${need.reasons.map((r) => r.kind).sort().join(', ')}); ` +
          `recommendation ${rec.recommendationId} is already ${rec.status}.`,
        evidenceIds: capSorted(need.evidenceIds, MAX_PRIORITY_EVIDENCE_IDS),
        progressIds: [],
        observedAt: null,
      });
      continue;
    }
    const sameNeedTerminal = chains.some(
      (rec) =>
        rec.needFingerprint === needFingerprintFor(need) && sameEvidenceSet(rec.evidenceIds, need.evidenceIds),
    );
    if (sameNeedTerminal) {
      continue;
    }
    const goalId = getActiveGoals(inputs.goals)
      .filter((goal) => goal.entityIds.some((id) => need.targetEntityIds.includes(id)))
      .sort((a, b) => a.goalId.localeCompare(b.goalId));
    out.push({
      kind: 'reinforcement',
      entityIds: [...need.targetEntityIds].sort(),
      problemId,
      goalId: goalId.length > 0 && goalId[0] ? goalId[0].goalId : null,
      recommendationId: null,
      reason:
        `A recent solve of ${problemId} shows insufficient consolidation ` +
        `(${need.reasons.map((r) => r.kind).sort().join(', ')}); no live recommendation exists yet.`,
      evidenceIds: capSorted(need.evidenceIds, MAX_PRIORITY_EVIDENCE_IDS),
      progressIds: [],
      observedAt: null,
    });
  }
  return out;
}

function buildRetrieval(
  inputs: AgendaInputs,
  remediationEntityIds: Set<string>,
): Omit<LongTermPriority, 'rank'>[] {
  const cap = inputs.retrievalCap ?? RETRIEVAL_CAP;
  const needs = detectRetrievalNeeds({
    profile: inputs.profile,
    plans: inputs.plans,
    attempts: inputs.attempts,
    problems: inputs.problems,
    classifications: inputs.classifications,
    knowledgeRecords: inputs.knowledgeRecords,
    nowIso: inputs.nowIso,
    staleAfterDays: inputs.staleAfterDays ?? STALE_AFTER_DAYS,
  }).filter((need) => !remediationEntityIds.has(need.entityId));
  return needs.slice(0, Math.max(0, cap)).map((need) => {
    const goalId = activeGoalForEntity(inputs.goals, need.entityId);
    return {
      kind: 'retrieval' as const,
      entityIds: [need.entityId],
      problemId: null,
      goalId,
      recommendationId: null,
      reason:
        `${need.entityId} previously reached ${need.status} (${need.statusConfidence} confidence), ` +
        `last observed ${need.lastObservedAt}, with no recent retrieval activity. ` +
        `Previously solid knowledge awaiting reactivation${goalId ? ` (active goal ${goalId})` : ''}.`,
      evidenceIds: capSorted(need.supportingEvidenceIds, MAX_PRIORITY_EVIDENCE_IDS),
      progressIds: [],
      observedAt: need.lastObservedAt,
    };
  });
}

function buildReview(inputs: AgendaInputs): Omit<LongTermPriority, 'rank'>[] {
  const out: Omit<LongTermPriority, 'rank'>[] = [];
  for (const goal of getActiveGoals(inputs.goals).sort((a, b) => a.goalId.localeCompare(b.goalId))) {
    const latest = getLatestProgressForGoal(inputs.progress, goal.goalId);
    if (latest === null || latest.progressSignal !== 'SUFFICIENT_EVIDENCE_FOR_REVIEW') {
      continue;
    }
    out.push({
      kind: 'review',
      entityIds: [...goal.entityIds].sort(),
      problemId: null,
      goalId: goal.goalId,
      recommendationId: null,
      reason:
        `Goal ${goal.goalId} has sufficient evidence for review ` +
        `(latest F3 signal at ${latest.evaluatedAt}). Learner decides whether it is addressed.`,
      evidenceIds: [],
      progressIds: capSorted([latest.progressId], MAX_PRIORITY_PROGRESS_IDS),
      observedAt: null,
    });
  }
  return out;
}

/**
 * Build the ordered long-term agenda. Pure: same snapshot always yields the
 * same ranked priorities. Inputs are never mutated. Empty data yields [].
 */
export function buildAgenda(inputs: AgendaInputs): LongTermPriority[] {
  const remediation = buildRemediation(inputs);
  const remediationEntityIds = new Set(
    remediation.flatMap((item) => item.entityIds),
  );
  const reinforcement = buildReinforcement(inputs);
  const retrieval = buildRetrieval(inputs, remediationEntityIds);
  const review = buildReview(inputs);
  return [...remediation, ...reinforcement, ...retrieval, ...review].map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Deterministic learner-facing agenda renderer. Wording distinguishes
 * retrieval ("previously solid, not retrieved recently") from remediation
 * ("recent struggle") using D/F3 vocabulary only — no AI, no scores.
 */
export function renderAgendaMarkdown(priorities: LongTermPriority[]): string {
  const ordered = priorities.slice().sort((a, b) => a.rank - b.rank || a.kind.localeCompare(b.kind));
  const lines: string[] = [];
  lines.push('# CodeSense Long-Term Agenda (J-4 derived view)');
  lines.push('');
  lines.push(
    'Ordered long-term priorities derived from existing evidence, progress, and plans. ' +
      'Retrieval items describe previously solid knowledge, never weakness.',
  );
  lines.push('');
  if (ordered.length === 0) {
    lines.push('_No long-term priorities right now._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| Rank | Kind | Focus | Why |');
  lines.push('| ---: | --- | --- | --- |');
  for (const item of ordered) {
    const focus =
      item.kind === 'reinforcement' && item.problemId
        ? item.problemId
        : item.kind === 'review' && item.goalId
          ? item.goalId
          : item.entityIds.join(', ');
    lines.push(`| ${item.rank} | ${item.kind} | ${escapeCell(focus)} | ${escapeCell(item.reason)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
