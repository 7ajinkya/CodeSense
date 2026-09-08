import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { dimensionStateOf } from '../learner/learnerModel';
import type { LearnerProfile } from '../learner/learnerModel';
import { getLearnerKnowledge } from '../learner/learnerQueries';
import { levelRank } from '../learner/learnerModelUpdater';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { DimensionLevel, EvidenceDimension, HelpLevel } from '../learner/learnerTypes';
import type { Attempt } from '../attempts/attempt';
import type { LearningGoal } from '../goals/goalTypes';
import { evidenceFingerprint } from '../goals/goalLifecycle';
import { laterEvidenceForGoal } from '../goals/goalQueries';
import type { ActivityPlan } from '../practice/activityTypes';
import {
  MAX_PROGRESS_EVIDENCE_IDS,
  MAX_PROGRESS_EXPLANATION_CHARS,
  MAX_PROGRESS_HISTORY_ENTRIES,
  MAX_PROGRESS_TEXT_CHARS,
  PROGRESS_ID_PREFIX,
} from './progressTypes';
import type {
  ActivityProgress,
  EntityProgressDetail,
  IndependenceFacet,
  ProgressPendingKind,
  ProgressSignal,
  ReassessmentSignal,
} from './progressTypes';
import { isKnownActivityIntent, isKnownActivityPurpose } from '../practice/activityTypes';

/**
 * Phase F3 progress evaluation: goal-relative interpretation of the
 * evidence one planned activity produced.
 *
 * Deterministic and inspectable by design:
 * - No AI calls, no network, no numeric mastery, no opaque score.
 * - Polarity is READ from D (membership in D's per-dimension
 *   positive/negative lists), never re-derived from evidence types here —
 *   so D's conservative aggregation (transfer applications, mistake
 *   dimensions, contradiction caps) is respected rather than duplicated.
 * - Level movement is compared with D's own `levelRank`.
 * - Attribution prefers the explicit chain (plan.linkedAttemptId →
 *   record.attemptId); timestamps alone never establish causality for
 *   linked records, and unlinked records are only weakly attributed when
 *   they cannot belong to another attempt.
 *
 * Pure: same inputs yield the same outcome. Never mutates the goal
 * (baseline stays immutable), the plan, the attempt, D evidence, or the
 * learner profile. Never transitions goals or plans.
 */

/** Goal statuses F3 may interpret (active now, or historically attributable). */
const ATTRIBUTABLE_GOAL_STATUSES: readonly string[] = ['active', 'paused', 'achieved'];

/** Plan statuses F3 will evaluate (withdrawn suggestions are out of scope by learner agency). */
const EVALUABLE_PLAN_STATUSES: readonly string[] = ['offered', 'started', 'completed'];

export interface AttributedEvidence {
  /** Strong: linked-attempt records at/after plan creation (sorted chronological). */
  strong: LearnerEvidence[];
  /** Weak: unlinked same-problem goal-local records in the plan window (sorted chronological). */
  weak: LearnerEvidence[];
}

/**
 * Attribute evidence to one planned activity.
 *
 * Strong attribution follows the explicit chain only:
 * `record.attemptId === plan.linkedAttemptId` (every D feed stamps the
 * originating attemptId) and the record is not older than the plan.
 *
 * Weak attribution covers records no attempt claims (`attemptId === null`,
 * e.g. human-curated reports): same problem, goal-local entities, inside
 * the plan window. Records claimed by a DIFFERENT attempt are never
 * attributed here — they may still be goal-relevant, which is a separate
 * (broader) set. When the plan has no linked attempt, nothing is
 * attributed: F3 does not guess.
 */
export function attributeActivityEvidence(
  evidence: LearnerEvidence[],
  plan: ActivityPlan,
  now: string,
): AttributedEvidence {
  const strong: LearnerEvidence[] = [];
  const weak: LearnerEvidence[] = [];
  if (plan.linkedAttemptId === null) {
    return { strong, weak };
  }
  const planEntityIds = new Set(plan.entityIds);
  for (const record of evidence) {
    if (record.timestamp.localeCompare(plan.createdAt) < 0 || record.timestamp.localeCompare(now) > 0) {
      continue;
    }
    if (record.attemptId === plan.linkedAttemptId) {
      strong.push(record);
      continue;
    }
    if (
      record.attemptId === null &&
      record.problemId === plan.problemId &&
      record.entityIds.some((id) => planEntityIds.has(id))
    ) {
      weak.push(record);
    }
  }
  const byTime = (a: LearnerEvidence, b: LearnerEvidence): number =>
    a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId);
  strong.sort(byTime);
  weak.sort(byTime);
  return { strong, weak };
}

export interface ProgressEvaluationInputs {
  goal: LearningGoal;
  plan: ActivityPlan;
  /** Attempt resolved via `plan.linkedAttemptId` (null when unresolvable). */
  attempt: Attempt | null;
  /** Full D evidence history (F3 selects; never mutates). */
  evidence: LearnerEvidence[];
  /** Current D profile (null when unavailable — evaluation degrades honestly). */
  profile: LearnerProfile | null;
  graph: KnowledgeGraph;
  /** Existing progress entries for this goal (history-aware signals + idempotency). */
  priorProgress: ActivityProgress[];
  now: string;
}

export type ProgressOutcome =
  | { status: 'evaluated'; progress: ActivityProgress; updated: boolean }
  | { status: 'pending'; kind: Extract<ProgressPendingKind, 'pending-evidence'>; reason: string }
  | {
      status: 'not-evaluable';
      kind: Extract<ProgressPendingKind, 'not-evaluable' | 'orphaned'>;
      reason: string;
    };

export function progressIdFor(goalId: string, planId: string, linkedAttemptId: string | null): string {
  return `${PROGRESS_ID_PREFIX}${stableHash(`${goalId}|${planId}|${linkedAttemptId ?? ''}`)}`;
}

/** Deterministic FNV-1a hex (matches repo hashing style, dependency-free). */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function isKnownDimensionLevel(value: unknown): value is DimensionLevel {
  return (
    value === 'UNKNOWN' ||
    value === 'EXPOSED' ||
    value === 'EMERGING' ||
    value === 'DEMONSTRATED' ||
    value === 'STRONG'
  );
}

function rankOfLevel(level: string): number {
  return isKnownDimensionLevel(level) ? levelRank(level) : levelRank('UNKNOWN');
}

function sortedUniqueIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Fingerprint over the attributed evidence + profile marker (F1 reuse for the join). */
function progressFingerprint(attributedIds: string[], profileUpdatedAt: string): string {
  return evidenceFingerprint(attributedIds, profileUpdatedAt);
}

interface ClassifiedNew {
  positive: LearnerEvidence[];
  negative: LearnerEvidence[];
  neutral: LearnerEvidence[];
}

/**
 * Sort activity records touching one entity by how D counted them in the
 * goal dimension: D's positive list → positive, D's negative list →
 * negative, anywhere else (exposure, off-dimension, unmodeled) → neutral
 * context. No evidence-type mapping is duplicated here.
 */
function classifyByDimensionLists(
  records: LearnerEvidence[],
  profile: LearnerProfile | null,
  entityId: string,
  dimension: EvidenceDimension,
): ClassifiedNew {
  const positive: LearnerEvidence[] = [];
  const negative: LearnerEvidence[] = [];
  const neutral: LearnerEvidence[] = [];
  const state = profile ? getLearnerKnowledge(profile, entityId) : null;
  const dim = state ? dimensionStateOf(state, dimension) : null;
  const posSet = new Set(dim ? dim.positiveEvidenceIds : []);
  const negSet = new Set(dim ? dim.negativeEvidenceIds : []);
  for (const record of records) {
    if (!record.entityIds.includes(entityId)) {
      continue;
    }
    if (posSet.has(record.evidenceId)) {
      positive.push(record);
    } else if (negSet.has(record.evidenceId)) {
      negative.push(record);
    } else {
      neutral.push(record);
    }
  }
  return { positive, negative, neutral };
}

/**
 * Independence facet from D's own independence accounting: records the
 * activity left in the independence positive list (independent success)
 * vs the negative list (help required), with D help levels quoted
 * verbatim. Never re-scores help.
 */
function buildIndependenceFacet(
  records: LearnerEvidence[],
  profile: LearnerProfile | null,
  goalEntityIds: string[],
): IndependenceFacet {
  const independentEvidenceIds: string[] = [];
  const helpEvidenceIds: string[] = [];
  const helpLevels = new Set<HelpLevel>();
  for (const entityId of goalEntityIds) {
    const state = profile ? getLearnerKnowledge(profile, entityId) : null;
    const dim = state ? dimensionStateOf(state, 'independence') : null;
    const posSet = new Set(dim ? dim.positiveEvidenceIds : []);
    const negSet = new Set(dim ? dim.negativeEvidenceIds : []);
    for (const record of records) {
      if (!record.entityIds.includes(entityId)) {
        continue;
      }
      if (posSet.has(record.evidenceId) && !independentEvidenceIds.includes(record.evidenceId)) {
        independentEvidenceIds.push(record.evidenceId);
      }
      if (negSet.has(record.evidenceId)) {
        if (!helpEvidenceIds.includes(record.evidenceId)) {
          helpEvidenceIds.push(record.evidenceId);
        }
        if (record.helpLevel !== undefined) {
          helpLevels.add(record.helpLevel);
        }
      }
    }
  }
  independentEvidenceIds.sort();
  helpEvidenceIds.sort();
  return {
    independent: independentEvidenceIds.length > 0,
    helped: helpEvidenceIds.length > 0,
    helpLevels: [...helpLevels].sort(),
    independentEvidenceIds,
    helpEvidenceIds,
  };
}

/**
 * Rival-facet signal for diagnostics: new activity evidence D counted in
 * a NON-goal dimension on goal entities (exposure never qualifies — it
 * sits in no valenced list). Only meaningful when the goal dimension
 * itself yielded nothing new.
 */
function rivalDimensionsWithNewEvidence(
  records: LearnerEvidence[],
  profile: LearnerProfile | null,
  goalEntityIds: string[],
  goalDimension: EvidenceDimension,
): EvidenceDimension[] {
  if (!profile) {
    return [];
  }
  const rivals = new Set<EvidenceDimension>();
  const dimensions: EvidenceDimension[] = [
    'recognition',
    'conceptual',
    'implementation',
    'debugging',
    'transfer',
    'independence',
  ];
  for (const dimension of dimensions) {
    if (dimension === goalDimension) {
      continue;
    }
    for (const entityId of goalEntityIds) {
      const state = getLearnerKnowledge(profile, entityId);
      if (!state) {
        continue;
      }
      const dim = dimensionStateOf(state, dimension);
      const counted = new Set([...dim.positiveEvidenceIds, ...dim.negativeEvidenceIds]);
      if (records.some((r) => r.entityIds.includes(entityId) && counted.has(r.evidenceId))) {
        rivals.add(dimension);
      }
    }
  }
  return [...rivals].sort();
}

function allGoalEntitiesDemonstrated(
  profile: LearnerProfile | null,
  goalEntityIds: string[],
): boolean {
  if (!profile || goalEntityIds.length === 0) {
    return false;
  }
  for (const entityId of goalEntityIds) {
    const state = getLearnerKnowledge(profile, entityId);
    if (!state) {
      return false;
    }
    const demonstrated = state.status === 'demonstrated' || state.status === 'strong';
    const confident = state.statusConfidence === 'medium' || state.statusConfidence === 'high';
    if (!demonstrated || !confident) {
      return false;
    }
  }
  return true;
}

function isPositiveOnlyEntry(entry: ActivityProgress): boolean {
  return entry.positiveNewIds.length > 0 && entry.negativeNewIds.length === 0;
}

interface SignalDecision {
  progressSignal: ProgressSignal;
  reassessment: ReassessmentSignal;
  decisionReasons: string[];
}

function decideSignal(args: {
  goal: LearningGoal;
  plan: ActivityPlan;
  positiveNew: LearnerEvidence[];
  negativeNew: LearnerEvidence[];
  hasAnyActivityEvidence: boolean;
  baselineLowConfidence: boolean;
  baselineIndicatesDifficulty: boolean;
  baselineStrong: boolean;
  rivals: EvidenceDimension[];
  priorPositiveOnlyDistinctPlans: number;
  priorStrugglingDistinctPlans: number;
  demonstratedNow: boolean;
}): SignalDecision {
  const pos = args.positiveNew.length;
  const neg = args.negativeNew.length;
  const transferFraming = args.plan.intent === 'transfer-practice' ? ' in transfer form' : '';

  // Rival-facet override (diagnostics only): the probe discriminated —
  // the live question sits in another dimension, not the goal's.
  if (
    args.plan.purpose === 'diagnostic' &&
    pos === 0 &&
    neg === 0 &&
    args.rivals.length > 0
  ) {
    return {
      progressSignal: 'UNCERTAINTY_REDUCED',
      reassessment: 'review-goal',
      decisionReasons: [
        `diagnostic activity produced no new ${args.goal.dimension} evidence but valenced evidence in ${args.rivals.join(', ')} — the goal direction may need rethinking with the learner`,
      ],
    };
  }

  if (pos > 0 && neg === 0) {
    // Hard invariant: ONE SUCCESS ≠ GOAL ACHIEVED. Review-grade signals
    // require repeated positive-only activities (distinct plans) PLUS
    // D's own demonstrated/strong standing on every goal target.
    if (args.priorPositiveOnlyDistinctPlans >= 1 && args.demonstratedNow) {
      return {
        progressSignal: 'SUFFICIENT_EVIDENCE_FOR_REVIEW',
        reassessment: 'sufficient-evidence-for-review',
        decisionReasons: [
          `repeated positive-only ${args.goal.dimension} evidence across ${args.priorPositiveOnlyDistinctPlans + 1} distinct activities${transferFraming}, with D standing demonstrated/strong on all goal targets — enough to ask the learner, never an automatic verdict`,
        ],
      };
    }
    if (args.plan.purpose === 'diagnostic' && args.baselineLowConfidence) {
      return {
        progressSignal: 'UNCERTAINTY_REDUCED',
        reassessment: 'continue',
        decisionReasons: [
          `diagnostic probe found positive ${args.goal.dimension} evidence against an uncertain baseline — what we learned feeds the next plan`,
        ],
      };
    }
    return {
      progressSignal: 'IMPROVING',
      reassessment: 'continue',
      decisionReasons: [
        `new positive ${args.goal.dimension} evidence${transferFraming} (${pos} record(s)); a single activity never settles a goal`,
      ],
    };
  }

  if (neg > 0 && pos === 0) {
    if (args.baselineIndicatesDifficulty) {
      // Repeated-targeted-struggle override: same facet failing across
      // three distinct activities suggests rethinking direction.
      if (args.priorStrugglingDistinctPlans >= 2) {
        return {
          progressSignal: 'STILL_STRUGGLING',
          reassessment: 'review-goal',
          decisionReasons: [
            `negative ${args.goal.dimension} evidence across ${args.priorStrugglingDistinctPlans + 1} distinct activities — repeated targeted practice is not moving this facet; reconsider direction with the learner`,
          ],
        };
      }
      return {
        progressSignal: 'STILL_STRUGGLING',
        reassessment: 'continue',
        decisionReasons: [
          `new negative ${args.goal.dimension} evidence (${neg} record(s)) consistent with the difficulty behind this goal`,
        ],
      };
    }
    if (args.baselineStrong) {
      return {
        progressSignal: 'REGRESSION_SIGNAL',
        reassessment: 'gather-more-evidence',
        decisionReasons: [
          `new negative ${args.goal.dimension} evidence against a previously demonstrated baseline — one failure is not lost skill; further evidence required`,
        ],
      };
    }
    if (args.plan.purpose === 'diagnostic' && args.baselineLowConfidence) {
      return {
        progressSignal: 'UNCERTAINTY_REDUCED',
        reassessment: 'continue',
        decisionReasons: [
          `diagnostic probe found ${args.goal.dimension} difficulty against an uncertain baseline — what we learned feeds the next plan`,
        ],
      };
    }
    return {
      progressSignal: 'EVIDENCE_ADDED',
      reassessment: 'gather-more-evidence',
      decisionReasons: [
        `new negative ${args.goal.dimension} evidence (${neg} record(s)) on a first/uncertain basis — too early to call struggle; single encounters prove nothing durable`,
      ],
    };
  }

  if (pos > 0 && neg > 0) {
    return {
      progressSignal: 'MIXED_SIGNAL',
      reassessment: 'gather-more-evidence',
      decisionReasons: [
        `contradictory new ${args.goal.dimension} evidence (${pos} positive, ${neg} negative) — uncertainty preserved, history kept; D aggregation stays authoritative`,
      ],
    };
  }

  // No valenced goal-dimension evidence from this activity.
  if (args.hasAnyActivityEvidence) {
    return {
      progressSignal: 'EVIDENCE_ADDED',
      reassessment: 'gather-more-evidence',
      decisionReasons: [
        `activity produced evidence, but none of it moves the ${args.goal.dimension} facet (exposure or off-dimension context only)`,
      ],
    };
  }
  return {
    progressSignal: 'NO_NEW_EVIDENCE',
    reassessment: 'gather-more-evidence',
    decisionReasons: [
      'completed activity left no attributable goal-local evidence (e.g. unclassified problem yields no D anchor)',
    ],
  };
}

function buildExplanation(args: {
  goal: LearningGoal;
  plan: ActivityPlan;
  attempt: Attempt;
  entities: EntityProgressDetail[];
  positiveNew: LearnerEvidence[];
  negativeNew: LearnerEvidence[];
  independence: IndependenceFacet;
  rivals: EvidenceDimension[];
  decision: SignalDecision;
  reassessment: ReassessmentSignal;
}): string {
  const learnerOwned = args.goal.source === 'learner-requested';
  const title = args.plan.problemTitle ?? args.plan.problemId;
  const purposeWord = args.plan.purpose === 'diagnostic' ? 'diagnostic probe' : 'targeted practice';
  const lines: string[] = [];
  if (learnerOwned) {
    lines.push(
      `You practiced "${title}" (${purposeWord} for your goal "${truncate(args.goal.description, MAX_PROGRESS_TEXT_CHARS)}"). Attempt ended as "${args.attempt.currentState}".`,
    );
  } else {
    lines.push(
      `Activity "${title}" (${purposeWord} for "${truncate(args.goal.description, MAX_PROGRESS_TEXT_CHARS)}") ended as "${args.attempt.currentState}".`,
    );
  }
  for (const detail of args.entities) {
    const movement =
      detail.currentLevel === null
        ? `${detail.baselineLevel} at activation → no model state now`
        : `${detail.baselineLevel} at activation → ${detail.currentLevel} now`;
    lines.push(`${detail.entityId} ${args.goal.dimension}: ${movement}.`);
  }
  const cite = (records: LearnerEvidence[]): string =>
    records.map((r) => `${r.evidenceId} (${r.evidenceType})`).join(', ');
  if (args.positiveNew.length > 0) {
    lines.push(
      learnerOwned
        ? `New encouraging evidence: ${cite(args.positiveNew)}.`
        : `New positive evidence: ${cite(args.positiveNew)}.`,
    );
  }
  if (args.negativeNew.length > 0) {
    lines.push(
      learnerOwned
        ? `New difficulty evidence (one data point, not a verdict): ${cite(args.negativeNew)}.`
        : `New difficulty evidence: ${cite(args.negativeNew)}.`,
    );
  }
  if (args.independence.independent) {
    lines.push('Independent success was observed on this activity.');
  }
  if (args.independence.helped) {
    const levels =
      args.independence.helpLevels.length > 0 ? ` (help level: ${args.independence.helpLevels.join(', ')})` : '';
    lines.push(`Help was involved${levels} — independence is not established by this activity.`);
  }
  if (args.plan.intent === 'transfer-practice') {
    lines.push('Transfer context preserved: this activity used the capability in a less-familiar form.');
  }
  if (args.rivals.length > 0) {
    lines.push(`Notably, new evidence also appeared in ${args.rivals.join(', ')} rather than ${args.goal.dimension}.`);
  }
  const nextStep =
    args.reassessment === 'continue'
      ? 'Suggested next step: continue with targeted practice.'
      : args.reassessment === 'gather-more-evidence'
        ? 'Suggested next step: gather more evidence before judging.'
        : args.reassessment === 'review-goal'
          ? 'Suggested next step: review the goal direction with the learner.'
          : 'Suggested next step: enough evidence to ask the learner whether the goal is addressed (their decision).';
  lines.push(nextStep);
  return truncate(lines.join(' '), MAX_PROGRESS_EXPLANATION_CHARS);
}

/**
 * Evaluate one planned activity against its goal. Pure and deterministic:
 * same inputs always yield the same outcome.
 *
 * Returns `evaluated` with the progress record (plus whether the stored
 * entry actually changed), `pending` when the attempt is unfinished or
 * unlinked-but-in-flight, or `not-evaluable` for orphaned/withdrawn/
 * mismatched inputs. Pending and not-evaluable outcomes are transient —
 * only evaluated records persist.
 */
export function evaluateActivityProgress(inputs: ProgressEvaluationInputs): ProgressOutcome {
  const { goal, plan, attempt, evidence, profile, graph, priorProgress, now } = inputs;

  if (plan.goalId !== goal.goalId) {
    return { status: 'not-evaluable', kind: 'not-evaluable', reason: `plan ${plan.planId} serves goal ${plan.goalId}, not ${goal.goalId}` };
  }
  if (!ATTRIBUTABLE_GOAL_STATUSES.includes(goal.status)) {
    return {
      status: 'not-evaluable',
      kind: goal.status === 'abandoned' || goal.status === 'dismissed' ? 'orphaned' : 'not-evaluable',
      reason: `goal ${goal.goalId} is ${goal.status} — progress is only evaluated for active, paused, or achieved goals`,
    };
  }
  if (goal.progressBaseline === null) {
    return { status: 'not-evaluable', kind: 'not-evaluable', reason: `goal ${goal.goalId} has no baseline anchor` };
  }
  for (const id of goal.entityIds) {
    if (!graph.hasEntity(id)) {
      return { status: 'not-evaluable', kind: 'not-evaluable', reason: `unknown entity "${id}" — refusing to interpret invented knowledge` };
    }
  }
  if (!isKnownActivityIntent(plan.intent) || !isKnownActivityPurpose(plan.purpose)) {
    return { status: 'not-evaluable', kind: 'not-evaluable', reason: `plan ${plan.planId} carries unknown intent/purpose` };
  }
  if (!EVALUABLE_PLAN_STATUSES.includes(plan.status)) {
    return {
      status: 'not-evaluable',
      kind: 'not-evaluable',
      reason: `plan ${plan.planId} is ${plan.status} — withdrawn suggestions are not interpreted as progress`,
    };
  }
  if (attempt === null || plan.linkedAttemptId === null) {
    const inFlight = plan.status === 'planned' || plan.status === 'offered' || plan.status === 'started';
    if (inFlight) {
      return {
        status: 'pending',
        kind: 'pending-evidence',
        reason: `plan ${plan.planId} has no linked attempt yet`,
      };
    }
    return {
      status: 'not-evaluable',
      kind: 'orphaned',
      reason: `plan ${plan.planId} resolved without a linked attempt`,
    };
  }
  if (attempt.attemptId !== plan.linkedAttemptId) {
    return {
      status: 'not-evaluable',
      kind: 'not-evaluable',
      reason: `attempt ${attempt.attemptId} is not the attempt linked to plan ${plan.planId}`,
    };
  }
  if (attempt.problemId !== plan.problemId) {
    return {
      status: 'not-evaluable',
      kind: 'not-evaluable',
      reason: `linked attempt problem ${attempt.problemId} does not match plan problem ${plan.problemId}`,
    };
  }
  if (attempt.completedAt === null) {
    return {
      status: 'pending',
      kind: 'pending-evidence',
      reason: `attempt ${attempt.attemptId} is not yet finalized`,
    };
  }

  const attributed = attributeActivityEvidence(evidence, plan, now);
  const activityRecords = [...attributed.strong, ...attributed.weak];
  const split = laterEvidenceForGoal(evidence, goal);
  const goalRelevantNewIds = sortedUniqueIds(split.after.map((r) => r.evidenceId)).slice(
    0,
    MAX_PROGRESS_EVIDENCE_IDS,
  );

  const baselineByEntity = new Map(
    goal.progressBaseline.entityStates.map((row) => [row.entityId, row] as const),
  );
  const entities: EntityProgressDetail[] = [];
  const positiveNew: LearnerEvidence[] = [];
  const negativeNew: LearnerEvidence[] = [];
  const seenPos = new Set<string>();
  const seenNeg = new Set<string>();
  let baselineLowConfidence = false;
  // Corroboration means confidence, not just origin: an evidence-derived
  // goal whose baseline confidence is low (ambiguous repetition) is still
  // an open question, not an established difficulty. Learner-requested
  // goals never inherit a difficulty backstory at all.
  let baselineIndicatesDifficulty =
    goal.source === 'evidence-derived' &&
    goal.evidenceBasis.needId !== null &&
    goal.entityIds.length > 0;
  let baselineStrong = true;
  for (const entityId of goal.entityIds) {
    const baselineRow = baselineByEntity.get(entityId);
    const baselineLevel = baselineRow ? baselineRow.level : 'UNKNOWN';
    const baselineConfidence = baselineRow ? baselineRow.confidence : 'low';
    if (baselineConfidence === 'low') {
      baselineLowConfidence = true;
    }
    if (baselineConfidence !== 'medium' && baselineConfidence !== 'high') {
      baselineIndicatesDifficulty = false;
    }
    if (rankOfLevel(baselineLevel) < levelRank('DEMONSTRATED')) {
      baselineStrong = false;
    }
    const state = profile ? getLearnerKnowledge(profile, entityId) : null;
    const dim = state ? dimensionStateOf(state, goal.dimension) : null;
    const classified = classifyByDimensionLists(activityRecords, profile, entityId, goal.dimension);
    for (const record of classified.positive) {
      if (!seenPos.has(record.evidenceId)) {
        seenPos.add(record.evidenceId);
        positiveNew.push(record);
      }
    }
    for (const record of classified.negative) {
      if (!seenNeg.has(record.evidenceId)) {
        seenNeg.add(record.evidenceId);
        negativeNew.push(record);
      }
    }
    entities.push({
      entityId,
      baselineLevel,
      baselineConfidence,
      currentLevel: dim ? dim.level : null,
      currentConfidence: dim ? dim.confidence : null,
      positiveNewIds: classified.positive.map((r) => r.evidenceId).sort(),
      negativeNewIds: classified.negative.map((r) => r.evidenceId).sort(),
    });
  }
  // Learner-requested goals never inherit a "difficulty" backstory: their
  // baseline is a neutral starting point, not evidence of weakness.
  if (goal.source === 'learner-requested') {
    baselineIndicatesDifficulty = false;
  }
  positiveNew.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
  negativeNew.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));

  const independence = buildIndependenceFacet(activityRecords, profile, goal.entityIds);
  const rivals = rivalDimensionsWithNewEvidence(activityRecords, profile, goal.entityIds, goal.dimension);

  const priorForGoal = priorProgress.filter((entry) => entry.goalId === goal.goalId);
  const priorPositiveOnlyDistinctPlans = new Set(
    priorForGoal
      .filter((entry) => entry.planId !== plan.planId && isPositiveOnlyEntry(entry))
      .map((entry) => entry.planId),
  ).size;
  const priorStrugglingDistinctPlans = new Set(
    priorForGoal
      .filter((entry) => entry.planId !== plan.planId && entry.progressSignal === 'STILL_STRUGGLING')
      .map((entry) => entry.planId),
  ).size;
  const demonstratedNow = allGoalEntitiesDemonstrated(profile, goal.entityIds);

  const decision = decideSignal({
    goal,
    plan,
    positiveNew,
    negativeNew,
    hasAnyActivityEvidence: activityRecords.length > 0,
    baselineLowConfidence,
    baselineIndicatesDifficulty,
    baselineStrong,
    rivals,
    priorPositiveOnlyDistinctPlans,
    priorStrugglingDistinctPlans,
    demonstratedNow,
  });

  const attributedIds = sortedUniqueIds(activityRecords.map((r) => r.evidenceId));
  const fingerprint = progressFingerprint(attributedIds, profile?.updatedAt ?? now);
  const progressId = progressIdFor(goal.goalId, plan.planId, plan.linkedAttemptId);
  const existing = priorForGoal.find((entry) => entry.progressId === progressId) ?? null;
  if (existing && existing.evidenceFingerprint === fingerprint) {
    return { status: 'evaluated', progress: existing, updated: false };
  }

  const explanation = buildExplanation({
    goal,
    plan,
    attempt,
    entities,
    positiveNew,
    negativeNew,
    independence,
    rivals,
    decision,
    reassessment: decision.reassessment,
  });

  const previousRevision =
    existing !== null
      ? {
          evaluatedAt: existing.evaluatedAt,
          progressSignal: existing.progressSignal,
          reassessment: existing.reassessment,
          evidenceFingerprint: existing.evidenceFingerprint,
        }
      : null;
  const signalHistory =
    existing !== null
      ? [...existing.signalHistory, ...(previousRevision !== null ? [previousRevision] : [])].slice(
          -MAX_PROGRESS_HISTORY_ENTRIES,
        )
      : [];

  const progress: ActivityProgress = {
    progressId,
    goalId: goal.goalId,
    goalTargetKey: goal.targetKey,
    planId: plan.planId,
    linkedAttemptId: plan.linkedAttemptId,
    goalSource: goal.source,
    dimension: goal.dimension,
    activity: {
      intent: plan.intent,
      purpose: plan.purpose,
      entityIds: [...plan.entityIds].sort(),
      problemId: plan.problemId,
      problemTitle: plan.problemTitle,
    },
    baselineRef: {
      capturedAt: goal.progressBaseline.capturedAt,
      profileUpdatedAt: goal.progressBaseline.profileUpdatedAt,
    },
    activityEvidenceIds: attributed.strong.map((r) => r.evidenceId).sort(),
    weakEvidenceIds: attributed.weak.map((r) => r.evidenceId).sort(),
    goalRelevantNewIds,
    entities,
    positiveNewIds: positiveNew.map((r) => r.evidenceId).sort().slice(0, MAX_PROGRESS_EVIDENCE_IDS),
    negativeNewIds: negativeNew.map((r) => r.evidenceId).sort().slice(0, MAX_PROGRESS_EVIDENCE_IDS),
    independence,
    progressSignal: decision.progressSignal,
    reassessment: decision.reassessment,
    explanation,
    firstEvaluatedAt: existing ? existing.firstEvaluatedAt : now,
    evaluatedAt: now,
    evaluationCount: (existing ? existing.evaluationCount : 0) + 1,
    evidenceFingerprint: fingerprint,
    signalHistory,
    provenance: {
      ontologyVersion: graph.ontologyVersion,
      aggregatorVersion: profile?.aggregatorVersion ?? 'unknown',
    },
  };
  return { status: 'evaluated', progress, updated: true };
}

/** Strict AI-candidate wording: explanation text ONLY (mirrors F1/F2 wording boundaries). */
export interface ProgressWordingCandidate {
  explanation?: string;
}

export function validateProgressWordingCandidate(raw: unknown): ProgressWordingCandidate | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'explanation') {
      return null;
    }
  }
  if (record.explanation === undefined) {
    return null;
  }
  if (typeof record.explanation !== 'string' || record.explanation.trim().length === 0) {
    return null;
  }
  return { explanation: truncate(record.explanation, MAX_PROGRESS_EXPLANATION_CHARS) };
}

/**
 * Apply validated candidate wording onto a progress record. Returns a new
 * record: display text may change, but identity, linkage, evidence refs,
 * signals, and provenance are preserved untouched.
 */
export function applyProgressWording(
  progress: ActivityProgress,
  candidate: ProgressWordingCandidate,
): ActivityProgress {
  return {
    ...progress,
    explanation: candidate.explanation ?? progress.explanation,
    entities: progress.entities.map((detail) => ({
      ...detail,
      positiveNewIds: [...detail.positiveNewIds],
      negativeNewIds: [...detail.negativeNewIds],
    })),
    activity: { ...progress.activity, entityIds: [...progress.activity.entityIds] },
    baselineRef: { ...progress.baselineRef },
    activityEvidenceIds: [...progress.activityEvidenceIds],
    weakEvidenceIds: [...progress.weakEvidenceIds],
    goalRelevantNewIds: [...progress.goalRelevantNewIds],
    positiveNewIds: [...progress.positiveNewIds],
    negativeNewIds: [...progress.negativeNewIds],
    independence: {
      ...progress.independence,
      helpLevels: [...progress.independence.helpLevels],
      independentEvidenceIds: [...progress.independence.independentEvidenceIds],
      helpEvidenceIds: [...progress.independence.helpEvidenceIds],
    },
    signalHistory: progress.signalHistory.map((revision) => ({ ...revision })),
    provenance: { ...progress.provenance },
  };
}
