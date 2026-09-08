import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import {
  finalizeClassification,
  validateClassificationPayload,
} from 'codesense/knowledge/classification';
import type { ProblemClassification } from 'codesense/knowledge/classification';
import { createManualProblem } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt } from 'codesense/attempts/attempt';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerProfile } from 'codesense/learner/learnerModel';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import { detectLearningNeeds } from 'codesense/goals/needDetection';
import { proposeGoalFromNeed, proposeGoalFromRequest } from 'codesense/goals/goalProposal';
import { acceptGoal, pauseGoal } from 'codesense/goals/goalLifecycle';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import { buildPracticeCatalog } from 'codesense/practice/activityCatalog';
import type { ActivityCatalogEntry } from 'codesense/practice/activityCatalog';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import { planNextActivity } from 'codesense/practice/activityPlanner';
import {
  cancelPlan,
  completePlan,
  linkAttemptToPlan,
  offerPlan,
  startPlan,
} from 'codesense/practice/activityLifecycle';
import {
  applyProgressWording,
  attributeActivityEvidence,
  evaluateActivityProgress,
  progressIdFor,
  validateProgressWordingCandidate,
} from 'codesense/progress/progressEvaluation';
import type { ActivityProgress } from 'codesense/progress/progressTypes';
import { LocalProgressStore, parseActivityProgress } from 'codesense/progress/progressStore';
import {
  buildPlannerDigest,
  citedEvidenceForGoal,
  getLatestProgressForGoal,
  getProgress,
  getProgressForPlan,
  getProgressHistoryForGoal,
  progressEvidenceIsTraceable,
  summarizeProgressForLearner,
} from 'codesense/progress/progressQueries';
import * as progressTypesModule from 'codesense/progress/progressTypes';
import * as progressEvaluationModule from 'codesense/progress/progressEvaluation';
import * as progressStoreModule from 'codesense/progress/progressStore';
import * as progressQueriesModule from 'codesense/progress/progressQueries';

/**
 * Phase F3 — Practice Evidence Feedback & Goal Reassessment.
 *
 * Behavioral properties: completed planned activities are attributed to
 * their goal through the explicit plan→attempt→D-evidence chain; new
 * evidence is interpreted relative to the immutable F1 baseline using
 * D's own accounting (never re-derived); signals are transparent and
 * non-numeric; one success/failure never settles a goal; the learner
 * owns lifecycle decisions; reprocessing is idempotent; frozen
 * C/D/E/F1/F2 behavior is untouched.
 */

const BFS = 'framework.bfs';
const DFS = 'framework.dfs';
const GRID_BFS = 'form.grid-bfs';
const STATE_BFS = 'form.state-space-bfs';
const MULTI_BFS = 'form.multisource-bfs';
const GRID_DFS = 'form.grid-dfs';
const GRAPH_TOPIC = 'topic.graphs';
const QUEUE_FIFO = 'concept.queue-fifo';
const CONNECTED = 'concept.connected-components';
const VISITED = 'tactic.visited-on-enqueue';
const DIST_PROP = 'pattern.distance-time-propagation';
const SHORTEST = 'pattern.shortest-path-unweighted';

const T0 = '2026-04-02T00:00:00.000Z';

function graph(): KnowledgeGraph {
  return getDefaultKnowledgeGraph();
}

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

let evidenceCounter = 0;

function ev(overrides: Record<string, unknown> & { timestamp: string }): LearnerEvidence {
  evidenceCounter += 1;
  const raw = {
    evidenceId: `ev_f3_${evidenceCounter}`,
    schemaVersion: 1,
    sessionId: 'ses_1',
    attemptId: 'att_1',
    problemId: 'prob_1',
    entityIds: [BFS],
    evidenceType: 'IMPLEMENTATION_SUCCESS',
    source: 'attempt-outcome',
    observation: 'Test observation of what happened.',
    interpretation: 'Test interpretation of what it means.',
    confidence: 'low',
    provenance: { source: 'attempt-outcome', sourceId: 'att_1' },
    ...overrides,
  };
  const parsed = validateLearnerEvidence(raw, { graph: graph() });
  if (!parsed) {
    throw new Error(`fixture evidence must validate: ${JSON.stringify(overrides)}`);
  }
  return parsed;
}

function rebuild(records: LearnerEvidence[], now = '2026-04-01T00:00:00.000Z'): LearnerProfile {
  return rebuildLearnerModel(records, graph(), { now });
}

// ---------------------------------------------------------------------------
// Problem + classification fixtures (existing problems, never generated)
// ---------------------------------------------------------------------------

function makeProblem(slug: string, title: string, difficulty: string | null): Problem {
  return createManualProblem(`https://leetcode.com/problems/${slug}/`, {
    title,
    statement: `Solve ${title} with BFS.`,
    difficulty: difficulty ?? undefined,
  });
}

function classify(
  problem: Problem,
  payload: Record<string, unknown>,
  at = '2026-03-15T00:00:00.000Z',
): ProblemClassification {
  const validated = validateClassificationPayload(payload, { graph: graph() });
  if (!validated.ok) {
    throw new Error(`fixture classification must validate: ${validated.detail}`);
  }
  return finalizeClassification(validated.value, {
    problemId: problem.problemId,
    ontologyVersion: graph().ontologyVersion,
    classifierVersion: '1',
    classifiedAt: at,
    problemSourceUrl: problem.provenance.sourceUrl,
    source: 'human-curated',
  });
}

function bfsIsolatingPayload(): Record<string, unknown> {
  return {
    topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
    concepts: [{ entityId: QUEUE_FIFO, confidence: 'high' }],
    frameworks: [{ entityId: BFS, confidence: 'high' }],
    forms: [{ entityId: GRID_BFS, confidence: 'high' }],
    patterns: [],
    variants: [],
    tactics: [{ entityId: VISITED, confidence: 'medium' }],
    prerequisites: [],
    solutionFamilies: [{ entityId: BFS, confidence: 'high' }],
    curriculumMappings: [],
    confidence: 'high',
  };
}

function bfsBroadHardPayload(): Record<string, unknown> {
  return {
    topics: [{ entityId: GRAPH_TOPIC, confidence: 'medium' }],
    concepts: [
      { entityId: QUEUE_FIFO, confidence: 'medium' },
      { entityId: CONNECTED, confidence: 'low' },
    ],
    frameworks: [
      { entityId: BFS, confidence: 'medium' },
      { entityId: DFS, confidence: 'low' },
    ],
    forms: [
      { entityId: GRID_BFS, confidence: 'medium' },
      { entityId: MULTI_BFS, confidence: 'low' },
    ],
    patterns: [
      { entityId: DIST_PROP, confidence: 'low' },
      { entityId: SHORTEST, confidence: 'low' },
    ],
    variants: [],
    tactics: [{ entityId: VISITED, confidence: 'low' }],
    prerequisites: [{ entityId: QUEUE_FIFO, confidence: 'low' }],
    solutionFamilies: [{ entityId: BFS, confidence: 'medium' }],
    curriculumMappings: [],
    confidence: 'medium',
  };
}

function bfsTransferPayload(): Record<string, unknown> {
  return {
    topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
    concepts: [{ entityId: QUEUE_FIFO, confidence: 'medium' }],
    frameworks: [{ entityId: BFS, confidence: 'high' }],
    forms: [{ entityId: STATE_BFS, confidence: 'high' }],
    patterns: [],
    variants: [],
    tactics: [{ entityId: VISITED, confidence: 'medium' }],
    prerequisites: [],
    solutionFamilies: [{ entityId: BFS, confidence: 'medium' }],
    curriculumMappings: [],
    confidence: 'high',
  };
}

function dfsUnrelatedPayload(): Record<string, unknown> {
  return {
    topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
    concepts: [{ entityId: CONNECTED, confidence: 'high' }],
    frameworks: [{ entityId: DFS, confidence: 'high' }],
    forms: [{ entityId: GRID_DFS, confidence: 'high' }],
    patterns: [],
    variants: [],
    tactics: [],
    prerequisites: [],
    solutionFamilies: [{ entityId: DFS, confidence: 'high' }],
    curriculumMappings: [],
    confidence: 'high',
  };
}

interface CatalogFixture {
  problems: Problem[];
  catalog: ActivityCatalogEntry[];
  isolating: Problem;
  broad: Problem;
  transfer: Problem;
  unrelated: Problem;
}

function buildCatalogFixture(): CatalogFixture {
  const pIsolating = makeProblem('rotting-oranges-f3', 'Rotting Oranges (BFS grid)', 'Easy');
  const pBroad = makeProblem('word-ladder-f3', 'Word Ladder (broad BFS)', 'Hard');
  const pTransfer = makeProblem('open-lock-f3', 'Open the Lock (state-space BFS)', 'Medium');
  const pUnrelated = makeProblem('clone-graph-f3', 'Clone Graph (DFS)', 'Medium');
  const problems = [pIsolating, pBroad, pTransfer, pUnrelated];
  const classifications = [
    classify(pIsolating, bfsIsolatingPayload()),
    classify(pBroad, bfsBroadHardPayload()),
    classify(pTransfer, bfsTransferPayload()),
    classify(pUnrelated, dfsUnrelatedPayload()),
  ];
  return {
    problems,
    catalog: buildPracticeCatalog(problems, classifications),
    isolating: pIsolating,
    broad: pBroad,
    transfer: pTransfer,
    unrelated: pUnrelated,
  };
}

// ---------------------------------------------------------------------------
// Goal + plan + attempt chain builders
// ---------------------------------------------------------------------------

/** Evidence-derived implementation goal from corroborated BFS difficulty, grounded on one problem. */
function strugglingGoalOn(
  problem: Problem,
  now = T0,
): { profile: LearnerProfile; evidence: LearnerEvidence[]; goal: LearningGoal } {
  const evidence = [1, 2, 3].map((n) =>
    ev({
      timestamp: `2026-03-0${n}T00:00:00.000Z`,
      evidenceId: `ev_f3_struggle_${problem.problemId}_${n}`,
      evidenceType: 'IMPLEMENTATION_FAILURE',
      confidence: 'medium',
      problemId: problem.problemId,
      attemptId: `att_base_${n}`,
      provenance: { source: 'attempt-outcome', sourceId: `att_base_${n}` },
    }),
  );
  const profile = rebuild(evidence);
  const needs = detectLearningNeeds({ profile, graph: graph(), now });
  const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
  if (!need) {
    throw new Error('fixture must yield a BFS implementation need');
  }
  const proposal = proposeGoalFromNeed(need, { graph: graph(), now });
  if (!proposal) {
    throw new Error('fixture proposal must build');
  }
  return { profile, evidence, goal: acceptGoal(proposal, { profile, now }) };
}

function learnerRequestedGoalOn(
  profile: LearnerProfile,
  dimension: 'implementation' | 'transfer' = 'implementation',
  now = T0,
): LearningGoal {
  const proposal = proposeGoalFromRequest(
    { entityIds: [BFS], dimension, learnerStatement: 'I want to get better at BFS.' },
    { graph: graph(), profile, now },
  );
  if (!proposal) {
    throw new Error('fixture learner-requested proposal must build');
  }
  return acceptGoal(proposal, { profile, now });
}

/** Plan one activity via the frozen F2 planner and surface it (offered). */
function plannedOffered(
  goal: LearningGoal,
  profile: LearnerProfile,
  evidence: LearnerEvidence[],
  catalog: ActivityCatalogEntry[],
  attempts: Attempt[],
  priorPlans: ActivityPlan[],
  now: string,
): ActivityPlan {
  const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts, priorPlans, now });
  if (outcome.status !== 'planned') {
    throw new Error(`fixture planning must succeed: ${outcome.reason}`);
  }
  return offerPlan(outcome.plans[0]!, now);
}

function completedAttempt(
  problemId: string,
  state: 'Got AC Independently' | 'Got AC with Help' | 'Got WA' | 'Got Stuck' | 'Abandoned / Continue Later',
  startedAt: string,
  completedAt: string,
  attemptId: string,
): Attempt {
  const attempt = createAttempt({ attemptId, problemId, sessionId: 'ses_1', startedAt });
  transitionAttemptState(attempt, state, 'learner', { timestamp: completedAt });
  completeAttempt(attempt, completedAt);
  return attempt;
}

/** Hand-built D records mirroring exactly what the frozen feeds emit for an attempt outcome. */
function attemptOutcomeEvidence(args: {
  attemptId: string;
  problemId: string;
  problemTitle: string;
  timestamp: string;
  evidenceId: string;
  evidenceType: 'IMPLEMENTATION_SUCCESS' | 'IMPLEMENTATION_FAILURE' | 'INDEPENDENT_SUCCESS' | 'HELP_REQUIRED' | 'TRANSFER_SUCCESS' | 'CONCEPTUAL_CONFUSION' | 'DEBUGGING_FAILURE' | 'RECURRING_MISTAKE';
  confidence?: 'low' | 'medium' | 'high';
  helpLevel?: 'none' | 'hint' | 'explanation' | 'solution' | 'unknown';
  mistakeCategory?: string;
  dimension?: 'implementation' | 'recognition' | 'conceptual' | 'debugging';
}): LearnerEvidence {
  return ev({
    timestamp: args.timestamp,
    evidenceId: args.evidenceId,
    attemptId: args.attemptId,
    problemId: args.problemId,
    entityIds: [BFS],
    evidenceType: args.evidenceType,
    confidence: args.confidence ?? 'low',
    source: 'attempt-outcome',
    observation: `Attempt on "${args.problemTitle}" ended (fixture outcome).`,
    interpretation: 'Fixture interpretation mirroring the frozen feed wording.',
    provenance: { source: 'attempt-outcome', sourceId: args.attemptId },
    ...(args.helpLevel !== undefined ? { helpLevel: args.helpLevel } : {}),
    ...(args.mistakeCategory !== undefined
      ? { mistakeCategory: args.mistakeCategory, dimension: args.dimension ?? 'implementation', source: 'mistake-report', provenance: { source: 'mistake-report', sourceId: null } }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// A. Basic attribution
// ---------------------------------------------------------------------------

describe('Phase F3 basic attribution (plan → attempt → D evidence → goal)', () => {
  function chain() {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    expect(plan.problemId).to.equal(fixture.isolating.problemId);
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_chain_1',
    );
    const linked = linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z');
    const started = startPlan(linked, '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_chain_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_chain_ind', evidenceType: 'INDEPENDENT_SUCCESS',
        confidence: 'medium', helpLevel: 'none',
      }),
    ];
    const all = [...evidence, ...fresh];
    return { fixture, goal, plan: started, attempt, fresh, all, profile: rebuild(all, '2026-04-04T00:00:01.000Z') };
  }

  it('completed planned activity links to the correct goal', () => {
    const { goal, plan, attempt, all, profile } = chain();
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.goalId).to.equal(goal.goalId);
    expect(outcome.progress.planId).to.equal(plan.planId);
    expect(outcome.progress.linkedAttemptId).to.equal(attempt.attemptId);
    expect(outcome.progress.goalTargetKey).to.equal(goal.targetKey);
  });

  it('resulting D evidence is found and cited', () => {
    const { plan, all, profile, goal, attempt } = chain();
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.activityEvidenceIds).to.include('ev_f3_chain_impl');
    expect(outcome.progress.activityEvidenceIds).to.include('ev_f3_chain_ind');
    expect(progressEvidenceIsTraceable(outcome.progress, all)).to.be.true;
  });

  it('relevant evidence is selected via D accounting (not type guessing)', () => {
    const { plan, all, profile, goal, attempt } = chain();
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // IMPLEMENTATION_SUCCESS is counted by D in the implementation lists → positive for the goal dimension.
    expect(outcome.progress.positiveNewIds).to.include('ev_f3_chain_impl');
    expect(outcome.progress.negativeNewIds).to.deep.equal([]);
    expect(outcome.progress.progressSignal).to.equal('IMPROVING');
  });

  it('unrelated evidence is excluded from activity attribution', () => {
    const { fixture, goal, plan, attempt, fresh, all, profile } = chain();
    const otherAttempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T11:00:00.000Z', '2026-04-04T00:00:02.000Z', 'att_f3_other_1',
    );
    const otherRecords = [
      attemptOutcomeEvidence({
        attemptId: otherAttempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:02.000Z', evidenceId: 'ev_f3_other_impl', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const unrelatedEntity = ev({
      timestamp: '2026-04-04T00:00:03.000Z', evidenceId: 'ev_f3_unrelated', entityIds: ['framework.dfs'],
      evidenceType: 'IMPLEMENTATION_FAILURE', attemptId: attempt.attemptId, problemId: plan.problemId,
      provenance: { source: 'attempt-outcome', sourceId: attempt.attemptId },
    });
    const extended = [...all, ...otherRecords, unrelatedEntity];
    const attributed = attributeActivityEvidence(extended, plan, '2026-04-05T00:00:00.000Z');
    const strongIds = attributed.strong.map((r) => r.evidenceId);
    // Another attempt's records are never attributed here, even on the same problem.
    expect(strongIds).to.not.include('ev_f3_other_impl');
    expect(strongIds).to.include('ev_f3_chain_impl');
    // A same-attempt record on an off-goal entity IS the activity's product
    // (honest attribution follows the attempt chain), but it must never
    // count as goal-facet evidence.
    expect(strongIds).to.include('ev_f3_unrelated');
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: extended, profile: rebuild(extended), graph: graph(),
      priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.positiveNewIds).to.not.include('ev_f3_unrelated');
    expect(outcome.progress.negativeNewIds).to.not.include('ev_f3_unrelated');
    expect(outcome.progress.positiveNewIds).to.not.include('ev_f3_other_impl');
    expect(outcome.progress.progressSignal).to.equal('IMPROVING');
    void fixture;
    void fresh;
    void profile;
  });
});

// ---------------------------------------------------------------------------
// B. Baseline comparison
// ---------------------------------------------------------------------------

describe('Phase F3 baseline comparison (immutable anchor, honest movement)', () => {
  function struggleChain() {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_base_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    return { fixture, goal, plan: linked, attempt, evidence };
  }

  it('baseline remains unchanged by evaluation', () => {
    const { goal, plan, attempt, evidence } = struggleChain();
    const before = JSON.stringify(goal);
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_base_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(JSON.stringify(goal)).to.equal(before);
    expect(goal.progressBaseline).to.not.be.null;
  });

  it('new evidence is separated from baseline evidence', () => {
    const { goal, plan, attempt, evidence } = struggleChain();
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_sep_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // Baseline IDs never leak into the "new" set; the fresh record does.
    for (const id of goal.progressBaseline!.evidenceIds) {
      expect(outcome.progress.positiveNewIds).to.not.include(id);
      expect(outcome.progress.negativeNewIds).to.not.include(id);
    }
    expect(outcome.progress.positiveNewIds).to.include('ev_f3_sep_impl');
    expect(outcome.progress.goalRelevantNewIds).to.include('ev_f3_sep_impl');
  });

  it('improvement can be represented without declaring mastery', () => {
    const { goal, plan, attempt, evidence } = struggleChain();
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_imp_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('IMPROVING');
    expect(outcome.progress.reassessment).to.equal('continue');
    // One success is data, not achievement: the goal is untouched and no review is claimed.
    expect(outcome.progress.reassessment).to.not.equal('sufficient-evidence-for-review');
    expect(goal.status).to.equal('active');
  });

  it('continued struggle can be represented without failing the goal', () => {
    const { goal, plan, attempt, evidence } = struggleChain();
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_str_impl', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('STILL_STRUGGLING');
    expect(outcome.progress.reassessment).to.equal('continue');
    expect(outcome.progress.negativeNewIds).to.include('ev_f3_str_impl');
    expect(goal.status).to.equal('active');
  });

  it('mixed evidence can be represented with uncertainty preserved', () => {
    const { goal, plan, attempt, evidence } = struggleChain();
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_mix_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_mix_mist', evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium', mistakeCategory: 'off-by-one', dimension: 'implementation',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('MIXED_SIGNAL');
    expect(outcome.progress.reassessment).to.equal('gather-more-evidence');
    expect(outcome.progress.positiveNewIds).to.include('ev_f3_mix_impl');
    expect(outcome.progress.negativeNewIds).to.include('ev_f3_mix_mist');
  });
});

// ---------------------------------------------------------------------------
// C. Independence vs help
// ---------------------------------------------------------------------------

describe('Phase F3 independent vs helped success (D help semantics reused)', () => {
  function implChain() {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    return { fixture, goal, plan, evidence };
  }

  it('independent success is distinct from helped success', () => {
    const { goal, plan, evidence } = implChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_indep_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_indep_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_indep_ind', evidenceType: 'INDEPENDENT_SUCCESS',
        confidence: 'medium', helpLevel: 'none',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.independence.independent).to.be.true;
    expect(outcome.progress.independence.helped).to.be.false;
    expect(outcome.progress.independence.independentEvidenceIds).to.include('ev_f3_indep_ind');
  });

  it('helped success does not falsely establish independence', () => {
    const { goal, plan, evidence } = implChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got AC with Help', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_help_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_help_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_help_req', evidenceType: 'HELP_REQUIRED',
        confidence: 'low', helpLevel: 'hint',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // Implementation evidence is still positive (shared credit), but independence is explicitly not established.
    expect(outcome.progress.positiveNewIds).to.include('ev_f3_help_impl');
    expect(outcome.progress.independence.independent).to.be.false;
    expect(outcome.progress.independence.helped).to.be.true;
    expect(outcome.progress.independence.helpLevels).to.include('hint');
    expect(outcome.progress.explanation).to.contain('independence is not established');
  });

  it('explanation-backed help is quoted with D levels, never re-scored', () => {
    const { goal, plan, evidence } = implChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got AC with Help', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_expl_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_expl_req', evidenceType: 'HELP_REQUIRED',
        confidence: 'medium', helpLevel: 'explanation',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.independence.helpLevels).to.deep.equal(['explanation']);
    expect(outcome.progress.explanation).to.contain('explanation');
  });
});

// ---------------------------------------------------------------------------
// D. Diagnostic activities
// ---------------------------------------------------------------------------

describe('Phase F3 diagnostic interpretation (what did we learn?)', () => {
  function debuggingDiagnosticChain() {
    const fixture = buildCatalogFixture();
    // Ambiguous low-confidence history → debugging need → diagnostic plan.
    const base = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_f3_amb_1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low', problemId: fixture.isolating.problemId, attemptId: 'att_amb_1', provenance: { source: 'attempt-outcome', sourceId: 'att_amb_1' } }),
      ev({ timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_f3_amb_2', evidenceType: 'DEBUGGING_FAILURE', confidence: 'low', problemId: fixture.isolating.problemId, attemptId: 'att_amb_2', provenance: { source: 'attempt-outcome', sourceId: 'att_amb_2' } }),
      ev({ timestamp: '2026-03-03T00:00:01.000Z', evidenceId: 'ev_f3_amb_3', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', problemId: fixture.isolating.problemId, attemptId: 'att_amb_3', provenance: { source: 'attempt-outcome', sourceId: 'att_amb_3' } }),
    ];
    const profile = rebuild(base);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: T0 });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'debugging');
    if (!need) {
      throw new Error('fixture must yield a BFS debugging need');
    }
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: T0 });
    if (!proposal) {
      throw new Error('fixture proposal must build');
    }
    const goal = acceptGoal(proposal, { profile, now: T0 });
    const plan = plannedOffered(goal, profile, base, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    expect(plan.purpose).to.equal('diagnostic');
    return { fixture, goal, plan, evidence: base };
  }

  it('diagnostic activity can produce uncertainty-reduced', () => {
    const { goal, plan, evidence } = debuggingDiagnosticChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_diag_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_diag_dbg', evidenceType: 'DEBUGGING_FAILURE',
      }),
    ];
    // Debugging failure is single-valence new evidence against an uncertain baseline.
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('UNCERTAINTY_REDUCED');
    expect(outcome.progress.reassessment).to.equal('continue');
  });

  it('diagnostic success does not become instructional mastery', () => {
    const fixture = buildCatalogFixture();
    const single = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_f3_d1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'high', problemId: fixture.isolating.problemId, attemptId: 'att_d1', provenance: { source: 'attempt-outcome', sourceId: 'att_d1' } }),
    ];
    const profile = rebuild(single);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: T0 });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    if (!need) {
      throw new Error('fixture must yield a BFS implementation need');
    }
    const goal = acceptGoal(proposeGoalFromNeed(need, { graph: graph(), now: T0 })!, { profile, now: T0 });
    const plan = plannedOffered(goal, profile, single, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    expect(plan.purpose).to.equal('diagnostic');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_diag_2',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_diag_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...single, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // One diagnostic success informs; it never reviews, let alone achieves.
    expect(outcome.progress.progressSignal).to.equal('UNCERTAINTY_REDUCED');
    expect(outcome.progress.reassessment).to.equal('continue');
    expect(goal.status).to.equal('active');
  });

  it('diagnostic evidence can redirect what F2 should target next', () => {
    const { goal, plan, evidence } = debuggingDiagnosticChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got Stuck', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_diag_3',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    // The probe surfaces conceptual confusion — nothing new in debugging.
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_diag_con', evidenceType: 'CONCEPTUAL_CONFUSION',
        confidence: 'medium',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('UNCERTAINTY_REDUCED');
    // The live question sits in another facet: flag the goal direction for learner review.
    expect(outcome.progress.reassessment).to.equal('review-goal');
    expect(outcome.progress.explanation).to.contain('conceptual');
  });
});

// ---------------------------------------------------------------------------
// E. Instructional activities
// ---------------------------------------------------------------------------

describe('Phase F3 instructional interpretation (is the capability improving?)', () => {
  it('targeted successful activity can produce improvement', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    expect(plan.purpose).to.equal('instructional');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_ins_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_ins_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_ins_ind', evidenceType: 'INDEPENDENT_SUCCESS',
        confidence: 'medium', helpLevel: 'none',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('IMPROVING');
    expect(outcome.progress.reassessment).to.equal('continue');
  });

  it('repeated failure produces a continued-struggle signal, then a direction review', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    let prior: ActivityProgress[] = [];
    let priorPlans: ActivityPlan[] = [];
    let attempts: Attempt[] = [];
    let all = [...evidence];
    const planDays = ['03', '06', '09'];
    const endDays = ['04', '07', '10'];
    const evalDays = ['05', '08', '11'];
    let lastOutcome: { status: string } | null = null;
    for (let i = 0; i < 3; i++) {
      const planDay = planDays[i]!;
      const endDay = endDays[i]!;
      const evalDay = evalDays[i]!;
      const currentProfile = rebuild(all, `2026-04-${planDay}T00:00:00.000Z`);
      const plan = plannedOffered(goal, currentProfile, all, fixture.catalog, attempts, priorPlans, `2026-04-${planDay}T00:00:00.000Z`);
      const attempt = completedAttempt(
        plan.problemId, 'Got WA', `2026-04-${planDay}T10:00:00.000Z`, `2026-04-${endDay}T00:00:00.000Z`, `att_f3_rep_${i}`,
      );
      const linked = startPlan(linkAttemptToPlan(plan, attempt, `2026-04-${planDay}T10:00:00.000Z`), `2026-04-${planDay}T10:00:00.000Z`);
      const done = completePlan(linked, `2026-04-${endDay}T00:00:00.000Z`);
      const fresh = [
        attemptOutcomeEvidence({
          attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
          timestamp: `2026-04-${endDay}T00:00:00.000Z`, evidenceId: `ev_f3_rep_${i}`, evidenceType: 'IMPLEMENTATION_FAILURE',
        }),
      ];
      all = [...all, ...fresh];
      const outcome = evaluateActivityProgress({
        goal, plan: done, attempt, evidence: all, profile: rebuild(all), graph: graph(),
        priorProgress: prior, now: `2026-04-${evalDay}T00:00:00.000Z`,
      });
      if (outcome.status !== 'evaluated' || !outcome.updated) {
        throw new Error('expected fresh evaluation');
      }
      expect(outcome.progress.progressSignal).to.equal('STILL_STRUGGLING');
      // First two rounds continue targeted practice; the third questions the direction.
      expect(outcome.progress.reassessment).to.equal(i < 2 ? 'continue' : 'review-goal');
      prior = [...prior, outcome.progress];
      priorPlans = [...priorPlans, done];
      attempts = [...attempts, attempt];
      lastOutcome = outcome;
    }
    expect(lastOutcome).to.not.be.null;
    expect(prior).to.have.lengthOf(3);
    // History is chronological and auditable — earlier interpretations are kept.
    expect(prior.map((p) => p.progressSignal)).to.deep.equal(['STILL_STRUGGLING', 'STILL_STRUGGLING', 'STILL_STRUGGLING']);
  });

  it('one instructional success never achieves the goal', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_one_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_one_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'high',
      }),
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:01.000Z', evidenceId: 'ev_f3_one_ind', evidenceType: 'INDEPENDENT_SUCCESS',
        confidence: 'high', helpLevel: 'none',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // Even high-confidence independent success on the exact target is one data point.
    expect(outcome.progress.progressSignal).to.not.equal('SUFFICIENT_EVIDENCE_FOR_REVIEW');
    expect(outcome.progress.reassessment).to.not.equal('sufficient-evidence-for-review');
    expect(goal.status).to.equal('active');
  });
});

// ---------------------------------------------------------------------------
// F. Transfer activities
// ---------------------------------------------------------------------------

describe('Phase F3 transfer interpretation (context preserved)', () => {
  it('transfer evidence stays distinguishable from familiar-form success', () => {
    const fixture = buildCatalogFixture();
    const base = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_f3_tr_0', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'medium', problemId: fixture.isolating.problemId, attemptId: 'att_tr_0', provenance: { source: 'attempt-outcome', sourceId: 'att_tr_0' } }),
    ];
    const profile = rebuild(base);
    const goal = learnerRequestedGoalOn(profile, 'transfer');
    const plan = plannedOffered(goal, profile, base, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    expect(plan.intent).to.equal('transfer-practice');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_tr_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_tr_ok', evidenceType: 'TRANSFER_SUCCESS',
        confidence: 'medium',
      }),
    ];
    const all = [...base, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.positiveNewIds).to.include('ev_f3_tr_ok');
    expect(outcome.progress.activity.intent).to.equal('transfer-practice');
    expect(outcome.progress.explanation).to.contain('less-familiar');
    expect(outcome.progress.explanation).to.not.contain('mastery');
  });
});

// ---------------------------------------------------------------------------
// G. Contradiction across activities
// ---------------------------------------------------------------------------

describe('Phase F3 contradiction (history kept, D aggregation respected)', () => {
  it('positive then negative leaves a mixed trajectory, erasing nothing', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    // Activity 1: success.
    const plan1 = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt1 = completedAttempt(
      plan1.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_pn_1',
    );
    const linked1 = startPlan(linkAttemptToPlan(plan1, attempt1, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh1 = [
      attemptOutcomeEvidence({
        attemptId: attempt1.attemptId, problemId: plan1.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_pn_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const after1 = [...evidence, ...fresh1];
    const out1 = evaluateActivityProgress({
      goal, plan: completePlan(linked1, '2026-04-04T00:00:00.000Z'), attempt: attempt1, evidence: after1,
      profile: rebuild(after1), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (out1.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(out1.progress.progressSignal).to.equal('IMPROVING');
    // Activity 2 (different problem): failure.
    const plan2 = plannedOffered(
      goal, rebuild(after1), after1, fixture.catalog, [attempt1],
      [completePlan(linked1, '2026-04-04T00:00:00.000Z')], '2026-04-06T00:00:00.000Z',
    );
    expect(plan2.problemId).to.not.equal(plan1.problemId);
    const attempt2 = completedAttempt(
      plan2.problemId, 'Got WA', '2026-04-06T10:00:00.000Z', '2026-04-07T00:00:00.000Z', 'att_f3_pn_2',
    );
    const linked2 = startPlan(linkAttemptToPlan(plan2, attempt2, '2026-04-06T10:00:00.000Z'), '2026-04-06T10:00:00.000Z');
    const fresh2 = [
      attemptOutcomeEvidence({
        attemptId: attempt2.attemptId, problemId: plan2.problemId, problemTitle: plan2.problemTitle ?? plan2.problemId,
        timestamp: '2026-04-07T00:00:00.000Z', evidenceId: 'ev_f3_pn_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const after2 = [...after1, ...fresh2];
    const out2 = evaluateActivityProgress({
      goal, plan: completePlan(linked2, '2026-04-07T00:00:00.000Z'), attempt: attempt2, evidence: after2,
      profile: rebuild(after2), graph: graph(), priorProgress: [out1.progress], now: '2026-04-08T00:00:00.000Z',
    });
    if (out2.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(out2.progress.progressSignal).to.equal('STILL_STRUGGLING');
    // The earlier improvement is still on record — the failure revises, never erases.
    const history = getProgressHistoryForGoal([out1.progress, out2.progress], goal.goalId);
    expect(history.map((p) => p.progressSignal)).to.deep.equal(['IMPROVING', 'STILL_STRUGGLING']);
  });

  it('negative then positive respects D standing (no premature review)', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan1 = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt1 = completedAttempt(
      plan1.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_np_1',
    );
    const linked1 = startPlan(linkAttemptToPlan(plan1, attempt1, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh1 = [
      attemptOutcomeEvidence({
        attemptId: attempt1.attemptId, problemId: plan1.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_np_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const after1 = [...evidence, ...fresh1];
    const out1 = evaluateActivityProgress({
      goal, plan: completePlan(linked1, '2026-04-04T00:00:00.000Z'), attempt: attempt1, evidence: after1,
      profile: rebuild(after1), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (out1.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(out1.progress.progressSignal).to.equal('STILL_STRUGGLING');
    const plan2 = plannedOffered(
      goal, rebuild(after1), after1, fixture.catalog, [attempt1],
      [completePlan(linked1, '2026-04-04T00:00:00.000Z')], '2026-04-06T00:00:00.000Z',
    );
    const attempt2 = completedAttempt(
      plan2.problemId, 'Got AC Independently', '2026-04-06T10:00:00.000Z', '2026-04-07T00:00:00.000Z', 'att_f3_np_2',
    );
    const linked2 = startPlan(linkAttemptToPlan(plan2, attempt2, '2026-04-06T10:00:00.000Z'), '2026-04-06T10:00:00.000Z');
    const fresh2 = [
      attemptOutcomeEvidence({
        attemptId: attempt2.attemptId, problemId: plan2.problemId, problemTitle: plan2.problemTitle ?? plan2.problemId,
        timestamp: '2026-04-07T00:00:00.000Z', evidenceId: 'ev_f3_np_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const after2 = [...after1, ...fresh2];
    const out2 = evaluateActivityProgress({
      goal, plan: completePlan(linked2, '2026-04-07T00:00:00.000Z'), attempt: attempt2, evidence: after2,
      profile: rebuild(after2), graph: graph(), priorProgress: [out1.progress], now: '2026-04-08T00:00:00.000Z',
    });
    if (out2.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // One later success against corroborated difficulty is improvement-in-progress, not resolution.
    expect(out2.progress.progressSignal).to.equal('IMPROVING');
    expect(out2.progress.reassessment).to.equal('continue');
  });
});

// ---------------------------------------------------------------------------
// H. Repeated positives → review-grade signal (D semantics, never auto-achieve)
// ---------------------------------------------------------------------------

describe('Phase F3 repeated evidence (review is earned, achievement is owned)', () => {
  it('repeated positive-only activities can justify learner review', () => {
    const fixture = buildCatalogFixture();
    // Single high-confidence failure: corroborated enough for a need, thin enough to move.
    const base = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_f3_suf_0', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'high', problemId: fixture.isolating.problemId, attemptId: 'att_suf_0', provenance: { source: 'attempt-outcome', sourceId: 'att_suf_0' } }),
    ];
    const baseProfile = rebuild(base);
    const needs = detectLearningNeeds({ profile: baseProfile, graph: graph(), now: T0 });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    if (!need) {
      throw new Error('fixture must yield a BFS implementation need');
    }
    const goal = acceptGoal(proposeGoalFromNeed(need, { graph: graph(), now: T0 })!, { profile: baseProfile, now: T0 });
    let prior: ActivityProgress[] = [];
    let priorPlans: ActivityPlan[] = [];
    let attempts: Attempt[] = [];
    let all = [...base];
    const planDays = ['03', '06'];
    const endDays = ['04', '07'];
    const evalDays = ['05', '08'];
    const signals: string[] = [];
    for (let i = 0; i < 2; i++) {
      const planDay = planDays[i]!;
      const endDay = endDays[i]!;
      const evalDay = evalDays[i]!;
      const currentProfile = rebuild(all, `2026-04-${planDay}T00:00:00.000Z`);
      const plan = plannedOffered(goal, currentProfile, all, fixture.catalog, attempts, priorPlans, `2026-04-${planDay}T00:00:00.000Z`);
      const attempt = completedAttempt(
        plan.problemId, 'Got AC Independently', `2026-04-${planDay}T10:00:00.000Z`, `2026-04-${endDay}T00:00:00.000Z`, `att_f3_suf_${i + 1}`,
      );
      const linked = startPlan(linkAttemptToPlan(plan, attempt, `2026-04-${planDay}T10:00:00.000Z`), `2026-04-${planDay}T10:00:00.000Z`);
      const done = completePlan(linked, `2026-04-${endDay}T00:00:00.000Z`);
      const fresh = [
        attemptOutcomeEvidence({
          attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
          timestamp: `2026-04-${endDay}T00:00:00.000Z`, evidenceId: `ev_f3_suf_impl_${i}`, evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'high',
        }),
        attemptOutcomeEvidence({
          attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
          timestamp: `2026-04-${endDay}T00:00:01.000Z`, evidenceId: `ev_f3_suf_ind_${i}`, evidenceType: 'INDEPENDENT_SUCCESS', confidence: 'high', helpLevel: 'none',
        }),
      ];
      all = [...all, ...fresh];
      const outcome = evaluateActivityProgress({
        goal, plan: done, attempt, evidence: all, profile: rebuild(all), graph: graph(),
        priorProgress: prior, now: `2026-04-${evalDay}T00:00:00.000Z`,
      });
      if (outcome.status !== 'evaluated' || !outcome.updated) {
        throw new Error('expected fresh evaluation');
      }
      signals.push(outcome.progress.progressSignal);
      prior = [...prior, outcome.progress];
      priorPlans = [...priorPlans, done];
      attempts = [...attempts, attempt];
      if (i === 1) {
        expect(outcome.progress.progressSignal).to.equal('SUFFICIENT_EVIDENCE_FOR_REVIEW');
        expect(outcome.progress.reassessment).to.equal('sufficient-evidence-for-review');
        // Review-grade is still not achievement: the goal stays learner-owned.
        expect(goal.status).to.equal('active');
      }
    }
    expect(signals[0]).to.not.equal('SUFFICIENT_EVIDENCE_FOR_REVIEW');
  });
});

// ---------------------------------------------------------------------------
// I. Learner-requested goals
// ---------------------------------------------------------------------------

describe('Phase F3 learner-requested goals (origin preserved, nothing fabricated)', () => {
  it('success completes practice without inventing a weakness backstory', () => {
    const fixture = buildCatalogFixture();
    const profile = rebuild([]);
    const goal = learnerRequestedGoalOn(profile, 'implementation');
    expect(goal.evidenceBasis.needId).to.be.null;
    const plan = plannedOffered(goal, profile, [], fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_lr_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_lr_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: fresh, profile: rebuild(fresh), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.goalSource).to.equal('learner-requested');
    expect(outcome.progress.explanation).to.contain('practiced');
    expect(outcome.progress.explanation).to.not.contain('weakness');
    expect(outcome.progress.explanation).to.not.contain('struggl');
  });

  it('first-practice difficulty is reported as early evidence, not a weakness verdict', () => {
    const fixture = buildCatalogFixture();
    const profile = rebuild([]);
    const goal = learnerRequestedGoalOn(profile, 'implementation');
    const plan = plannedOffered(goal, profile, [], fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_lr_2',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_lr_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: fresh, profile: rebuild(fresh), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // Early difficulty is added honestly — never upgraded into a struggle verdict.
    expect(outcome.progress.progressSignal).to.equal('EVIDENCE_ADDED');
    expect(outcome.progress.reassessment).to.equal('gather-more-evidence');
    expect(outcome.progress.explanation).to.not.contain('weakness');
  });

  it('no evidence is fabricated for learner-requested progress', () => {
    const fixture = buildCatalogFixture();
    const profile = rebuild([]);
    const goal = learnerRequestedGoalOn(profile, 'implementation');
    const plan = plannedOffered(goal, profile, [], fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_lr_3',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_lr_ok3', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: fresh, profile: rebuild(fresh), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(progressEvidenceIsTraceable(outcome.progress, fresh)).to.be.true;
    expect(outcome.progress.evidenceFingerprint).to.contain('ev_f3_lr_ok3');
  });
});

// ---------------------------------------------------------------------------
// J. Regression signal (strong baseline meets new failure)
// ---------------------------------------------------------------------------

describe('Phase F3 regression (one failure is not lost skill)', () => {
  it('new failure on demonstrated capability gathers evidence instead of verdicts', () => {
    const fixture = buildCatalogFixture();
    const base = [1, 2, 3].map((n) =>
      ev({
        timestamp: `2026-03-0${n}T00:00:00.000Z`,
        evidenceId: `ev_f3_reg_base_${n}`,
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: `prob_reg_${n}`,
        attemptId: `att_reg_${n}`,
        provenance: { source: 'attempt-outcome', sourceId: `att_reg_${n}` },
      }),
    );
    const profile = rebuild(base);
    const goal = learnerRequestedGoalOn(profile, 'implementation');
    const plan = plannedOffered(goal, profile, base, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_reg_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: plan.problemTitle ?? plan.problemId,
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_reg_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...base, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('REGRESSION_SIGNAL');
    expect(outcome.progress.reassessment).to.equal('gather-more-evidence');
    expect(goal.status).to.equal('active');
  });
});

// ---------------------------------------------------------------------------
// K. Traceability of the full chain
// ---------------------------------------------------------------------------

describe('Phase F3 traceability (goal → plan → attempt → evidence → signal)', () => {
  it('every link of the chain is inspectable from the record', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_trace_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_trace_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const progress = outcome.progress;
    // goal → plan → attempt → evidence → signal, each step holding the previous step's ID.
    expect(plan.goalId).to.equal(goal.goalId);
    expect(progress.planId).to.equal(plan.planId);
    expect(linked.linkedAttemptId).to.equal(attempt.attemptId);
    expect(progress.linkedAttemptId).to.equal(attempt.attemptId);
    expect(progress.activityEvidenceIds).to.include('ev_f3_trace_impl');
    expect(progressEvidenceIsTraceable(progress, all)).to.be.true;
    expect(progress.explanation).to.contain('ev_f3_trace_impl');
    expect(progress.explanation).to.contain(BFS);
    expect(progress.baselineRef.capturedAt).to.equal(goal.progressBaseline!.capturedAt);
    expect(citedEvidenceForGoal([progress], goal.goalId)).to.include('ev_f3_trace_impl');
  });
});

// ---------------------------------------------------------------------------
// L. Idempotency
// ---------------------------------------------------------------------------

describe('Phase F3 idempotency (stable identity, visible revisions)', () => {
  function evaluatedOnce() {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_idem_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_idem_impl', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const args = {
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [] as ActivityProgress[],
      now: '2026-04-05T00:00:00.000Z',
    };
    return { goal, plan: linked, attempt, all, args };
  }

  it('same activity processed twice does not duplicate progress', () => {
    const { args } = evaluatedOnce();
    const first = evaluateActivityProgress(args);
    if (first.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(first.updated).to.be.true;
    const second = evaluateActivityProgress({ ...args, priorProgress: [first.progress] });
    if (second.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(second.updated).to.be.false;
    expect(second.progress.progressId).to.equal(first.progress.progressId);
    expect(second.progress.evaluationCount).to.equal(first.progress.evaluationCount);
    expect(second.progress).to.deep.equal(first.progress);
  });

  it('deterministic identity across independent evaluations', () => {
    const { goal, plan } = evaluatedOnce();
    expect(progressIdFor(goal.goalId, plan.planId, plan.linkedAttemptId)).to.equal(
      progressIdFor(goal.goalId, plan.planId, plan.linkedAttemptId),
    );
  });

  it('late-arriving evidence revises visibly instead of duplicating', () => {
    const { goal, plan, attempt, all, args } = evaluatedOnce();
    const first = evaluateActivityProgress(args);
    if (first.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const late = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T12:00:00.000Z', evidenceId: 'ev_f3_idem_late', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const extended = [...all, ...late];
    const second = evaluateActivityProgress({
      ...args,
      evidence: extended,
      profile: rebuild(extended),
      priorProgress: [first.progress],
      now: '2026-04-06T00:00:00.000Z',
    });
    if (second.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(second.updated).to.be.true;
    expect(second.progress.progressId).to.equal(first.progress.progressId);
    expect(second.progress.evaluationCount).to.equal(2);
    expect(second.progress.signalHistory).to.have.lengthOf(1);
    expect(second.progress.signalHistory[0]!.evidenceFingerprint).to.equal(first.progress.evidenceFingerprint);
    expect(second.progress.positiveNewIds).to.include('ev_f3_idem_late');
  });

  it('store upserts share one row per activity', async () => {
    const dir = tmpDir('codesense-test-f3-idempotent');
    clean(dir);
    try {
      const { args } = evaluatedOnce();
      const first = evaluateActivityProgress(args);
      if (first.status !== 'evaluated') {
        throw new Error('expected evaluated');
      }
      const store = new LocalProgressStore(dir);
      await store.upsertProgress(first.progress);
      await store.upsertProgress(first.progress);
      expect(await store.listProgress()).to.have.lengthOf(1);
      expect(await store.getProgress(first.progress.progressId)).to.deep.equal(first.progress);
      expect(await store.getProgress('prog_missing')).to.be.null;
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// M. Lifecycle edge cases
// ---------------------------------------------------------------------------

describe('Phase F3 lifecycle (conservative, fail-open, never crashing)', () => {
  function offeredChain() {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    return { fixture, goal, plan, profile, evidence };
  }

  it('incomplete attempt is pending, never evaluated', () => {
    const { goal, plan, profile, evidence } = offeredChain();
    const attempt = createAttempt({ attemptId: 'att_f3_open_1', problemId: plan.problemId, sessionId: 'ses_1', startedAt: '2026-04-03T10:00:00.000Z' });
    transitionAttemptState(attempt, 'Got Stuck', 'learner', { timestamp: '2026-04-03T11:00:00.000Z' });
    const linked = linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z');
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(outcome.status).to.equal('pending');
    if (outcome.status !== 'pending') {
      throw new Error('expected pending');
    }
    expect(outcome.kind).to.equal('pending-evidence');
  });

  it('in-flight plan without a linked attempt is pending', () => {
    const { goal, plan, profile, evidence } = offeredChain();
    const outcome = evaluateActivityProgress({
      goal, plan, attempt: null, evidence, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(outcome.status).to.equal('pending');
  });

  it('terminal plan without a linked attempt is orphaned, not guessed', () => {
    const { goal, plan, profile, evidence } = offeredChain();
    const done = completePlan(startPlan(plan, '2026-04-03T10:00:00.000Z'), '2026-04-04T00:00:00.000Z');
    const outcome = evaluateActivityProgress({
      goal, plan: done, attempt: null, evidence, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(outcome.status).to.equal('not-evaluable');
    if (outcome.status !== 'not-evaluable') {
      throw new Error('expected not-evaluable');
    }
    expect(outcome.kind).to.equal('orphaned');
  });

  it('completed attempt on an unclassified problem yields honest no-evidence progress', () => {
    const { goal, plan, profile, evidence } = offeredChain();
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_noev_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    // D synchronization produced nothing attributable (e.g. unclassified problem anchors nothing).
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    expect(outcome.progress.progressSignal).to.equal('NO_NEW_EVIDENCE');
    expect(outcome.progress.reassessment).to.equal('gather-more-evidence');
  });

  it('orphaned and mismatched inputs never crash', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const otherGoal = { ...goal, goalId: 'goal_elsewhere', status: 'dismissed' as const };
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_mis_1',
    );
    // Plan serves a different goal.
    const mismatched = evaluateActivityProgress({
      goal: otherGoal, plan, attempt, evidence, profile, graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(mismatched.status).to.equal('not-evaluable');
    // Dismissed goals are history, not interpretable progress.
    const dismissed = evaluateActivityProgress({
      goal: otherGoal,
      plan: { ...plan, goalId: otherGoal.goalId },
      attempt,
      evidence,
      profile,
      graph: graph(),
      priorProgress: [],
      now: '2026-04-05T00:00:00.000Z',
    });
    expect(dismissed.status).to.equal('not-evaluable');
    if (dismissed.status !== 'not-evaluable') {
      throw new Error('expected not-evaluable');
    }
    expect(dismissed.kind).to.equal('orphaned');
    void fixture;
  });

  it('paused goals remain attributable; withdrawn plans are out of scope', () => {
    const { goal, plan, profile, evidence } = offeredChain();
    const paused = pauseGoal(goal, '2026-04-04T12:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_pause_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_pause_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...evidence, ...fresh];
    const onPaused = evaluateActivityProgress({
      goal: paused, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(onPaused.status).to.equal('evaluated');
    // Withdrawn suggestions are not interpreted, even with evidence present.
    const withdrawn = evaluateActivityProgress({
      goal, plan: cancelPlan(linked, '2026-04-04T00:00:01.000Z'), attempt, evidence: all, profile: rebuild(all),
      graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    expect(withdrawn.status).to.equal('not-evaluable');
  });
});

// ---------------------------------------------------------------------------
// N. F2 integration seam (F3 informs, F2 decides)
// ---------------------------------------------------------------------------

describe('Phase F3 → F2 seam (progress available, planning untouched)', () => {
  it('digest compacts history for the next planning call', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_seam_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_seam_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: completePlan(linked, '2026-04-04T00:00:00.000Z'), attempt, evidence: all, profile: rebuild(all),
      graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const digest = buildPlannerDigest([outcome.progress], goal.goalId);
    expect(digest.goalId).to.equal(goal.goalId);
    expect(digest.latestSignal).to.equal('STILL_STRUGGLING');
    expect(digest.latestReassessment).to.equal('continue');
    expect(digest.evaluatedActivities).to.equal(1);
    expect(digest.strugglingActivities).to.equal(1);
    expect(digest.positiveActivities).to.equal(0);
    expect(digest.latestEvidenceIds).to.include('ev_f3_seam_bad');
    expect(getLatestProgressForGoal([outcome.progress], goal.goalId)?.progressId).to.equal(outcome.progress.progressId);
    expect(getLatestProgressForGoal([outcome.progress], 'goal_missing')).to.be.null;
  });

  it('F3 history plus F2 novelty steer the next activity without F3 deciding it', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_loop_1',
    );
    const done = completePlan(
      startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z'),
      '2026-04-04T00:00:00.000Z',
    );
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_loop_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...evidence, ...fresh];
    const evaluated = evaluateActivityProgress({
      goal, plan: done, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (evaluated.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    // The loop closes through frozen F2 inputs only: the completed plan is
    // now "used", so F2 novelty prefers a different activity; F3's digest
    // explains why (struggle continues) without choosing anything.
    const next = planNextActivity({
      goal, graph: graph(), profile: rebuild(all), evidence: all, catalog: fixture.catalog,
      attempts: [attempt], priorPlans: [done], now: '2026-04-06T00:00:00.000Z',
    });
    expect(next.status).to.equal('planned');
    if (next.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(next.plans[0]!.problemId).to.not.equal(done.problemId);
    const digest = buildPlannerDigest([evaluated.progress], goal.goalId);
    expect(digest.latestSignal).to.equal('STILL_STRUGGLING');
  });

  it('learner-facing progress answers what happened and what is suggested', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_face_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_face_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const summary = summarizeProgressForLearner(outcome.progress, { goalDescription: goal.description });
    expect(summary.signal).to.equal('IMPROVING');
    expect(summary.summary.length).to.be.greaterThan(0);
    expect(summary.nextStep.length).to.be.greaterThan(0);
    expect(summary.goalDescription).to.be.a('string');
    expect(getProgress([outcome.progress], outcome.progress.progressId)?.progressId).to.equal(outcome.progress.progressId);
    expect(getProgressForPlan([outcome.progress], plan.planId)).to.have.lengthOf(1);
    expect(getProgressHistoryForGoal([outcome.progress], goal.goalId)).to.have.lengthOf(1);
  });
});

// ---------------------------------------------------------------------------
// O. No second learner model + scope guard + store
// ---------------------------------------------------------------------------

describe('Phase F3 no second learner model', () => {
  it('progress records carry signals and references only', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got AC Independently', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_nomodel_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_nomodel_ok', evidenceType: 'IMPLEMENTATION_SUCCESS',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const serialized = JSON.stringify(outcome.progress);
    for (const forbidden of [
      'positiveWeight',
      'negativeWeight',
      'supportingEvidenceIds',
      'contradictingEvidenceIds',
      'trajectory',
      'recurringMistakes',
      'totalEvidenceCount',
      'statusConfidence',
      'practiceScore',
      'mastery',
      'proficiency',
      'capabilityScore',
      'knowledgeStates',
      'copiedLearnerModel',
    ]) {
      expect(serialized, `progress must not carry learner-model field ${forbidden}`).to.not.contain(forbidden);
    }
  });
});

describe('Phase F3 scope guard (no planning, coaching, mastery, or generation surface)', () => {
  function exportedKeys(module: Record<string, unknown>): string[] {
    return Object.keys(module).sort();
  }

  it('exposes exactly the F3 progress surface (tripwire for scope creep)', () => {
    expect(exportedKeys(progressTypesModule)).to.deep.equal([
      'MAX_PROGRESS_EVIDENCE_IDS',
      'MAX_PROGRESS_EXPLANATION_CHARS',
      'MAX_PROGRESS_HISTORY_ENTRIES',
      'MAX_PROGRESS_TEXT_CHARS',
      'PROGRESS_ID_PREFIX',
      'PROGRESS_PENDING_KINDS',
      'PROGRESS_SCHEMA_VERSION',
      'PROGRESS_SIGNALS',
      'REASSESSMENT_SIGNALS',
      'isKnownProgressPendingKind',
      'isKnownProgressSignal',
      'isKnownReassessmentSignal',
    ]);
    expect(exportedKeys(progressEvaluationModule)).to.deep.equal([
      'applyProgressWording',
      'attributeActivityEvidence',
      'evaluateActivityProgress',
      'progressIdFor',
      'validateProgressWordingCandidate',
    ]);
    expect(exportedKeys(progressStoreModule)).to.deep.equal(['LocalProgressStore', 'parseActivityProgress']);
    expect(exportedKeys(progressQueriesModule)).to.deep.equal([
      'MAX_PROGRESS_DIGEST_CHARS',
      'buildPlannerDigest',
      'citedEvidenceForGoal',
      'getLatestProgressForGoal',
      'getProgress',
      'getProgressForPlan',
      'getProgressHistoryForGoal',
      'progressEvidenceIsTraceable',
      'summarizeProgressForLearner',
    ]);
  });

  it('wording candidates cannot smuggle state', () => {
    expect(validateProgressWordingCandidate(null)).to.be.null;
    expect(validateProgressWordingCandidate({})).to.be.null;
    expect(validateProgressWordingCandidate({ explanation: '   ' })).to.be.null;
    expect(validateProgressWordingCandidate({ explanation: 'ok', progressSignal: 'IMPROVING' })).to.be.null;
    expect(validateProgressWordingCandidate({ explanation: 'ok', planId: 'plan_x' })).to.be.null;
    const candidate = validateProgressWordingCandidate({ explanation: 'Clearer learner wording.' });
    expect(candidate).to.not.be.null;
  });

  it('applies wording without touching identity, linkage, or signals', () => {
    const fixture = buildCatalogFixture();
    const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
    const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
    const attempt = completedAttempt(
      plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_word_1',
    );
    const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
    const fresh = [
      attemptOutcomeEvidence({
        attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
        timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_word_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
      }),
    ];
    const all = [...evidence, ...fresh];
    const outcome = evaluateActivityProgress({
      goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
    });
    if (outcome.status !== 'evaluated') {
      throw new Error('expected evaluated');
    }
    const before = JSON.stringify(outcome.progress);
    const worded = applyProgressWording(outcome.progress, { explanation: 'AI phrasing here.' });
    expect(worded.explanation).to.equal('AI phrasing here.');
    expect(worded.progressId).to.equal(outcome.progress.progressId);
    expect(worded.progressSignal).to.equal(outcome.progress.progressSignal);
    expect(worded.reassessment).to.equal(outcome.progress.reassessment);
    expect(worded.activityEvidenceIds).to.deep.equal(outcome.progress.activityEvidenceIds);
    expect(JSON.stringify(outcome.progress)).to.equal(before);
  });
});

describe('Phase F3 store (durable, validated, lenient reads)', () => {
  it('persists and reloads progress across store instances', async () => {
    const dir = tmpDir('codesense-test-f3-store');
    clean(dir);
    try {
      const fixture = buildCatalogFixture();
      const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
      const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
      const attempt = completedAttempt(
        plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_store_1',
      );
      const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
      const fresh = [
        attemptOutcomeEvidence({
          attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
          timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_store_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
        }),
      ];
      const all = [...evidence, ...fresh];
      const outcome = evaluateActivityProgress({
        goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
      });
      if (outcome.status !== 'evaluated') {
        throw new Error('expected evaluated');
      }
      const writer = new LocalProgressStore(dir);
      await writer.upsertProgress(outcome.progress);
      const reader = new LocalProgressStore(dir);
      expect(await reader.getProgress(outcome.progress.progressId)).to.deep.equal(outcome.progress);
      expect(await reader.listProgress()).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('skips corrupt rows and refuses malformed writes', async () => {
    const dir = tmpDir('codesense-test-f3-corrupt');
    clean(dir);
    try {
      const fixture = buildCatalogFixture();
      const { profile, evidence, goal } = strugglingGoalOn(fixture.isolating);
      const plan = plannedOffered(goal, profile, evidence, fixture.catalog, [], [], '2026-04-03T00:00:00.000Z');
      const attempt = completedAttempt(
        plan.problemId, 'Got WA', '2026-04-03T10:00:00.000Z', '2026-04-04T00:00:00.000Z', 'att_f3_corrupt_1',
      );
      const linked = startPlan(linkAttemptToPlan(plan, attempt, '2026-04-03T10:00:00.000Z'), '2026-04-03T10:00:00.000Z');
      const fresh = [
        attemptOutcomeEvidence({
          attemptId: attempt.attemptId, problemId: plan.problemId, problemTitle: 'Rotting Oranges',
          timestamp: '2026-04-04T00:00:00.000Z', evidenceId: 'ev_f3_corrupt_bad', evidenceType: 'IMPLEMENTATION_FAILURE',
        }),
      ];
      const all = [...evidence, ...fresh];
      const outcome = evaluateActivityProgress({
        goal, plan: linked, attempt, evidence: all, profile: rebuild(all), graph: graph(), priorProgress: [], now: '2026-04-05T00:00:00.000Z',
      });
      if (outcome.status !== 'evaluated') {
        throw new Error('expected evaluated');
      }
      const store = new LocalProgressStore(dir);
      await store.upsertProgress(outcome.progress);
      const file = path.join(dir, '.codesense', 'goal-progress.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
      onDisk.push({ garbage: true }, null, 'nope');
      fs.writeFileSync(file, JSON.stringify(onDisk));
      expect(await store.listProgress()).to.have.lengthOf(1);
      let threw = false;
      try {
        await store.upsertProgress({ nope: true } as unknown as ActivityProgress);
      } catch {
        threw = true;
      }
      expect(threw, 'malformed progress must not persist').to.be.true;
      expect(parseActivityProgress(null)).to.be.null;
      expect(parseActivityProgress({})).to.be.null;
    } finally {
      clean(dir);
    }
  });
});
