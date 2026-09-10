import { expect } from 'chai';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { createManualProblem } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import type { ProblemClassification } from 'codesense/knowledge/classification';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt, AttemptState } from 'codesense/attempts/attempt';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { EvidenceType, KnowledgeStatus } from 'codesense/learner/learnerTypes';
import {
  emptyKnowledgeState,
  emptyLearnerProfile,
} from 'codesense/learner/learnerModel';
import type { LearnerKnowledgeState, LearnerMistakePattern, LearnerProfile } from 'codesense/learner/learnerModel';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import type { ActivityProgress, ProgressSignal } from 'codesense/progress/progressTypes';
import type { LearnerReflection } from 'codesense/reflection/reflectionTypes';
import type { LongTermRecommendation } from 'codesense/longterm/recommendation';
import { needFingerprintFor } from 'codesense/longterm/recommendation';
import { detectReinforcementNeed } from 'codesense/longterm/reinforcementNeed';
import {
  STALE_AFTER_DAYS,
  cutoffIso,
  detectRetrievalNeeds,
} from 'codesense/longterm/retrieval';
import {
  RETRIEVAL_CAP,
  buildAgenda,
  isKnownPriorityKind,
  renderAgendaMarkdown,
} from 'codesense/longterm/prioritization';
import type { AgendaInputs } from 'codesense/longterm/prioritization';

/**
 * Phase J-4 — stale-demonstrated retrieval + cross-goal prioritization.
 * Pure derivation over frozen D/F1/F2/F3/G/J state. No scores, no AI.
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
const FRESH = '2026-05-20T10:00:00.000Z';
const NOW = '2026-06-01T00:00:00.000Z';

let graph: KnowledgeGraph;
let evidenceSeq = 0;
let progressSeq = 0;

function makeState(
  entityId: string,
  status: KnowledgeStatus,
  confidence: 'low' | 'medium' | 'high',
  lastObservedAt: string,
  supporting: string[] = [],
  contradicting: string[] = [],
): LearnerKnowledgeState {
  const state = emptyKnowledgeState(entityId, T0);
  state.status = status;
  state.statusConfidence = confidence;
  state.lastObservedAt = lastObservedAt;
  state.updatedAt = lastObservedAt;
  state.supportingEvidenceIds = supporting;
  state.contradictingEvidenceIds = contradicting;
  return state;
}

function makeProfile(states: LearnerKnowledgeState[]): LearnerProfile {
  const profile = emptyLearnerProfile(T0, graph);
  profile.knowledgeStates = states;
  profile.updatedAt = NOW;
  return profile;
}

function makeProblem(url: string, title: string): Problem {
  return createManualProblem(url, { title, statement: `Solve ${title}.` }, T0);
}

function makeClassification(
  problem: Problem,
  buckets: { concepts?: string[]; frameworks?: string[]; forms?: string[]; tactics?: string[] },
): ProblemClassification {
  const ids = (list: string[] | undefined) => (list ?? []).map((entityId) => ({ entityId, confidence: 'high' as const }));
  return {
    problemId: problem.problemId,
    ontologyVersion: '1',
    classifierVersion: '1',
    classifiedAt: T0,
    topics: [],
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
    evidenceId: args.evidenceId ?? `ev_j4_${evidenceSeq}`,
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

function makeGoal(goalId: string, entityIds: string[], status: LearningGoal['status'] = 'active'): LearningGoal {
  return {
    goalId,
    targetKey: `${[...entityIds].sort().join('+')}:implementation`,
    entityIds,
    dimension: 'implementation',
    description: `Improve ${entityIds.join(', ')}.`,
    source: 'evidence-derived',
    status,
    createdAt: T0,
    updatedAt: T0,
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: T0,
      ontologyVersion: '1',
      aggregatorVersion: '1',
      needId: null,
    },
    successCriteria: {
      summary: 'Solve related problems independently.',
      dimension: 'implementation',
      guidance: 'Independent accepted outcomes.',
    },
    progressBaseline: null,
    decidedAt: T0,
  };
}

function makePlan(planId: string, goalId: string, problem: Problem, entityIds: string[], status: ActivityPlan['status']): ActivityPlan {
  return {
    planId,
    goalId,
    goalTargetKey: `${goalId}:implementation`,
    activityKind: 'coding-problem',
    problemId: problem.problemId,
    problemTitle: 'P',
    intent: 'implementation-practice',
    purpose: 'instructional',
    entityIds,
    dimension: 'implementation',
    rationale: 'Test plan.',
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: T0,
      ontologyVersion: '1',
      aggregatorVersion: '1',
      needId: null,
      goalSource: 'evidence-derived',
    },
    expectedEvidence: 'Test.',
    expectedEvidenceTypes: [],
    createdAt: T0,
    updatedAt: T0,
    status,
    position: 0,
    sequenceLength: 1,
    sequenceId: 'seq_j4',
    linkedAttemptId: null,
    provenance: { ontologyVersion: '1', aggregatorVersion: '1', catalogSize: 1 },
  };
}

function makeProgress(args: {
  signal: ProgressSignal;
  goalId: string;
  entityIds: string[];
  evaluatedAt: string;
  progressId?: string;
}): ActivityProgress {
  progressSeq += 1;
  return {
    progressId: args.progressId ?? `prog_j4_${progressSeq}`,
    goalId: args.goalId,
    goalTargetKey: `${args.goalId}:implementation`,
    planId: `plan_j4_${progressSeq}`,
    linkedAttemptId: null,
    goalSource: 'evidence-derived',
    dimension: 'implementation',
    activity: {
      intent: 'implementation-practice',
      purpose: 'instructional',
      entityIds: args.entityIds,
      problemId: 'prob_none',
      problemTitle: 'P',
    },
    baselineRef: { capturedAt: T0, profileUpdatedAt: T0 },
    activityEvidenceIds: [],
    weakEvidenceIds: [],
    goalRelevantNewIds: [],
    entities: args.entityIds.map((entityId) => ({
      entityId,
      baselineLevel: 'UNKNOWN',
      baselineConfidence: 'low',
      currentLevel: null,
      currentConfidence: null,
      positiveNewIds: [],
      negativeNewIds: [],
    })),
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

function makeMistake(mistakeId: string, category: string, entityIds: string[]): LearnerMistakePattern {
  return {
    mistakeId,
    category,
    relatedEntityIds: entityIds,
    occurrences: [{ evidenceId: `ev_${mistakeId}`, attemptId: null, timestamp: T2 }],
    firstObservedAt: T1,
    lastObservedAt: T2,
    status: 'recurring',
    resolvedAt: null,
    confidence: 'medium',
    evidenceIds: [`ev_${mistakeId}`],
  };
}

function makeRecommendation(recId: string, sourceProblemId: string, status: LongTermRecommendation['status'], needFp: string, evidenceIds: string[]): LongTermRecommendation {
  return {
    recommendationId: recId,
    schemaVersion: 1,
    chainId: `chain_${sourceProblemId}`,
    role: 'reinforcement',
    sourceProblemId,
    reinforcementProblemId: 'prob_other',
    goalId: null,
    needFingerprint: needFp,
    evidenceIds: [...evidenceIds].sort(),
    candidateBasis: {
      sharedFrameworks: [FW_BS],
      sharedForms: [],
      sharedConcepts: [],
      sharedTactics: [],
      candidateAreas: 1,
      sourceAreas: 2,
      candidateTimesAttempted: 0,
      candidateTimesSolved: 0,
    },
    explanation: 'Test recommendation.',
    status,
    counterpartRecommendationId: null,
    supersedesRecommendationId: null,
    supersededByRecommendationId: null,
    createdAt: T1,
    updatedAt: T1,
  };
}

function emptyInputs(): AgendaInputs {
  return {
    nowIso: NOW,
    profile: null,
    evidence: [],
    goals: [],
    plans: [],
    progress: [],
    reflections: [],
    attempts: [],
    problems: [],
    classifications: [],
    knowledgeRecords: [],
    recommendations: [],
  };
}

describe('Phase J-4 — retrieval detector (Cases A–F)', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
    for (const id of [FW_BS, FORM_SOA, CONCEPT_MONO, CONCEPT_FEAS, TACTIC_DEF, TACTIC_PROVE]) {
      expect(graph.hasEntity(id), id).to.equal(true);
    }
    expect(STALE_AFTER_DAYS).to.be.greaterThan(0);
  });

  function retrievalInputs(profile: LearnerProfile | null) {
    return {
      profile,
      plans: [],
      attempts: [],
      problems: [],
      classifications: [],
      knowledgeRecords: [],
      nowIso: NOW,
    };
  }

  it('A. stale demonstrated knowledge surfaces as retrieval', () => {
    const needs = detectRetrievalNeeds(
      retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', T1, ['ev_old1'])])),
    );
    expect(needs.length).to.equal(1);
    expect(needs[0]!.entityId).to.equal(CONCEPT_MONO);
    expect(needs[0]!.status).to.equal('demonstrated');
    expect(needs[0]!.lastObservedAt).to.equal(T1);
    expect(needs[0]!.supportingEvidenceIds).to.deep.equal(['ev_old1']);
  });

  it('B. recently observed demonstrated knowledge stays silent', () => {
    const needs = detectRetrievalNeeds(
      retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', FRESH, ['ev_fresh'])])),
    );
    expect(needs).to.deep.equal([]);
  });

  it('C. recent contradictory struggle is not retrieval', () => {
    const needs = detectRetrievalNeeds(
      retrievalInputs(
        makeProfile([makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_neg1', 'ev_neg2'])]),
      ),
    );
    expect(needs).to.deep.equal([]);
  });

  it('D. low/medium-confidence solve follows the J-2 path, not retrieval', () => {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source, { concepts: [CONCEPT_FEAS], tactics: [TACTIC_DEF] });
    const solve = makeAttempt({ attemptId: 'att_d1', problem: source, startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, entityIds: [TACTIC_DEF], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_d_low' }),
    ];
    const profile = makeProfile([makeState(TACTIC_DEF, 'developing', 'low', T1E)]);
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    // The same developing/low entity is neither demonstrated nor strong → no retrieval.
    const needs = detectRetrievalNeeds(retrievalInputs(profile));
    expect(needs).to.deep.equal([]);
  });

  it('E. no evidence at all is not retrieval', () => {
    expect(detectRetrievalNeeds(retrievalInputs(makeProfile([])))).to.deep.equal([]);
    expect(detectRetrievalNeeds(retrievalInputs(null))).to.deep.equal([]);
  });

  it('F. exposure-only evidence is not retrieval', () => {
    const needs = detectRetrievalNeeds(
      retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'exposed', 'high', T1, ['ev_exp'])])),
    );
    expect(needs).to.deep.equal([]);
  });

  it('low-confidence demonstrated and in-flight coverage suppress retrieval', () => {
    const problem = makeProblem('https://leetcode.com/problems/two-sum/', 'Two Sum');
    const lowConf = detectRetrievalNeeds(
      retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'low', T1, ['ev_x'])])),
    );
    expect(lowConf).to.deep.equal([]);
    const plan = makePlan('plan_cov', 'goal_cov', problem, [CONCEPT_MONO], 'offered');
    const covered = detectRetrievalNeeds({
      ...retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_y'])])),
      plans: [plan],
    });
    expect(covered).to.deep.equal([]);
    const recentAttemptProblem = makeProblem('https://leetcode.com/problems/other/', 'Other');
    const classification = makeClassification(recentAttemptProblem, { concepts: [CONCEPT_MONO] });
    const recent = makeAttempt({ attemptId: 'att_cov', problem: recentAttemptProblem, startedAt: FRESH, toState: 'Got WA', completedAt: '2026-05-20T11:00:00.000Z' });
    const coveredByAttempt = detectRetrievalNeeds({
      ...retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_z'])])),
      attempts: [recent],
      problems: [recentAttemptProblem],
      classifications: [classification],
    });
    expect(coveredByAttempt).to.deep.equal([]);
  });

  it('cutoff seam is explicit and invalid reference times fail loudly', () => {
    expect(cutoffIso(NOW, STALE_AFTER_DAYS).localeCompare(NOW)).to.be.lessThan(0);
    expect(() => cutoffIso('not-a-time', STALE_AFTER_DAYS)).to.throw();
    // Narrower window keeps the same old observation silent — policy, not truth.
    const needs = detectRetrievalNeeds({
      ...retrievalInputs(makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', FRESH, ['ev_f'])])),
      staleAfterDays: 365,
    });
    expect(needs).to.deep.equal([]);
  });

  it('malformed D rows are skipped, never fatal', () => {
    const profile = makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', T1, ['ev_ok'])]);
    (profile.knowledgeStates as unknown[]).push(
      { entityId: 42, status: 'demonstrated', statusConfidence: 'high', lastObservedAt: T1 },
      { entityId: 'concept.ghost', status: 'demonstrated', statusConfidence: 'high', lastObservedAt: T1 },
    );
    // 'concept.ghost' is structurally sound (unknown IDs are H's concern, not J-4's);
    // the malformed row is skipped.
    const needs = detectRetrievalNeeds(retrievalInputs(profile));
    expect(needs.map((n) => n.entityId).sort()).to.deep.equal(['concept.ghost', CONCEPT_MONO]);
  });
});

describe('Phase J-4 — cross-goal prioritization', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  beforeEach(() => {
    evidenceSeq = 0;
    progressSeq = 0;
  });

  function indicatedFixture() {
    const source = makeProblem('https://leetcode.com/problems/binary-search/', 'Binary Search');
    const classification = makeClassification(source, { concepts: [CONCEPT_FEAS], tactics: [TACTIC_DEF] });
    const solve = makeAttempt({ attemptId: 'att_r1', problem: source, startedAt: T1, toState: 'Got AC with Help', completedAt: T1E });
    const evidence = [
      makeEvidence({ attempt: solve, entityIds: [TACTIC_DEF], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_r_low' }),
    ];
    const profile = makeProfile([makeState(TACTIC_DEF, 'developing', 'low', T1E)]);
    return { source, classification, solve, evidence, profile };
  }

  it('1+2. stale demonstrated surfaces; fresh stays silent', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_old1'])]),
    });
    expect(agenda.length).to.equal(1);
    expect(agenda[0]!.kind).to.equal('retrieval');
    expect(agenda[0]!.rank).to.equal(1);
    expect(agenda[0]!.entityIds).to.deep.equal([CONCEPT_MONO]);
    expect(agenda[0]!.observedAt).to.equal(T1);
    const silent = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', FRESH, ['ev_new'])]),
    });
    expect(silent).to.deep.equal([]);
  });

  it('3+14. contradictory struggle becomes remediation, ahead of unrelated retrieval', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_neg1']),
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_old1']),
      ]),
      goals: [makeGoal('goal_g1', [FW_BS])],
    });
    expect(agenda.map((p) => p.kind)).to.deep.equal(['remediation', 'retrieval']);
    expect(agenda[0]!.entityIds).to.deep.equal([FW_BS]);
    expect(agenda[0]!.goalId).to.equal('goal_g1');
    expect(agenda[0]!.reason).to.contain('struggle');
    expect(agenda.map((p) => p.rank)).to.deep.equal([1, 2]);
  });

  it('4+5. struggle outranks retrieval; reinforcement outranks retrieval', () => {
    const { source, classification, solve, evidence, profile } = indicatedFixture();
    profile.knowledgeStates.push(makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_old1']));
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile,
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
    });
    const kinds = agenda.map((p) => p.kind);
    expect(kinds[0]).to.equal('reinforcement');
    expect(kinds[kinds.length - 1]).to.equal('retrieval');
    const struggleFirst = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        makeState(FW_BS, 'mixed', 'medium', T2, ['ev_pos'], ['ev_neg']),
        makeState(CONCEPT_MONO, 'demonstrated', 'high', T1, ['ev_old1']),
      ]),
    });
    expect(struggleFirst.map((p) => p.kind)).to.deep.equal(['remediation', 'retrieval']);
  });

  it('recurring mistakes force remediation even on demonstrated entities', () => {
    const profile = makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', T2, ['ev_pos'])]);
    profile.recurringMistakes = [makeMistake('m_offbyone', 'off-by-one', [CONCEPT_MONO])];
    const agenda = buildAgenda({ ...emptyInputs(), profile });
    expect(agenda.length).to.equal(1);
    expect(agenda[0]!.kind).to.equal('remediation');
    expect(agenda[0]!.reason).to.contain('off-by-one');
    // …and the claimed entity is therefore excluded from retrieval.
    expect(agenda[0]!.evidenceIds).to.contain('ev_m_offbyone');
  });

  it('F3 struggle signals claim entities for remediation', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(FORM_SOA, 'developing', 'medium', T2)]),
      progress: [makeProgress({ signal: 'STILL_STRUGGLING', goalId: 'goal_g9', entityIds: [FORM_SOA], evaluatedAt: T2, progressId: 'prog_struggle' })],
    });
    expect(agenda.length).to.equal(1);
    expect(agenda[0]!.kind).to.equal('remediation');
    expect(agenda[0]!.progressIds).to.deep.equal(['prog_struggle']);
  });

  it('responded-but-unemitted learner voice enriches remediation reasons only', () => {
    const reflection: LearnerReflection = {
      reflectionId: 'refl_att9',
      schemaVersion: 1,
      status: 'responded',
      category: 'unsure-why-worked',
      freeText: 'Not sure why it worked.',
      interpretation: {
        entityIds: [FW_BS],
        dimension: 'conceptual',
        evidenceType: 'CONCEPTUAL_CONFUSION',
        confidence: 'low',
        aiAssisted: false,
        learnerConfirmed: true,
      },
      evidenceIds: [],
      provenance: {
        sessionId: null,
        attemptId: 'att_9',
        problemId: 'prob_9',
        problemTitle: null,
        classificationStatus: 'unclassified',
        goalId: null,
        planId: null,
        progressSignal: null,
        source: 'explicit-learner-reflection',
        offeredAt: T1,
        respondedAt: T2,
      },
      createdAt: T1,
      updatedAt: T2,
    };
    const withVoice = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_neg'])]),
      reflections: [reflection],
    });
    const withoutVoice = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_neg'])]),
      reflections: [],
    });
    expect(withVoice.length).to.equal(1);
    expect(withoutVoice.length).to.equal(1);
    expect(withVoice[0]!.kind).to.equal('remediation');
    expect(withVoice[0]!.reason).to.contain('unsure-why-worked');
    expect(withoutVoice[0]!.reason).to.not.contain('unsure-why-worked');
    expect(withVoice[0]!.evidenceIds).to.deep.equal(withoutVoice[0]!.evidenceIds);
  });

  it('6+12. retrieval cap respected; remediation always ahead regardless of staleness', () => {
    const stale = [CONCEPT_MONO, CONCEPT_FEAS, FORM_SOA, TACTIC_DEF, TACTIC_PROVE].map((id, i) =>
      makeState(id, 'strong', 'high', `2025-0${(i % 5) + 1}-01T00:00:00.000Z`, [`ev_old_${i}`]),
    );
    const profile = makeProfile([...stale, makeState(FW_BS, 'struggling', 'high', T2, [], ['ev_neg'])]);
    const agenda = buildAgenda({ ...emptyInputs(), profile });
    expect(agenda[0]!.kind).to.equal('remediation');
    expect(agenda.filter((p) => p.kind === 'retrieval').length).to.equal(RETRIEVAL_CAP);
    expect(RETRIEVAL_CAP).to.be.greaterThan(0);
    const capped = buildAgenda({ ...emptyInputs(), profile, retrievalCap: 1 });
    expect(capped.filter((p) => p.kind === 'retrieval').length).to.equal(1);
    // Stalest-first within the retrieval class only.
    const retrieval = agenda.filter((p) => p.kind === 'retrieval');
    const observed = retrieval.map((p) => p.observedAt ?? '');
    expect([...observed].sort()).to.deep.equal(observed);
  });

  it('7+8+9. deterministic ordering, stable ties, identical snapshots', () => {
    const inputs: AgendaInputs = {
      ...emptyInputs(),
      profile: makeProfile([
        makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_n1']),
        makeState(TACTIC_PROVE, 'mixed', 'medium', T2, ['ev_p'], ['ev_n2']),
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o1']),
      ]),
      goals: [makeGoal('goal_b', [FW_BS]), makeGoal('goal_a', [TACTIC_PROVE])],
    };
    const first = buildAgenda(inputs);
    expect(first.map((p) => p.entityIds[0])).to.deep.equal([FW_BS, TACTIC_PROVE, CONCEPT_MONO]);
    expect(first.map((p) => p.rank)).to.deep.equal([1, 2, 3]);
    // Reordered input arrays must not move the agenda.
    const reordered: AgendaInputs = {
      ...inputs,
      profile: makeProfile([...inputs.profile!.knowledgeStates].reverse()),
      goals: [...inputs.goals].reverse(),
    };
    expect(buildAgenda(reordered)).to.deep.equal(first);
    expect(buildAgenda(inputs)).to.deep.equal(first);
  });

  it('10. unrelated timestamp changes do not alter ranking', () => {
    const base: AgendaInputs = {
      ...emptyInputs(),
      profile: makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o'])]),
      reflections: [
        {
          reflectionId: 'refl_unrelated',
          schemaVersion: 1,
          status: 'offered',
          category: null,
          freeText: null,
          interpretation: null,
          evidenceIds: [],
          provenance: {
            sessionId: null,
            attemptId: 'att_u',
            problemId: 'prob_u',
            problemTitle: null,
            classificationStatus: 'unclassified',
            goalId: null,
            planId: null,
            progressSignal: null,
            source: 'explicit-learner-reflection',
            offeredAt: T1,
            respondedAt: null,
          },
          createdAt: T1,
          updatedAt: T1,
        },
      ],
    };
    const before = buildAgenda(base);
    const touched: AgendaInputs = {
      ...base,
      reflections: base.reflections.map((r) => ({ ...r, offeredAt: FRESH, updatedAt: FRESH })),
    };
    expect(buildAgenda(touched)).to.deep.equal(before);
  });

  it('11. skipped/deferred chains suppress duplicates without creating evidence', () => {
    const { source, classification, solve, evidence, profile } = indicatedFixture();
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    expect(decision.outcome).to.equal('reinforcement-indicated');
    const fp = needFingerprintFor(decision.need!);
    const skipped = makeRecommendation('rec_skipped', source.problemId, 'skipped', fp, decision.need!.evidenceIds);
    const before = JSON.stringify({ evidence, profile });
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile,
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      recommendations: [skipped],
    });
    expect(agenda.filter((p) => p.kind === 'reinforcement')).to.deep.equal([]);
    expect(JSON.stringify({ evidence, profile })).to.equal(before);
    const deferred = makeRecommendation('rec_deferred', source.problemId, 'deferred', 'other_fp', ['ev_other']);
    const live = buildAgenda({
      ...emptyInputs(),
      profile,
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      recommendations: [deferred],
    });
    // A live chain for the same problem is referenced, never duplicated.
    expect(live.filter((p) => p.kind === 'reinforcement').length).to.equal(1);
    expect(live.find((p) => p.kind === 'reinforcement')?.recommendationId).to.equal('rec_deferred');
  });

  it('12. completed chains suppress same-need duplicates but not fresh needs', () => {
    const { source, classification, solve, evidence, profile } = indicatedFixture();
    const decision = detectReinforcementNeed({
      problem: source, attempts: [solve], evidence, profile, progress: [], classification, knowledge: null,
    });
    const fp = needFingerprintFor(decision.need!);
    const done = makeRecommendation('rec_done', source.problemId, 'completed', fp, decision.need!.evidenceIds);
    const suppressed = buildAgenda({
      ...emptyInputs(),
      profile,
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      recommendations: [done],
    });
    expect(suppressed.filter((p) => p.kind === 'reinforcement')).to.deep.equal([]);
    // New evidence → new J-2 fingerprint → the chain no longer covers it.
    const extra = makeEvidence({ attempt: solve, entityIds: [TACTIC_DEF], evidenceType: 'CONCEPTUAL_CONFUSION', confidence: 'medium', timestamp: T2, evidenceId: 'ev_r_new' });
    const fresh = buildAgenda({
      ...emptyInputs(),
      profile,
      evidence: [...evidence, extra],
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      recommendations: [done],
    });
    expect(fresh.filter((p) => p.kind === 'reinforcement').length).to.equal(1);
  });

  it('13. multiple goals compete deterministically; review trails retrieval', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        makeState(TACTIC_PROVE, 'struggling', 'medium', T2, [], ['ev_n']),
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o']),
      ]),
      goals: [makeGoal('goal_b', [TACTIC_PROVE]), makeGoal('goal_a', [TACTIC_PROVE, CONCEPT_MONO])],
      progress: [makeProgress({ signal: 'SUFFICIENT_EVIDENCE_FOR_REVIEW', goalId: 'goal_a', entityIds: [CONCEPT_MONO], evaluatedAt: T2, progressId: 'prog_rev' })],
    });
    expect(agenda.map((p) => p.kind)).to.deep.equal(['remediation', 'retrieval', 'review']);
    expect(agenda[0]!.goalId).to.equal('goal_a');
    expect(agenda[2]!.goalId).to.equal('goal_a');
    expect(agenda[2]!.progressIds).to.deep.equal(['prog_rev']);
  });

  it('15. no scores, weights, or verdict vocabulary anywhere', () => {
    const { source, classification, solve, evidence, profile } = indicatedFixture();
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        ...profile.knowledgeStates,
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o']),
      ]),
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      goals: [makeGoal('goal_g1', [TACTIC_DEF])],
    });
    const text = JSON.stringify(agenda).toLowerCase();
    for (const banned of ['score', 'weight', 'mastery', 'weakness', 'weak', 'forgot', 'mastered', 'ranked by']) {
      expect(text, banned).to.not.contain(banned);
    }
    expect(isKnownPriorityKind('retrieval')).to.equal(true);
    expect(isKnownPriorityKind('bogus')).to.equal(false);
  });

  it('16. every cited ID exists in the input snapshot', () => {
    const { source, classification, solve, profile } = indicatedFixture();
    const cited = makeEvidence({ attempt: solve, entityIds: [TACTIC_DEF], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low', timestamp: T1E, evidenceId: 'ev_cited' });
    const state = profile.knowledgeStates.find((s) => s.entityId === TACTIC_DEF)!;
    state.supportingEvidenceIds = ['ev_cited'];
    profile.recurringMistakes = [{ ...makeMistake('m_x', 'off-by-one', [TACTIC_DEF]), evidenceIds: ['ev_cited'] }];
    const prog = makeProgress({ signal: 'STILL_STRUGGLING', goalId: 'goal_g1', entityIds: [TACTIC_DEF], evaluatedAt: T2, progressId: 'prog_s1' });
    const inputs: AgendaInputs = {
      ...emptyInputs(),
      profile,
      evidence: [cited],
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      goals: [makeGoal('goal_g1', [TACTIC_DEF])],
      progress: [prog],
    };
    const agenda = buildAgenda(inputs);
    const evidenceIds = new Set(inputs.evidence.map((e) => e.evidenceId));
    const progressIds = new Set(inputs.progress.map((p) => p.progressId));
    for (const item of agenda) {
      for (const id of item.evidenceIds) {
        expect(evidenceIds.has(id), id).to.equal(true);
      }
      for (const id of item.progressIds) {
        expect(progressIds.has(id), id).to.equal(true);
      }
    }
    expect(agenda.length).to.be.greaterThan(0);
  });

  it('17. empty data is deterministic', () => {
    expect(buildAgenda(emptyInputs())).to.deep.equal([]);
    expect(buildAgenda(emptyInputs())).to.deep.equal(buildAgenda(emptyInputs()));
    expect(renderAgendaMarkdown([])).to.contain('No long-term priorities');
    expect(renderAgendaMarkdown([])).to.equal(renderAgendaMarkdown([]));
  });

  it('renderer is deterministic and separates retrieval from remediation', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_n']),
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o']),
      ]),
    });
    const first = renderAgendaMarkdown(agenda);
    const second = renderAgendaMarkdown(buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([
        makeState(FW_BS, 'struggling', 'medium', T2, [], ['ev_n']),
        makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_o']),
      ]),
    }));
    expect(first).to.equal(second);
    expect(first).to.contain('| Rank | Kind | Focus | Why |');
    expect(first).to.contain('remediation');
    expect(first).to.contain('retrieval');
    expect(first).to.contain('Previously solid knowledge awaiting reactivation');
    expect(first).to.contain('repeated struggle');
    expect(first.toLowerCase()).to.not.contain("you're weak");
    expect(first.toLowerCase()).to.not.contain('you forgot');
  });

  it('inputs are never mutated', () => {
    const { source, classification, solve, evidence, profile } = indicatedFixture();
    const inputs: AgendaInputs = {
      ...emptyInputs(),
      profile,
      evidence,
      attempts: [solve],
      problems: [source],
      classifications: [classification],
      goals: [makeGoal('goal_g1', [TACTIC_DEF])],
    };
    const before = JSON.stringify(inputs);
    buildAgenda(inputs);
    renderAgendaMarkdown(buildAgenda(inputs));
    expect(JSON.stringify(inputs)).to.equal(before);
  });
});

describe('Phase J-4 — semantic audit hardening (F2 coverage + D contradiction)', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
  });

  function staleStrongInputs() {
    return {
      profile: makeProfile([makeState(CONCEPT_MONO, 'strong', 'high', T1, ['ev_old1'])]),
      plans: [] as ActivityPlan[],
      attempts: [] as Attempt[],
      problems: [] as Problem[],
      classifications: [] as ProblemClassification[],
      knowledgeRecords: [],
      nowIso: NOW,
    };
  }

  it('F2-A. unrelated in-flight plans do not suppress retrieval', () => {
    const problem = makeProblem('https://leetcode.com/problems/other/', 'Other');
    const unrelated = makePlan('plan_other', 'goal_other', problem, [FW_BS], 'started');
    const needs = detectRetrievalNeeds({ ...staleStrongInputs(), plans: [unrelated] });
    expect(needs.map((n) => n.entityId)).to.deep.equal([CONCEPT_MONO]);
  });

  it('F2-B/D. same-entity in-flight plans suppress; terminal plans never do', () => {
    const problem = makeProblem('https://leetcode.com/problems/other/', 'Other');
    for (const status of ['planned', 'offered', 'started'] as const) {
      const needs = detectRetrievalNeeds({
        ...staleStrongInputs(),
        plans: [makePlan(`plan_${status}`, 'goal_x', problem, [CONCEPT_MONO], status)],
      });
      expect(needs, status).to.deep.equal([]);
    }
    for (const status of ['completed', 'skipped', 'cancelled'] as const) {
      const needs = detectRetrievalNeeds({
        ...staleStrongInputs(),
        plans: [makePlan(`plan_${status}`, 'goal_x', problem, [CONCEPT_MONO], status)],
      });
      expect(needs.map((n) => n.entityId), status).to.deep.equal([CONCEPT_MONO]);
    }
  });

  it('F2-C. suppression is entity-level by design (dimension-blind, per spec 5.5)', () => {
    // A plan targeting the same entity in a different dimension still counts
    // as coverage "on that entity". Dimension-slicing would duplicate D's
    // per-dimension authority, and retrieval granularity is the entity
    // (matching D's KnowledgeStatus rollup). Pinned intentionally.
    const problem = makeProblem('https://leetcode.com/problems/other/', 'Other');
    const plan = makePlan('plan_deb', 'goal_x', problem, [CONCEPT_MONO], 'offered');
    const debuggingPlan: ActivityPlan = { ...plan, dimension: 'debugging' };
    const needs = detectRetrievalNeeds({ ...staleStrongInputs(), plans: [debuggingPlan] });
    expect(needs).to.deep.equal([]);
  });

  it('D-E. contradicting IDs with authoritative demonstrated status still retrieve', () => {
    // D weighed the contradiction and kept demonstrated/high: J-4 trusts D
    // rather than re-weighing polarity itself. Pinned intentionally.
    const needs = detectRetrievalNeeds({
      ...staleStrongInputs(),
      profile: makeProfile([makeState(CONCEPT_MONO, 'demonstrated', 'high', T1, ['ev_pos'], ['ev_neg_old'])]),
    });
    expect(needs.map((n) => n.entityId)).to.deep.equal([CONCEPT_MONO]);
  });

  it('D-F. recent struggle can never surface as retrieval, only remediation', () => {
    const agenda = buildAgenda({
      ...emptyInputs(),
      profile: makeProfile([makeState(FW_BS, 'struggling', 'high', T2, [], ['ev_neg'])]),
      evidence: [],
    });
    expect(agenda.length).to.equal(1);
    expect(agenda[0]!.kind).to.equal('remediation');
    expect(JSON.stringify(agenda).toLowerCase()).to.not.contain('retrieval');
  });
});
