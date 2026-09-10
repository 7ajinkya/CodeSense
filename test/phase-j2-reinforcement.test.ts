import { expect } from 'chai';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { ProblemClassification } from 'codesense/knowledge/classification';
import { createManualProblem } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt, AttemptState } from 'codesense/attempts/attempt';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { EvidenceType } from 'codesense/learner/learnerTypes';
import {
  emptyKnowledgeState,
  emptyLearnerProfile,
} from 'codesense/learner/learnerModel';
import type { LearnerKnowledgeState, LearnerProfile } from 'codesense/learner/learnerModel';
import type { ActivityProgress } from 'codesense/progress/progressTypes';
import type { ProgressSignal } from 'codesense/progress/progressTypes';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import { createProblemKnowledge } from 'codesense/longterm/problemKnowledge';
import {
  detectReinforcementNeed,
  isConsolidationSignal,
} from 'codesense/longterm/reinforcementNeed';
import {
  knowledgeSetFor,
  selectReinforcementCandidates,
} from 'codesense/longterm/reinforcementCandidate';
import type { CandidateSource } from 'codesense/longterm/reinforcementCandidate';
import { deriveProblemStats } from 'codesense/longterm/problemStats';
import * as reinforcementNeedModule from 'codesense/longterm/reinforcementNeed';
import * as reinforcementCandidateModule from 'codesense/longterm/reinforcementCandidate';

/**
 * Phase J-2 — reinforcement detection + similar/easier candidate selection.
 * Pure derivation over frozen D/F3/C/J-0/J-1 state. No persistence, no AI.
 */

// Canonical C IDs (verified against the ontology catalog).
const FW_BS = 'framework.binary-search';
const FW_BFS = 'framework.bfs';
const FORM_SOA = 'form.search-on-answer';
const FORM_LB = 'form.lower-upper-bound';
const CONCEPT_MONO = 'concept.monotonicity';
const CONCEPT_FEAS = 'concept.feasibility-predicate';
const CONCEPT_INV = 'concept.invariants';
const TACTIC_DEF = 'tactic.define-feasible-predicate';
const TACTIC_PROVE = 'tactic.prove-monotonicity';
const TACTIC_VISIT = 'tactic.visited-on-enqueue';
const TOPIC_ARRAYS = 'topic.arrays-hashing';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T10:00:00.000Z';
const T1E = '2026-02-01T10:40:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';
const T2E = '2026-03-01T10:40:00.000Z';

let graph: KnowledgeGraph;

function makeProblem(url: string, title: string, difficulty: string | null = null): Problem {
  const problem = createManualProblem(url, { title, statement: `Solve ${title}.` }, T0);
  return difficulty === null ? problem : { ...problem, difficulty };
}

function ref(entityId: string): { entityId: string; confidence: 'high' } {
  return { entityId, confidence: 'high' };
}

function makeClassification(
  problem: Problem,
  buckets: {
    frameworks?: string[];
    forms?: string[];
    concepts?: string[];
    tactics?: string[];
    topics?: string[];
  },
): ProblemClassification {
  const ids = (list: string[] | undefined) => (list ?? []).map(ref);
  return {
    problemId: problem.problemId,
    ontologyVersion: '1',
    classifierVersion: '1',
    classifiedAt: T0,
    topics: ids(buckets.topics),
    concepts: ids(buckets.concepts),
    frameworks: ids(buckets.frameworks),
    forms: ids(buckets.forms),
    patterns: [],
    variants: [],
    tactics: ids(buckets.tactics),
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
  sessionId: string;
  startedAt: string;
  toState: AttemptState;
  completedAt: string;
}): Attempt {
  const attempt = createAttempt({
    attemptId: args.attemptId,
    problemId: args.problem.problemId,
    sessionId: args.sessionId,
    startedAt: args.startedAt,
  });
  transitionAttemptState(attempt, args.toState, 'learner', { timestamp: args.completedAt });
  completeAttempt(attempt, args.completedAt);
  return attempt;
}

let evidenceSeq = 0;
function makeEvidence(args: {
  attempt: Attempt | null;
  problem: Problem;
  entityIds: string[];
  evidenceType: EvidenceType;
  confidence: 'low' | 'medium' | 'high';
  timestamp: string;
  evidenceId?: string;
}): LearnerEvidence {
  evidenceSeq += 1;
  return {
    evidenceId: args.evidenceId ?? `ev_j2_${evidenceSeq}`,
    schemaVersion: 1,
    timestamp: args.timestamp,
    sessionId: 'ses_1',
    attemptId: args.attempt ? args.attempt.attemptId : null,
    problemId: args.problem.problemId,
    entityIds: args.entityIds,
    evidenceType: args.evidenceType,
    source: 'attempt-outcome',
    observation: `Observed ${args.evidenceType}.`,
    interpretation: 'Test interpretation.',
    confidence: args.confidence,
    provenance: { source: 'attempt-outcome', sourceId: args.attempt ? args.attempt.attemptId : null },
  };
}

function makeState(
  entityId: string,
  opts: { status: LearnerKnowledgeState['status']; statusConfidence: 'low' | 'medium' | 'high' },
): LearnerKnowledgeState {
  const state = emptyKnowledgeState(entityId, T0);
  state.status = opts.status;
  state.statusConfidence = opts.statusConfidence;
  for (const dim of ['recognition', 'conceptual', 'implementation', 'debugging', 'transfer', 'independence'] as const) {
    state[dim].confidence = opts.statusConfidence;
  }
  return state;
}

function makeProfile(states: LearnerKnowledgeState[]): LearnerProfile {
  const profile = emptyLearnerProfile(T0, graph);
  profile.knowledgeStates = states;
  return profile;
}

let progressSeq = 0;
function makeProgress(args: {
  signal: ProgressSignal;
  problem: Problem;
  linkedAttemptId: string | null;
  evaluatedAt: string;
}): ActivityProgress {
  progressSeq += 1;
  return {
    progressId: `prog_j2_${progressSeq}`,
    goalId: 'goal_j2',
    goalTargetKey: 'target_j2',
    planId: `plan_j2_${progressSeq}`,
    linkedAttemptId: args.linkedAttemptId,
    goalSource: 'evidence-derived',
    dimension: 'implementation',
    activity: {
      intent: 'implementation-practice',
      purpose: 'instructional',
      entityIds: [CONCEPT_MONO],
      problemId: args.problem.problemId,
      problemTitle: 'Source',
    },
    baselineRef: { capturedAt: T0, profileUpdatedAt: T0 },
    activityEvidenceIds: [],
    weakEvidenceIds: [],
    goalRelevantNewIds: [],
    entities: [],
    independence: {
      independent: false,
      helped: false,
      helpLevels: [],
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

function sourceFixture(): { problem: Problem; classification: ProblemClassification } {
  const problem = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
  const classification = makeClassification(problem, {
    frameworks: [FW_BS],
    forms: [FORM_SOA],
    concepts: [CONCEPT_MONO, CONCEPT_FEAS],
    tactics: [TACTIC_DEF, TACTIC_PROVE],
  });
  return { problem, classification };
}

function candidateFixture(
  url: string,
  title: string,
  buckets: { frameworks?: string[]; forms?: string[]; concepts?: string[]; tactics?: string[]; topics?: string[] },
  difficulty: string | null = null,
): CandidateSource {
  const problem = makeProblem(url, title, difficulty);
  return { problem, classification: makeClassification(problem, buckets), knowledge: null };
}

describe('Phase J-2 — reinforcement detection', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
    for (const id of [FW_BS, FW_BFS, FORM_SOA, FORM_LB, CONCEPT_MONO, CONCEPT_FEAS, CONCEPT_INV, TACTIC_DEF, TACTIC_PROVE, TACTIC_VISIT, TOPIC_ARRAYS]) {
      expect(graph.hasEntity(id), id).to.equal(true);
    }
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  it('A. consolidated problem → no reinforcement', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_a1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const profile = makeProfile(
      [FW_BS, FORM_SOA, CONCEPT_MONO, CONCEPT_FEAS, TACTIC_DEF, TACTIC_PROVE].map((id) =>
        makeState(id, { status: 'demonstrated', statusConfidence: 'high' }),
      ),
    );
    const decision = detectReinforcementNeed({
      problem,
      attempts: [solve],
      evidence: [],
      profile,
      progress: [makeProgress({ signal: 'IMPROVING', problem, linkedAttemptId: solve.attemptId, evaluatedAt: T2 })],
      classification,
      knowledge: null,
    });
    expect(decision.outcome).to.equal('no-reinforcement-needed');
    expect(decision.need).to.equal(null);
    expect(decision.reasons.map((r) => r.kind)).to.deep.equal(['consolidated-strength']);
  });

  it('B. solved with help + low-confidence evidence → indicated', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_b1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const decision = detectReinforcementNeed({
      problem, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    expect(decision.need?.sourceProblemId).to.equal(problem.problemId);
    expect(decision.need?.solvedAttemptIds).to.deep.equal([solve.attemptId]);
    expect(decision.need?.targetEntityIds).to.contain(FW_BS);
    expect(decision.need?.reasons.length).to.be.greaterThanOrEqual(2);
    expect(decision.need?.evidenceIds).to.contain(evidence[0]!.evidenceId);
  });

  it('C. medium-confidence evidence + F3 mixed signal → indicated', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_c1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [CONCEPT_MONO], evidenceType: 'CONCEPTUAL_CONFUSION', confidence: 'medium', timestamp: T1E }),
    ];
    const decision = detectReinforcementNeed({
      problem,
      attempts: [solve],
      evidence,
      profile: null,
      progress: [makeProgress({ signal: 'MIXED_SIGNAL', problem, linkedAttemptId: solve.attemptId, evaluatedAt: T2 })],
      classification,
      knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    expect(decision.need?.reasons.map((r) => r.kind).sort()).to.deep.equal(['f3-struggle-signal', 'low-confidence-evidence']);
  });

  it('D. one noisy signal → insufficient, never a weakness verdict', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_d1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const decision = detectReinforcementNeed({
      problem, attempts: [solve], evidence, profile: null, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('insufficient-evidence');
    expect(decision.need).to.equal(null);
    expect(JSON.stringify(decision).toLowerCase()).to.not.contain('weak');
    expect(JSON.stringify(decision).toLowerCase()).to.not.contain('struggling');
  });

  it('never-solved problem → no reinforcement (not initial-learning business)', () => {
    const { problem, classification } = sourceFixture();
    const failed = makeAttempt({ attemptId: 'att_n1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got WA', completedAt: T1E });
    const decision = detectReinforcementNeed({
      problem, attempts: [failed], evidence: [], profile: null, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('no-reinforcement-needed');
    expect(decision.reasons.map((r) => r.kind)).to.deep.equal(['no-solved-attempt']);
  });

  it('M. J-1 notes are pointers, not evidence — notes alone never trigger', () => {
    const { problem } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_m1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const knowledge = createProblemKnowledge({
      problem,
      graph,
      input: {
        conceptIds: [CONCEPT_MONO],
        tacticIds: [TACTIC_DEF],
        keyInsight: 'The predicate flips exactly once.',
        learnerNotes: 'I finally understood the invariant',
      },
      now: T1E,
    });
    const decision = detectReinforcementNeed({
      problem, attempts: [solve], evidence: [], profile: null, progress: [], classification: null, knowledge,
    });
    // Targets ARE established from the record (pointers work)…
    expect(decision.outcome).to.equal('insufficient-evidence');
    // …but notes create no signal on their own.
    expect(decision.need).to.equal(null);
    expect(decision.reasons).to.deep.equal([]);
  });

  it('L-detection. unclassified + no record → safe abstention', () => {
    const { problem } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_l1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const decision = detectReinforcementNeed({
      problem, attempts: [solve], evidence: [], profile: null, progress: [], classification: null, knowledge: null,
    });
    expect(decision.outcome).to.equal('insufficient-evidence');
    expect(decision.reasons.map((r) => r.kind)).to.deep.equal(['no-structured-knowledge']);
  });

  it('repeated attempt rows cannot inflate the decision (idempotent input)', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_r1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const inputs = { problem, evidence, profile, progress: [], classification, knowledge: null };
    const once = detectReinforcementNeed({ ...inputs, attempts: [solve] });
    const twice = detectReinforcementNeed({ ...inputs, attempts: [solve, { ...solve }] });
    expect(twice).to.deep.equal(once);
  });
});

describe('Phase J-2 — candidate selection', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function indicatedNeed(source: CandidateSource, solve: Attempt): NonNullable<ReturnType<typeof detectReinforcementNeed>['need']> {
    const evidence = [
      makeEvidence({ attempt: solve, problem: source.problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const decision = detectReinforcementNeed({
      problem: source.problem,
      attempts: [solve],
      evidence,
      profile,
      progress: [],
      classification: source.classification,
      knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    return decision.need!;
  }

  function sourceWithSolve(): { source: CandidateSource; solve: Attempt } {
    const { problem, classification } = sourceFixture();
    const source: CandidateSource = { problem, classification, knowledge: null };
    const solve = makeAttempt({ attemptId: 'att_s1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    return { source, solve };
  }

  it('E. relevant candidate sharing core knowledge is selected with reasons', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const easy = candidateFixture('https://leetcode.com/problems/lower-bound/', 'Lower Bound', {
      frameworks: [FW_BS],
      concepts: [CONCEPT_MONO],
    });
    const selection = selectReinforcementCandidates({ need, source, candidates: [easy], attempts: [solve] });
    expect(selection.outcome).to.equal('candidate-found');
    expect(selection.candidates.length).to.equal(1);
    const [found] = selection.candidates;
    expect(found!.problemId).to.equal(easy.problem.problemId);
    expect(found!.sharedFrameworks).to.deep.equal([FW_BS]);
    expect(found!.candidateAreas).to.be.lessThan(6);
    expect(found!.orderingBasis.length).to.be.greaterThan(0);
    expect(selection.rejected).to.deep.equal([]);
  });

  it('F+H+I. irrelevant, self, and canonical-duplicate candidates are rejected', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const other = candidateFixture('https://leetcode.com/problems/rotting-oranges/', 'Rotting Oranges', {
      frameworks: [FW_BFS],
      tactics: [TACTIC_VISIT],
    });
    const duplicate = candidateFixture('https://leetcode.com/problems/binary-search/?ref=x', 'Binary Search Copy', {
      frameworks: [FW_BS],
    });
    expect(duplicate.problem.problemId).to.equal(source.problem.problemId);
    const selection = selectReinforcementCandidates({
      need,
      source,
      candidates: [source, other, duplicate],
      attempts: [solve],
    });
    expect(selection.outcome).to.equal('no-suitable-candidate');
    expect(selection.candidates).to.deep.equal([]);
    const byId = new Map(selection.rejected.map((r) => [r.problemId, r.excludedReason]));
    expect(byId.get(source.problem.problemId)).to.equal('self-exclusion');
    expect(byId.get(other.problem.problemId)).to.equal('no-shared-core-knowledge');
  });

  it('G. verbatim difficulty labels never order candidates (documented limitation)', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const narrowHard = candidateFixture('https://leetcode.com/problems/narrow-hard/', 'Narrow Hard', {
      frameworks: [FW_BS],
      forms: [FORM_SOA],
    }, 'Hard');
    const broadEasy = candidateFixture('https://leetcode.com/problems/broad-easy/', 'Broad Easy', {
      frameworks: [FW_BS],
      concepts: [CONCEPT_MONO, CONCEPT_FEAS],
      tactics: [TACTIC_DEF],
    }, 'Easy');
    const first = selectReinforcementCandidates({ need, source, candidates: [broadEasy, narrowHard], attempts: [solve] });
    expect(first.outcome).to.equal('candidate-found');
    // More focused wins despite the scarier label.
    expect(first.candidates[0]!.problemId).to.equal(narrowHard.problem.problemId);
    // Swapping the labels changes nothing — labels are opaque context.
    const swappedHard = { ...narrowHard, problem: { ...narrowHard.problem, difficulty: 'Easy' } };
    const swappedEasy = { ...broadEasy, problem: { ...broadEasy.problem, difficulty: 'Hard' } };
    const second = selectReinforcementCandidates({ need, source, candidates: [swappedEasy, swappedHard], attempts: [solve] });
    expect(second.candidates.map((c) => c.problemId)).to.deep.equal(first.candidates.map((c) => c.problemId));
  });

  it('J. practiced candidates deprioritized; twice-solved excluded', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const fresh = candidateFixture('https://leetcode.com/problems/fresh-easy/', 'Fresh', { frameworks: [FW_BS] });
    const practiced = candidateFixture('https://leetcode.com/problems/seen-once/', 'Seen Once', {
      frameworks: [FW_BS],
      concepts: [CONCEPT_MONO],
    });
    const spent = candidateFixture('https://leetcode.com/problems/spent-twice/', 'Spent', { frameworks: [FW_BS] });
    const seenAttempts = [
      makeAttempt({ attemptId: 'att_j1', problem: practiced.problem, sessionId: 'ses_9', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E }),
      makeAttempt({ attemptId: 'att_j2', problem: spent.problem, sessionId: 'ses_9', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E }),
      makeAttempt({ attemptId: 'att_j3', problem: spent.problem, sessionId: 'ses_9', startedAt: T2, toState: 'Got AC with Help', completedAt: T2E }),
    ];
    const selection = selectReinforcementCandidates({
      need, source, candidates: [practiced, spent, fresh], attempts: [solve, ...seenAttempts],
    });
    expect(selection.outcome).to.equal('candidate-found');
    expect(selection.candidates.map((c) => c.problemId)).to.deep.equal([
      fresh.problem.problemId,
      practiced.problem.problemId,
    ]);
    const spentRejection = selection.rejected.find((r) => r.problemId === spent.problem.problemId);
    expect(spentRejection?.excludedReason).to.equal('already-consolidated');
  });

  it('K. no suitable candidate → explicit outcome, never forced', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const broad = candidateFixture('https://leetcode.com/problems/big-one/', 'Big One', {
      frameworks: [FW_BS],
      forms: [FORM_SOA],
      concepts: [CONCEPT_MONO, CONCEPT_FEAS, CONCEPT_INV],
      tactics: [TACTIC_DEF, TACTIC_PROVE, TACTIC_VISIT],
    });
    const selection = selectReinforcementCandidates({ need, source, candidates: [broad], attempts: [solve] });
    expect(selection.outcome).to.equal('no-suitable-candidate');
    expect(selection.candidates).to.deep.equal([]);
    expect(selection.rejected[0]!.excludedReason).to.equal('not-more-focused');
  });

  it('adversarial: all irrelevant, topic-only overlap, superficial metadata, missing data', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const topicOnly = candidateFixture('https://leetcode.com/problems/some-array/', 'Some Array', {
      topics: [TOPIC_ARRAYS],
      concepts: [CONCEPT_INV],
    });
    const superficial = candidateFixture('https://leetcode.com/problems/other-bs/', 'Other BS', {
      concepts: [CONCEPT_INV],
      tactics: [TACTIC_VISIT],
    }, 'Easy');
    const missing: CandidateSource = {
      problem: makeProblem('https://leetcode.com/problems/mystery/', 'Mystery'),
      classification: null,
      knowledge: null,
    };
    const selection = selectReinforcementCandidates({
      need, source, candidates: [topicOnly, superficial, missing], attempts: [solve],
    });
    expect(selection.outcome).to.equal('no-suitable-candidate');
    expect(selection.candidates).to.deep.equal([]);
    const reasons = new Map(selection.rejected.map((r) => [r.problemId, r.excludedReason]));
    expect(reasons.get(topicOnly.problem.problemId)).to.equal('no-shared-core-knowledge');
    expect(reasons.get(superficial.problem.problemId)).to.equal('no-shared-core-knowledge');
    expect(reasons.get(missing.problem.problemId)).to.equal('insufficient-structured-similarity');
  });

  it('adversarial: original listed many times collapses to one exclusion; need mismatch throws', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const again: CandidateSource = { ...source };
    const selection = selectReinforcementCandidates({ need, source, candidates: [source, again], attempts: [solve] });
    expect(selection.rejected.filter((r) => r.problemId === source.problem.problemId).length).to.equal(1);
    const foreign = candidateFixture('https://leetcode.com/problems/foreign/', 'Foreign', { frameworks: [FW_BS] });
    const foreignNeed = { ...need, sourceProblemId: foreign.problem.problemId };
    expect(() => selectReinforcementCandidates({ need: foreignNeed, source, candidates: [], attempts: [] })).to.throw();
  });

  it('adversarial: skipped F2 plan contributes no signal (non-compliance is not evidence)', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_skip1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const skippedPlan: ActivityPlan = {
      planId: 'plan_skipped',
      goalId: 'goal_j2',
      goalTargetKey: 'target_j2',
      activityKind: 'coding-problem',
      problemId: problem.problemId,
      problemTitle: 'Binary Search',
      intent: 'implementation-practice',
      purpose: 'instructional',
      entityIds: [FW_BS],
      dimension: 'implementation',
      rationale: 'Skipped by the learner.',
      evidenceBasis: {
        evidenceIds: [],
        profileUpdatedAt: T0,
        ontologyVersion: '1',
        aggregatorVersion: '1',
        needId: null,
        goalSource: 'evidence-derived',
      },
      expectedEvidence: 'None — skipped.',
      expectedEvidenceTypes: [],
      createdAt: T2,
      updatedAt: T2,
      status: 'skipped',
      position: 0,
      sequenceLength: 1,
      sequenceId: 'seq_skipped',
      linkedAttemptId: null,
      provenance: { ontologyVersion: '1', aggregatorVersion: '1', catalogSize: 1 },
    };
    // The skipped plan links no attempt, so the J-2 inputs are byte-identical
    // with or without its existence — skipping cannot become a signal.
    expect(skippedPlan.linkedAttemptId).to.equal(null);
    const inputs = { problem, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null };
    expect(detectReinforcementNeed(inputs).outcome).to.equal('reinforcement-indicated');
  });

  it('Q+R. determinism under reordering; idempotent repetition', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    const a = candidateFixture('https://leetcode.com/problems/cand-a/', 'A', { frameworks: [FW_BS] });
    const b = candidateFixture('https://leetcode.com/problems/cand-b/', 'B', {
      frameworks: [FW_BS],
      concepts: [CONCEPT_MONO],
    });
    const first = selectReinforcementCandidates({ need, source, candidates: [a, b], attempts: [solve] });
    const reordered = selectReinforcementCandidates({ need, source, candidates: [b, a], attempts: [solve] });
    expect(reordered).to.deep.equal(first);
    expect(selectReinforcementCandidates({ need, source, candidates: [a, b], attempts: [solve] })).to.deep.equal(first);
    const needInputs = {
      problem: source.problem,
      attempts: [solve],
      evidence: [
        makeEvidence({ attempt: solve, problem: source.problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_qr_fixed' }),
      ],
      profile: makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]),
      progress: [],
      classification: source.classification,
      knowledge: null,
    };
    const n1 = detectReinforcementNeed(needInputs);
    const n2Evidence = [
      makeEvidence({ attempt: solve, problem: source.problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_qr_fixed' }),
    ];
    const n2 = detectReinforcementNeed({ ...needInputs, evidence: n2Evidence });
    expect(n2).to.deep.equal(n1);
  });

  it('X. every output is explainable through structured basis', () => {
    const { source, solve } = sourceWithSolve();
    const need = indicatedNeed(source, solve);
    for (const reason of need.reasons) {
      expect(reason.kind.length).to.be.greaterThan(0);
      expect(reason.detail.length).to.be.greaterThan(0);
    }
    expect(need.evidenceIds.length).to.be.greaterThan(0);
    const easy = candidateFixture('https://leetcode.com/problems/lower-bound/', 'Lower Bound', {
      frameworks: [FW_BS],
      concepts: [CONCEPT_MONO],
    });
    const selection = selectReinforcementCandidates({ need, source, candidates: [easy], attempts: [solve] });
    const [found] = selection.candidates;
    expect(found!.orderingBasis.join(' ')).to.contain(FW_BS);
    expect(JSON.stringify(selection).toLowerCase()).to.not.contain('similarity');
  });
});

describe('Phase J-2 — boundaries', () => {
  it('N+O+P. inputs and frozen projections are not mutated', () => {
    const { problem, classification } = sourceFixture();
    const solve = makeAttempt({ attemptId: 'att_n1', problem, sessionId: 'ses_1', startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const progress = [makeProgress({ signal: 'MIXED_SIGNAL', problem, linkedAttemptId: solve.attemptId, evaluatedAt: T2 })];
    const inputs = { problem, attempts: [solve], evidence, profile, progress, classification, knowledge: null };
    const before = JSON.stringify(inputs);
    const statsBefore = JSON.stringify(deriveProblemStats([problem], [solve]));
    const decision = detectReinforcementNeed(inputs);
    expect(JSON.stringify(inputs)).to.equal(before);
    expect(JSON.stringify(deriveProblemStats([problem], [solve]))).to.equal(statsBefore);
    expect(graph.hasEntity(FW_BS)).to.equal(true);
    expect(graph.getEntity(FW_BS)?.type).to.equal('framework');
    if (decision.outcome === 'reinforcement-indicated' && decision.need) {
      const easy = candidateFixture('https://leetcode.com/problems/lower-bound/', 'Lower Bound', {
        frameworks: [FW_BS],
      });
      const selInputs = {
        need: decision.need,
        source: { problem, classification, knowledge: null } as CandidateSource,
        candidates: [easy],
        attempts: [solve],
      };
      const selBefore = JSON.stringify(selInputs);
      selectReinforcementCandidates(selInputs);
      expect(JSON.stringify(selInputs)).to.equal(selBefore);
    } else {
      expect.fail('expected reinforcement to be indicated for the boundary fixture');
    }
  });

  it('S+T+U+V+W. narrow export surface: no persistence, I, lifecycle, staleness, or priority engine', () => {
    expect(Object.keys(reinforcementNeedModule).sort()).to.deep.equal([
      'MAX_REASON_EVIDENCE_IDS',
      'MIN_CORROBORATING_SIGNALS',
      'detectReinforcementNeed',
      'isConsolidationSignal',
      'targetEntitiesFor',
    ]);
    expect(Object.keys(reinforcementCandidateModule).sort()).to.deep.equal([
      'MAX_CANDIDATE_SOLVES',
      'knowledgeSetFor',
      'selectReinforcementCandidates',
    ]);
    // Single-input pure APIs: no `now`, no thresholds, no goal/plan params.
    expect(detectReinforcementNeed.length).to.equal(1);
    expect(selectReinforcementCandidates.length).to.equal(1);
    // Timestamps do not decay: a 2020-shaped history decides identically.
    const { problem, classification } = sourceFixture();
    const old = makeAttempt({ attemptId: 'att_old', problem, sessionId: 'ses_0', startedAt: '2020-01-01T10:00:00.000Z', toState: 'Got AC with Help', completedAt: '2020-01-01T10:40:00.000Z' });
    const oldEvidence = [
      makeEvidence({ attempt: old, problem, entityIds: [FW_BS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: '2020-01-01T10:40:00.000Z' }),
    ];
    const profile = makeProfile([makeState(FW_BS, { status: 'developing', statusConfidence: 'low' })]);
    const decision = detectReinforcementNeed({
      problem, attempts: [old], evidence: oldEvidence, profile, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
  });

  it('isConsolidationSignal reads F3 vocabulary without re-deriving it', () => {
    expect(isConsolidationSignal('IMPROVING')).to.equal(true);
    expect(isConsolidationSignal('SUFFICIENT_EVIDENCE_FOR_REVIEW')).to.equal(true);
    expect(isConsolidationSignal('UNCERTAINTY_REDUCED')).to.equal(true);
    expect(isConsolidationSignal('STILL_STRUGGLING')).to.equal(false);
    expect(isConsolidationSignal('MIXED_SIGNAL')).to.equal(false);
  });
});
