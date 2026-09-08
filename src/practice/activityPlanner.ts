import { randomUUID } from 'crypto';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { frameworkFamily } from '../learner/learnerModelUpdater';
import { dimensionStateOf } from '../learner/learnerModel';
import type { LearnerProfile } from '../learner/learnerModel';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import { getLearnerKnowledge } from '../learner/learnerQueries';
import type { Attempt } from '../attempts/attempt';
import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import type { LearningGoal } from '../goals/goalTypes';
import { laterEvidenceForGoal } from '../goals/goalQueries';
import type { ActivityCatalogEntry } from './activityCatalog';
import { candidateEntityOverlap, candidateIsolatesTarget } from './activityCatalog';
import {
  MAX_PLAN_EVIDENCE_IDS,
  MAX_PLAN_RATIONALE_CHARS,
  MAX_PLAN_SEQUENCE_LENGTH,
  MAX_PLAN_TEXT_CHARS,
  PRACTICE_PLAN_ID_PREFIX,
  PRACTICE_SEQUENCE_ID_PREFIX,
} from './activityTypes';
import type {
  ActivityIntent,
  ActivityPlan,
  ActivityPurpose,
  ActivityWordingCandidate,
} from './activityTypes';
import { intentForDimension, isKnownActivityIntent } from './activityTypes';

/**
 * Phase F2 targeted practice planner: active goal → ranked existing
 * activities → bounded, explainable activity plan(s).
 *
 * Deterministic and inspectable by design:
 * - No AI calls, no network, no numeric mastery, no opaque score.
 * - Every decision cites its inputs (goal, D state, evidence IDs, C
 *   entities, prior plans/attempts, learner preference).
 * - Ranking exposes per-candidate factor reasons instead of a single
 *   number, so "why this activity" is always answerable.
 * - Difficulty is recorded as an informational note only — a harder
 *   problem never wins on difficulty alone.
 *
 * The planner READS frozen C/D/F1 contracts and WRITES only plans.
 * It never creates or mutates D evidence, never duplicates the C
 * taxonomy, never re-derives F1 needs, and never generates problems.
 */

export const MAX_PLAN_ACTIVITIES = MAX_PLAN_SEQUENCE_LENGTH;
export const MIN_EVIDENCE_FOR_INSTRUCTIONAL = 3;

export interface LearnerPreference {
  /** Explicitly requested pedagogical framing (honored when compatible with the goal). */
  preferredIntent?: ActivityIntent;
  /** Learner said they want coding practice (all F2 activities are coding problems; recorded, not overriding). */
  wantsCodingPractice?: boolean;
  /** Problem IDs the learner asked to avoid (hard filter). */
  excludeProblemIds?: string[];
  /** Free-form learner phrasing, kept as provenance only (never parsed for capability). */
  note?: string;
}

export interface PracticePlanningInputs {
  goal: LearningGoal;
  graph: KnowledgeGraph;
  profile: LearnerProfile | null;
  evidence: LearnerEvidence[];
  catalog: ActivityCatalogEntry[];
  attempts: Attempt[];
  priorPlans: ActivityPlan[];
  learnerPreference?: LearnerPreference;
  now: string;
  /** 1..MAX_PLAN_ACTIVITIES (default 1). Sequences stay small and adaptive. */
  maxActivities?: number;
  /** Problem IDs where repetition is explicitly justified (retry after feedback). */
  allowRepeatProblemIds?: string[];
}

export interface RankedCandidate {
  entry: ActivityCatalogEntry;
  /** Goal entities this candidate exercises (sorted). */
  overlap: string[];
  isolatesTarget: boolean;
  /** True when the candidate uses a less-familiar form of the same framework family. */
  isTransferVariant: boolean;
  /** True when neither prior plans for this goal nor completed attempts have used it. */
  isUnused: boolean;
  evidenceUtility: 'high' | 'medium' | 'low';
  /** Human-readable factor breakdown (inspectable ranking, never a bare score). */
  rankingReasons: string[];
  /** Verbatim difficulty note (informational only). */
  difficultyNote: string | null;
}

export interface PlanningDecision {
  intent: ActivityIntent;
  purpose: ActivityPurpose;
  purposeReasons: string[];
  evidenceIds: string[];
  uncertaintyNote: string | null;
  preferenceNote: string | null;
}

export type PlanningOutcome =
  | { status: 'planned'; plans: ActivityPlan[]; ranked: RankedCandidate[]; decision: PlanningDecision }
  | { status: 'no-plan'; reason: string; ranked: RankedCandidate[] };

export function generatePlanId(): string {
  return `${PRACTICE_PLAN_ID_PREFIX}${randomUUID()}`;
}

export function generateSequenceId(): string {
  return `${PRACTICE_SEQUENCE_ID_PREFIX}${randomUUID()}`;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function expectedEvidenceTypesFor(dimension: EvidenceDimension): EvidenceType[] {
  switch (dimension) {
    case 'recognition':
      return ['RECOGNITION'];
    case 'conceptual':
      return ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'];
    case 'implementation':
      return ['IMPLEMENTATION_SUCCESS', 'IMPLEMENTATION_FAILURE'];
    case 'debugging':
      return ['DEBUGGING_SUCCESS', 'DEBUGGING_FAILURE'];
    case 'transfer':
      return ['TRANSFER_SUCCESS', 'TRANSFER_FAILURE'];
    case 'independence':
      return ['INDEPENDENT_SUCCESS', 'HELP_REQUIRED'];
    case 'exposure':
      return ['EXPOSURE'];
  }
}

function expectedEvidenceProse(dimension: EvidenceDimension, entityIds: string[]): string {
  const targets = entityIds.join(', ');
  switch (dimension) {
    case 'recognition':
      return `Independent recognition (or a miss) on ${targets} would corroborate or revise the recognition picture.`;
    case 'conceptual':
      return `Explanations and approach choices on ${targets} would add conceptual evidence either way.`;
    case 'implementation':
      return `A worked implementation on ${targets} — success or failure — would add implementation evidence.`;
    case 'debugging':
      return `Diagnosing and fixing any failure on ${targets} would add debugging evidence.`;
    case 'transfer':
      return `Success or struggle on this less-familiar form of ${targets} would add transfer evidence.`;
    case 'independence':
      return `How much help is needed on ${targets} would add independence evidence.`;
    case 'exposure':
      return `Attempting ${targets} would add exposure history before any stronger claim.`;
  }
}

/** Forms already encountered via prior problems (evidence + attempts + prior plans). */
function priorFormsSeen(args: {
  evidence: LearnerEvidence[];
  attempts: Attempt[];
  priorPlans: ActivityPlan[];
  catalog: ActivityCatalogEntry[];
  goalEntityIds: string[];
}): Set<string> {
  const priorProblemIds = new Set<string>();
  for (const record of args.evidence) {
    if (record.problemId && record.entityIds.some((id) => args.goalEntityIds.includes(id))) {
      priorProblemIds.add(record.problemId);
    }
  }
  for (const attempt of args.attempts) {
    priorProblemIds.add(attempt.problemId);
  }
  for (const plan of args.priorPlans) {
    priorProblemIds.add(plan.problemId);
  }
  const byProblem = new Map(args.catalog.map((entry) => [entry.problemId, entry] as const));
  const forms = new Set<string>();
  for (const problemId of priorProblemIds) {
    const entry = byProblem.get(problemId);
    if (entry) {
      for (const form of entry.forms) {
        forms.add(form);
      }
    }
  }
  return forms;
}

function isTransferVariant(
  entry: ActivityCatalogEntry,
  goalEntityIds: string[],
  graph: KnowledgeGraph,
  priorForms: Set<string>,
): boolean {
  if (entry.forms.length === 0 || priorForms.size === 0) {
    // Transfer means "less familiar than what the learner has done": with
    // no prior forms on record, nothing is less familiar yet.
    return false;
  }
  const family = new Set<string>();
  for (const goalId of goalEntityIds) {
    for (const member of frameworkFamily(graph, goalId)) {
      family.add(member);
    }
  }
  const inFamily = entry.entityIds.some((id) => family.has(id));
  if (!inFamily) {
    return false;
  }
  // A transfer variant uses the same family through a form the learner has
  // not practiced yet (less-obvious context). Familiar forms — including
  // the goal's own IDs — are not transfer variants.
  return entry.forms.some((form) => !goalEntityIds.includes(form) && !priorForms.has(form));
}

function completedProblemIds(attempts: Attempt[]): Set<string> {
  const out = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.completedAt !== null) {
      out.add(attempt.problemId);
    }
  }
  return out;
}

function successfulProblemIds(attempts: Attempt[]): Set<string> {
  const out = new Set<string>();
  for (const attempt of attempts) {
    if (
      attempt.completedAt !== null &&
      (attempt.currentState === 'Got AC Independently' || attempt.currentState === 'Got AC with Help')
    ) {
      out.add(attempt.problemId);
    }
  }
  return out;
}

function rankCandidates(args: {
  goal: LearningGoal;
  graph: KnowledgeGraph;
  evidence: LearnerEvidence[];
  attempts: Attempt[];
  priorPlans: ActivityPlan[];
  catalog: ActivityCatalogEntry[];
  excludedProblemIds: Set<string>;
  activePlanProblemIds: Set<string>;
}): RankedCandidate[] {
  const completed = completedProblemIds(args.attempts);
  const succeeded = successfulProblemIds(args.attempts);
  const priorForGoal = new Set(
    args.priorPlans.filter((p) => p.goalId === args.goal.goalId).map((p) => p.problemId),
  );
  const priorForms = priorFormsSeen({
    evidence: args.evidence,
    attempts: args.attempts,
    priorPlans: args.priorPlans.filter((p) => p.goalId === args.goal.goalId),
    catalog: args.catalog,
    goalEntityIds: args.goal.entityIds,
  });
  const ranked: RankedCandidate[] = [];
  for (const entry of args.catalog) {
    if (args.excludedProblemIds.has(entry.problemId) || args.activePlanProblemIds.has(entry.problemId)) {
      continue;
    }
    const overlap = candidateEntityOverlap(entry, args.goal.entityIds);
    if (overlap.length === 0) {
      continue;
    }
    const isolates = candidateIsolatesTarget(entry, args.goal.entityIds);
    const transfer = isTransferVariant(entry, args.goal.entityIds, args.graph, priorForms);
    const usedBefore = priorForGoal.has(entry.problemId) || completed.has(entry.problemId);
    const alreadyDemonstrated = succeeded.has(entry.problemId);
    let utility: RankedCandidate['evidenceUtility'] = 'medium';
    if (!usedBefore && isolates) {
      utility = 'high';
    } else if (!usedBefore) {
      utility = 'medium';
    } else {
      utility = 'low';
    }
    if (alreadyDemonstrated) {
      utility = 'low';
    }
    // Transfer goals value unfamiliar forms; focused goals value isolation.
    if (args.goal.dimension === 'transfer' && transfer && !usedBefore) {
      utility = 'high';
    }
    const reasons: string[] = [];
    reasons.push(`shares ${overlap.length}/${args.goal.entityIds.length} goal entities (${overlap.join(', ')})`);
    reasons.push(
      isolates
        ? `isolates the target (${entry.entityIds.length} entities total)`
        : `broad coverage (${entry.entityIds.length} entities total)`,
    );
    reasons.push(usedBefore ? 'already used — new evidence unlikely' : 'unused — likely new evidence');
    if (transfer) {
      reasons.push('transfer variant — less-familiar form of the same family');
    }
    if (alreadyDemonstrated) {
      reasons.push('already solved — repeating it would re-prove known capability');
    }
    if (utility === 'high') {
      reasons.push('evidence utility high');
    } else if (utility === 'medium') {
      reasons.push('evidence utility medium');
    } else {
      reasons.push('evidence utility low');
    }
    ranked.push({
      entry,
      overlap,
      isolatesTarget: isolates,
      isTransferVariant: transfer,
      isUnused: !usedBefore,
      evidenceUtility: utility,
      rankingReasons: reasons,
      difficultyNote:
        entry.difficulty !== null
          ? `difficulty "${entry.difficulty}" noted (informational only, not ranked by)`
          : null,
    });
  }
  const utilityRank = (utility: RankedCandidate['evidenceUtility']): number =>
    utility === 'high' ? 0 : utility === 'medium' ? 1 : 2;
  ranked.sort((a, b) => {
    if (Number(a.isUnused) !== Number(b.isUnused)) {
      return Number(b.isUnused) - Number(a.isUnused);
    }
    if (utilityRank(a.evidenceUtility) !== utilityRank(b.evidenceUtility)) {
      return utilityRank(a.evidenceUtility) - utilityRank(b.evidenceUtility);
    }
    // Pedagogical fit beats breadth: isolation before raw overlap.
    if (Number(a.isolatesTarget) !== Number(b.isolatesTarget)) {
      return Number(b.isolatesTarget) - Number(a.isolatesTarget);
    }
    // Transfer goals prefer transfer variants; other goals prefer familiar isolation.
    if (a.isTransferVariant !== b.isTransferVariant) {
      if (args.goal.dimension === 'transfer') {
        return Number(b.isTransferVariant) - Number(a.isTransferVariant);
      }
      return Number(a.isTransferVariant) - Number(b.isTransferVariant);
    }
    if (b.overlap.length !== a.overlap.length) {
      return b.overlap.length - a.overlap.length;
    }
    return a.entry.problemId.localeCompare(b.entry.problemId);
  });
  return ranked;
}

interface PurposeAssessment {
  purpose: ActivityPurpose;
  reasons: string[];
  evidenceIds: string[];
  uncertaintyNote: string | null;
}

function assessPurpose(args: {
  goal: LearningGoal;
  profile: LearnerProfile | null;
  evidence: LearnerEvidence[];
}): PurposeAssessment {
  // Learner-requested goals with no evidence: honest instructional practice,
  // never a manufactured weakness.
  if (args.goal.source === 'learner-requested' && args.goal.evidenceBasis.evidenceIds.length === 0) {
    const onTarget = args.evidence.filter((record) =>
      record.entityIds.some((id) => args.goal.entityIds.includes(id)),
    );
    if (onTarget.length === 0) {
      return {
        purpose: 'instructional',
        reasons: ['learner-requested goal with no prior evidence on the target — providing requested practice'],
        evidenceIds: [],
        uncertaintyNote: null,
      };
    }
  }
  if (!args.profile || args.goal.entityIds.length === 0) {
    return {
      purpose: 'diagnostic',
      reasons: ['insufficient model basis to assume a specific weakness — probing first'],
      evidenceIds: args.goal.evidenceBasis.evidenceIds.slice(0, MAX_PLAN_EVIDENCE_IDS),
      uncertaintyNote: 'Limited basis; treating the first activity as a probe, not a verdict.',
    };
  }
  const evidenceIds: string[] = [];
  let corroborated = 0;
  let uncertain = 0;
  const reasonBits: string[] = [];
  for (const entityId of args.goal.entityIds) {
    const state = getLearnerKnowledge(args.profile, entityId);
    if (!state) {
      uncertain += 1;
      reasonBits.push(`${entityId}: no model state yet`);
      continue;
    }
    const dim = dimensionStateOf(state, args.goal.dimension);
    for (const id of [...state.supportingEvidenceIds, ...state.contradictingEvidenceIds].slice(
      0,
      MAX_PLAN_EVIDENCE_IDS,
    )) {
      if (!evidenceIds.includes(id)) {
        evidenceIds.push(id);
      }
    }
    const negativeMajority = dim.negativeWeight > 0 && dim.negativeWeight > dim.positiveWeight;
    const corroboratedHere =
      (state.status === 'struggling' || state.status === 'mixed') &&
      negativeMajority &&
      (state.statusConfidence === 'medium' || state.statusConfidence === 'high');
    if (corroboratedHere) {
      corroborated += 1;
      reasonBits.push(
        `${entityId}: ${state.status} (${dim.negativeWeight} difficulty vs ${dim.positiveWeight} supporting, confidence ${state.statusConfidence})`,
      );
    } else {
      uncertain += 1;
      reasonBits.push(
        `${entityId}: status ${state.status}, ${args.goal.dimension} ${dim.level} (confidence ${dim.confidence})`,
      );
    }
  }
  // Corroborated weakness on every target → targeted intervention.
  // Corroboration means repeated evidence, not one strongly-worded
  // record: a single data point stays diagnostic whatever D's rollup says.
  if (corroborated > 0 && uncertain === 0 && evidenceIds.length >= MIN_EVIDENCE_FOR_INSTRUCTIONAL) {
    return {
      purpose: 'instructional',
      reasons: [`corroborated difficulty on all ${corroborated} target(s): ${reasonBits.join('; ')}`],
      evidenceIds: evidenceIds.slice(0, MAX_PLAN_EVIDENCE_IDS),
      uncertaintyNote: null,
    };
  }
  // Anything else preserves uncertainty: probe before assuming.
  const capped = evidenceIds.slice(0, MAX_PLAN_EVIDENCE_IDS);
  const uncertaintyNote =
    'Uncertainty is high — this activity checks the capability rather than assuming it.';
  return {
    purpose: 'diagnostic',
    reasons: [`uncertain basis — probing first: ${reasonBits.join('; ')}`],
    evidenceIds: capped,
    uncertaintyNote,
  };
}

function describeIntent(intent: ActivityIntent): string {
  switch (intent) {
    case 'recognition-practice':
      return 'recognition practice';
    case 'conceptual-practice':
      return 'conceptual practice';
    case 'implementation-practice':
      return 'implementation practice';
    case 'debugging-practice':
      return 'debugging practice';
    case 'transfer-practice':
      return 'transfer practice';
    case 'independence-practice':
      return 'independent practice';
    case 'reinforcement':
      return 'consolidation practice';
  }
}

function buildRationale(args: {
  goal: LearningGoal;
  candidate: RankedCandidate;
  intent: ActivityIntent;
  purpose: ActivityPurpose;
  position: number;
  sequenceLength: number;
  preferenceNote: string | null;
  uncertaintyNote: string | null;
  graph: KnowledgeGraph;
}): string {
  const names = args.candidate.overlap
    .map((id) => args.graph.getEntity(id)?.name ?? id)
    .join(', ');
  const title = args.candidate.entry.title ?? args.candidate.entry.problemId;
  const positionNote =
    args.sequenceLength > 1
      ? ` (step ${args.position + 1} of ${args.sequenceLength})`
      : '';
  if (args.goal.source === 'learner-requested' && args.goal.evidenceBasis.evidenceIds.length === 0) {
    const purposeLine =
      args.purpose === 'diagnostic'
        ? `This is a diagnostic probe${positionNote}: a first look at ${names}, not a verdict about ability.`
        : `This is focused ${describeIntent(args.intent)}${positionNote} for your goal on ${names}.`;
    const base =
      `You asked to improve ${names}, so "${title}" gives you ${describeIntent(args.intent)} ` +
      `toward "${truncate(args.goal.description, MAX_PLAN_TEXT_CHARS)}". ${purposeLine}`;
    const preference = args.preferenceNote ? ` ${args.preferenceNote}` : '';
    const fit = args.candidate.isolatesTarget
      ? ' It isolates the target rather than mixing in unrelated skills.'
      : ' It exercises the target alongside related knowledge.';
    return truncate(`${base}${fit}${preference}`, MAX_PLAN_RATIONALE_CHARS);
  }
  const purposeLine =
    args.purpose === 'diagnostic'
      ? `Let's use "${title}" to check whether ${names} ${args.goal.dimension} is actually the issue${positionNote}.`
      : `This is targeted ${describeIntent(args.intent)} for ${names}${positionNote}.`;
  const evidenceNote =
    args.goal.evidenceBasis.evidenceIds.length > 0
      ? ` Based on ${args.goal.evidenceBasis.evidenceIds.length} evidence-backed encounter(s) behind "${truncate(args.goal.description, MAX_PLAN_TEXT_CHARS)}".`
      : '';
  const fit = args.candidate.isolatesTarget
    ? ' The problem isolates the target rather than introducing unrelated concepts.'
    : args.candidate.isTransferVariant
      ? ' The problem uses the capability in a less obvious context to test transfer.'
      : ' The problem exercises the target alongside related knowledge.';
  const uncertainty = args.uncertaintyNote ? ` ${args.uncertaintyNote}` : '';
  const preference = args.preferenceNote ? ` ${args.preferenceNote}` : '';
  return truncate(`${purposeLine}${evidenceNote}${fit}${uncertainty}${preference}`, MAX_PLAN_RATIONALE_CHARS);
}

/**
 * Plan the next targeted activity (or small bounded sequence) for an
 * active goal. Pure and deterministic: same inputs yield the same plans
 * in the same order. Returns `no-plan` with an honest reason instead of
 * inventing evidence, entities, or activities.
 */
export function planTargetedPractice(inputs: PracticePlanningInputs): PlanningOutcome {
  const { goal, graph } = inputs;
  const now = inputs.now;
  const maxActivities = Math.max(1, Math.min(inputs.maxActivities ?? 1, MAX_PLAN_ACTIVITIES));
  const preference = inputs.learnerPreference ?? {};
  const excluded = new Set(preference.excludeProblemIds ?? []);
  const activePlanProblemIds = new Set(
    inputs.priorPlans
      .filter((p) => p.goalId === goal.goalId && (p.status === 'planned' || p.status === 'offered' || p.status === 'started'))
      .map((p) => p.problemId),
  );

  if (goal.status !== 'active') {
    return { status: 'no-plan', reason: `goal ${goal.goalId} is ${goal.status}, not active`, ranked: [] };
  }
  if (goal.entityIds.length === 0) {
    return {
      status: 'no-plan',
      reason: 'goal has no target entities — refusing to invent a topic',
      ranked: [],
    };
  }
  for (const id of goal.entityIds) {
    if (!graph.hasEntity(id)) {
      return { status: 'no-plan', reason: `unknown entity "${id}" — refusing to plan on invented knowledge`, ranked: [] };
    }
  }

  const ranked = rankCandidates({
    goal,
    graph,
    evidence: inputs.evidence,
    attempts: inputs.attempts,
    priorPlans: inputs.priorPlans,
    catalog: inputs.catalog,
    excludedProblemIds: excluded,
    activePlanProblemIds,
  });
  // Justified repetition seam: terminally-used problems rank low, but when
  // NOTHING unused remains and the caller explicitly allows a repeat, the
  // best low-utility candidate may still serve (with its reason stated).
  const allowRepeat = new Set(inputs.allowRepeatProblemIds ?? []);
  let eligible = ranked.filter((c) => c.isUnused || allowRepeat.has(c.entry.problemId));
  if (eligible.length === 0 && ranked.length > 0) {
    return {
      status: 'no-plan',
      reason: 'all relevant activities were already used — specify allowRepeatProblemIds to justify a retry',
      ranked,
    };
  }
  if (eligible.length === 0) {
    return { status: 'no-plan', reason: 'no candidate activities share the goal entities', ranked };
  }

  const assessment = assessPurpose({ goal, profile: inputs.profile, evidence: inputs.evidence });
  let intent = intentForDimension(goal.dimension);
  let preferenceNote: string | null = null;
  if (preference.preferredIntent !== undefined && isKnownActivityIntent(preference.preferredIntent)) {
    const wanted = preference.preferredIntent;
    // Honor explicit framing when it matches the goal dimension or the goal
    // itself is learner-owned (intent matters); otherwise record why not.
    const wantedDimension = wanted === 'reinforcement' ? null : wanted.split('-')[0];
    if (wanted === intent || goal.source === 'learner-requested' || wantedDimension === goal.dimension) {
      if (wanted !== intent) {
        preferenceNote = `Honoring your requested framing (${wanted}).`;
      }
      intent = wanted;
    } else {
      preferenceNote = `Noted your requested framing (${wanted}); keeping ${intent} tied to the goal dimension.`;
    }
  } else if (preference.wantsCodingPractice === true) {
    preferenceNote = 'Honoring your request for coding practice with a coding problem.';
  }
  if (typeof preference.note === 'string' && preference.note.trim().length > 0) {
    const note = truncate(preference.note, 80);
    preferenceNote = preferenceNote ? `${preferenceNote} ("${note}")` : `Noted: "${note}".`;
  }

  const decision: PlanningDecision = {
    intent,
    purpose: assessment.purpose,
    purposeReasons: assessment.reasons,
    evidenceIds: assessment.evidenceIds,
    uncertaintyNote: assessment.uncertaintyNote,
    preferenceNote,
  };

  // Bounded adaptive sequence: every step serves the same goal, but roles
  // adapt to the assessment — never a fixed THEORY → MCQ → PROBLEM ladder.
  const sequenceId = generateSequenceId();
  const take = Math.min(maxActivities, eligible.length);
  const plans: ActivityPlan[] = [];
  for (let position = 0; position < take; position++) {
    const candidate = eligible[position];
    if (!candidate) {
      continue;
    }
    // Follow-up roles: a diagnostic opening is followed by instructional
    // work, then transfer where a variant exists. An instructional opening
    // is followed by transfer/reinforcement. Single-activity plans keep
    // the assessed purpose/intent untouched.
    let stepPurpose: ActivityPurpose = assessment.purpose;
    let stepIntent: ActivityIntent = intent;
    if (take > 1) {
      if (position === 0) {
        stepPurpose = assessment.purpose;
        stepIntent = intent;
      } else if (position === 1) {
        stepPurpose = 'instructional';
        stepIntent = intent === 'reinforcement' ? 'reinforcement' : intent;
      } else {
        const transferCandidate = candidate.isTransferVariant ? candidate : null;
        stepPurpose = 'instructional';
        stepIntent = transferCandidate ? 'transfer-practice' : intent;
      }
    }
    const rationale = buildRationale({
      goal,
      candidate,
      intent: stepIntent,
      purpose: stepPurpose,
      position,
      sequenceLength: take,
      preferenceNote: position === 0 ? preferenceNote : null,
      uncertaintyNote: position === 0 ? assessment.uncertaintyNote : null,
      graph,
    });
    const evidenceIds =
      position === 0
        ? assessment.evidenceIds
        : assessment.evidenceIds.slice(0, Math.max(0, MAX_PLAN_EVIDENCE_IDS - 2));
    plans.push({
      planId: generatePlanId(),
      goalId: goal.goalId,
      goalTargetKey: goal.targetKey,
      activityKind: 'coding-problem',
      problemId: candidate.entry.problemId,
      problemTitle: candidate.entry.title,
      intent: stepIntent,
      purpose: stepPurpose,
      entityIds: [...candidate.overlap],
      dimension: goal.dimension,
      rationale,
      evidenceBasis: {
        evidenceIds,
        profileUpdatedAt: inputs.profile?.updatedAt ?? now,
        ontologyVersion: graph.ontologyVersion,
        aggregatorVersion: inputs.profile?.aggregatorVersion ?? 'unknown',
        needId: goal.evidenceBasis.needId,
        goalSource: goal.source,
      },
      expectedEvidence: truncate(expectedEvidenceProse(goal.dimension, candidate.overlap), MAX_PLAN_TEXT_CHARS),
      expectedEvidenceTypes: expectedEvidenceTypesFor(goal.dimension),
      createdAt: now,
      updatedAt: now,
      status: 'planned',
      position,
      sequenceLength: take,
      sequenceId,
      linkedAttemptId: null,
      provenance: {
        ontologyVersion: graph.ontologyVersion,
        aggregatorVersion: inputs.profile?.aggregatorVersion ?? 'unknown',
        catalogSize: inputs.catalog.length,
      },
    });
  }
  return { status: 'planned', plans, ranked: eligible, decision };
}

/** Convenience wrapper: plan exactly one next activity. */
export function planNextActivity(
  inputs: Omit<PracticePlanningInputs, 'maxActivities'>,
): PlanningOutcome {
  return planTargetedPractice({ ...inputs, maxActivities: 1 });
}

export type GoalReassessmentSignal =
  | 'continue'
  | 'gather-more-evidence'
  | 'appears-addressed'
  | 'review-with-learner';

export interface GoalReassessment {
  signal: GoalReassessmentSignal;
  reason: string;
  newEvidenceIds: string[];
}

/**
 * Reassessment signal after practice: qualitative, evidence-grounded, and
 * deliberately threshold-free. Reads the goal baseline split
 * (`laterEvidenceForGoal`) plus current D state; creates no scores and
 * never declares mastery — `appears-addressed` only ever suggests the
 * learner review and decide.
 */
export function reassessGoalAfterPractice(args: {
  goal: LearningGoal;
  profile: LearnerProfile | null;
  evidence: LearnerEvidence[];
}): GoalReassessment {
  const { goal, profile, evidence } = args;
  const split = laterEvidenceForGoal(evidence, goal);
  if (split.after.length === 0) {
    return {
      signal: 'gather-more-evidence',
      reason: 'No goal-local evidence has arrived since activation — more practice is needed before any judgment.',
      newEvidenceIds: [],
    };
  }
  const newEvidenceIds = split.after.map((record) => record.evidenceId);
  if (!profile || goal.entityIds.length === 0) {
    return {
      signal: 'gather-more-evidence',
      reason: 'New evidence exists but the model basis is missing — keep gathering before reassessing.',
      newEvidenceIds,
    };
  }
  let addressed = 0;
  let struggling = 0;
  for (const entityId of goal.entityIds) {
    const state = getLearnerKnowledge(profile, entityId);
    if (!state) {
      continue;
    }
    if (
      (state.status === 'demonstrated' || state.status === 'strong') &&
      (state.statusConfidence === 'medium' || state.statusConfidence === 'high')
    ) {
      addressed += 1;
    } else if (state.status === 'struggling' || state.status === 'mixed') {
      struggling += 1;
    }
  }
  if (addressed > 0 && struggling === 0 && addressed === goal.entityIds.length) {
    return {
      signal: 'appears-addressed',
      reason:
        'Current D state shows sustained positive evidence on all goal targets — suggest the learner review and decide, not an automatic verdict.',
      newEvidenceIds,
    };
  }
  if (struggling > 0) {
    return {
      signal: 'continue',
      reason: `D state still flags difficulty on ${struggling} target(s) — continue the goal with a different activity.`,
      newEvidenceIds,
    };
  }
  return {
    signal: 'review-with-learner',
    reason: 'Evidence is mixed or still thin — best resolved by the learner, not by the planner.',
    newEvidenceIds,
  };
}

/** Evidence attributable to one plan: the linked attempt's records plus post-plan goal-local evidence. */
export function evidenceForPlan(evidence: LearnerEvidence[], plan: ActivityPlan): LearnerEvidence[] {
  return evidence
    .filter((record) => {
      const matchesAttempt = plan.linkedAttemptId !== null && record.attemptId === plan.linkedAttemptId;
      const matchesProblem =
        record.problemId === plan.problemId &&
        record.entityIds.some((id) => plan.entityIds.includes(id)) &&
        record.timestamp.localeCompare(plan.createdAt) >= 0;
      return matchesAttempt || matchesProblem;
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * Strict validation for AI-produced wording candidates (rationale /
 * expected-evidence text ONLY). Anything else — ids, statuses, intents,
 * purposes, provenance — is rejected, so candidate wording can never
 * smuggle durable planning state.
 */
export function validateActivityWordingCandidate(raw: unknown): ActivityWordingCandidate | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'rationale' && key !== 'expectedEvidence') {
      return null;
    }
  }
  const out: ActivityWordingCandidate = {};
  let claimed = false;
  if (record.rationale !== undefined) {
    if (typeof record.rationale !== 'string' || record.rationale.trim().length === 0) {
      return null;
    }
    out.rationale = truncate(record.rationale, MAX_PLAN_RATIONALE_CHARS);
    claimed = true;
  }
  if (record.expectedEvidence !== undefined) {
    if (typeof record.expectedEvidence !== 'string' || record.expectedEvidence.trim().length === 0) {
      return null;
    }
    out.expectedEvidence = truncate(record.expectedEvidence, MAX_PLAN_TEXT_CHARS);
    claimed = true;
  }
  return claimed ? out : null;
}

/**
 * Apply validated candidate wording onto a plan draft. Returns a new
 * record: display text may change, but identity, linkage, intent,
 * purpose, targets, evidence basis, lifecycle, and provenance are
 * preserved untouched.
 */
export function applyActivityWording(plan: ActivityPlan, candidate: ActivityWordingCandidate): ActivityPlan {
  return {
    ...plan,
    rationale: candidate.rationale ?? plan.rationale,
    expectedEvidence: candidate.expectedEvidence ?? plan.expectedEvidence,
    entityIds: [...plan.entityIds],
    expectedEvidenceTypes: [...plan.expectedEvidenceTypes],
    evidenceBasis: { ...plan.evidenceBasis, evidenceIds: [...plan.evidenceBasis.evidenceIds] },
    provenance: { ...plan.provenance },
  };
}

/** All goal-local evidence cited by a plan actually exists (traceability check for tests/callers). */
export function planEvidenceIsTraceable(plan: ActivityPlan, evidence: LearnerEvidence[]): boolean {
  const known = new Set(evidence.map((record) => record.evidenceId));
  return plan.evidenceBasis.evidenceIds.every((id) => known.has(id));
}

/** Recent goal-local evidence for planner context (bounded, chronological). */
export function recentGoalEvidence(
  evidence: LearnerEvidence[],
  goal: LearningGoal,
  limit: number,
): LearnerEvidence[] {
  const scoped = evidence.filter((record) => record.entityIds.some((id) => goal.entityIds.includes(id)));
  return scoped
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.evidenceId.localeCompare(a.evidenceId))
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
}
