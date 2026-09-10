import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { ProblemClassification } from 'codesense/knowledge/classification';
import { createManualProblem, hashIdentity } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt, AttemptState } from 'codesense/attempts/attempt';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { EvidenceType, HelpLevel } from 'codesense/learner/learnerTypes';
import {
  emptyKnowledgeState,
  emptyLearnerProfile,
} from 'codesense/learner/learnerModel';
import type { LearnerKnowledgeState, LearnerProfile } from 'codesense/learner/learnerModel';
import type { ActivityProgress, ProgressSignal } from 'codesense/progress/progressTypes';
import { LocalProblemStore } from 'codesense/problems/problemStore';
import { LocalAttemptStore } from 'codesense/attempts/attemptStore';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalGoalStore } from 'codesense/goals/goalStore';
import { LocalActivityPlanStore } from 'codesense/practice/activityStore';
import { LocalProgressStore } from 'codesense/progress/progressStore';
import { LocalReflectionStore } from 'codesense/reflection/reflectionStore';
import { LocalProblemKnowledgeStore } from 'codesense/longterm/problemKnowledgeStore';
import { detectReinforcementNeed } from 'codesense/longterm/reinforcementNeed';
import { selectReinforcementCandidates } from 'codesense/longterm/reinforcementCandidate';
import {
  acceptRecommendation,
  applyCompletion,
  canonicalIdentityMaterial,
  chainIdFor,
  deferRecommendation,
  deriveRecommendation,
  deriveRevisitRecommendation,
  evaluateCompletion,
  isKnownRecommendationStatus,
  linkCounterpartRecommendation,
  markSuperseded,
  needFingerprintFor,
  parseRecommendation,
  recommendationIdFor,
  skipRecommendation,
} from 'codesense/longterm/recommendation';
import type { LongTermRecommendation } from 'codesense/longterm/recommendation';
import { LocalRecommendationStore } from 'codesense/longterm/recommendationStore';
import * as recommendationModule from 'codesense/longterm/recommendation';

/**
 * Phase J-3 — long-term recommendation + reinforcement chain.
 * Deterministic, learner-choice-driven, fail-closed. No AI.
 */

const FW_BS = 'framework.binary-search';
const FORM_SOA = 'form.search-on-answer';
const CONCEPT_MONO = 'concept.monotonicity';
const CONCEPT_FEAS = 'concept.feasibility-predicate';
const TACTIC_DEF = 'tactic.define-feasible-predicate';
const TACTIC_PROVE = 'tactic.prove-monotonicity';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T10:00:00.000Z';
const T1E = '2026-02-01T10:40:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';
const T3 = '2026-04-01T10:00:00.000Z';
const T3E = '2026-04-01T10:40:00.000Z';
const T4 = '2026-05-01T10:00:00.000Z';
const T5 = '2026-06-01T10:00:00.000Z';
const T5E = '2026-06-01T10:40:00.000Z';

let graph: KnowledgeGraph;

function makeProblem(url: string, title: string): Problem {
  return createManualProblem(url, { title, statement: `Solve ${title}.` }, T0);
}

function makeClassification(problem: Problem): ProblemClassification {
  const ids = (list: string[]) => list.map((entityId) => ({ entityId, confidence: 'high' as const }));
  return {
    problemId: problem.problemId,
    ontologyVersion: '1',
    classifierVersion: '1',
    classifiedAt: T0,
    topics: [],
    concepts: ids([CONCEPT_MONO, CONCEPT_FEAS]),
    frameworks: ids([FW_BS]),
    forms: ids([FORM_SOA]),
    patterns: [],
    variants: [],
    tactics: ids([TACTIC_DEF, TACTIC_PROVE]),
    prerequisites: [],
    solutionFamilies: [],
    curriculumMappings: [],
    confidence: 'high',
    provenance: {
      source: 'human-curated',
      classifierVersion: '1',
      ontologyVersion: '1',
      classifiedAt: T0,
      problemSourceUrl: problem.canonicalUrl,
    },
  };
}

function makeAttempt(args: {
  attemptId: string;
  problem: Problem;
  startedAt: string;
  toState: AttemptState;
  completedAt: string;
}): Attempt {
  const attempt = createAttempt({
    attemptId: args.attemptId,
    problemId: args.problem.problemId,
    sessionId: 'ses_1',
    startedAt: args.startedAt,
  });
  transitionAttemptState(attempt, args.toState, 'learner', { timestamp: args.completedAt });
  completeAttempt(attempt, args.completedAt);
  return attempt;
}

let evidenceSeq = 0;
function makeEvidence(args: {
  attempt: Attempt;
  entityIds: string[];
  evidenceType: EvidenceType;
  confidence: 'low' | 'medium' | 'high';
  timestamp: string;
  evidenceId?: string;
}): LearnerEvidence {
  evidenceSeq += 1;
  return {
    evidenceId: args.evidenceId ?? `ev_j3_${evidenceSeq}`,
    schemaVersion: 1,
    timestamp: args.timestamp,
    sessionId: 'ses_1',
    attemptId: args.attempt.attemptId,
    problemId: args.attempt.problemId,
    entityIds: args.entityIds,
    evidenceType: args.evidenceType,
    source: 'attempt-outcome',
    observation: `Observed ${args.evidenceType}.`,
    interpretation: 'Test interpretation.',
    confidence: args.confidence,
    provenance: { source: 'attempt-outcome', sourceId: args.attempt.attemptId },
  };
}

function makeIndicatedInputs(source: Problem, classification: ProblemClassification) {
  const solve = makeAttempt({ attemptId: 'att_src1', problem: source, startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
  const evidence = [
    makeEvidence({ attempt: solve, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_src_low' }),
  ];
  const profile: LearnerProfile = emptyLearnerProfile(T0, graph);
  const state: LearnerKnowledgeState = emptyKnowledgeState(FW_BS, T0);
  state.status = 'developing';
  state.statusConfidence = 'low';
  profile.knowledgeStates = [state];
  return { solve, evidence, profile };
}

let progressSeq = 0;
function makeProgress(args: {
  signal: ProgressSignal;
  attempt: Attempt;
  evaluatedAt: string;
  independent: boolean;
  helped: boolean;
  helpLevels?: HelpLevel[];
}): ActivityProgress {
  progressSeq += 1;
  return {
    progressId: `prog_j3_${progressSeq}`,
    goalId: 'goal_j3',
    goalTargetKey: 'target_j3',
    planId: `plan_j3_${progressSeq}`,
    linkedAttemptId: args.attempt.attemptId,
    goalSource: 'evidence-derived',
    dimension: 'implementation',
    activity: {
      intent: 'implementation-practice',
      purpose: 'instructional',
      entityIds: [FW_BS],
      problemId: args.attempt.problemId,
      problemTitle: 'P',
    },
    baselineRef: { capturedAt: T0, profileUpdatedAt: T0 },
    activityEvidenceIds: [],
    weakEvidenceIds: [],
    goalRelevantNewIds: [],
    entities: [],
    independence: {
      independent: args.independent,
      helped: args.helped,
      helpLevels: args.helpLevels ?? [],
      independentEvidenceIds: [],
      helpEvidenceIds: [],
    },
    positiveNewIds: [],
    negativeNewIds: [],
    progressSignal: args.signal,
    reassessment: 'continue',
    explanation: 'Test explanation.',
    firstEvaluatedAt: args.evaluatedAt,
    evaluatedAt: args.evaluatedAt,
    evaluationCount: 1,
    evidenceFingerprint: `fp_${progressSeq}`,
    signalHistory: [],
    provenance: { ontologyVersion: '1', aggregatorVersion: '1' },
  };
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codesense-j3-'));
}

function snapshotDir(workspace: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = path.join(workspace, '.codesense');
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const file of fs.readdirSync(dir).sort()) {
    out.set(file, fs.readFileSync(path.join(dir, file), 'utf-8'));
  }
  return out;
}

describe('Phase J-3 — recommendation derivation', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function setup() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    expect(selection.outcome).to.equal('candidate-found');
    return { source, classification, easyProblem, decision, selection, solve, evidence, profile };
  }

  it('1+2+3. abstention: no need / insufficient evidence / no candidate → null', () => {
    const { source, classification, decision, selection } = setup();
    const noNeed = { ...decision, outcome: 'no-reinforcement-needed' as const, need: null };
    expect(deriveRecommendation({ decision: noNeed, selection, now: T2 })).to.equal(null);
    const weak = { ...decision, outcome: 'insufficient-evidence' as const, need: null };
    expect(deriveRecommendation({ decision: weak, selection, now: T2 })).to.equal(null);
    const empty = { ...selection, outcome: 'no-suitable-candidate' as const, candidates: [] };
    expect(deriveRecommendation({ decision, selection: empty, now: T2 })).to.equal(null);
  });

  it('4+8. valid recommendation with source/candidate linkage', () => {
    const { source, decision, selection } = setup();
    const rec = deriveRecommendation({ decision, selection, goalId: 'goal_x', sourceProblemLabel: 'Binary Search', now: T2 })!;
    expect(rec).to.not.equal(null);
    expect(rec.role).to.equal('reinforcement');
    expect(rec.status).to.equal('offered');
    expect(rec.sourceProblemId).to.equal(source.problemId);
    expect(rec.reinforcementProblemId).to.not.equal(source.problemId);
    expect(rec.reinforcementProblemId).to.equal(selection.candidates[0]!.problemId);
    expect(rec.goalId).to.equal('goal_x');
    expect(rec.chainId).to.equal(chainIdFor(rec.sourceProblemId, rec.reinforcementProblemId));
    expect(rec.counterpartRecommendationId).to.equal(null);
    expect(rec.supersedesRecommendationId).to.equal(null);
    expect(rec.createdAt).to.equal(T2);
    expect(rec.candidateBasis.sharedFrameworks).to.deep.equal([FW_BS]);
    expect(rec.evidenceIds).to.deep.equal(['ev_src_low']);
  });

  it('5. explanation is deterministic and grounded', () => {
    const { decision, selection } = setup();
    const a = deriveRecommendation({ decision, selection, sourceProblemLabel: 'Binary Search', now: T2 })!;
    const b = deriveRecommendation({ decision, selection, sourceProblemLabel: 'Binary Search', now: T2 })!;
    expect(a.explanation).to.equal(b.explanation);
    expect(a.explanation).to.contain('Binary Search');
    expect(a.explanation).to.contain(FW_BS);
    expect(a.explanation).to.contain('revisit');
  });

  it('6+7. explanation carries no unsupported claims', () => {
    const { decision, selection } = setup();
    const rec = deriveRecommendation({ decision, selection, sourceProblemLabel: 'Binary Search', now: T2 })!;
    const lower = rec.explanation.toLowerCase();
    for (const banned of ['easier', 'lower difficulty', 'definitely', 'you are weak', "you don't understand", 'you do not understand', 'mastered', 'mastery', 'forgot', 'weak at']) {
      expect(lower, banned).to.not.contain(banned);
    }
  });

  it('9+10. deterministic identity; identical input is idempotent', () => {
    const { decision, selection } = setup();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    const b = deriveRecommendation({ decision, selection, now: T2 })!;
    expect(a.recommendationId).to.equal(b.recommendationId);
    expect(a).to.deep.equal(b);
    const need = decision.need!;
    const candidate = selection.candidates[0]!;
    expect(a.recommendationId).to.equal(
      recommendationIdFor({
        role: 'reinforcement',
        sourceProblemId: need.sourceProblemId,
        reinforcementProblemId: candidate.problemId,
        goalId: a.goalId,
        needFingerprint: needFingerprintFor(need),
        evidenceFingerprint: hashIdentity([...need.evidenceIds].sort().join(',')),
        sharedFrameworks: candidate.sharedFrameworks,
        sharedForms: candidate.sharedForms,
        sharedConcepts: candidate.sharedConcepts,
        sharedTactics: candidate.sharedTactics,
        candidateAreas: candidate.candidateAreas,
        sourceAreas: candidate.sourceAreas,
        candidateTimesAttempted: candidate.timesAttempted,
        candidateTimesSolved: candidate.timesSolved,
      }),
    );
    expect(a.recommendationId.startsWith('rec_')).to.equal(true);
    expect(a.chainId.startsWith('chain_')).to.equal(true);
  });

  it('11+12+35. new evidence → new ID; old row superseded, never deleted', async () => {
    const { source, classification, decision, selection, solve, profile, evidence } = setup();
    const old = deriveRecommendation({ decision, selection, now: T2 })!;
    const extra = makeEvidence({ attempt: solve, entityIds: [CONCEPT_MONO], evidenceType: 'CONCEPTUAL_CONFUSION', confidence: 'medium', timestamp: T1E, evidenceId: 'ev_src_extra' });
    const decision2 = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence: [...evidence, extra], profile, progress: [], classification, knowledge: null,
    });
    expect(decision2.outcome).to.equal('reinforcement-indicated');
    const fresh = deriveRecommendation({ decision: decision2, selection, supersedesRecommendationId: old.recommendationId, now: T3 })!;
    expect(fresh.recommendationId).to.not.equal(old.recommendationId);
    expect(fresh.supersedesRecommendationId).to.equal(old.recommendationId);
    expect(fresh.chainId).to.equal(old.chainId);
    const retired = markSuperseded(old, fresh.recommendationId, T3);
    expect(retired.status).to.equal('superseded');
    expect(retired.supersededByRecommendationId).to.equal(fresh.recommendationId);
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    await store.upsertRecommendation(old);
    await store.upsertRecommendation(retired);
    await store.upsertRecommendation(fresh);
    // Re-deriving the same new state upserts, never duplicates.
    await store.upsertRecommendation(fresh);
    const listed = await store.listRecommendations();
    expect(listed.length).to.equal(2);
    expect(listed.map((r) => r.status).sort()).to.deep.equal(['offered', 'superseded']);
  });

  it('AB. goal linkage stays an honest copied reference', () => {
    const { decision, selection } = setup();
    const withGoal = deriveRecommendation({ decision, selection, goalId: 'goal_x', now: T2 })!;
    const withoutGoal = deriveRecommendation({ decision, selection, now: T2 })!;
    expect(withGoal.goalId).to.equal('goal_x');
    expect(withoutGoal.goalId).to.equal(null);
    expect(withGoal).to.not.have.property('goalSource');
    expect(JSON.stringify(withGoal)).to.not.contain('master');
  });
});

describe('Phase J-3 — lifecycle and learner choice', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function offered(): LongTermRecommendation {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    return deriveRecommendation({ decision, selection, now: T2 })!;
  }

  it('13+14+15. accept / skip / defer transitions', () => {
    const rec = offered();
    const accepted = acceptRecommendation(rec, T3);
    expect(accepted.status).to.equal('accepted');
    expect(accepted.createdAt).to.equal(T2);
    expect(accepted.updatedAt).to.equal(T3);
    expect(skipRecommendation(rec, T3).status).to.equal('skipped');
    expect(deferRecommendation(rec, T3).status).to.equal('deferred');
    // Accepted can still be declined or deferred — disposition, not execution.
    expect(skipRecommendation(accepted, T3).status).to.equal('skipped');
    expect(deferRecommendation(accepted, T3).status).to.equal('deferred');
    expect(isKnownRecommendationStatus('accepted')).to.equal(true);
    expect(isKnownRecommendationStatus('bogus')).to.equal(false);
  });

  it('16. illegal transitions throw; terminal states stay terminal', () => {
    const rec = offered();
    expect(() => acceptRecommendation(skipRecommendation(rec, T3), T4)).to.throw();
    expect(() => skipRecommendation(markSuperseded(rec, 'rec_other', T3), T4)).to.throw();
    const done = { ...rec, status: 'completed' as const };
    expect(() => skipRecommendation(done, T4)).to.throw();
    expect(() => acceptRecommendation(done, T4)).to.throw();
    expect(() => linkCounterpartRecommendation(skipRecommendation(rec, T3), 'rec_x', T4)).to.throw();
    expect(() => linkCounterpartRecommendation(rec, '  ', T4)).to.throw();
  });

  it('17. accept ≠ completion', () => {
    const rec = acceptRecommendation(offered(), T3);
    const assessment = evaluateCompletion(rec, [], []);
    expect(assessment.complete).to.equal(false);
    expect(assessment.ground).to.equal('missing-attempt');
    expect(() => applyCompletion(rec, assessment, T4)).to.throw();
  });

  it('18+19. skip/defer produce no evidence and touch no stores', async () => {
    const workspace = makeWorkspace();
    const evidenceStore = new LocalLearnerEvidenceStore(workspace);
    const progressStore = new LocalProgressStore(workspace);
    const recStore = new LocalRecommendationStore(workspace);
    const rec = offered();
    await recStore.upsertRecommendation(rec);
    const before = snapshotDir(workspace);
    const evidenceBefore = await evidenceStore.listEvidence();
    skipRecommendation(rec, T3);
    deferRecommendation(rec, T3);
    acceptRecommendation(rec, T3);
    expect(await evidenceStore.listEvidence()).to.deep.equal(evidenceBefore);
    expect(await progressStore.listProgress()).to.deep.equal([]);
    const after = snapshotDir(workspace);
    // Pure transitions write nothing; only the earlier upsert file exists.
    expect([...after.keys()]).to.deep.equal([...before.keys()]);
    expect(after.get('recommendations.json')).to.equal(before.get('recommendations.json'));
  });
});

describe('Phase J-3 — completion and revisit chain', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function chainSetup() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    const rec = deriveRecommendation({ decision, selection, sourceProblemLabel: 'Binary Search', now: T2 })!;
    return { source, easyProblem, rec };
  }

  it('20+21+22. completion needs a post-offer completed attempt AND linked F3 progress', () => {
    const { easyProblem, rec } = chainSetup();
    expect(evaluateCompletion(rec, [], []).ground).to.equal('missing-attempt');
    const attempt = makeAttempt({ attemptId: 'att_r1', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const noProgress = evaluateCompletion(rec, [attempt], []);
    expect(noProgress.complete).to.equal(false);
    expect(noProgress.ground).to.equal('missing-progress');
    expect(noProgress.attemptId).to.equal(attempt.attemptId);
    expect(() => applyCompletion(rec, noProgress, T4)).to.throw();
    const progress = makeProgress({ signal: 'IMPROVING', attempt, evaluatedAt: T3E, independent: true, helped: false });
    const done = evaluateCompletion(rec, [attempt], [progress]);
    expect(done.complete).to.equal(true);
    expect(done.ground).to.equal('attempt-and-progress');
    expect(done.progressId).to.equal(progress.progressId);
    const completed = applyCompletion(acceptRecommendation(rec, T3), done, T4);
    expect(completed.status).to.equal('completed');
  });

  it('23+24. helped result completes the occurrence but is never independent', () => {
    const { easyProblem, rec } = chainSetup();
    // Raw attempt state claims independence, but F3's facet reports help:
    // J-3 must follow the facet, proving no raw-state re-derivation.
    const attempt = makeAttempt({ attemptId: 'att_h1', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const progress = makeProgress({ signal: 'EVIDENCE_ADDED', attempt, evaluatedAt: T3E, independent: false, helped: true, helpLevels: ['hint'] });
    const assessment = evaluateCompletion(rec, [attempt], [progress]);
    expect(assessment.complete).to.equal(true);
    expect(assessment.independent).to.equal(false);
    expect(assessment.helped).to.equal(true);
  });

  it('25+27+28. independent completion enables a revisit of the original', () => {
    const { source, easyProblem, rec } = chainSetup();
    const attempt = makeAttempt({ attemptId: 'att_r1', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const progress = makeProgress({ signal: 'IMPROVING', attempt, evaluatedAt: T3E, independent: true, helped: false });
    const completed = applyCompletion(acceptRecommendation(rec, T3), evaluateCompletion(rec, [attempt], [progress]), T4);
    const revisit = deriveRevisitRecommendation({
      reinforcement: completed,
      assessment: evaluateCompletion(rec, [attempt], [progress]),
      now: T4,
    })!;
    expect(revisit).to.not.equal(null);
    expect(revisit.role).to.equal('revisit');
    expect(revisit.status).to.equal('offered');
    expect(revisit.sourceProblemId).to.equal(source.problemId);
    expect(revisit.reinforcementProblemId).to.equal(easyProblem.problemId);
    expect(revisit.chainId).to.equal(completed.chainId);
    expect(revisit.counterpartRecommendationId).to.equal(completed.recommendationId);
    expect(revisit.explanation).to.contain('independent');
    // Link the back-pointer; both halves now reference each other.
    const linked = linkCounterpartRecommendation(completed, revisit.recommendationId, T4);
    expect(linked.counterpartRecommendationId).to.equal(revisit.recommendationId);
    expect(linked.status).to.equal('completed');
  });

  it('helped completion still permits a revisit — framed as transfer check', () => {
    const { rec, easyProblem } = chainSetup();
    const attempt = makeAttempt({ attemptId: 'att_h2', problem: easyProblem, startedAt: T3, toState: 'Got AC with Help', completedAt: T3E });
    const progress = makeProgress({ signal: 'IMPROVING', attempt, evaluatedAt: T3E, independent: false, helped: true, helpLevels: ['hint'] });
    const completed = applyCompletion(rec, evaluateCompletion(rec, [attempt], [progress]), T4);
    const revisit = deriveRevisitRecommendation({
      reinforcement: completed,
      assessment: evaluateCompletion(rec, [attempt], [progress]),
      now: T4,
    })!;
    expect(revisit).to.not.equal(null);
    expect(revisit.explanation).to.contain('help');
    expect(revisit.explanation.toLowerCase()).to.not.contain('completed independently');
    expect(revisit.explanation.toLowerCase()).to.not.contain('mastered');
  });

  it('26. struggle/mixed outcomes preserve the chain and yield no revisit', () => {
    const { rec, easyProblem } = chainSetup();
    for (const signal of ['STILL_STRUGGLING', 'MIXED_SIGNAL', 'REGRESSION_SIGNAL', 'NO_NEW_EVIDENCE'] as const) {
      const attempt = makeAttempt({ attemptId: `att_${signal}`, problem: easyProblem, startedAt: T3, toState: 'Got WA', completedAt: T3E });
      const progress = makeProgress({ signal, attempt, evaluatedAt: T3E, independent: false, helped: false });
      const assessment = evaluateCompletion(rec, [attempt], [progress]);
      expect(assessment.complete, signal).to.equal(true);
      const completed = applyCompletion(rec, assessment, T4);
      expect(
        deriveRevisitRecommendation({ reinforcement: completed, assessment, now: T4 }),
        signal,
      ).to.equal(null);
    }
  });

  it('29+30. revisit creates nothing; original attempts stay separate', async () => {
    const workspace = makeWorkspace();
    const problems = new LocalProblemStore(workspace);
    const attempts = new LocalAttemptStore(workspace);
    const plans = new LocalActivityPlanStore(workspace);
    const knowledge = new LocalProblemKnowledgeStore(workspace);
    const { source, easyProblem, rec } = chainSetup();
    await problems.upsertProblem(source);
    await problems.upsertProblem(easyProblem);
    const problemsBefore = await problems.listProblems();
    const attempt = makeAttempt({ attemptId: 'att_r1', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    await attempts.saveAttempt(attempt);
    const progress = makeProgress({ signal: 'IMPROVING', attempt, evaluatedAt: T3E, independent: true, helped: false });
    const completed = applyCompletion(rec, evaluateCompletion(rec, [attempt], [progress]), T4);
    const revisit = deriveRevisitRecommendation({
      reinforcement: completed,
      assessment: evaluateCompletion(rec, [attempt], [progress]),
      now: T4,
    })!;
    // Revisiting resolves through the same canonical row + new attempt rows.
    const revisitAttempt = makeAttempt({ attemptId: 'att_rev1', problem: source, startedAt: T5, toState: 'Got AC Independently', completedAt: T5E });
    await attempts.saveAttempt(revisitAttempt);
    expect((await problems.listProblems()).length).to.equal(problemsBefore.length);
    expect(await plans.listPlans()).to.deep.equal([]);
    expect(await knowledge.listKnowledge()).to.deep.equal([]);
    expect(JSON.stringify(revisit)).to.not.contain('planId');
    expect(JSON.stringify(revisit)).to.not.contain('attemptId');
    expect(JSON.stringify(revisit)).to.not.contain('artifact');
    const stored = await attempts.listAttemptsForProblem(source.problemId);
    expect(stored.map((a) => a.attemptId)).to.deep.equal(['att_rev1']);
    expect(new Set([attempt.attemptId, revisitAttempt.attemptId]).size).to.equal(2);
  });

  it('31+32. chain linkage preserved; choosing another candidate is safe', () => {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const mkEasy = (slug: string, title: string, concepts: string[]) => {
      const problem = makeProblem(`https://leetcode.com/problems/${slug}/`, title);
      const cls: ProblemClassification = { ...makeClassification(problem), concepts: concepts.map((entityId) => ({ entityId, confidence: 'high' as const })), tactics: [] };
      return { problem, classification: cls, knowledge: null };
    };
    const easy1 = mkEasy('lower-bound', 'Lower Bound', []);
    const easy2 = mkEasy('first-bad-version', 'First Bad Version', [CONCEPT_MONO]);
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [easy2, easy1],
      attempts: [solve],
    });
    expect(selection.candidates.length).to.equal(2);
    const first = deriveRecommendation({ decision, selection, now: T2 })!;
    const second = deriveRecommendation({ decision, selection, candidateProblemId: selection.candidates[1]!.problemId, now: T2 })!;
    expect(second.reinforcementProblemId).to.not.equal(first.reinforcementProblemId);
    expect(second.recommendationId).to.not.equal(first.recommendationId);
    expect(second.chainId).to.not.equal(first.chainId);
    // Learner declines the first; the second stands on its own chain.
    const declined = skipRecommendation(first, T3);
    expect(declined.status).to.equal('skipped');
    expect(second.status).to.equal('offered');
  });

  it('36+37+38+39. completion guards: unrelated, pre-offer, active, multi-attempt', () => {
    const { source, easyProblem, rec } = chainSetup();
    const other = makeProblem('https://leetcode.com/problems/two-sum/', 'Two Sum');
    const foreign = makeAttempt({ attemptId: 'att_f1', problem: other, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const foreignProgress = makeProgress({ signal: 'IMPROVING', attempt: foreign, evaluatedAt: T3E, independent: true, helped: false });
    expect(evaluateCompletion(rec, [foreign], [foreignProgress]).ground).to.equal('missing-attempt');
    const early = makeAttempt({ attemptId: 'att_e1', problem: easyProblem, startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const earlyProgress = makeProgress({ signal: 'IMPROVING', attempt: early, evaluatedAt: T1E, independent: true, helped: false });
    expect(evaluateCompletion(rec, [early], [earlyProgress]).ground).to.equal('missing-attempt');
    const active = createAttempt({ attemptId: 'att_active', problemId: easyProblem.problemId, sessionId: 'ses_1', startedAt: T3 });
    expect(evaluateCompletion(rec, [active], []).ground).to.equal('missing-attempt');
    const late = makeAttempt({ attemptId: 'att_late', problem: easyProblem, startedAt: T5, toState: 'Got AC Independently', completedAt: T5E });
    const lateProgress = makeProgress({ signal: 'IMPROVING', attempt: late, evaluatedAt: T5E, independent: true, helped: false });
    const multi = evaluateCompletion(rec, [early, late], [earlyProgress, lateProgress]);
    expect(multi.complete).to.equal(true);
    expect(multi.attemptId).to.equal('att_late');
  });

  it('40. adversarial ID/content mismatch abstains', () => {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [],
      attempts: [solve],
    });
    const forged = { ...selection, sourceProblemId: 'prob_forged' };
    expect(deriveRecommendation({ decision, selection: forged, now: T2 })).to.equal(null);
    expect(deriveRecommendation({ decision, selection, candidateProblemId: 'prob_missing', now: T2 })).to.equal(null);
  });
});

describe('Phase J-3 — persistence and boundaries', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function offered(): LongTermRecommendation {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    return deriveRecommendation({ decision, selection, now: T2 })!;
  }

  it('33+34. persistence round-trips; malformed rows fail safely', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const rec = offered();
    await store.upsertRecommendation(rec);
    const accepted = acceptRecommendation(rec, T3);
    await store.upsertRecommendation(accepted);
    expect((await store.listRecommendations()).length).to.equal(1);
    expect(await new LocalRecommendationStore(workspace).getRecommendation(rec.recommendationId)).to.deep.equal(accepted);
    const file = path.join(workspace, '.codesense', 'recommendations.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
    rows.push({ nonsense: true }, 'junk', 42, { ...(rows[0] as Record<string, unknown>), status: 'bogus' });
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    const listed = await new LocalRecommendationStore(workspace).listRecommendations();
    expect(listed.length).to.equal(1);
    expect(parseRecommendation({ nonsense: true })).to.equal(null);
    let threw = false;
    try {
      await store.upsertRecommendation({ nonsense: true } as never);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('41-46. full flow mutates no frozen stores', async () => {
    const workspace = makeWorkspace();
    const problems = new LocalProblemStore(workspace);
    const attempts = new LocalAttemptStore(workspace);
    const evidence = new LocalLearnerEvidenceStore(workspace);
    const goals = new LocalGoalStore(workspace);
    const plans = new LocalActivityPlanStore(workspace);
    const progress = new LocalProgressStore(workspace);
    const reflections = new LocalReflectionStore(workspace);
    const knowledge = new LocalProblemKnowledgeStore(workspace);
    const recs = new LocalRecommendationStore(workspace);
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    await problems.upsertProblem(source);
    await problems.upsertProblem(easyProblem);
    const { solve, evidence: ev, profile } = makeIndicatedInputs(source, classification);
    await attempts.saveAttempt(solve);
    const before = snapshotDir(workspace);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence: ev, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: { ...makeClassification(easyProblem), concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }], tactics: [] }, knowledge: null }],
      attempts: [solve],
    });
    const rec = deriveRecommendation({ decision, selection, now: T2 })!;
    const accepted = acceptRecommendation(rec, T3);
    const practice = makeAttempt({ attemptId: 'att_px', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const prog = makeProgress({ signal: 'IMPROVING', attempt: practice, evaluatedAt: T3E, independent: true, helped: false });
    const completed = applyCompletion(accepted, evaluateCompletion(accepted, [solve, practice], [prog]), T4);
    const revisit = deriveRevisitRecommendation({
      reinforcement: completed,
      assessment: evaluateCompletion(accepted, [solve, practice], [prog]),
      now: T4,
    })!;
    await recs.upsertRecommendation(rec);
    await recs.upsertRecommendation(linkCounterpartRecommendation(completed, revisit.recommendationId, T4));
    await recs.upsertRecommendation(revisit);
    expect(await evidence.listEvidence()).to.deep.equal([]);
    expect(await goals.listGoals()).to.deep.equal([]);
    expect(await plans.listPlans()).to.deep.equal([]);
    expect(await progress.listProgress()).to.deep.equal([]);
    expect(await reflections.listReflections()).to.deep.equal([]);
    expect(await knowledge.listKnowledge()).to.deep.equal([]);
    const after = snapshotDir(workspace);
    for (const [file, content] of before) {
      expect(after.get(file), file).to.equal(content);
    }
    for (const [file] of after) {
      if (!before.has(file)) {
        expect(file).to.equal('recommendations.json');
      }
    }
    expect(graph.getEntity(FW_BS)?.type).to.equal('framework');
  });

  it('47. narrow surface; no J-4+ concepts; time never decides', () => {
    expect(Object.keys(recommendationModule).sort()).to.deep.equal([
      'CHAIN_ID_PREFIX',
      'RECOMMENDATION_ID_PREFIX',
      'RECOMMENDATION_SCHEMA_VERSION',
      'RECOMMENDATION_STATUSES',
      'RECOMMENDATION_TRANSITIONS',
      'acceptRecommendation',
      'applyCompletion',
      'buildExplanation',
      'canonicalIdentityMaterial',
      'chainIdFor',
      'deferRecommendation',
      'deriveRecommendation',
      'deriveRevisitRecommendation',
      'evaluateCompletion',
      'isKnownRecommendationRole',
      'isKnownRecommendationStatus',
      'linkCounterpartRecommendation',
      'markSuperseded',
      'needFingerprintFor',
      'parseRecommendation',
      'recommendationIdFor',
      'skipRecommendation',
    ]);
    expect(deriveRecommendation.length).to.equal(1);
    expect(evaluateCompletion.length).to.equal(3);
    // A 2020-shaped history completes identically: ordering, never decay.
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const rec = { ...offered(), reinforcementProblemId: easyProblem.problemId, sourceProblemId: source.problemId };
    const old = makeAttempt({ attemptId: 'att_old', problem: easyProblem, startedAt: '2020-01-01T10:00:00.000Z', toState: 'Got AC Independently', completedAt: '2020-01-01T10:40:00.000Z' });
    const prog = makeProgress({ signal: 'IMPROVING', attempt: old, evaluatedAt: '2020-01-01T10:40:00.000Z', independent: true, helped: false });
    const offeredOld = { ...rec, createdAt: '2019-01-01T00:00:00.000Z', updatedAt: '2019-01-01T00:00:00.000Z' };
    expect(evaluateCompletion(offeredOld, [old], [prog]).complete).to.equal(true);
  });
});

describe('Phase J-3 — Fix 1 terminal-state protection', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function fixture() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    const rec = deriveRecommendation({ decision, selection, now: T2 })!;
    const rederived = (): LongTermRecommendation => deriveRecommendation({ decision, selection, now: T3 })!;
    return { rec, rederived, easyProblem };
  }

  it('F1.1 skipped survives identical re-derivation', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { rec, rederived } = fixture();
    await store.upsertRecommendation(skipRecommendation(rec, T3));
    await store.upsertRecommendation(rederived());
    expect((await store.getRecommendation(rec.recommendationId))?.status).to.equal('skipped');
  });

  it('F1.2 completed survives identical re-derivation', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { rec, rederived, easyProblem } = fixture();
    const practice = makeAttempt({ attemptId: 'att_f12', problem: easyProblem, startedAt: T3, toState: 'Got AC Independently', completedAt: T3E });
    const prog = makeProgress({ signal: 'IMPROVING', attempt: practice, evaluatedAt: T3E, independent: true, helped: false });
    const done = applyCompletion(acceptRecommendation(rec, T3), evaluateCompletion(rec, [practice], [prog]), T4);
    await store.upsertRecommendation(done);
    await store.upsertRecommendation({ ...rederived(), createdAt: T4, updatedAt: T4 });
    expect((await store.getRecommendation(rec.recommendationId))?.status).to.equal('completed');
  });

  it('F1.3 superseded survives identical re-derivation', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { rec, rederived } = fixture();
    await store.upsertRecommendation(markSuperseded(rec, 'rec_successor', T3));
    await store.upsertRecommendation(rederived());
    const stored = (await store.getRecommendation(rec.recommendationId))!;
    expect(stored.status).to.equal('superseded');
    expect(stored.supersededByRecommendationId).to.equal('rec_successor');
  });

  it('F1.4 accepted/deferred do not regress; forward transitions persist', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { rec, rederived } = fixture();
    await store.upsertRecommendation(acceptRecommendation(rec, T3));
    await store.upsertRecommendation(rederived());
    expect((await store.getRecommendation(rec.recommendationId))?.status).to.equal('accepted');
    await store.upsertRecommendation(deferRecommendation(acceptRecommendation(rec, T3), T4));
    await store.upsertRecommendation(rederived());
    expect((await store.getRecommendation(rec.recommendationId))?.status).to.equal('deferred');
    // Deliberate forward motion still persists through the same upsert path.
    await store.upsertRecommendation(skipRecommendation(acceptRecommendation(rec, T3), T4));
    expect((await store.getRecommendation(rec.recommendationId))?.status).to.equal('skipped');
  });

  it('F1.5 learner choice intact after reload; re-derivation idempotent', async () => {
    const workspace = makeWorkspace();
    const { rec, rederived } = fixture();
    await new LocalRecommendationStore(workspace).upsertRecommendation(skipRecommendation(rec, T3));
    expect((await new LocalRecommendationStore(workspace).getRecommendation(rec.recommendationId))?.status).to.equal('skipped');
    await new LocalRecommendationStore(workspace).upsertRecommendation(rederived());
    await new LocalRecommendationStore(workspace).upsertRecommendation(rederived());
    const listed = await new LocalRecommendationStore(workspace).listRecommendations();
    expect(listed.length).to.equal(1);
    expect(listed[0]!.status).to.equal('skipped');
  });

  it('F1.8 genuinely new IDs coexist with terminal rows', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    const old = deriveRecommendation({ decision, selection, now: T2 })!;
    await store.upsertRecommendation(skipRecommendation(old, T3));
    const extra = makeEvidence({ attempt: solve, entityIds: [CONCEPT_MONO], evidenceType: 'CONCEPTUAL_CONFUSION', confidence: 'medium', timestamp: T1E, evidenceId: 'ev_new_ctx' });
    const decision2 = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence: [...evidence, extra], profile, progress: [], classification, knowledge: null,
    });
    const fresh = deriveRecommendation({ decision: decision2, selection, now: T4 })!;
    expect(fresh.recommendationId).to.not.equal(old.recommendationId);
    await store.upsertRecommendation(fresh);
    const listed = await store.listRecommendations();
    expect(listed.length).to.equal(2);
    expect(listed.map((r) => r.status).sort()).to.deep.equal(['offered', 'skipped']);
  });
});

describe('Phase J-3 — Fix 2 canonical identity', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function fixture() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    return { decision, selection };
  }

  it('F2.1 identical semantic input → identical ID and material', () => {
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    const b = deriveRecommendation({ decision, selection, now: T2 })!;
    expect(a.recommendationId).to.equal(b.recommendationId);
    expect(canonicalIdentityMaterial).to.be.a('function');
  });

  it('F2.2+F2.3 practice-count changes fork identity; old row preserved', async () => {
    const { decision, selection } = fixture();
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    await store.upsertRecommendation(a);
    const before = JSON.stringify(await store.getRecommendation(a.recommendationId));
    const bumped = {
      ...selection,
      candidates: selection.candidates.map((c, i) =>
        i === 0 ? { ...c, timesAttempted: c.timesAttempted + 2 } : c,
      ),
    };
    const b = deriveRecommendation({ decision, selection: bumped, now: T3 })!;
    expect(b.recommendationId).to.not.equal(a.recommendationId);
    const solved = {
      ...selection,
      candidates: selection.candidates.map((c, i) =>
        i === 0 ? { ...c, timesSolved: c.timesSolved + 1 } : c,
      ),
    };
    const c = deriveRecommendation({ decision, selection: solved, now: T3 })!;
    expect(c.recommendationId).to.not.equal(a.recommendationId);
    expect(c.recommendationId).to.not.equal(b.recommendationId);
    await store.upsertRecommendation(b);
    expect(JSON.stringify(await store.getRecommendation(a.recommendationId))).to.equal(before);
    expect((await store.listRecommendations()).length).to.equal(2);
  });

  it('F2.4 solved-attempt-only differences do not fork identity (option B)', () => {
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    const alteredNeed = {
      ...decision.need!,
      solvedAttemptIds: [...decision.need!.solvedAttemptIds, 'att_ghost'],
      reasons: decision.need!.reasons.map((r) => ({ ...r, detail: `${r.detail} (reworded)` })),
    };
    const altered = { ...decision, need: alteredNeed };
    const b = deriveRecommendation({ decision: altered, selection, now: T2 })!;
    // Same kinds + same evidence + same basis → same semantic snapshot…
    expect(b.recommendationId).to.equal(a.recommendationId);
    // …while the excluded prose legitimately differs.
    expect(b.explanation).to.not.equal(a.explanation);
  });

  it('F2.5+F2.6+F2.7 problem and role changes fork identity', () => {
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    const candidate = selection.candidates[0]!;
    const material = {
      role: 'reinforcement' as const,
      sourceProblemId: decision.need!.sourceProblemId,
      reinforcementProblemId: candidate.problemId,
      goalId: a.goalId,
      needFingerprint: needFingerprintFor(decision.need!),
      evidenceFingerprint: hashIdentity([...decision.need!.evidenceIds].sort().join(',')),
      sharedFrameworks: candidate.sharedFrameworks,
      sharedForms: candidate.sharedForms,
      sharedConcepts: candidate.sharedConcepts,
      sharedTactics: candidate.sharedTactics,
      candidateAreas: candidate.candidateAreas,
      sourceAreas: candidate.sourceAreas,
      candidateTimesAttempted: candidate.timesAttempted,
      candidateTimesSolved: candidate.timesSolved,
    };
    expect(recommendationIdFor({ ...material, sourceProblemId: 'prob_other' })).to.not.equal(a.recommendationId);
    expect(recommendationIdFor({ ...material, reinforcementProblemId: 'prob_other' })).to.not.equal(a.recommendationId);
    expect(recommendationIdFor({ ...material, role: 'revisit' })).to.not.equal(a.recommendationId);
    expect(recommendationIdFor({ ...material, goalId: 'goal_other' })).to.not.equal(a.recommendationId);
  });

  it('F2.8+F2.9+F2.10 non-material changes keep identity', () => {
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, sourceProblemLabel: 'Binary Search', now: T2 })!;
    const relabeled = deriveRecommendation({ decision, selection, sourceProblemLabel: 'BS (link)', now: T3 })!;
    expect(relabeled.recommendationId).to.equal(a.recommendationId);
    expect(relabeled.explanation).to.not.equal(a.explanation);
    expect(relabeled.createdAt).to.not.equal(a.createdAt);
  });
});

describe('Phase J-3 — combined fix regression', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function fixture() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source);
    const easyProblem = makeProblem('https://leetcode.com/problems/lower-bound/', 'Lower Bound');
    const easyClassification: ProblemClassification = {
      ...makeClassification(easyProblem),
      concepts: [{ entityId: CONCEPT_MONO, confidence: 'high' }],
      tactics: [],
    };
    const { solve, evidence, profile } = makeIndicatedInputs(source, classification);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const selection = selectReinforcementCandidates({
      need: decision.need!,
      source: { problem: source, classification, knowledge: null },
      candidates: [{ problem: easyProblem, classification: easyClassification, knowledge: null }],
      attempts: [solve],
    });
    return { decision, selection };
  }

  it('E2E-1 skipped A survives same-semantic re-derivation', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    await store.upsertRecommendation(a);
    await store.upsertRecommendation(skipRecommendation(a, T3));
    const same = deriveRecommendation({ decision, selection, now: T4 })!;
    expect(same.recommendationId).to.equal(a.recommendationId);
    await store.upsertRecommendation(same);
    const stored = (await store.getRecommendation(a.recommendationId))!;
    expect(stored.status).to.equal('skipped');
    expect((await store.listRecommendations()).length).to.equal(1);
  });

  it('E2E-2 material practice change forks B while A stays historical', async () => {
    const workspace = makeWorkspace();
    const store = new LocalRecommendationStore(workspace);
    const { decision, selection } = fixture();
    const a = deriveRecommendation({ decision, selection, now: T2 })!;
    await store.upsertRecommendation(a);
    const before = JSON.stringify(await store.getRecommendation(a.recommendationId));
    const changed = {
      ...selection,
      candidates: selection.candidates.map((c) => ({ ...c, timesAttempted: c.timesAttempted + 1 })),
    };
    const b = deriveRecommendation({ decision, selection: changed, now: T3 })!;
    expect(b.recommendationId).to.not.equal(a.recommendationId);
    await store.upsertRecommendation(b);
    expect(JSON.stringify(await store.getRecommendation(a.recommendationId))).to.equal(before);
    expect((await store.getRecommendation(b.recommendationId))?.status).to.equal('offered');
    expect((await store.listRecommendations()).length).to.equal(2);
  });
});
