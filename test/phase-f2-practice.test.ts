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
import { acceptGoal } from 'codesense/goals/goalLifecycle';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import {
  buildPracticeCatalog,
  catalogEntryFromProblem,
  candidateEntityOverlap,
  candidateIsolatesTarget,
} from 'codesense/practice/activityCatalog';
import type { ActivityCatalogEntry } from 'codesense/practice/activityCatalog';
import {
  applyActivityWording,
  evidenceForPlan,
  planEvidenceIsTraceable,
  planNextActivity,
  planTargetedPractice,
  reassessGoalAfterPractice,
  validateActivityWordingCandidate,
} from 'codesense/practice/activityPlanner';
import {
  cancelPlan,
  completePlan,
  linkAttemptToPlan,
  offerPlan,
  skipPlan,
  startPlan,
  transitionPlanStatus,
} from 'codesense/practice/activityLifecycle';
import { LocalActivityPlanStore, parseActivityPlan } from 'codesense/practice/activityStore';
import {
  getActivePlansForGoal,
  getLatestPlanForGoal,
  getPlan,
  getPlansByStatus,
  getPlansForGoal,
  summarizePlanForLearner,
  summarizePlansForGoal,
} from 'codesense/practice/activityQueries';
import * as activityTypesModule from 'codesense/practice/activityTypes';
import * as activityCatalogModule from 'codesense/practice/activityCatalog';
import * as activityPlannerModule from 'codesense/practice/activityPlanner';
import * as activityLifecycleModule from 'codesense/practice/activityLifecycle';
import * as activityStoreModule from 'codesense/practice/activityStore';
import * as activityQueriesModule from 'codesense/practice/activityQueries';

/**
 * Phase F2 — Targeted Practice Planning & Activity Selection.
 *
 * Behavioral properties: active goals yield relevant, explainable,
 * diagnostic-or-instructional plans over EXISTING problems; no invented
 * evidence/entities/problems; repetition avoided without justification;
 * difficulty never decisive; learner intent honored without corrupting
 * evidence; bounded adaptive sequences; lifecycle validated; no second
 * learner model; frozen C/D/E/F1 untouched.
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

const NOW = '2026-04-02T00:00:00.000Z';

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
    evidenceId: `ev_f2_${evidenceCounter}`,
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

function profileWith(records: LearnerEvidence[], now = '2026-04-01T00:00:00.000Z'): LearnerProfile {
  return rebuildLearnerModel(records, graph(), { now });
}

function strugglingImplementationProfile(): { profile: LearnerProfile; evidence: LearnerEvidence[] } {
  const evidence = [1, 2, 3].map((n) =>
    ev({
      timestamp: `2026-03-0${n}T00:00:00.000Z`,
      evidenceId: `ev_f2_struggle_${n}`,
      evidenceType: 'IMPLEMENTATION_FAILURE',
      confidence: 'medium',
    }),
  );
  return { profile: profileWith(evidence), evidence };
}

function ambiguousProfile(): { profile: LearnerProfile; evidence: LearnerEvidence[] } {
  const evidence = [
    ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_f2_amb_1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
    ev({ timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_f2_amb_2', evidenceType: 'DEBUGGING_FAILURE', confidence: 'low' }),
    ev({ timestamp: '2026-03-03T00:00:01.000Z', evidenceId: 'ev_f2_amb_3', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
  ];
  return { profile: profileWith(evidence), evidence };
}

function recognitionWeakProfile(): LearnerProfile {
  const records: LearnerEvidence[] = [];
  for (let n = 1; n <= 3; n++) {
    records.push(
      ev({
        timestamp: `2026-03-0${n}T00:00:00.000Z`,
        evidenceId: `ev_f2_ra_${n}`,
        evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium',
        source: 'mistake-report',
        provenance: { source: 'mistake-report', sourceId: null },
        mistakeCategory: 'missed-problem-form',
        dimension: 'recognition',
        problemId: `prob_ra_${n}`,
      }),
    );
  }
  for (let n = 4; n <= 6; n++) {
    records.push(
      ev({
        timestamp: `2026-03-0${n}T00:00:00.000Z`,
        evidenceId: `ev_f2_ra_${n}`,
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: `prob_ra_${n}`,
      }),
    );
  }
  return profileWith(records);
}

// ---------------------------------------------------------------------------
// Problem + classification fixtures (existing problems, never generated)
// ---------------------------------------------------------------------------

let problemCounter = 0;

function makeProblem(slug: string, title: string, difficulty: string | null): Problem {
  problemCounter += 1;
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
  classifications: ProblemClassification[];
  catalog: ActivityCatalogEntry[];
  isolating: ActivityCatalogEntry;
  broadHard: ActivityCatalogEntry;
  transfer: ActivityCatalogEntry;
  unrelated: ActivityCatalogEntry;
}

function buildCatalogFixture(): CatalogFixture {
  const pIsolating = makeProblem('rotting-oranges-f2', 'Rotting Oranges (BFS grid)', 'Easy');
  const pBroad = makeProblem('word-ladder-f2', 'Word Ladder (broad BFS)', 'Hard');
  const pTransfer = makeProblem('open-lock-f2', 'Open the Lock (state-space BFS)', 'Medium');
  const pUnrelated = makeProblem('clone-graph-f2', 'Clone Graph (DFS)', 'Medium');
  const cIsolating = classify(pIsolating, bfsIsolatingPayload());
  const cBroad = classify(pBroad, bfsBroadHardPayload());
  const cTransfer = classify(pTransfer, bfsTransferPayload());
  const cUnrelated = classify(pUnrelated, dfsUnrelatedPayload());
  const problems = [pIsolating, pBroad, pTransfer, pUnrelated];
  const classifications = [cIsolating, cBroad, cTransfer, cUnrelated];
  const catalog = buildPracticeCatalog(problems, classifications);
  const byId = new Map(catalog.map((e) => [e.problemId, e] as const));
  return {
    problems,
    classifications,
    catalog,
    isolating: byId.get(pIsolating.problemId)!,
    broadHard: byId.get(pBroad.problemId)!,
    transfer: byId.get(pTransfer.problemId)!,
    unrelated: byId.get(pUnrelated.problemId)!,
  };
}

function activeImplementationGoal(now = NOW): { profile: LearnerProfile; evidence: LearnerEvidence[]; goal: LearningGoal } {
  const { profile, evidence } = strugglingImplementationProfile();
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

function activeLearnerRequestedGoal(now = NOW): { profile: LearnerProfile; goal: LearningGoal } {
  const { profile } = strugglingImplementationProfile();
  const proposal = proposeGoalFromRequest(
    { entityIds: [BFS], dimension: 'implementation', learnerStatement: 'I want to get better at dynamic programming.' },
    { graph: graph(), profile, now },
  );
  if (!proposal) {
    throw new Error('fixture learner-requested proposal must build');
  }
  return { profile, goal: acceptGoal(proposal, { profile, now }) };
}

function completedAttemptFor(problem: Problem, state: 'Got AC Independently' | 'Got WA' = 'Got AC Independently'): Attempt {
  const attempt = createAttempt({ problemId: problem.problemId, sessionId: 'ses_1' });
  transitionAttemptState(attempt, state, 'learner');
  completeAttempt(attempt);
  return attempt;
}

// ---------------------------------------------------------------------------
// A. Goal → activity
// ---------------------------------------------------------------------------

describe('Phase F2 goal → activity (active goals only, existing problems)', () => {
  it('active evidence-derived goal produces a relevant targeted activity', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const plan = outcome.plans[0]!;
    expect(plan.goalId).to.equal(goal.goalId);
    expect(plan.goalTargetKey).to.equal(goal.targetKey);
    expect(plan.dimension).to.equal('implementation');
    expect(plan.intent).to.equal('implementation-practice');
    expect(plan.entityIds).to.deep.equal([BFS]);
    expect(plan.activityKind).to.equal('coding-problem');
    expect(plan.status).to.equal('planned');
    expect(plan.rationale.length).to.be.greaterThan(0);
    expect(plan.expectedEvidenceTypes).to.include('IMPLEMENTATION_SUCCESS');
    expect(planEvidenceIsTraceable(plan, evidence)).to.be.true;
  });

  it('active learner-requested goal produces relevant activity without inventing evidence', () => {
    const { profile, goal } = activeLearnerRequestedGoal();
    const { catalog } = buildCatalogFixture();
    expect(goal.source).to.equal('learner-requested');
    expect(goal.evidenceBasis.evidenceIds).to.deep.equal([]);
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const plan = outcome.plans[0]!;
    expect(plan.evidenceBasis.evidenceIds).to.deep.equal([]);
    expect(plan.evidenceBasis.goalSource).to.equal('learner-requested');
    expect(plan.evidenceBasis.needId).to.be.null;
    expect(plan.rationale).to.contain('You asked');
    expect(plan.rationale).to.not.contain('weak at');
    expect(plan.rationale).to.not.contain('Repeated difficulty');
  });

  it('no active goal does not produce targeted activity', () => {
    const { profile, evidence } = strugglingImplementationProfile();
    const { catalog } = buildCatalogFixture();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation')!;
    const proposed = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    expect(proposed.status).to.equal('proposed');
    const outcome = planNextActivity({ goal: proposed, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('no-plan');
    if (outcome.status !== 'no-plan') {
      throw new Error('expected no-plan');
    }
    expect(outcome.reason).to.contain('not active');
  });

  it('goal without target entities yields no plan instead of inventing a topic', () => {
    const { profile } = strugglingImplementationProfile();
    const { catalog } = buildCatalogFixture();
    const proposal = proposeGoalFromRequest(
      { dimension: 'implementation', learnerStatement: 'Just get better generally.' },
      { graph: graph(), profile, now: NOW },
    )!;
    const active = acceptGoal(proposal, { profile, now: NOW });
    expect(active.entityIds).to.deep.equal([]);
    const outcome = planNextActivity({ goal: active, graph: graph(), profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('no-plan');
  });
});

// ---------------------------------------------------------------------------
// B. Diagnostic vs instructional
// ---------------------------------------------------------------------------

describe('Phase F2 diagnostic vs instructional (uncertainty-honest)', () => {
  it('uncertain learner state produces a diagnostic activity', () => {
    const { profile, evidence } = ambiguousProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(needs.length).to.be.greaterThan(0);
    const need = needs[0]!;
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    const goal = acceptGoal(proposal, { profile, now: NOW });
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.decision.purpose).to.equal('diagnostic');
    expect(outcome.plans[0]!.purpose).to.equal('diagnostic');
    expect(outcome.decision.uncertaintyNote).to.be.a('string');
    expect(outcome.decision.purposeReasons.length).to.be.greaterThan(0);
    expect(outcome.plans[0]!.rationale).to.contain('check whether');
  });

  it('corroborated weakness produces instructional activity', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.decision.purpose).to.equal('instructional');
    expect(outcome.plans[0]!.purpose).to.equal('instructional');
    expect(outcome.decision.uncertaintyNote).to.be.null;
    expect(outcome.plans[0]!.rationale).to.contain('targeted');
  });

  it('learner-requested practice with no evidence is instructional, not a fake diagnosis', () => {
    const { profile, goal } = activeLearnerRequestedGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.purpose).to.equal('instructional');
  });
});

// ---------------------------------------------------------------------------
// C. Dimension targeting
// ---------------------------------------------------------------------------

describe('Phase F2 dimension targeting (recognition ≠ implementation)', () => {
  function activeGoalForDimension(dimension: 'recognition' | 'implementation'): { profile: LearnerProfile; evidence: LearnerEvidence[]; goal: LearningGoal } {
    const profile = dimension === 'recognition' ? recognitionWeakProfile() : strugglingImplementationProfile().profile;
    const evidence: LearnerEvidence[] = [];
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === dimension);
    if (!need) {
      throw new Error(`fixture must yield a BFS ${dimension} need`);
    }
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    return { profile, evidence, goal: acceptGoal(proposal, { profile, now: NOW }) };
  }

  it('recognition weakness yields recognition practice', () => {
    const { profile, goal } = activeGoalForDimension('recognition');
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.intent).to.equal('recognition-practice');
    expect(outcome.plans[0]!.expectedEvidenceTypes).to.deep.equal(['RECOGNITION']);
  });

  it('implementation weakness yields implementation practice', () => {
    const { profile, evidence, goal } = activeGoalForDimension('implementation');
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.intent).to.equal('implementation-practice');
    expect(outcome.plans[0]!.expectedEvidenceTypes).to.include('IMPLEMENTATION_SUCCESS');
  });

  it('different dimensions produce materially different plans', () => {
    const rec = activeGoalForDimension('recognition');
    const impl = activeGoalForDimension('implementation');
    const { catalog } = buildCatalogFixture();
    const outRec = planNextActivity({ goal: rec.goal, graph: graph(), profile: rec.profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW });
    const outImpl = planNextActivity({ goal: impl.goal, graph: graph(), profile: impl.profile, evidence: impl.evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outRec.status).to.equal('planned');
    expect(outImpl.status).to.equal('planned');
    if (outRec.status !== 'planned' || outImpl.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outRec.plans[0]!.intent).to.not.equal(outImpl.plans[0]!.intent);
    expect(outRec.plans[0]!.expectedEvidenceTypes).to.not.deep.equal(outImpl.plans[0]!.expectedEvidenceTypes);
    expect(outRec.plans[0]!.rationale).to.not.equal(outImpl.plans[0]!.rationale);
  });
});

// ---------------------------------------------------------------------------
// D. C integration
// ---------------------------------------------------------------------------

describe('Phase F2 C integration (canonical entities only)', () => {
  it('uses canonical C entity IDs and rejects invalid references', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    for (const id of outcome.plans[0]!.entityIds) {
      expect(graph().hasEntity(id), `unknown entity ${id}`).to.be.true;
    }
    expect(outcome.plans[0]!.entityIds.every((id) => goal.entityIds.includes(id))).to.be.true;
    const ghost: LearningGoal = { ...goal, entityIds: ['topic.lost-continent'] };
    const refused = planNextActivity({ goal: ghost, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(refused.status).to.equal('no-plan');
  });

  it('creates no duplicate knowledge taxonomy', () => {
    const serialized = JSON.stringify(activityTypesModule) + JSON.stringify(Object.keys(activityCatalogModule));
    for (const forbidden of ['ontologyCatalog', 'taxonomy', 'skillList', 'masteryLevels']) {
      expect(serialized).to.not.contain(forbidden);
    }
    const { catalog, isolating } = buildCatalogFixture();
    expect(isolating.entityIds.every((id) => graph().hasEntity(id))).to.be.true;
    expect(candidateEntityOverlap(isolating, [BFS])).to.deep.equal([BFS]);
    expect(candidateIsolatesTarget(isolating, [BFS])).to.be.true;
    void catalog;
  });

  it('unrelated problems never win on topic similarity alone', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog, unrelated } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.problemId).to.not.equal(unrelated.problemId);
  });
});

// ---------------------------------------------------------------------------
// E. Evidence traceability
// ---------------------------------------------------------------------------

describe('Phase F2 evidence traceability (no fabricated evidence)', () => {
  it('evidence basis cites real D/F1 references', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const plan = outcome.plans[0]!;
    expect(plan.evidenceBasis.evidenceIds.length).to.be.greaterThan(0);
    expect(planEvidenceIsTraceable(plan, evidence)).to.be.true;
    expect(plan.evidenceBasis.needId).to.equal(goal.evidenceBasis.needId);
    expect(plan.evidenceBasis.goalSource).to.equal('evidence-derived');
  });

  it('planner never mutates frozen inputs', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const before = JSON.stringify({ profile, evidence, goal, catalog });
    planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(JSON.stringify({ profile, evidence, goal, catalog })).to.equal(before);
  });
});

// ---------------------------------------------------------------------------
// F. Repetition
// ---------------------------------------------------------------------------

describe('Phase F2 repetition (novelty with justified retries)', () => {
  it('already-completed identical activity is not blindly selected again', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const fixture = buildCatalogFixture();
    const first = planNextActivity({ goal, graph: graph(), profile, evidence, catalog: fixture.catalog, attempts: [], priorPlans: [], now: NOW });
    expect(first.status).to.equal('planned');
    if (first.status !== 'planned') {
      throw new Error('expected planned');
    }
    const usedProblemId = first.plans[0]!.problemId;
    const usedProblem = fixture.problems.find((p) => p.problemId === usedProblemId)!;
    const attempts = [completedAttemptFor(usedProblem, 'Got AC Independently')];
    const priorPlans = [{ ...first.plans[0]!, status: 'completed' as const }];
    const second = planNextActivity({ goal, graph: graph(), profile, evidence, catalog: fixture.catalog, attempts, priorPlans, now: NOW });
    expect(second.status).to.equal('planned');
    if (second.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(second.plans[0]!.problemId).to.not.equal(usedProblemId);
  });

  it('justified repetition remains possible via explicit allow-list', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const single = makeProblem('solo-bfs-f2', 'Solo BFS', 'Easy');
    const singleClass = classify(single, bfsIsolatingPayload());
    const catalog = buildPracticeCatalog([single], [singleClass]);
    const first = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(first.status).to.equal('planned');
    if (first.status !== 'planned') {
      throw new Error('expected planned');
    }
    const priorPlans = [{ ...first.plans[0]!, status: 'completed' as const }];
    const attempts = [completedAttemptFor(single, 'Got WA')];
    const refused = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts, priorPlans, now: NOW });
    expect(refused.status).to.equal('no-plan');
    const retried = planNextActivity({
      goal, graph: graph(), profile, evidence, catalog, attempts, priorPlans, now: NOW,
      allowRepeatProblemIds: [single.problemId],
    });
    expect(retried.status).to.equal('planned');
    if (retried.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(retried.plans[0]!.problemId).to.equal(single.problemId);
  });

  it('active in-flight plans block duplicate offers', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const fixture = buildCatalogFixture();
    const first = planNextActivity({ goal, graph: graph(), profile, evidence, catalog: fixture.catalog, attempts: [], priorPlans: [], now: NOW });
    expect(first.status).to.equal('planned');
    if (first.status !== 'planned') {
      throw new Error('expected planned');
    }
    const inFlight = [{ ...first.plans[0]!, status: 'offered' as const }];
    const second = planNextActivity({ goal, graph: graph(), profile, evidence, catalog: fixture.catalog, attempts: [], priorPlans: inFlight, now: NOW });
    if (second.status === 'planned') {
      expect(second.plans[0]!.problemId).to.not.equal(first.plans[0]!.problemId);
    }
  });
});

// ---------------------------------------------------------------------------
// G. Difficulty
// ---------------------------------------------------------------------------

describe('Phase F2 difficulty (fit beats hardness)', () => {
  it('harder does not automatically win', () => {
    // Realistic history: the learner's failures happened on grid-BFS work,
    // so grid forms are familiar and state-space forms are transfer. The
    // isolating Easy problem must still beat the broad Hard problem on fit.
    const fixture = buildCatalogFixture();
    const { catalog, isolating, broadHard } = fixture;
    expect(isolating.difficulty).to.not.equal(broadHard.difficulty);
    const records = [1, 2, 3].map((n) =>
      ev({
        timestamp: `2026-03-0${n}T00:00:00.000Z`,
        evidenceId: `ev_f2_diff_${n}`,
        evidenceType: 'IMPLEMENTATION_FAILURE',
        confidence: 'medium',
        problemId: isolating.problemId,
      }),
    );
    const profile = profileWith(records);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    if (!need) {
      throw new Error('fixture must yield a BFS implementation need');
    }
    const goal = acceptGoal(proposeGoalFromNeed(need, { graph: graph(), now: NOW })!, { profile, now: NOW });
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence: records, catalog, attempts: [], priorPlans: [], now: NOW });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    // The isolating problem (Easy) must beat the broad Hard problem.
    expect(outcome.plans[0]!.problemId).to.equal(isolating.problemId);
    expect(outcome.plans[0]!.problemId).to.not.equal(broadHard.problemId);
    const ranked = outcome.ranked.find((c) => c.entry.problemId === broadHard.problemId);
    expect(ranked?.difficultyNote).to.contain('informational only');
  });
});

// ---------------------------------------------------------------------------
// H. Learner intent
// ---------------------------------------------------------------------------

describe('Phase F2 learner intent (preferences without corrupting evidence)', () => {
  it('learner-requested framing can influence selection', () => {
    const { profile, goal } = activeLearnerRequestedGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({
      goal, graph: graph(), profile, evidence: [], catalog, attempts: [], priorPlans: [], now: NOW,
      learnerPreference: { preferredIntent: 'transfer-practice', wantsCodingPractice: true },
    });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.intent).to.equal('transfer-practice');
    expect(outcome.decision.preferenceNote).to.be.a('string');
    expect(outcome.plans[0]!.evidenceBasis.evidenceIds).to.deep.equal([]);
  });

  it('incompatible framing is noted, not silently obeyed', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({
      goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW,
      learnerPreference: { preferredIntent: 'recognition-practice' },
    });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    // Goal dimension is implementation; recognition framing is incompatible.
    expect(outcome.plans[0]!.intent).to.equal('implementation-practice');
    expect(outcome.decision.preferenceNote).to.contain('keeping');
  });

  it('excluded problems are honored as hard filters', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog, isolating } = buildCatalogFixture();
    const outcome = planNextActivity({
      goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW,
      learnerPreference: { excludeProblemIds: [isolating.problemId] },
    });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.problemId).to.not.equal(isolating.problemId);
  });
});

// ---------------------------------------------------------------------------
// I. Sequences
// ---------------------------------------------------------------------------

describe('Phase F2 sequences (bounded, adaptive, never a fixed ladder)', () => {
  it('bounded multi-activity plans preserve order', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planTargetedPractice({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW, maxActivities: 3 });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans).to.have.lengthOf(3);
    expect(outcome.plans.map((p) => p.position)).to.deep.equal([0, 1, 2]);
    expect(outcome.plans.map((p) => p.sequenceLength)).to.deep.equal([3, 3, 3]);
    const sequences = new Set(outcome.plans.map((p) => p.sequenceId));
    expect(sequences.size).to.equal(1);
    const ids = outcome.plans.map((p) => p.problemId);
    expect(new Set(ids).size).to.equal(3);
    for (const plan of outcome.plans) {
      expect(plan.entityIds).to.include(BFS);
      expect(plan.dimension).to.equal('implementation');
    }
  });

  it('no universal sequence: different states open differently', () => {
    const impl = activeImplementationGoal();
    const amb = ambiguousProfile();
    const ambNeeds = detectLearningNeeds({ profile: amb.profile, graph: graph(), now: NOW });
    const ambGoal = acceptGoal(proposeGoalFromNeed(ambNeeds[0]!, { graph: graph(), now: NOW })!, { profile: amb.profile, now: NOW });
    const { catalog } = buildCatalogFixture();
    const outImpl = planTargetedPractice({ goal: impl.goal, graph: graph(), profile: impl.profile, evidence: impl.evidence, catalog, attempts: [], priorPlans: [], now: NOW, maxActivities: 2 });
    const outAmb = planTargetedPractice({ goal: ambGoal, graph: graph(), profile: amb.profile, evidence: amb.evidence, catalog, attempts: [], priorPlans: [], now: NOW, maxActivities: 2 });
    expect(outImpl.status).to.equal('planned');
    expect(outAmb.status).to.equal('planned');
    if (outImpl.status !== 'planned' || outAmb.status !== 'planned') {
      throw new Error('expected planned');
    }
    // Corroborated weakness opens instructional; uncertainty opens diagnostic.
    expect(outImpl.plans[0]!.purpose).to.equal('instructional');
    expect(outAmb.plans[0]!.purpose).to.equal('diagnostic');
  });

  it('diagnostic and instructional can coexist in one adaptive sequence', () => {
    const amb = ambiguousProfile();
    const ambNeeds = detectLearningNeeds({ profile: amb.profile, graph: graph(), now: NOW });
    const ambGoal = acceptGoal(proposeGoalFromNeed(ambNeeds[0]!, { graph: graph(), now: NOW })!, { profile: amb.profile, now: NOW });
    const { catalog } = buildCatalogFixture();
    const outcome = planTargetedPractice({ goal: ambGoal, graph: graph(), profile: amb.profile, evidence: amb.evidence, catalog, attempts: [], priorPlans: [], now: NOW, maxActivities: 2 });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    expect(outcome.plans[0]!.purpose).to.equal('diagnostic');
    expect(outcome.plans[1]!.purpose).to.equal('instructional');
  });
});

// ---------------------------------------------------------------------------
// J. Lifecycle
// ---------------------------------------------------------------------------

describe('Phase F2 lifecycle (plans are not attempts)', () => {
  function planned(): { plan: import('codesense/practice/activityTypes').ActivityPlan } {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    return { plan: outcome.plans[0]! };
  }

  it('walks the valid lifecycle', () => {
    const { plan } = planned();
    const offered = offerPlan(plan, '2026-04-03T00:00:00.000Z');
    expect(offered.status).to.equal('offered');
    const started = startPlan(offered, '2026-04-04T00:00:00.000Z');
    expect(started.status).to.equal('started');
    const done = completePlan(started, '2026-04-05T00:00:00.000Z');
    expect(done.status).to.equal('completed');
    expect(done.planId).to.equal(plan.planId);
    expect(done.goalId).to.equal(plan.goalId);
  });

  it('rejects invalid transitions loudly', () => {
    const { plan } = planned();
    expect(() => transitionPlanStatus(plan, 'completed', NOW)).to.throw(/Invalid activity plan transition/);
    expect(() => startPlan(plan, NOW)).to.throw(/Invalid activity plan transition/);
    const done = completePlan(startPlan(offerPlan(plan, NOW), NOW), NOW);
    expect(() => transitionPlanStatus(done, 'offered', NOW)).to.throw(/Invalid activity plan transition/);
    expect(() => skipPlan(done, NOW)).to.throw(/Invalid activity plan transition/);
    expect(() => cancelPlan(done, NOW)).to.throw(/Invalid activity plan transition/);
  });

  it('plan state never replaces attempt state', () => {
    const { plan } = planned();
    const fixture = buildCatalogFixture();
    const problem = fixture.problems.find((p) => p.problemId === plan.problemId)!;
    const attempt = createAttempt({ problemId: problem.problemId, sessionId: 'ses_1' });
    const before = JSON.stringify(attempt);
    const linked = linkAttemptToPlan(plan, attempt, NOW);
    expect(linked.linkedAttemptId).to.equal(attempt.attemptId);
    // The attempt itself is untouched (authoritative lifecycle lives there).
    expect(JSON.stringify(attempt)).to.equal(before);
    expect(linked.status).to.equal(plan.status);
    const other = createAttempt({ problemId: 'prob_other', sessionId: 'ses_1' });
    expect(() => linkAttemptToPlan(plan, other, NOW)).to.throw(/Cannot link attempt/);
  });

  it('persists and reloads plans across store instances', async () => {
    const dir = tmpDir('codesense-test-f2-lifecycle');
    clean(dir);
    try {
      const { plan } = planned();
      const writer = new LocalActivityPlanStore(dir);
      await writer.upsertPlan(plan);
      const reader = new LocalActivityPlanStore(dir);
      expect(await reader.getPlan(plan.planId)).to.deep.equal(plan);
      expect(await reader.listPlans()).to.have.lengthOf(1);
      expect(await reader.getPlan('plan_missing')).to.be.null;
    } finally {
      clean(dir);
    }
  });

  it('skips corrupt rows and refuses malformed writes', async () => {
    const dir = tmpDir('codesense-test-f2-corrupt');
    clean(dir);
    try {
      const { plan } = planned();
      const store = new LocalActivityPlanStore(dir);
      await store.upsertPlan(plan);
      const file = path.join(dir, '.codesense', 'activity-plans.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
      onDisk.push({ garbage: true }, null, 'nope');
      fs.writeFileSync(file, JSON.stringify(onDisk));
      expect(await store.listPlans()).to.have.lengthOf(1);
      let threw = false;
      try {
        await store.upsertPlan({ nope: true } as unknown as Parameters<LocalActivityPlanStore['upsertPlan']>[0]);
      } catch {
        threw = true;
      }
      expect(threw, 'malformed plan must not persist').to.be.true;
      expect(parseActivityPlan(null)).to.be.null;
      expect(parseActivityPlan({})).to.be.null;
    } finally {
      clean(dir);
    }
  });

  it('exposes typed plan queries', () => {
    const { plan } = planned();
    const offered = offerPlan(plan, NOW);
    const plans = [plan, { ...offered, planId: 'plan_other', goalId: 'goal_other', position: 0, sequenceId: 'seq_other', sequenceLength: 1 }];
    expect(getPlan(plans, plan.planId)?.planId).to.equal(plan.planId);
    expect(getPlan(plans, 'missing')).to.be.null;
    expect(getPlansForGoal(plans, plan.goalId)).to.have.lengthOf(1);
    expect(getPlansByStatus(plans, 'offered')).to.have.lengthOf(1);
    expect(getActivePlansForGoal(plans, plan.goalId)).to.have.lengthOf(1);
    expect(getLatestPlanForGoal(plans, plan.goalId)?.planId).to.equal(plan.planId);
    expect(getLatestPlanForGoal(plans, 'goal_missing')).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// K. Evidence feedback seam + reassessment
// ---------------------------------------------------------------------------

describe('Phase F2 evidence seam and reassessment (no second model)', () => {
  it('activity → attempt → evidence association is preserved', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const plan = outcome.plans[0]!;
    const attempt = createAttempt({ problemId: plan.problemId, sessionId: 'ses_1', startedAt: '2026-04-03T00:00:00.000Z' });
    const linked = linkAttemptToPlan(plan, attempt, '2026-04-03T00:00:00.000Z');
    const followUp = ev({
      timestamp: '2026-04-04T00:00:00.000Z',
      evidenceId: 'ev_f2_followup_1',
      attemptId: attempt.attemptId,
      problemId: plan.problemId,
      entityIds: [BFS],
      evidenceType: 'IMPLEMENTATION_FAILURE',
      confidence: 'low',
    });
    const attributed = evidenceForPlan([...evidence, followUp], linked);
    expect(attributed.map((r) => r.evidenceId)).to.include('ev_f2_followup_1');
  });

  it('reassessment signals without mastery thresholds', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    // No post-baseline evidence → gather more.
    const empty = reassessGoalAfterPractice({ goal, profile, evidence: evidence.filter((r) => goal.entityIds.every((id) => !r.entityIds.includes(id))) });
    expect(empty.signal).to.equal('gather-more-evidence');
    // Post-baseline difficulty → continue.
    const later = ev({ timestamp: '2026-05-01T00:00:01.000Z', evidenceId: 'ev_f2_re_1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' });
    const cont = reassessGoalAfterPractice({ goal, profile, evidence: [...evidence, later] });
    expect(cont.signal).to.equal('continue');
    expect(cont.newEvidenceIds).to.include('ev_f2_re_1');
    // Sustained positive evidence on a fresh goal → appears addressed (review, never auto-verdict).
    const positives = [1, 2, 3, 4].map((n) =>
      ev({ timestamp: `2026-03-0${n}T00:00:00.000Z`, evidenceId: `ev_f2_pos_${n}`, evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'high', problemId: `prob_pos_${n}` }),
    );
    const strongProfile = profileWith(positives);
    const strongNeeds = detectLearningNeeds({ profile: strongProfile, graph: graph(), now: NOW });
    expect(strongNeeds).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// L. Learner-facing summary
// ---------------------------------------------------------------------------

describe('Phase F2 learner-facing summary (what/why/purpose/goal/next)', () => {
  it('communicates what, why, purpose, goal, and next', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planTargetedPractice({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW, maxActivities: 2 });
    expect(outcome.status).to.equal('planned');
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const [first, second] = outcome.plans;
    const summary = summarizePlanForLearner(first!, { goalDescription: goal.description, siblingPlans: outcome.plans });
    expect(summary.title.length).to.be.greaterThan(0);
    expect(summary.why.length).to.be.greaterThan(0);
    expect(summary.purposeLabel).to.contain(first!.purpose === 'diagnostic' ? 'Diagnostic' : 'Instructional');
    expect(summary.goalDescription).to.be.a('string');
    expect(summary.positionLabel).to.contain('Step 1 of 2');
    expect(summary.nextPreview).to.equal(second!.problemTitle ?? second!.problemId);
    expect(summary.expectedSignal.length).to.be.greaterThan(0);
    const all = summarizePlansForGoal(outcome.plans, goal.goalId, goal.description);
    expect(all).to.have.lengthOf(2);
  });
});

// ---------------------------------------------------------------------------
// M. AI boundary + scope guard + no second model
// ---------------------------------------------------------------------------

describe('Phase F2 AI boundary (wording only, never state)', () => {
  it('accepts well-formed wording and rejects state-smuggling candidates', () => {
    const candidate = validateActivityWordingCandidate({ rationale: 'Clearer rationale.', expectedEvidence: 'Clearer signal.' });
    expect(candidate).to.not.be.null;
    expect(validateActivityWordingCandidate(null)).to.be.null;
    expect(validateActivityWordingCandidate({})).to.be.null;
    expect(validateActivityWordingCandidate({ rationale: '   ' })).to.be.null;
    expect(validateActivityWordingCandidate({ rationale: 'ok', status: 'active' })).to.be.null;
    expect(validateActivityWordingCandidate({ rationale: 'ok', intent: 'transfer-practice' })).to.be.null;
    expect(validateActivityWordingCandidate({ rationale: 'ok', planId: 'plan_x' })).to.be.null;
  });

  it('applies wording without touching identity, linkage, or provenance', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const plan = outcome.plans[0]!;
    const before = JSON.stringify(plan);
    const worded = applyActivityWording(plan, { rationale: 'AI phrasing.', expectedEvidence: 'AI signal.' });
    expect(worded.rationale).to.equal('AI phrasing.');
    expect(worded.expectedEvidence).to.equal('AI signal.');
    expect(worded.planId).to.equal(plan.planId);
    expect(worded.goalId).to.equal(plan.goalId);
    expect(worded.intent).to.equal(plan.intent);
    expect(worded.purpose).to.equal(plan.purpose);
    expect(worded.status).to.equal('planned');
    expect(worded.evidenceBasis).to.deep.equal(plan.evidenceBasis);
    expect(JSON.stringify(plan)).to.equal(before);
  });
});

describe('Phase F2 no second learner model', () => {
  it('plans carry planning state only — no capability scores', () => {
    const { profile, evidence, goal } = activeImplementationGoal();
    const { catalog } = buildCatalogFixture();
    const outcome = planNextActivity({ goal, graph: graph(), profile, evidence, catalog, attempts: [], priorPlans: [], now: NOW });
    if (outcome.status !== 'planned') {
      throw new Error('expected planned');
    }
    const serialized = JSON.stringify(outcome.plans[0]!);
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
    ]) {
      expect(serialized, `plan must not carry learner-model field ${forbidden}`).to.not.contain(forbidden);
    }
  });
});

describe('Phase F2 scope guard (no I/G/H/I/J surface)', () => {
  function exportedKeys(module: Record<string, unknown>): string[] {
    return Object.keys(module).sort();
  }

  it('exposes exactly the F2 practice surface (tripwire for scope creep)', () => {
    expect(exportedKeys(activityTypesModule)).to.deep.equal([
      'ACTIVITY_INTENTS',
      'ACTIVITY_KINDS',
      'ACTIVITY_PLAN_STATUSES',
      'ACTIVITY_PLAN_TRANSITIONS',
      'ACTIVITY_PURPOSES',
      'MAX_DEBUG_SNAPSHOT_CHARS',
      'MAX_DEBUG_TESTS',
      'MAX_DEBUG_TEST_CHARS',
      'MAX_DEBUG_TEXT_CHARS',
      'MAX_GENERATED_ID_CHARS',
      'MAX_GENERATED_STATEMENT_CHARS',
      'MAX_GENERATED_TITLE_CHARS',
      'MAX_PLAN_EVIDENCE_IDS',
      'MAX_PLAN_RATIONALE_CHARS',
      'MAX_PLAN_SEQUENCE_LENGTH',
      'MAX_PLAN_TEXT_CHARS',
      'MAX_PLAN_TITLE_CHARS',
      'PRACTICE_PLAN_ID_PREFIX',
      'PRACTICE_SCHEMA_VERSION',
      'PRACTICE_SEQUENCE_ID_PREFIX',
      'intentDimension',
      'intentForDimension',
      'isKnownActivityIntent',
      'isKnownActivityKind',
      'isKnownActivityPlanStatus',
      'isKnownActivityPurpose',
      'validateDebuggingTaskPayload',
      'validateGeneratedArtifact',
    ]);
    expect(exportedKeys(activityCatalogModule)).to.deep.equal([
      'buildPracticeCatalog',
      'candidateEntityOverlap',
      'candidateIsolatesTarget',
      'catalogEntryFromProblem',
    ]);
    expect(exportedKeys(activityPlannerModule)).to.deep.equal([
      'MAX_PLAN_ACTIVITIES',
      'MIN_EVIDENCE_FOR_INSTRUCTIONAL',
      'applyActivityWording',
      'evidenceForPlan',
      'generatePlanId',
      'generateSequenceId',
      'planEvidenceIsTraceable',
      'planNextActivity',
      'planTargetedPractice',
      'reassessGoalAfterPractice',
      'recentGoalEvidence',
      'validateActivityWordingCandidate',
    ]);
    expect(exportedKeys(activityLifecycleModule)).to.deep.equal([
      'cancelPlan',
      'completePlan',
      'linkAttemptToPlan',
      'offerPlan',
      'skipPlan',
      'startPlan',
      'transitionPlanStatus',
    ]);
    expect(exportedKeys(activityStoreModule)).to.deep.equal(['LocalActivityPlanStore', 'parseActivityPlan']);
    expect(exportedKeys(activityQueriesModule)).to.deep.equal([
      'MAX_PLAN_DIGEST_CHARS',
      'evidenceForPlan',
      'getActivePlansForGoal',
      'getEvidenceForPlan',
      'getLatestPlanForGoal',
      'getPlan',
      'getPlansByStatus',
      'getPlansForGoal',
      'summarizePlanForLearner',
      'summarizePlansForGoal',
    ]);
  });
});
