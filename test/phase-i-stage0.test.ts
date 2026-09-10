import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { createManualProblem } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt } from 'codesense/attempts/attempt';
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import { getEvidenceForEntity } from 'codesense/learner/learnerQueries';
import { proposeGoalFromRequest } from 'codesense/goals/goalProposal';
import { acceptGoal } from 'codesense/goals/goalLifecycle';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import {
  ACTIVITY_KINDS,
  isKnownActivityKind,
  validateDebuggingTaskPayload,
} from 'codesense/practice/activityTypes';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import { LocalActivityPlanStore, parseActivityPlan } from 'codesense/practice/activityStore';
import {
  completePlan,
  linkAttemptToPlan,
  offerPlan,
  startPlan,
} from 'codesense/practice/activityLifecycle';
import { recommendIntervention } from 'codesense/coach/coachDecision';
import type { DecisionInput } from 'codesense/coach/coachDecision';
import { emptyLearnerSignals } from 'codesense/coach/coachTypes';
import type { ReflectionCategory } from 'codesense/reflection/reflectionTypes';
import {
  deriveHypotheses,
  selectDiscriminatingNeed,
} from 'codesense/generation/diagnose';
import type {
  AttemptEvolutionObservation,
  DeriveHypothesesInput,
} from 'codesense/generation/diagnose';

/**
 * Phase I Stage 0 — F2 `debugging-task` amendment + transient diagnostic
 * reasoning (no generation engine, no stores, no sandbox).
 *
 * Pins: kind accept/reject, strict payload validation, normal attempt
 * lifecycle reuse, competing (never verdict) hypotheses, uncertainty
 * preservation, established-need/learner-request honesty, frozen D/F1/F2/
 * E/C/H boundaries, structural import guards, full-suite regression.
 */

const BFS = 'framework.bfs';
const NOW = '2026-07-01T12:00:00.000Z';

const BANNED_OUTPUT_TERMS = [
  'rote learner',
  'rote-learner',
  'does not understand',
  'lacks motivation',
  'weak at binary',
  'has not learned',
  'personality',
  'unable to learn',
  'mastery',
];

function graph() {
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepFreeze(item);
      }
    } else {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function problemFixture(url: string, title: string): Problem {
  return createManualProblem(url, { title, statement: `${title} statement.` }, '2026-07-01T09:00:00.000Z');
}

function attemptFixture(
  attemptId: string,
  problemId: string,
  startedAt: string,
  finalState: Attempt['currentState'],
  completedAt: string,
): Attempt {
  const attempt = createAttempt({ attemptId, problemId, sessionId: 'ses_stage0', startedAt });
  transitionAttemptState(attempt, finalState, 'learner', { timestamp: completedAt });
  completeAttempt(attempt, completedAt);
  return attempt;
}

function evidenceFixture(
  evidenceId: string,
  timestamp: string,
  attemptId: string | null,
  problemId: string | null,
  type: LearnerEvidence['evidenceType'],
  confidence: LearnerEvidence['confidence'],
): LearnerEvidence {
  const parsed = validateLearnerEvidence(
    {
      evidenceId,
      schemaVersion: 1,
      timestamp,
      sessionId: 'ses_stage0',
      attemptId,
      problemId,
      entityIds: [BFS],
      evidenceType: type,
      source: 'attempt-outcome',
      observation: `observed ${evidenceId}`,
      interpretation: `interpreted ${evidenceId}`,
      confidence,
      provenance: { source: 'attempt-outcome', sourceId: attemptId },
    },
    { graph: graph() },
  );
  if (!parsed) {
    throw new Error(`fixture evidence must validate: ${evidenceId}`);
  }
  return parsed;
}

function goalFixture(now: string): LearningGoal {
  const proposed = proposeGoalFromRequest(
    { entityIds: [BFS], dimension: 'conceptual', learnerStatement: 'Get better at BFS boundaries.' },
    { graph: graph(), profile: null, now },
  );
  if (!proposed) {
    throw new Error('fixture goal must propose');
  }
  return acceptGoal(proposed, { profile: rebuildLearnerModel([], graph(), { now }), now });
}

function debugPlanFixture(goal: LearningGoal, problem: Problem): ActivityPlan {
  return {
    planId: 'plan_dbg_1',
    goalId: goal.goalId,
    goalTargetKey: goal.targetKey,
    activityKind: 'debugging-task',
    problemId: problem.problemId,
    problemTitle: problem.title,
    intent: 'debugging-practice',
    purpose: 'diagnostic',
    entityIds: [BFS],
    dimension: goal.dimension,
    rationale: 'Diagnose the boundary fault in this binary search.',
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: NOW,
      ontologyVersion: graph().ontologyVersion,
      aggregatorVersion: '1',
      needId: null,
      goalSource: goal.source,
    },
    expectedEvidence: 'A fixed loop plus execution evidence.',
    expectedEvidenceTypes: ['DEBUGGING_FAILURE', 'DEBUGGING_SUCCESS'],
    debugPayload: {
      brokenSnapshot: 'while (l <= r):\n    m = (l + r) // 2',
      faultKind: 'off-by-one',
      referenceFix: 'while (l < r):\n    m = (l + r) // 2',
      tests: ['loop terminates on two-element input', 'bounds never exclude the answer'],
    },
    createdAt: NOW,
    updatedAt: NOW,
    status: 'planned',
    position: 0,
    sequenceLength: 1,
    sequenceId: 'seq_stage0',
    linkedAttemptId: null,
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1', catalogSize: 1 },
  };
}

function binarySearchEvolution(problemA: Problem, problemB: Problem): AttemptEvolutionObservation[] {
  return [
    {
      attemptId: 'att_bs1',
      problemId: problemA.problemId,
      finalState: 'Got WA',
      edits: [
        { insertedText: 'm = l + 1' },
        { insertedText: 'while (l <= r)' },
        { insertedText: 'if (arr[m] < target) { l = m; } else { r = m; }' },
        { insertedText: 'm = r - 1' },
      ],
      syntaxErrorCount: 0,
      executionFailureCount: 2,
      convergedToSuccess: false,
      hasExplanatoryReply: false,
    },
    {
      attemptId: 'att_bs2',
      problemId: problemB.problemId,
      finalState: 'Got AC Independently',
      edits: [{ insertedText: 'while (l < r)' }, { insertedText: 'l = m + 1' }],
      syntaxErrorCount: 0,
      executionFailureCount: 0,
      convergedToSuccess: true,
      hasExplanatoryReply: false,
    },
  ];
}

function binaryInput(): { input: DeriveHypothesesInput; goal: LearningGoal } {
  const problemA = problemFixture('https://example.com/bs-a', 'BS A');
  const problemB = problemFixture('https://example.com/bs-b', 'BS B');
  const goal = goalFixture(NOW);
  const evConfusion = evidenceFixture('ev_bs1', '2026-07-01T10:00:00.000Z', 'att_bs1', problemA.problemId, 'CONCEPTUAL_CONFUSION', 'medium');
  const evSuccess = evidenceFixture('ev_bs2', '2026-07-01T11:00:00.000Z', 'att_bs2', problemB.problemId, 'IMPLEMENTATION_SUCCESS', 'high');
  const profile = rebuildLearnerModel([evConfusion, evSuccess], graph(), { now: NOW });
  // H-composability: scope evidence through the frozen learner query API.
  const scoped = getEvidenceForEntity([evConfusion, evSuccess], BFS);
  return {
    goal,
    input: {
      goal,
      profile,
      evidence: scoped,
      evolution: binarySearchEvolution(problemA, problemB),
      reflectionCategories: [] as ReflectionCategory[],
      graph: graph(),
    },
  };
}

describe('Phase I Stage 0 — F2 ActivityKind amendment', () => {
  it('accepts coding-problem and debugging-task, rejects micro-task and anything else', () => {
    expect(ACTIVITY_KINDS).to.deep.equal(['coding-problem', 'debugging-task']);
    expect(isKnownActivityKind('coding-problem')).to.equal(true);
    expect(isKnownActivityKind('debugging-task')).to.equal(true);
    expect(isKnownActivityKind('micro-task')).to.equal(false);
    expect(isKnownActivityKind('trace-task')).to.equal(false);
    expect(isKnownActivityKind('')).to.equal(false);
    expect(isKnownActivityKind(undefined)).to.equal(false);
  });

  it('validates debugging payloads strictly and rejects malformed ones', () => {
    const ok = validateDebuggingTaskPayload({
      brokenSnapshot: 'while (l <= r): pass',
      faultKind: 'off-by-one',
      referenceFix: 'while (l < r): pass',
      tests: ['terminates'],
    });
    expect(ok).to.not.equal(null);
    expect(validateDebuggingTaskPayload({ brokenSnapshot: 'x', referenceFix: 'y', tests: [] })).to.equal(null);
    expect(validateDebuggingTaskPayload({ brokenSnapshot: 'x', referenceFix: 'y' })).to.equal(null);
    expect(validateDebuggingTaskPayload({ brokenSnapshot: '', referenceFix: 'y', tests: ['t'] })).to.equal(null);
    expect(validateDebuggingTaskPayload({ brokenSnapshot: 'x', referenceFix: '', tests: ['t'] })).to.equal(null);
    expect(
      validateDebuggingTaskPayload({ brokenSnapshot: 'x', referenceFix: 'y', tests: ['t'], faultKind: 'Not Kebab!' }),
    ).to.equal(null);
    expect(validateDebuggingTaskPayload(null)).to.equal(null);
    expect(validateDebuggingTaskPayload('debugging')).to.equal(null);
  });

  it('round-trips debugging-task plans through the store with payload preserved', async () => {
    const dir = tmpDir('codesense-i-stage0-debug-plan');
    clean(dir);
    const goal = goalFixture(NOW);
    const problem = problemFixture('https://example.com/dbg', 'Debug Me');
    const plan = debugPlanFixture(goal, problem);
    const store = new LocalActivityPlanStore(dir);
    await store.upsertPlan(plan);
    const loaded = await store.getPlan(plan.planId);
    expect(loaded).to.not.equal(null);
    expect(loaded?.activityKind).to.equal('debugging-task');
    expect(loaded?.debugPayload).to.deep.equal(plan.debugPayload);
    clean(dir);
  });

  it('rejects debugging-task plans without payloads and coding-problems smuggling payloads', async () => {
    const dir = tmpDir('codesense-i-stage0-debug-reject');
    clean(dir);
    const goal = goalFixture(NOW);
    const problem = problemFixture('https://example.com/dbg2', 'Debug Two');
    const store = new LocalActivityPlanStore(dir);
    const missing = debugPlanFixture(goal, problem);
    delete (missing as unknown as Record<string, unknown>).debugPayload;
    let threw = false;
    try {
      await store.upsertPlan(missing);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    const smuggled = { ...debugPlanFixture(goal, problem), activityKind: 'coding-problem' as const };
    threw = false;
    try {
      await store.upsertPlan(smuggled);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(parseActivityPlan({ ...smuggled, activityKind: 'micro-task' })).to.equal(null);
    clean(dir);
  });

  it('keeps the normal plan lifecycle and attempt linkage working for debugging tasks', () => {
    const goal = goalFixture(NOW);
    const problem = problemFixture('https://example.com/dbg3', 'Debug Three');
    const offered = offerPlan(debugPlanFixture(goal, problem), NOW);
    const started = startPlan(offered, NOW);
    const done = completePlan(started, NOW);
    expect(done.status).to.equal('completed');
    expect(done.debugPayload).to.deep.equal(debugPlanFixture(goal, problem).debugPayload);
    const attempt = attemptFixture('att_dbg', problem.problemId, NOW, 'Got AC with Help', NOW);
    const linked = linkAttemptToPlan(started, attempt, NOW);
    expect(linked.linkedAttemptId).to.equal('att_dbg');
    expect(linked.debugPayload).to.deep.equal(debugPlanFixture(goal, problem).debugPayload);
    const other = attemptFixture('att_other', 'prob_other', NOW, 'Got WA', NOW);
    expect(() => linkAttemptToPlan(started, other, NOW)).to.throw();
  });

  it('leaves existing coding-problem behavior unchanged (no payload key)', async () => {
    const dir = tmpDir('codesense-i-stage0-coding-unchanged');
    clean(dir);
    const goal = goalFixture(NOW);
    const problem = problemFixture('https://example.com/plain', 'Plain Problem');
    const plan: ActivityPlan = {
      planId: 'plan_plain_1',
      goalId: goal.goalId,
      goalTargetKey: goal.targetKey,
      activityKind: 'coding-problem',
      problemId: problem.problemId,
      problemTitle: problem.title,
      intent: 'conceptual-practice',
      purpose: 'diagnostic',
      entityIds: [BFS],
      dimension: goal.dimension,
      rationale: 'Practice BFS conceptually.',
      evidenceBasis: {
        evidenceIds: [],
        profileUpdatedAt: NOW,
        ontologyVersion: graph().ontologyVersion,
        aggregatorVersion: '1',
        needId: null,
        goalSource: goal.source,
      },
      expectedEvidence: 'Attempt the problem.',
      expectedEvidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
      createdAt: NOW,
      updatedAt: NOW,
      status: 'planned',
      position: 0,
      sequenceLength: 1,
      sequenceId: 'seq_plain',
      linkedAttemptId: null,
      provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1', catalogSize: 1 },
    };
    const store = new LocalActivityPlanStore(dir);
    await store.upsertPlan(plan);
    const loaded = await store.getPlan(plan.planId);
    expect(loaded).to.not.equal(null);
    expect('debugPayload' in (loaded as object)).to.equal(false);
    clean(dir);
  });
});

describe('Phase I Stage 0 — transient diagnostic hypotheses', () => {
  it('preserves competing explanations for binary-search perturbation telemetry', () => {
    const { input } = binaryInput();
    const first = deriveHypotheses(deepFreeze(input));
    const kinds = first.hypotheses.map((h) => h.kind);
    expect(kinds).to.include('boundary-invariant-uncertainty');
    expect(kinds).to.include('template-perturbation-possibility');
    for (const hypothesis of first.hypotheses) {
      expect(hypothesis.rivals.length).to.be.greaterThan(0);
      expect(hypothesis.unknowns.length).to.be.greaterThan(0);
      expect(['low', 'medium']).to.include(hypothesis.confidence);
      expect(hypothesis.id.startsWith('hyp_')).to.equal(true);
    }
    // Deterministic: same inputs reconstruct the same output (no accumulation).
    const second = deriveHypotheses(input);
    expect(second).to.deep.equal(first);
  });

  it('never emits verdict, trait, motivation, or mastery language', () => {
    const { input, goal } = binaryInput();
    const result = deriveHypotheses(input);
    const route = selectDiscriminatingNeed(result, { goal, learnerRequested: false });
    const serialized = JSON.stringify({ result, route }).toLowerCase();
    for (const term of BANNED_OUTPUT_TERMS) {
      expect(serialized).to.not.include(term);
    }
  });

  it('refuses single-event overdiagnosis across all thin-evidence shapes', () => {
    const problem = problemFixture('https://example.com/thin', 'Thin');
    const thin = (evolution: AttemptEvolutionObservation[]): ReturnType<typeof deriveHypotheses> =>
      deriveHypotheses({ goal: null, profile: null, evidence: [], evolution, reflectionCategories: [], graph: graph() });
    const oneOddEdit = thin([
      {
        attemptId: 'att_solo',
        problemId: problem.problemId,
        finalState: 'Got AC Independently',
        edits: [{ insertedText: 'x = 1' }],
        syntaxErrorCount: 0,
        executionFailureCount: 0,
        convergedToSuccess: true,
        hasExplanatoryReply: false,
      },
    ]);
    expect(oneOddEdit.hypotheses).to.deep.equal([]);
    expect(oneOddEdit.unknowns.length).to.be.greaterThan(0);
    const oneSyntaxError = thin([
      {
        attemptId: 'att_syn',
        problemId: problem.problemId,
        finalState: 'Got Error / Compilation Error',
        edits: [{ insertedText: 'pritn(x)' }],
        syntaxErrorCount: 1,
        executionFailureCount: 0,
        convergedToSuccess: false,
        hasExplanatoryReply: false,
      },
    ]);
    expect(oneSyntaxError.hypotheses).to.deep.equal([]);
    const oneBoundaryEdit = thin([
      {
        attemptId: 'att_bnd',
        problemId: problem.problemId,
        finalState: 'Got WA',
        edits: [{ insertedText: 'while (l <= r)' }],
        syntaxErrorCount: 0,
        executionFailureCount: 1,
        convergedToSuccess: false,
        hasExplanatoryReply: false,
      },
    ]);
    expect(oneBoundaryEdit.hypotheses).to.deep.equal([]);
    const thinRoute = selectDiscriminatingNeed(oneOddEdit, { goal: null, learnerRequested: false });
    expect(thinRoute.route).to.equal('no-diagnostic-action');
  });

  it('routes genuine uncertainty to the coach and reaches existing E machinery unmodified', () => {
    const { input, goal } = binaryInput();
    const result = deriveHypotheses(input);
    const route = selectDiscriminatingNeed(result, { goal, learnerRequested: false });
    expect(route.route).to.equal('ask-coach');
    if (route.route !== 'ask-coach') {
      throw new Error('expected ask-coach routing');
    }
    expect(route.coachSignal.hasUnknowns).to.equal(true);
    expect(route.coachSignal.diagnosticConfidence).to.equal('low');
    // New caller of EXISTING E capability: frozen Rule 3 (low + unknowns → question).
    const decisionInput: DecisionInput = {
      difficultyType: route.coachSignal.difficultyType,
      diagnosticConfidence: route.coachSignal.diagnosticConfidence,
      hasUnknowns: route.coachSignal.hasUnknowns,
      learnerRelevance: [],
      prerequisiteStatuses: [],
      activeMistakeCategories: [],
      signals: emptyLearnerSignals(),
      previousIntervention: null,
      previousOutcome: null,
      priorInterventionCount: 0,
      urgency: 'low',
      attemptState: 'Got WA',
      abandonmentStreak: 0,
    };
    expect(recommendIntervention(decisionInput).proposed).to.equal('SOCRATIC_QUESTION');
  });

  it('consumes established needs and learner requests without manufacturing hypotheses', () => {
    const { goal } = binaryInput();
    const empty = deriveHypotheses({ goal, profile: null, evidence: [], evolution: [], reflectionCategories: [], graph: graph() });
    expect(empty.hypotheses).to.deep.equal([]);
    const established = selectDiscriminatingNeed(empty, {
      goal,
      learnerRequested: false,
      establishedNeed: { needId: 'need_abc', summary: 'Corroborated boundary need.' },
    });
    expect(established.route).to.equal('use-established-need');
    if (established.route === 'use-established-need') {
      expect(established.needId).to.equal('need_abc');
    }
    const requested = selectDiscriminatingNeed(empty, {
      goal,
      learnerRequested: true,
      learnerStatement: 'Give me a harder binary-search problem.',
    });
    expect(requested.route).to.equal('honor-learner-request');
    if (requested.route === 'honor-learner-request') {
      expect(requested.statement).to.equal('Give me a harder binary-search problem.');
    }
    const serialized = JSON.stringify({ established, requested }).toLowerCase();
    for (const term of BANNED_OUTPUT_TERMS) {
      expect(serialized).to.not.include(term);
    }
  });

  it('rejects unknown C entities instead of reasoning about invented knowledge', () => {
    const goal = { ...goalFixture(NOW), entityIds: ['bogus.entity'] };
    const problem = problemFixture('https://example.com/cb', 'CB');
    const result = deriveHypotheses({
      goal,
      profile: null,
      evidence: [],
      evolution: binarySearchEvolution(problem, problem),
      reflectionCategories: [],
      graph: graph(),
    });
    expect(result.hypotheses).to.deep.equal([]);
    expect(result.unknowns.join(' ')).to.include('no known knowledge entities');
  });
});

describe('Phase I Stage 0 — frozen boundaries (mutating nothing)', () => {
  it('performs no D mutation (frozen inputs survive deep-freeze)', () => {
    const { input } = binaryInput();
    const before = JSON.stringify({ evidence: input.evidence, profile: input.profile });
    deriveHypotheses(deepFreeze(input));
    expect(JSON.stringify({ evidence: input.evidence, profile: input.profile })).to.equal(before);
  });

  it('performs no F1 mutation (goal lifecycle untouched)', () => {
    const { input, goal } = binaryInput();
    const frozen = deepFreeze(goal);
    const result = deriveHypotheses({ ...input, goal: frozen });
    selectDiscriminatingNeed(result, { goal: frozen, learnerRequested: false });
    expect(frozen.status).to.equal('active');
    expect(JSON.stringify(frozen)).to.equal(JSON.stringify(goal));
  });

  it('creates no ActivityPlan and emits no plan-shaped output', () => {
    const { input, goal } = binaryInput();
    const result = deriveHypotheses(input);
    const route = selectDiscriminatingNeed(result, { goal, learnerRequested: false });
    const serialized = JSON.stringify({ result, route });
    for (const key of ['"planId"', '"linkedAttemptId"', '"activityKind"', '"sequenceId"']) {
      expect(serialized).to.not.include(key);
    }
  });

  it('carries no lifecycle/status fields on hypotheses (nothing to transition or expire)', () => {
    const { input } = binaryInput();
    const result = deriveHypotheses(input);
    expect(result.hypotheses.length).to.be.greaterThan(0);
    for (const hypothesis of result.hypotheses) {
      expect(Object.keys(hypothesis).sort()).to.deep.equal(
        ['basisEvidenceIds', 'confidence', 'id', 'kind', 'observedSignals', 'rivals', 'unknowns'],
      );
    }
  });

  it('guards architectural ownership structurally (no forbidden imports or stores)', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const source = fs.readFileSync(path.join(root, 'src', 'generation', 'diagnose.ts'), 'utf-8');
    for (const forbidden of [
      'transitionGoalStatus',
      'transitionPlanStatus',
      'linkAttemptToPlan',
      'proposeGoalFromNeed',
      'proposeGoalFromRequest',
      'acceptGoal',
      'syncAttemptToLearnerModel',
      'syncRecordsToLearnerModel',
      'appendEvidence',
      'upsertPlan',
      'upsertGoal',
      'saveJsonArray',
      'loadJsonArray',
      'hypotheses.json',
      'hypothesisStore',
      'hypothesisLifecycle',
      'child_process',
      'spawn(',
      'execFile',
      'execSync',
    ]) {
      expect(source).to.not.include(forbidden);
    }
    expect(fs.existsSync(path.join(root, 'src', 'generation', 'hypothesisStore.ts'))).to.equal(false);
    expect(fs.existsSync(path.join(root, 'src', 'generation', 'hypothesisLifecycle.ts'))).to.equal(false);
  });
});
