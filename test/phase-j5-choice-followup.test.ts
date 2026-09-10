import { expect } from 'chai';
import {
  isActionable,
  isKnownLearnerChoiceAction,
  resolveChoice,
} from 'codesense/longterm/choiceFollowUp';
import type { LearnerChoiceAction } from 'codesense/longterm/choiceFollowUp';
import type { LongTermPriority } from 'codesense/longterm/prioritization';
import type { LongTermRecommendation } from 'codesense/longterm/recommendation';
import * as choiceFollowUpModule from 'codesense/longterm/choiceFollowUp';

/**
 * Phase J-5 Stage 1 — learner-choice resolution over frozen J-3/J-4 state.
 * Pure mapping only: no D writes, no planning, no generation, no AI.
 */

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T10:00:00.000Z';

function makeRecommendation(overrides: Partial<LongTermRecommendation> = {}): LongTermRecommendation {
  return {
    recommendationId: 'rec_test_1',
    schemaVersion: 1,
    chainId: 'chain_test_1',
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
    explanation: 'Stored J-3 explanation for the reinforcement.',
    status: 'offered',
    counterpartRecommendationId: null,
    supersedesRecommendationId: null,
    supersededByRecommendationId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makePriority(overrides: Partial<LongTermPriority> = {}): LongTermPriority {
  return {
    rank: 1,
    kind: 'reinforcement',
    entityIds: ['framework.binary-search'],
    problemId: 'prob_source',
    goalId: 'goal_1',
    recommendationId: 'rec_test_1',
    reason: 'J-4 agenda reason for the reinforcement.',
    evidenceIds: ['ev_1'],
    progressIds: [],
    observedAt: null,
    ...overrides,
  };
}

describe('Phase J-5 Stage 1 — choice resolution', () => {
  it('1. start → accepted (disposition only)', () => {
    const rec = makeRecommendation();
    const result = resolveChoice({ priority: makePriority(), recommendation: rec, action: 'start', now: T1 });
    expect(result.recommendation.status).to.equal('accepted');
    expect(result.recommendation.updatedAt).to.equal(T1);
    expect(result.recommendation.createdAt).to.equal(T0);
    expect(result.alternativeRequest).to.equal(null);
    expect(result.explanation).to.equal(rec.explanation);
  });

  it('2. skip → skipped', () => {
    const rec = makeRecommendation();
    const result = resolveChoice({ priority: makePriority(), recommendation: rec, action: 'skip', now: T1 });
    expect(result.recommendation.status).to.equal('skipped');
    expect(result.alternativeRequest).to.equal(null);
  });

  it('3. later → deferred', () => {
    const rec = makeRecommendation();
    const result = resolveChoice({ priority: makePriority(), recommendation: rec, action: 'later', now: T1 });
    expect(result.recommendation.status).to.equal('deferred');
    expect(result.alternativeRequest).to.equal(null);
  });

  it('4. why → read-only; recommendation object unchanged', () => {
    const rec = makeRecommendation();
    const priority = makePriority();
    const result = resolveChoice({ priority, recommendation: rec, action: 'why', now: T1 });
    expect(result.recommendation).to.equal(rec);
    expect(result.alternativeRequest).to.equal(null);
    expect(result.explanation).to.contain(rec.explanation);
  });

  it('5+6. another → current declined + F2 request excluding the declined problem', () => {
    const rec = makeRecommendation();
    const result = resolveChoice({ priority: makePriority(), recommendation: rec, action: 'another', now: T1 });
    expect(result.recommendation.status).to.equal('skipped');
    expect(result.alternativeRequest).to.not.equal(null);
    expect(result.alternativeRequest!.goalId).to.equal('goal_1');
    expect(result.alternativeRequest!.excludeProblemIds).to.deep.equal(['prob_reinforce']);
  });

  it('another on a revisit role declines the source problem', () => {
    const rec = makeRecommendation({ role: 'revisit', recommendationId: 'rec_revisit' });
    const result = resolveChoice({
      priority: makePriority({ recommendationId: 'rec_revisit' }),
      recommendation: rec,
      action: 'another',
      now: T1,
    });
    expect(result.recommendation.status).to.equal('skipped');
    expect(result.alternativeRequest!.excludeProblemIds).to.deep.equal(['prob_source']);
  });

  it('another propagates a null goal honestly instead of inventing one', () => {
    const rec = makeRecommendation({ goalId: null });
    const result = resolveChoice({ priority: makePriority(), recommendation: rec, action: 'another', now: T1 });
    expect(result.alternativeRequest!.goalId).to.equal(null);
  });

  it('7–10. choice creates no evidence surface (no D imports; inputs untouched)', () => {
    const rec = makeRecommendation();
    const priority = makePriority();
    const recBefore = JSON.stringify(rec);
    const priorityBefore = JSON.stringify(priority);
    for (const action of ['start', 'another', 'later', 'skip', 'why'] as const) {
      resolveChoice({ priority, recommendation: rec, action, now: T1 });
    }
    expect(JSON.stringify(rec)).to.equal(recBefore);
    expect(JSON.stringify(priority)).to.equal(priorityBefore);
  });

  it('14+15. terminal rows and illegal actions follow J-3 conventions (throw)', () => {
    const skipped = makeRecommendation({ status: 'skipped' });
    expect(() => resolveChoice({ priority: makePriority(), recommendation: skipped, action: 'start', now: T1 })).to.throw();
    expect(() => resolveChoice({ priority: makePriority(), recommendation: skipped, action: 'skip', now: T1 })).to.throw();
    const completed = makeRecommendation({ status: 'completed' });
    expect(() => resolveChoice({ priority: makePriority(), recommendation: completed, action: 'later', now: T1 })).to.throw();
    const offered = makeRecommendation();
    expect(() =>
      resolveChoice({ priority: makePriority(), recommendation: offered, action: 'bogus' as LearnerChoiceAction, now: T1 }),
    ).to.throw();
    expect(() =>
      resolveChoice({ priority: makePriority(), recommendation: null as unknown as LongTermRecommendation, action: 'skip', now: T1 }),
    ).to.throw();
    expect(isKnownLearnerChoiceAction('start')).to.equal(true);
    expect(isKnownLearnerChoiceAction('bogus')).to.equal(false);
  });

  it('16. cross-goal isolation: only the selected recommendation is touched', () => {
    const selected = makeRecommendation({ recommendationId: 'rec_a', goalId: 'goal_a' });
    const other = makeRecommendation({ recommendationId: 'rec_b', goalId: 'goal_b', sourceProblemId: 'prob_other' });
    const otherBefore = JSON.stringify(other);
    const result = resolveChoice({
      priority: makePriority({ recommendationId: 'rec_a', goalId: 'goal_a' }),
      recommendation: selected,
      action: 'skip',
      now: T1,
    });
    expect(result.recommendation.recommendationId).to.equal('rec_a');
    expect(JSON.stringify(other)).to.equal(otherBefore);
  });

  it('17. no ActivityPlan shape is produced', () => {
    const result = resolveChoice({
      priority: makePriority(),
      recommendation: makeRecommendation(),
      action: 'another',
      now: T1,
    });
    expect(result).to.not.have.property('planId');
    expect(result).to.not.have.property('linkedAttemptId');
    expect(result.alternativeRequest).to.not.have.property('planId');
    expect(Object.keys(result).sort()).to.deep.equal(['alternativeRequest', 'explanation', 'recommendation']);
  });

  it('19+20. why is deterministic and preserves the J-4 reason', () => {
    const rec = makeRecommendation();
    const priority = makePriority();
    const first = resolveChoice({ priority, recommendation: rec, action: 'why', now: T1 });
    const second = resolveChoice({ priority, recommendation: rec, action: 'why', now: T1 });
    expect(first.explanation).to.equal(second.explanation);
    expect(first.explanation).to.contain(priority.reason);
  });

  it('narrow module surface: no stores, writers, planners, or generators', () => {
    expect(Object.keys(choiceFollowUpModule).sort()).to.deep.equal([
      'LEARNER_CHOICE_ACTIONS',
      'isActionable',
      'isKnownLearnerChoiceAction',
      'resolveChoice',
    ]);
  });
});

describe('Phase J-5 Stage 1 — actionability', () => {
  it('11. actionable when the ID is in the fresh agenda', () => {
    const rec = makeRecommendation();
    const agenda = [makePriority(), makePriority({ rank: 2, recommendationId: 'rec_other', problemId: null, kind: 'retrieval', entityIds: ['e1'] })];
    expect(isActionable({ recommendation: rec, agenda })).to.equal(true);
  });

  it('12+13. not actionable when absent; persistence alone never suffices', () => {
    const rec = makeRecommendation();
    expect(isActionable({ recommendation: rec, agenda: [] })).to.equal(false);
    expect(
      isActionable({ recommendation: rec, agenda: [makePriority({ recommendationId: 'rec_other' })] }),
    ).to.equal(false);
    expect(isActionable({ recommendation: null, agenda: [makePriority()] })).to.equal(false);
    expect(isActionable({ recommendation: rec, agenda: null })).to.equal(false);
  });
});
