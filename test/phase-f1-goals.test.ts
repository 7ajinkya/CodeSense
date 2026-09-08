import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerProfile } from 'codesense/learner/learnerModel';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import { LocalGoalStore, parseLearningGoal } from 'codesense/goals/goalStore';
import {
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  MAX_GOAL_DESCRIPTION_CHARS,
  isKnownGoalSource,
  isKnownGoalStatus,
} from 'codesense/goals/goalTypes';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import {
  MAX_DETECTED_NEEDS,
  detectLearningNeeds,
  needIdFor,
  needTargetKey,
} from 'codesense/goals/needDetection';
import {
  applyCandidateWording,
  explainProposal,
  goalTargetKey,
  proposeGoalFromNeed,
  proposeGoalFromRequest,
  successCriteriaFor,
  validateGoalCandidate,
} from 'codesense/goals/goalProposal';
import {
  abandonGoal,
  acceptGoal,
  captureBaseline,
  completeGoal,
  evidenceFingerprint,
  modifyGoal,
  pauseGoal,
  rejectGoal,
  resumeGoal,
  transitionGoalStatus,
} from 'codesense/goals/goalLifecycle';
import {
  findConflictingGoal,
  getActiveGoals,
  getGoal,
  getGoalsByStatus,
  getGoalsForEntity,
  getProposals,
  laterEvidenceForGoal,
  proposalFingerprint,
  shouldSuppressProposal,
  summarizeGoalsForPrompt,
} from 'codesense/goals/goalQueries';
import * as goalTypesModule from 'codesense/goals/goalTypes';
import * as needDetectionModule from 'codesense/goals/needDetection';
import * as goalProposalModule from 'codesense/goals/goalProposal';
import * as goalLifecycleModule from 'codesense/goals/goalLifecycle';
import * as goalStoreModule from 'codesense/goals/goalStore';
import * as goalQueriesModule from 'codesense/goals/goalQueries';

/**
 * Phase F1 — Learning Needs & Learner-Owned Goals.
 *
 * Behavioral (not line-coverage) properties live here: needs derive only
 * from corroborated evidence, single weak events never become goals,
 * uncertainty is preserved, proposals never self-activate, the learner
 * owns accept/modify/reject, rejections suppress re-spam, baselines stay
 * small, and F touches neither C's taxonomy nor D's capability model.
 */

const BFS = 'framework.bfs';
const MULTI_BFS = 'form.multisource-bfs';
const GRAPH_TOPIC = 'topic.graphs';

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

function graph(): KnowledgeGraph {
  return getDefaultKnowledgeGraph();
}

let evidenceCounter = 0;

function ev(
  overrides: Record<string, unknown> & { timestamp: string },
): LearnerEvidence {
  evidenceCounter += 1;
  const raw = {
    evidenceId: `ev_f1_${evidenceCounter}`,
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
      evidenceId: `ev_struggle_${n}`,
      evidenceType: 'IMPLEMENTATION_FAILURE',
      confidence: 'medium',
    }),
  );
  return { profile: profileWith(evidence), evidence };
}

const NOW = '2026-04-02T00:00:00.000Z';

function activateFirstNeed(
  profile: LearnerProfile,
  now = NOW,
): { need: NonNullable<ReturnType<typeof detectLearningNeeds>[number]>; proposal: LearningGoal; active: LearningGoal } {
  const needs = detectLearningNeeds({ profile, graph: graph(), now });
  const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
  if (!need) {
    throw new Error('fixture must yield a BFS implementation need');
  }
  const proposal = proposeGoalFromNeed(need, { graph: graph(), now });
  if (!proposal) {
    throw new Error('fixture proposal must build');
  }
  return { need, proposal, active: acceptGoal(proposal, { profile, now }) };
}

// ---------------------------------------------------------------------------
// A. Learning need
// ---------------------------------------------------------------------------

describe('Phase F1 learning needs (evidence-derived, corroborated)', () => {
  it('creates a need from corroborated repeated difficulty', () => {
    const { profile } = strugglingImplementationProfile();
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.status).to.equal('struggling');
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(needs.length).to.be.greaterThan(0);
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    expect(need, 'implementation need for BFS').to.not.be.undefined;
    expect(need!.entityIds).to.deep.equal([BFS]);
    expect(need!.confidence).to.equal(state.statusConfidence);
    expect(need!.needId).to.equal(needIdFor([BFS], 'implementation'));
    expect(need!.evidenceBasis.evidenceIds.length).to.be.greaterThan(0);
    expect(need!.evidenceBasis.profileUpdatedAt).to.equal(profile.updatedAt);
    expect(need!.evidenceBasis.ontologyVersion).to.equal(profile.ontologyVersion);
    expect(need!.evidenceBasis.aggregatorVersion).to.equal(profile.aggregatorVersion);
    expect(need!.ambiguity).to.be.undefined;
  });

  it('a single weak event creates evidence, never a need', () => {
    const profile = profileWith([
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceType: 'EXPOSURE', confidence: 'high' }),
      ev({ timestamp: '2026-03-01T00:00:02.000Z', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
    ]);
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.status).to.not.equal('struggling');
    expect(detectLearningNeeds({ profile, graph: graph(), now: NOW })).to.deep.equal([]);
  });

  it('exposure alone creates no need', () => {
    const profile = profileWith([
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceType: 'EXPOSURE', confidence: 'high' }),
    ]);
    expect(detectLearningNeeds({ profile, graph: graph(), now: NOW })).to.deep.equal([]);
  });

  it('empty profile yields no needs (unknown stays unknown)', () => {
    const profile = profileWith([]);
    expect(detectLearningNeeds({ profile, graph: graph(), now: NOW })).to.deep.equal([]);
  });

  it('preserves uncertainty instead of inventing precision', () => {
    // Repeated low-confidence mixed signals: ambiguous repetition.
    const profile = profileWith([
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_amb_1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ev({ timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_amb_2', evidenceType: 'DEBUGGING_FAILURE', confidence: 'low' }),
      ev({ timestamp: '2026-03-03T00:00:01.000Z', evidenceId: 'ev_amb_3', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
    ]);
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.statusConfidence).to.equal('low');
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(needs.length).to.be.greaterThan(0);
    for (const need of needs) {
      expect(need.confidence).to.equal('low');
      expect(need.ambiguity, 'ambiguity preserved').to.not.be.undefined;
      expect(need.ambiguity!.length).to.be.greaterThan(0);
    }
  });

  it('links canonical C entities and the correct D dimension', () => {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    for (const need of needs) {
      for (const id of need.entityIds) {
        expect(graph().hasEntity(id), `unknown entity ${id}`).to.be.true;
      }
      expect(need.dimension).to.equal('implementation');
    }
    expect(needTargetKey([BFS], 'implementation')).to.equal(`${BFS}|implementation`);
  });

  it('is deterministic and capped', () => {
    const { profile } = strugglingImplementationProfile();
    const first = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const second = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(second).to.deep.equal(first);
    expect(first.length).to.be.lessThanOrEqual(MAX_DETECTED_NEEDS);
    const limited = detectLearningNeeds({ profile, graph: graph(), now: NOW, limit: 0 });
    expect(limited).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// B. Goal proposal
// ---------------------------------------------------------------------------

describe('Phase F1 goal proposals (explainable, sourced)', () => {
  function firstNeed() {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    if (!need) {
      throw new Error('fixture must yield an implementation need');
    }
    return { profile, need };
  }

  it('builds an evidence-derived proposal that stays proposed', () => {
    const { need } = firstNeed();
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW });
    expect(proposal).to.not.be.null;
    expect(proposal!.status).to.equal('proposed');
    expect(proposal!.source).to.equal('evidence-derived');
    expect(proposal!.targetKey).to.equal(`${BFS}|implementation`);
    expect(proposal!.evidenceBasis.needId).to.equal(need.needId);
    expect(proposal!.evidenceBasis.evidenceIds).to.deep.equal(need.evidenceBasis.evidenceIds);
    expect(proposal!.progressBaseline).to.be.null;
    expect(proposal!.decidedAt).to.be.null;
    expect(proposal!.description.length).to.be.greaterThan(0);
  });

  it('builds a learner-requested goal without inventing evidence', () => {
    const { profile } = strugglingImplementationProfile();
    const goal = proposeGoalFromRequest(
      { entityIds: [BFS], dimension: 'recognition', learnerStatement: 'I want to get better at dynamic programming.' },
      { graph: graph(), profile, now: NOW },
    );
    expect(goal).to.not.be.null;
    expect(goal!.source).to.equal('learner-requested');
    expect(goal!.status).to.equal('proposed');
    expect(goal!.evidenceBasis.needId).to.be.null;
    expect(goal!.evidenceBasis.evidenceIds).to.deep.equal([]);
    expect(goal!.evidenceBasis.learnerStatement).to.equal('I want to get better at dynamic programming.');
    expect(goal!.dimension).to.equal('recognition');
  });

  it('refuses unresolvable learner input instead of guessing', () => {
    const { profile } = strugglingImplementationProfile();
    expect(
      proposeGoalFromRequest({ entityIds: ['no.such.entity'], learnerStatement: 'Get better.' }, { graph: graph(), profile, now: NOW }),
    ).to.be.null;
    expect(
      proposeGoalFromRequest({ entityIds: [], learnerStatement: '   ' }, { graph: graph(), profile, now: NOW }),
    ).to.be.null;
    expect(
      proposeGoalFromRequest({ learnerStatement: '' }, { graph: graph(), profile, now: NOW }),
    ).to.be.null;
  });

  it('preserves provenance from need through proposal', () => {
    const { profile, need } = firstNeed();
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    expect(proposal.evidenceBasis.ontologyVersion).to.equal(profile.ontologyVersion);
    expect(proposal.evidenceBasis.aggregatorVersion).to.equal(profile.aggregatorVersion);
    expect(proposal.evidenceBasis.profileUpdatedAt).to.equal(profile.updatedAt);
  });

  it('explains proposals with grounded excerpts and uncertainty intact', () => {
    const { profile, need } = firstNeed();
    const evidence = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_exp_1', observation: 'Attempt ended WA on a grid BFS.' }),
      ev({ timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_exp_2', observation: 'Attempt ended TLE on a grid BFS.' }),
    ];
    void profile;
    const explanation = explainProposal(need, evidence, graph());
    expect(explanation.summary.length).to.be.greaterThan(0);
    for (const point of explanation.evidencePoints) {
      expect(point.length).to.be.lessThanOrEqual(200);
    }
    // Points cite only observations actually present in the passed evidence.
    const joined = explanation.evidencePoints.join(' ');
    expect(joined).to.not.contain('Attempt ended WA');
    const matching = explainProposal(
      { ...need, evidenceBasis: { ...need.evidenceBasis, evidenceIds: ['ev_exp_1'] } },
      evidence,
      graph(),
    );
    expect(matching.evidencePoints).to.deep.equal(['Attempt ended WA on a grid BFS.']);
    expect(matching.uncertainty).to.be.null;
    const hedged = explainProposal(
      { ...need, ambiguity: ['Rival reading: unfamiliar variant.'] },
      evidence,
      graph(),
    );
    expect(hedged.uncertainty).to.contain('Rival reading');
  });

  it('aligns success criteria with the goal dimension', () => {
    const { need } = firstNeed();
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    expect(proposal.successCriteria.dimension).to.equal('implementation');
    expect(proposal.successCriteria.summary).to.contain('mplement');
    expect(proposal.successCriteria.guidance.length).to.be.greaterThan(0);
    const recognition = successCriteriaFor('recognition');
    expect(recognition.dimension).to.equal('recognition');
    expect(recognition.summary).to.contain('independent');
  });
});

// ---------------------------------------------------------------------------
// C. Learner ownership (accept / modify / reject, §25 flows)
// ---------------------------------------------------------------------------

describe('Phase F1 learner ownership (proposals never self-activate)', () => {
  function proposedGoal() {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation')!;
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
    return { profile, proposal };
  }

  it('a fresh proposal is inert until decided', () => {
    const { proposal } = proposedGoal();
    expect(proposal.status).to.equal('proposed');
    expect(proposal.progressBaseline).to.be.null;
    expect(proposal.decidedAt).to.be.null;
  });

  it('accept activates with a baseline and decision stamp', () => {
    const { profile, proposal } = proposedGoal();
    const active = acceptGoal(proposal, { profile, now: NOW, note: 'sounds right' });
    expect(active.status).to.equal('active');
    expect(active.decidedAt).to.equal(NOW);
    expect(active.decisionNote).to.equal('sounds right');
    expect(active.progressBaseline).to.not.be.null;
    expect(active.progressBaseline!.capturedAt).to.equal(NOW);
    expect(active.description).to.equal(proposal.description);
  });

  it('modify activates the learner text while preserving provenance', () => {
    const { profile, proposal } = proposedGoal();
    const modified = modifyGoal(
      proposal,
      { description: 'Yes, but focus on unfamiliar grid wording.', learnerStatement: 'unfamiliar grid wording' },
      { profile, now: NOW },
    );
    expect(modified.status).to.equal('active');
    expect(modified.description).to.equal('Yes, but focus on unfamiliar grid wording.');
    expect(modified.evidenceBasis.originalDescription).to.equal(proposal.description);
    expect(modified.evidenceBasis.learnerStatement).to.equal('unfamiliar grid wording');
    expect(modified.evidenceBasis.needId).to.equal(proposal.evidenceBasis.needId);
    expect(modified.evidenceBasis.evidenceIds).to.deep.equal(proposal.evidenceBasis.evidenceIds);
    expect(modified.progressBaseline).to.not.be.null;
  });

  it('reject dismisses and suppresses immediate re-proposal on identical evidence', () => {
    const { profile, proposal } = proposedGoal();
    const dismissed = rejectGoal(proposal, { profileUpdatedAt: profile.updatedAt, now: NOW });
    expect(dismissed.status).to.equal('dismissed');
    expect(dismissed.decidedAt).to.equal(NOW);
    expect(dismissed.evidenceBasis.dismissalFingerprint).to.be.a('string');
    const fingerprint = proposalFingerprint(proposal.evidenceBasis.evidenceIds, profile.updatedAt);
    expect(
      shouldSuppressProposal([dismissed], proposal.targetKey, fingerprint),
      'identical evidence re-proposal suppressed',
    ).to.be.true;
    // New evidence re-opens the question: different fingerprint, no suppression.
    expect(
      shouldSuppressProposal([dismissed], proposal.targetKey, `${fingerprint}-plus-ev-new`),
    ).to.be.false;
    // A different target is never suppressed by this dismissal.
    expect(shouldSuppressProposal([dismissed], 'other|recognition', fingerprint)).to.be.false;
  });

  it('§25 reject flow: no active goal, no immediate recreation', () => {
    const { profile, proposal } = proposedGoal();
    const dismissed = rejectGoal(proposal, { profileUpdatedAt: profile.updatedAt, now: NOW });
    expect(getActiveGoals([dismissed])).to.deep.equal([]);
    expect(getProposals([dismissed])).to.deep.equal([]);
    // Same evidence re-detected → same target key → still suppressed.
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const again = needs
      .map((need) => proposeGoalFromNeed(need, { graph: graph(), now: NOW }))
      .find((p) => p && p.targetKey === proposal.targetKey);
    expect(again, 'same need re-proposed structurally').to.not.be.undefined;
    const fp = proposalFingerprint(again!.evidenceBasis.evidenceIds, profile.updatedAt);
    expect(shouldSuppressProposal([dismissed], again!.targetKey, fp)).to.be.true;
  });

  it('§25 modify flow: active goal reflects learner text with provenance', () => {
    const { profile, proposal } = proposedGoal();
    const active = modifyGoal(
      proposal,
      { description: 'Focus on unfamiliar grid wording.', learnerStatement: 'grids confuse me' },
      { profile, now: NOW },
    );
    expect(getActiveGoals([active])).to.have.lengthOf(1);
    expect(active.description).to.equal('Focus on unfamiliar grid wording.');
    expect(active.evidenceBasis.learnerStatement).to.equal('grids confuse me');
    expect(active.evidenceBasis.originalDescription).to.equal(proposal.description);
    expect(active.source).to.equal('evidence-derived');
  });
});

// ---------------------------------------------------------------------------
// D. Goal lifecycle
// ---------------------------------------------------------------------------

describe('Phase F1 goal lifecycle (persisted, validated)', () => {
  function activeGoal(now = NOW): { profile: ReturnType<typeof strugglingImplementationProfile>['profile']; goal: LearningGoal } {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation')!;
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now })!;
    return { profile, goal: acceptGoal(proposal, { profile, now }) };
  }

  it('persists and reloads goals across store instances', async () => {
    const dir = tmpDir('codesense-test-f1-lifecycle');
    clean(dir);
    try {
      const { goal } = activeGoal();
      const writer = new LocalGoalStore(dir);
      await writer.upsertGoal(goal);
      const reader = new LocalGoalStore(dir);
      expect(await reader.getGoal(goal.goalId)).to.deep.equal(goal);
      expect(await reader.listGoals()).to.have.lengthOf(1);
      expect(await reader.getGoal('goal_missing')).to.be.null;
    } finally {
      clean(dir);
    }
  });

  it('walks the valid lifecycle without losing provenance', async () => {
    const { goal } = activeGoal('2026-04-02T00:00:00.000Z');
    const paused = pauseGoal(goal, '2026-04-03T00:00:00.000Z');
    expect(paused.status).to.equal('paused');
    const resumed = resumeGoal(paused, '2026-04-04T00:00:00.000Z');
    expect(resumed.status).to.equal('active');
    expect(resumed.progressBaseline).to.deep.equal(goal.progressBaseline);
    expect(resumed.evidenceBasis.needId).to.equal(goal.evidenceBasis.needId);
    const achieved = completeGoal(resumed, '2026-04-05T00:00:00.000Z', 'solved three grids solo');
    expect(achieved.status).to.equal('achieved');
    expect(achieved.decisionNote).to.equal('solved three grids solo');
  });

  it('rejects invalid transitions loudly', () => {
    const { goal } = activeGoal();
    expect(() => transitionGoalStatus(goal, 'proposed', NOW)).to.throw(/Invalid goal transition/);
    expect(() => acceptGoal(goal, { profile: strugglingImplementationProfile().profile, now: NOW })).to.throw(
      /Only a proposed goal can be accepted/,
    );
    expect(() => resumeGoal(goal, NOW)).to.throw(/Invalid goal transition/);
    const achieved = completeGoal(goal, NOW);
    expect(() => transitionGoalStatus(achieved, 'active', NOW)).to.throw(/Invalid goal transition/);
    expect(() => pauseGoal(achieved, NOW)).to.throw(/Invalid goal transition/);
  });

  it('prevents duplicate equivalent active goals', () => {
    const { goal } = activeGoal();
    const twin = { ...goal, goalId: 'goal_twin', status: 'proposed' as const };
    expect(findConflictingGoal([goal], twin.targetKey)?.goalId).to.equal(goal.goalId);
    expect(findConflictingGoal([goal], 'other|recognition')).to.be.null;
    const done = completeGoal(goal, NOW);
    expect(findConflictingGoal([done], twin.targetKey)).to.be.null;
  });

  it('skips corrupt rows instead of failing the whole history', async () => {
    const dir = tmpDir('codesense-test-f1-corrupt');
    clean(dir);
    try {
      const { goal } = activeGoal();
      const store = new LocalGoalStore(dir);
      await store.upsertGoal(goal);
      const file = path.join(dir, '.codesense', 'learning-goals.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
      onDisk.push({ garbage: true }, null, 'nope');
      fs.writeFileSync(file, JSON.stringify(onDisk));
      expect(await store.listGoals()).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('refuses malformed writes and exposes typed queries', async () => {
    const dir = tmpDir('codesense-test-f1-malformed');
    clean(dir);
    try {
      const store = new LocalGoalStore(dir);
      let threw = false;
      try {
        await store.upsertGoal({ nope: true } as unknown as LearningGoal);
      } catch {
        threw = true;
      }
      expect(threw, 'malformed goal must not persist').to.be.true;
      const { goal } = activeGoal();
      await store.upsertGoal(goal);
      expect(getGoal(await store.listGoals(), goal.goalId)?.status).to.equal('active');
      expect(getGoalsByStatus(await store.listGoals(), 'active')).to.have.lengthOf(1);
      expect(getGoalsByStatus(await store.listGoals(), 'proposed')).to.deep.equal([]);
      expect(getGoalsForEntity(await store.listGoals(), BFS)).to.have.lengthOf(1);
      expect(getGoalsForEntity(await store.listGoals(), 'topic.graphs')).to.deep.equal([]);
      expect(parseLearningGoal(null)).to.be.null;
      expect(parseLearningGoal({})).to.be.null;
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// E. Baseline
// ---------------------------------------------------------------------------

describe('Phase F1 goal baselines (small snapshots, not model copies)', () => {
  it('captures dimension levels without duplicating the profile', () => {
    const { profile } = strugglingImplementationProfile();
    const { active: goal } = activateFirstNeed(profile);
    const baseline = goal.progressBaseline!;
    expect(baseline.capturedAt).to.equal(NOW);
    expect(baseline.profileUpdatedAt).to.equal(profile.updatedAt);
    expect(baseline.entityStates).to.have.lengthOf(1);
    expect(baseline.entityStates[0]).to.deep.equal({
      entityId: BFS,
      dimension: 'implementation',
      level: profile.knowledgeStates.find((s) => s.entityId === BFS)!.implementation.level,
      confidence: profile.knowledgeStates.find((s) => s.entityId === BFS)!.implementation.confidence,
    });
    expect(baseline.evidenceIds.length).to.be.greaterThan(0);
    // Small by construction: no profile-shaped fields leak in.
    const serialized = JSON.stringify(baseline);
    expect(serialized).to.not.contain('recurringMistakes');
    expect(serialized).to.not.contain('totalEvidenceCount');
    expect(serialized).to.not.contain('supportingEvidenceIds');
  });

  it('distinguishes later evidence from baseline evidence', () => {
    const { profile, evidence: base } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(needs.length).to.be.greaterThan(0);
    const proposal = proposeGoalFromNeed(needs[0]!, { graph: graph(), now: NOW })!;
    const active = acceptGoal(proposal, { profile, now: NOW });
    const later = ev({ timestamp: '2026-05-01T00:00:01.000Z', evidenceId: 'ev_later_1' });
    const split = laterEvidenceForGoal([...base, later], active);
    expect(split.before.map((r) => r.evidenceId)).to.include('ev_struggle_1');
    expect(split.before.map((r) => r.evidenceId)).to.not.include('ev_later_1');
    expect(split.after.map((r) => r.evidenceId)).to.deep.equal(['ev_later_1']);
  });

  it('summarizes active goals for the coach channel without leaking history', () => {
    const { proposal, active } = activateFirstNeed(strugglingImplementationProfile().profile);
    expect(summarizeGoalsForPrompt([])).to.deep.equal([]);
    expect(summarizeGoalsForPrompt([proposal])).to.deep.equal([]);
    const lines = summarizeGoalsForPrompt([active]);
    expect(lines).to.have.lengthOf(1);
    expect(lines[0]).to.contain('Active learning goal');
    expect(lines[0]).to.contain('accepted proposal');
    expect(lines[0]!.length).to.be.lessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// F. C/D/F boundaries
// ---------------------------------------------------------------------------

describe('Phase F1 boundaries (C canonical, D authoritative, F additive)', () => {
  it('references canonical C entities and skips unknown ones', () => {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    expect(needs.length).to.be.greaterThan(0);
    for (const need of needs) {
      for (const id of need.entityIds) {
        expect(graph().hasEntity(id), `need references unknown entity ${id}`).to.be.true;
      }
    }
    // A hand-built state on an invented entity yields nothing (no guessing).
    const ghost = JSON.parse(JSON.stringify(profile)) as LearnerProfile;
    ghost.knowledgeStates.push({
      entityId: 'topic.lost-continent',
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      evidenceCount: 5,
      exposure: { level: 'EXPOSED', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      recognition: { level: 'UNKNOWN', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      conceptual: { level: 'UNKNOWN', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      implementation: { level: 'EXPOSED', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: ['ev_x1', 'ev_x2', 'ev_x3'], positiveWeight: 0, negativeWeight: 3, lastUpdatedAt: NOW },
      debugging: { level: 'UNKNOWN', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      transfer: { level: 'UNKNOWN', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      independence: { level: 'UNKNOWN', confidence: 'low', positiveEvidenceIds: [], negativeEvidenceIds: [], positiveWeight: 0, negativeWeight: 0, lastUpdatedAt: null },
      status: 'struggling',
      statusConfidence: 'medium',
      supportingEvidenceIds: [],
      contradictingEvidenceIds: ['ev_x1', 'ev_x2', 'ev_x3'],
      trajectory: [],
      updatedAt: NOW,
    });
    const ghostNeeds = detectLearningNeeds({ profile: ghost, graph: graph(), now: NOW });
    expect(ghostNeeds.some((n) => n.entityIds.includes('topic.lost-continent'))).to.be.false;
  });

  it('derives needs from D state without duplicating aggregation', () => {
    const { profile } = strugglingImplementationProfile();
    const before = JSON.stringify(profile);
    detectLearningNeeds({ profile, graph: graph(), now: NOW });
    proposeGoalFromNeed(
      detectLearningNeeds({ profile, graph: graph(), now: NOW }).find(
        (n) => n.entityIds.includes(BFS) && n.dimension === 'implementation',
      )!,
      { graph: graph(), now: NOW },
    );
    // F reads D output; the profile object is never mutated by F.
    expect(JSON.stringify(profile)).to.equal(before);
  });

  it('stores no capability assessment on goals (references only)', () => {
    const { active: goal } = activateFirstNeed(strugglingImplementationProfile().profile);
    const serialized = JSON.stringify(goal);
    for (const forbidden of [
      'positiveWeight',
      'negativeWeight',
      'supportingEvidenceIds',
      'contradictingEvidenceIds',
      'trajectory',
      'recurringMistakes',
      'totalEvidenceCount',
      'statusConfidence',
    ]) {
      expect(serialized, `goal must not carry D field ${forbidden}`).to.not.contain(forbidden);
    }
  });

  it('cannot mutate D capability state through any F entry point', () => {
    const { profile } = strugglingImplementationProfile();
    const before = JSON.stringify(profile);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const proposal = proposeGoalFromNeed(needs[0]!, { graph: graph(), now: NOW })!;
    acceptGoal(proposal, { profile, now: NOW });
    modifyGoal(proposal, { description: 'changed' }, { profile, now: NOW });
    rejectGoal(proposal, { profileUpdatedAt: profile.updatedAt, now: NOW });
    captureBaseline(
      acceptGoal(proposeGoalFromNeed(needs[0]!, { graph: graph(), now: NOW })!, { profile, now: NOW }),
      profile,
      NOW,
    );
    expect(JSON.stringify(profile)).to.equal(before);
  });
});

// ---------------------------------------------------------------------------
// G. AI boundary (wording assistance only, never durable state)
// ---------------------------------------------------------------------------

describe('Phase F1 AI boundary (candidates cannot touch durable state)', () => {
  function draftProposal() {
    const { profile } = strugglingImplementationProfile();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation')!;
    return proposeGoalFromNeed(need, { graph: graph(), now: NOW })!;
  }

  it('accepts a well-formed wording candidate', () => {
    const candidate = validateGoalCandidate({
      description: 'Get reliably better at BFS grid implementation.',
      successCriteriaSummary: 'Three solo grid solves without hints.',
    });
    expect(candidate).to.not.be.null;
    expect(candidate!.description).to.equal('Get reliably better at BFS grid implementation.');
    expect(candidate!.successCriteriaSummary).to.equal('Three solo grid solves without hints.');
  });

  it('rejects malformed or state-smuggling candidates', () => {
    expect(validateGoalCandidate(null)).to.be.null;
    expect(validateGoalCandidate('just text')).to.be.null;
    expect(validateGoalCandidate({})).to.be.null;
    expect(validateGoalCandidate({ description: '   ' })).to.be.null;
    expect(validateGoalCandidate({ description: 42 })).to.be.null;
    expect(validateGoalCandidate({ description: 'ok', status: 'active' })).to.be.null;
    expect(validateGoalCandidate({ description: 'ok', source: 'learner-requested' })).to.be.null;
    expect(validateGoalCandidate({ description: 'ok', goalId: 'goal_x' })).to.be.null;
    expect(validateGoalCandidate({ description: 'ok', evidenceBasis: {} })).to.be.null;
    expect(validateGoalCandidate({ successCriteriaSummary: '' })).to.be.null;
  });

  it('applies wording without touching identity, source, status, or provenance', () => {
    const proposal = draftProposal();
    const before = JSON.stringify(proposal);
    const worded = applyCandidateWording(proposal, {
      description: 'AI phrasing here.',
      successCriteriaSummary: 'AI criteria here.',
    });
    expect(worded.description).to.equal('AI phrasing here.');
    expect(worded.successCriteria.summary).to.equal('AI criteria here.');
    expect(worded.goalId).to.equal(proposal.goalId);
    expect(worded.source).to.equal(proposal.source);
    expect(worded.status).to.equal('proposed');
    expect(worded.decidedAt).to.be.null;
    expect(worded.progressBaseline).to.be.null;
    expect(worded.evidenceBasis).to.deep.equal(proposal.evidenceBasis);
    expect(worded.targetKey).to.equal(proposal.targetKey);
    // Source proposal untouched (pure function).
    expect(JSON.stringify(proposal)).to.equal(before);
  });

  it('a candidate can never silently activate a goal', () => {
    const proposal = draftProposal();
    const worded = applyCandidateWording(proposal, { description: 'AI phrasing here.' });
    expect(worded.status).to.equal('proposed');
    expect(worded.decidedAt).to.be.null;
    expect(worded.progressBaseline).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// H. Phase boundaries (no practice engine, no G/H/I/J leakage)
// ---------------------------------------------------------------------------

describe('Phase F1 scope guard (no F2/G/H/I/J surface)', () => {
  function exportedKeys(module: Record<string, unknown>): string[] {
    return Object.keys(module).sort();
  }

  it('exposes exactly the F1 goal surface (tripwire for scope creep)', () => {
    expect(exportedKeys(goalTypesModule)).to.deep.equal([
      'GOAL_SCHEMA_VERSION',
      'GOAL_SOURCES',
      'GOAL_STATUSES',
      'GOAL_TRANSITIONS',
      'MAX_GOAL_DESCRIPTION_CHARS',
      'MAX_GOAL_ENTITY_IDS',
      'MAX_GOAL_EVIDENCE_IDS',
      'MAX_GOAL_TEXT_CHARS',
      'isKnownGoalSource',
      'isKnownGoalStatus',
    ]);
    expect(exportedKeys(needDetectionModule)).to.deep.equal([
      'MAX_DETECTED_NEEDS',
      'MAX_NEED_EVIDENCE_IDS',
      'MIN_EVIDENCE_FOR_AMBIGUOUS_NEED',
      'detectLearningNeeds',
      'needIdFor',
      'needTargetKey',
    ]);
    expect(exportedKeys(goalProposalModule)).to.deep.equal([
      'GOAL_ID_PREFIX',
      'applyCandidateWording',
      'explainProposal',
      'generateGoalId',
      'goalTargetKey',
      'proposeGoalFromNeed',
      'proposeGoalFromRequest',
      'successCriteriaFor',
      'validateGoalCandidate',
    ]);
    expect(exportedKeys(goalLifecycleModule)).to.deep.equal([
      'abandonGoal',
      'acceptGoal',
      'captureBaseline',
      'completeGoal',
      'evidenceFingerprint',
      'modifyGoal',
      'pauseGoal',
      'rejectGoal',
      'resumeGoal',
      'transitionGoalStatus',
    ]);
    expect(exportedKeys(goalStoreModule)).to.deep.equal(['LocalGoalStore', 'parseLearningGoal']);
    expect(exportedKeys(goalQueriesModule)).to.deep.equal([
      'MAX_GOAL_DIGEST_CHARS',
      'MAX_GOAL_DIGEST_LINES',
      'findConflictingGoal',
      'getActiveGoals',
      'getGoal',
      'getGoalsByStatus',
      'getGoalsForEntity',
      'getProposals',
      'laterEvidenceForGoal',
      'proposalFingerprint',
      'shouldSuppressProposal',
      'summarizeGoalsForPrompt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §24 acceptance: same learner area, different evidence → different goals
// ---------------------------------------------------------------------------

describe('Phase F1 §24 acceptance (structured goals differ by evidence)', () => {
  function recognitionWeakImplementationStrong(): LearnerProfile {
    const records: LearnerEvidence[] = [];
    for (let n = 1; n <= 3; n++) {
      records.push(
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_ra_${n}`,
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
          evidenceId: `ev_ra_${n}`,
          evidenceType: 'IMPLEMENTATION_SUCCESS',
          confidence: 'medium',
          problemId: `prob_ra_${n}`,
        }),
      );
    }
    return profileWith(records);
  }

  function recognitionStrongImplementationWeak(): LearnerProfile {
    const records: LearnerEvidence[] = [];
    for (let n = 1; n <= 3; n++) {
      records.push(
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_rb_${n}`,
          evidenceType: 'RECOGNITION',
          confidence: 'medium',
          problemId: `prob_rb_${n}`,
        }),
      );
    }
    for (let n = 4; n <= 6; n++) {
      records.push(
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_rb_${n}`,
          evidenceType: 'RECURRING_MISTAKE',
          confidence: 'medium',
          source: 'mistake-report',
          provenance: { source: 'mistake-report', sourceId: null },
          mistakeCategory: 'off-by-one',
          dimension: 'implementation',
          problemId: `prob_rb_${n}`,
        }),
      );
    }
    return profileWith(records);
  }

  it('recognition-weak vs implementation-weak learners get different goal dimensions', () => {
    const profileA = recognitionWeakImplementationStrong();
    const needsA = detectLearningNeeds({ profile: profileA, graph: graph(), now: NOW });
    const needA = needsA.find((n) => n.entityIds.includes(BFS) && n.dimension === 'recognition');
    expect(needA, 'learner A needs recognition').to.not.be.undefined;
    const proposalA = proposeGoalFromNeed(needA!, { graph: graph(), now: NOW })!;
    expect(proposalA.dimension).to.equal('recognition');
    expect(proposalA.entityIds).to.deep.equal([BFS]);

    const profileB = recognitionStrongImplementationWeak();
    const needsB = detectLearningNeeds({ profile: profileB, graph: graph(), now: NOW });
    const needB = needsB.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    expect(needB, 'learner B needs implementation').to.not.be.undefined;
    const proposalB = proposeGoalFromNeed(needB!, { graph: graph(), now: NOW })!;
    expect(proposalB.dimension).to.equal('implementation');
    expect(proposalB.entityIds).to.deep.equal([BFS]);

    // Structured difference, not just wording: dimensions and dedup keys differ.
    expect(proposalA.dimension).to.not.equal(proposalB.dimension);
    expect(proposalA.targetKey).to.not.equal(proposalB.targetKey);
    expect(proposalA.description).to.not.equal(proposalB.description);
    expect(proposalA.successCriteria.dimension).to.not.equal(proposalB.successCriteria.dimension);
  });
});
