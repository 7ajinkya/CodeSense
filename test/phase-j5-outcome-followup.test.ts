import { expect } from 'chai';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt, AttemptState } from 'codesense/attempts/attempt';
import type { ActivityProgress, ProgressSignal } from 'codesense/progress/progressTypes';
import type { LongTermRecommendation } from 'codesense/longterm/recommendation';
import { observeOutcomes } from 'codesense/longterm/outcomeFollowUp';
import * as outcomeFollowUpModule from 'codesense/longterm/outcomeFollowUp';

/**
 * Phase J-5 Stage 2 — outcome observation and follow-up routing.
 * Thin orchestration over frozen J-3 semantics only. Each test targets
 * Stage 2 behavior (observation/no-op/idempotency/routing); J-3/F3 unit
 * semantics are covered by their frozen suites and are not re-proven here.
 */

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T10:00:00.000Z';
const T1E = '2026-02-01T10:40:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';
const NOW = '2026-04-01T10:00:00.000Z';

let progressSeq = 0;

function makeRecommendation(overrides: Partial<LongTermRecommendation> = {}): LongTermRecommendation {
  return {
    recommendationId: 'rec_obs_1',
    schemaVersion: 1,
    chainId: 'chain_obs_1',
    role: 'reinforcement',
    sourceProblemId: 'prob_source',
    reinforcementProblemId: 'prob_reinforce',
    goalId: 'goal_1',
    needFingerprint: 'fp_need',
    evidenceIds: ['ev_1'],
    candidateBasis: {
      sharedFrameworks: ['framework.binary-search'],
      sharedForms: [],
      sharedConcepts: [],
      sharedTactics: [],
      candidateAreas: 1,
      sourceAreas: 2,
      candidateTimesAttempted: 0,
      candidateTimesSolved: 0,
    },
    explanation: 'Stored J-3 explanation.',
    status: 'offered',
    counterpartRecommendationId: null,
    supersedesRecommendationId: null,
    supersededByRecommendationId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeAttempt(args: {
  attemptId: string;
  problemId: string;
  startedAt: string;
  toState: AttemptState;
  completedAt: string;
}): Attempt {
  const attempt = createAttempt({ attemptId: args.attemptId, problemId: args.problemId, sessionId: 'ses_1', startedAt: args.startedAt });
  transitionAttemptState(attempt, args.toState, 'learner', { timestamp: args.completedAt });
  completeAttempt(attempt, args.completedAt);
  return attempt;
}

function makeProgress(args: {
  attemptId: string;
  signal: ProgressSignal;
  evaluatedAt: string;
  planId?: string;
}): ActivityProgress {
  progressSeq += 1;
  return {
    progressId: `prog_obs_${progressSeq}`,
    goalId: 'goal_1',
    goalTargetKey: 'target_1',
    planId: args.planId ?? `plan_obs_${progressSeq}`,
    linkedAttemptId: args.attemptId,
    goalSource: 'evidence-derived',
    dimension: 'implementation',
    activity: {
      intent: 'implementation-practice',
      purpose: 'instructional',
      entityIds: ['framework.binary-search'],
      problemId: 'prob_reinforce',
      problemTitle: 'P',
    },
    baselineRef: { capturedAt: T0, profileUpdatedAt: T0 },
    activityEvidenceIds: [],
    weakEvidenceIds: [],
    goalRelevantNewIds: [],
    entities: [],
    independence: {
      independent: true,
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
    evidenceFingerprint: `fp_obs_${progressSeq}`,
    signalHistory: [],
    provenance: { ontologyVersion: '1', aggregatorVersion: '1' },
  };
}

describe('Phase J-5 Stage 2 — outcome observation', () => {
  beforeEach(() => {
    progressSeq = 0;
  });

  it('empty snapshots yield an empty result', () => {
    expect(observeOutcomes({ recommendations: [], attempts: [], progress: [], now: NOW })).to.deep.equal({
      completed: [],
      revisits: [],
      observations: [],
    });
  });

  it('valid completion completes the row and derives the revisit', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_1', signal: 'IMPROVING', evaluatedAt: T1E });
    const result = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW });
    expect(result.completed.length).to.equal(1);
    expect(result.completed[0]!.status).to.equal('completed');
    expect(result.completed[0]!.updatedAt).to.equal(NOW);
    expect(result.revisits.length).to.equal(1);
    expect(result.revisits[0]!.role).to.equal('revisit');
    expect(result.revisits[0]!.sourceProblemId).to.equal('prob_source');
    expect(result.revisits[0]!.chainId).to.equal('chain_obs_1');
    expect(result.revisits[0]!.counterpartRecommendationId).to.equal('rec_obs_1');
    expect(result.revisits[0]!.createdAt).to.equal(NOW);
    expect(result.observations).to.deep.equal([
      { recommendationId: 'rec_obs_1', completed: true, ground: 'attempt-and-progress', revisit: result.revisits[0] },
    ]);
  });

  it('wrong problem, pre-offer, and missing progress all fail closed', () => {
    const rec = makeRecommendation();
    const foreign = makeAttempt({ attemptId: 'att_f', problemId: 'prob_other', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const foreignProgress = makeProgress({ attemptId: 'att_f', signal: 'IMPROVING', evaluatedAt: T1E });
    const wrong = observeOutcomes({ recommendations: [rec], attempts: [foreign], progress: [foreignProgress], now: NOW });
    expect(wrong.completed).to.deep.equal([]);
    expect(wrong.revisits).to.deep.equal([]);
    expect(wrong.observations[0]!.ground).to.equal('missing-attempt');

    const early = makeAttempt({ attemptId: 'att_e', problemId: 'prob_reinforce', startedAt: '2025-01-01T00:00:00.000Z', toState: 'Got AC Independently', completedAt: '2025-01-01T00:40:00.000Z' });
    const earlyProgress = makeProgress({ attemptId: 'att_e', signal: 'IMPROVING', evaluatedAt: '2025-01-01T00:40:00.000Z' });
    expect(
      observeOutcomes({ recommendations: [rec], attempts: [early], progress: [earlyProgress], now: NOW }).observations[0]!.ground,
    ).to.equal('missing-attempt');

    const unlinked = makeAttempt({ attemptId: 'att_u', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const missing = observeOutcomes({ recommendations: [rec], attempts: [unlinked], progress: [], now: NOW });
    expect(missing.completed).to.deep.equal([]);
    expect(missing.observations[0]).to.deep.include({ completed: false, ground: 'missing-progress' });
  });

  it('accepted rows evaluate; terminal and deferred rows are reported untouched', () => {
    const base = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_1', signal: 'IMPROVING', evaluatedAt: T1E });
    const accepted = observeOutcomes({
      recommendations: [{ ...base, status: 'accepted' }],
      attempts: [attempt],
      progress: [progress],
      now: NOW,
    });
    expect(accepted.completed.length).to.equal(1);

    const terminal = observeOutcomes({
      recommendations: [
        { ...base, recommendationId: 'rec_skipped', status: 'skipped' },
        { ...base, recommendationId: 'rec_done', status: 'completed' },
        { ...base, recommendationId: 'rec_sup', status: 'superseded' },
        { ...base, recommendationId: 'rec_def', status: 'deferred' },
      ],
      attempts: [attempt],
      progress: [progress],
      now: NOW,
    });
    expect(terminal.completed).to.deep.equal([]);
    expect(terminal.revisits).to.deep.equal([]);
    expect(terminal.observations).to.deep.equal([
      { recommendationId: 'rec_skipped', completed: false, ground: null, revisit: null },
      { recommendationId: 'rec_done', completed: false, ground: null, revisit: null },
      { recommendationId: 'rec_sup', completed: false, ground: null, revisit: null },
      { recommendationId: 'rec_def', completed: false, ground: null, revisit: null },
    ]);
  });

  it('repeated observation is idempotent, including duplicate input rows', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_1', signal: 'IMPROVING', evaluatedAt: T1E });
    const first = observeOutcomes({ recommendations: [rec, { ...rec }], attempts: [attempt, attempt], progress: [progress], now: NOW });
    expect(first.observations.length).to.equal(1);
    expect(first.completed.length).to.equal(1);
    const second = observeOutcomes({
      recommendations: [...first.completed, ...first.revisits],
      attempts: [attempt],
      progress: [progress],
      now: T2,
    });
    // Completed rows are terminal (reported untouched); the fresh revisit row
    // targets the source problem, for which no attempt exists here.
    expect(second.completed).to.deep.equal([]);
    expect(second.revisits).to.deep.equal([]);
    expect(second.observations).to.deep.equal([
      { recommendationId: 'rec_obs_1', completed: false, ground: null, revisit: null },
      { recommendationId: first.revisits[0]!.recommendationId, completed: false, ground: 'missing-attempt', revisit: null },
    ]);
  });

  it('struggle completes the occurrence but derives no revisit', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got WA', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_1', signal: 'STILL_STRUGGLING', evaluatedAt: T1E });
    const result = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW });
    expect(result.completed.length).to.equal(1);
    expect(result.revisits).to.deep.equal([]);
    expect(result.observations[0]!.completed).to.equal(true);
  });

  it('delayed evidence completes on a later pass without new derivation', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const early = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [], now: NOW });
    expect(early.completed).to.deep.equal([]);
    const progress = makeProgress({ attemptId: 'att_1', signal: 'IMPROVING', evaluatedAt: T1E });
    const late = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW });
    expect(late.completed.length).to.equal(1);
    expect(late.revisits.length).to.equal(1);
  });

  it('outside-plan attempts complete via plan-agnostic linkage (no new plan restriction)', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_free', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_free', signal: 'IMPROVING', evaluatedAt: T1E, planId: 'plan_unrelated' });
    const result = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW });
    expect(result.completed.length).to.equal(1);
    expect(result.observations[0]!.ground).to.equal('attempt-and-progress');
  });

  it('skipped rec plus independent solve leaves the rec untouched', () => {
    const rec = makeRecommendation({ status: 'skipped' });
    const attempt = makeAttempt({ attemptId: 'att_free', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_free', signal: 'IMPROVING', evaluatedAt: T1E });
    const result = observeOutcomes({ recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW });
    expect(result.completed).to.deep.equal([]);
    expect(result.revisits).to.deep.equal([]);
    expect(result.observations).to.deep.equal([
      { recommendationId: 'rec_obs_1', completed: false, ground: null, revisit: null },
    ]);
  });

  it('inputs are never mutated and the surface stays narrow', () => {
    const rec = makeRecommendation();
    const attempt = makeAttempt({ attemptId: 'att_1', problemId: 'prob_reinforce', startedAt: T1, toState: 'Got AC Independently', completedAt: T1E });
    const progress = makeProgress({ attemptId: 'att_1', signal: 'IMPROVING', evaluatedAt: T1E });
    const inputs = { recommendations: [rec], attempts: [attempt], progress: [progress], now: NOW };
    const before = JSON.stringify(inputs);
    const result = observeOutcomes(inputs);
    expect(JSON.stringify(inputs)).to.equal(before);
    expect(JSON.stringify(result)).to.not.contain('planId');
    expect(Object.keys(outcomeFollowUpModule).sort()).to.deep.equal(['observeOutcomes']);
  });
});
