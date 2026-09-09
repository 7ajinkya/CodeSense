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
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import { detectLearningNeeds } from 'codesense/goals/needDetection';
import { proposeGoalFromNeed, proposeGoalFromRequest } from 'codesense/goals/goalProposal';
import { acceptGoal } from 'codesense/goals/goalLifecycle';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import { LocalGoalStore } from 'codesense/goals/goalStore';
import type { GoalStore } from 'codesense/goals/goalStore';
import {
  formatProvenanceLine,
  isProposalFresh,
  partitionPendingByFreshness,
  resolveProposalProvenance,
} from 'codesense/goals/goalFreshness';
import { proposeGoalForAttemptEnd } from 'codesense/goals/goalChain';
import type { GoalChainPorts } from 'codesense/goals/goalChain';

/**
 * Phase F1 proposal-lifecycle hardening: freshness, provenance,
 * single-flight proposal creation, and stale-pending discipline.
 *
 * Regression coverage for the stale-recommendation incident: an
 * undismissed suggestion from problem A must never present as problem
 * B's recommendation; a stale pending proposal must never suppress a
 * legitimate new one; overlapping endProblem chains must not duplicate
 * proposals. Frozen F1 module semantics (detection, proposal shape,
 * lifecycle, dedup) are unchanged — these tests pin the orchestration
 * around them.
 */

const BFS = 'framework.bfs';

const NOW1 = '2026-04-02T00:00:00.000Z';
const NOW2 = '2026-04-10T00:00:00.000Z';

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
    evidenceId: `ev_f1h_${evidenceCounter}`,
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

function strugglingImplEvidence(): LearnerEvidence[] {
  return [1, 2, 3].map((n) =>
    ev({
      timestamp: `2026-03-0${n}T00:00:00.000Z`,
      evidenceId: `ev_f1h_struggle_${n}`,
      evidenceType: 'IMPLEMENTATION_FAILURE',
      confidence: 'medium',
      attemptId: `att_base_${n}`,
      provenance: { source: 'attempt-outcome', sourceId: `att_base_${n}` },
    }),
  );
}

function resolvedImplStrugglingDebugEvidence(): LearnerEvidence[] {
  const out: LearnerEvidence[] = [];
  for (let n = 1; n <= 3; n++) {
    out.push(
      ev({
        timestamp: `2026-03-1${n}T00:00:00.000Z`,
        evidenceId: `ev_f1h_resolved_${n}`,
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        attemptId: `att_ok_${n}`,
        provenance: { source: 'attempt-outcome', sourceId: `att_ok_${n}` },
      }),
    );
  }
  for (let n = 1; n <= 3; n++) {
    out.push(
      ev({
        timestamp: `2026-03-2${n}T00:00:00.000Z`,
        evidenceId: `ev_f1h_debug_${n}`,
        evidenceType: 'DEBUGGING_FAILURE',
        confidence: 'medium',
        attemptId: `att_dbg_${n}`,
        provenance: { source: 'attempt-outcome', sourceId: `att_dbg_${n}` },
      }),
    );
  }
  return out;
}

function profileWith(records: LearnerEvidence[], now = '2026-04-01T00:00:00.000Z'): LearnerProfile {
  return rebuildLearnerModel(records, graph(), { now });
}

async function chainPorts(dir: string, profile: LearnerProfile, now: string): Promise<GoalChainPorts> {
  const goalStore = new LocalGoalStore(dir);
  const modelStore = new LocalLearnerModelStore(dir);
  await modelStore.saveProfile(profile);
  return { goalStore, modelStore, graph: graph(), nowIso: () => now };
}

// ---------------------------------------------------------------------------
// Freshness predicates
// ---------------------------------------------------------------------------

describe('Proposal freshness (need still detects, or learner-owned)', () => {
  function implProposal(): { proposal: LearningGoal; profile: LearnerProfile; evidence: LearnerEvidence[] } {
    const evidence = strugglingImplEvidence();
    const profile = profileWith(evidence);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW1 });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation');
    if (!need) {
      throw new Error('fixture must yield a BFS implementation need');
    }
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW1 });
    if (!proposal) {
      throw new Error('fixture proposal must build');
    }
    return { proposal, profile, evidence };
  }

  it('evidence-derived proposal is fresh while its need still detects', () => {
    const { proposal, profile } = implProposal();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW2 });
    expect(isProposalFresh(proposal, needs)).to.be.true;
  });

  it('evidence-derived proposal is stale once its need no longer detects', () => {
    const { proposal } = implProposal();
    const later = profileWith(resolvedImplStrugglingDebugEvidence());
    const needs = detectLearningNeeds({ profile: later, graph: graph(), now: NOW2 });
    expect(needs.some((n) => n.needId === proposal.evidenceBasis.needId)).to.be.false;
    expect(isProposalFresh(proposal, needs)).to.be.false;
  });

  it('non-proposed goals are never fresh suggestions', () => {
    const { proposal, profile } = implProposal();
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW2 });
    const active = acceptGoal(proposal, { profile, now: NOW2 });
    expect(isProposalFresh(active, needs)).to.be.false;
  });

  it('learner-owned requests stay fresh by ownership, never by evidence', () => {
    const profile = profileWith([]);
    const proposal = proposeGoalFromRequest(
      { entityIds: [BFS], dimension: 'implementation', learnerStatement: 'I want BFS practice.' },
      { graph: graph(), profile, now: NOW1 },
    );
    if (!proposal) {
      throw new Error('fixture learner-requested proposal must build');
    }
    expect(proposal.evidenceBasis.needId).to.be.null;
    expect(isProposalFresh(proposal, [])).to.be.true;
    const later = profileWith(resolvedImplStrugglingDebugEvidence());
    const needs = detectLearningNeeds({ profile: later, graph: graph(), now: NOW2 });
    expect(isProposalFresh(proposal, needs)).to.be.true;
  });

  it('partitions pending proposals deterministically', () => {
    const { proposal: freshProposal, profile } = implProposal();
    const requested = proposeGoalFromRequest(
      { entityIds: [BFS], dimension: 'transfer', learnerStatement: 'Transfer please.' },
      { graph: graph(), profile, now: NOW1 },
    );
    if (!requested) {
      throw new Error('fixture learner-requested proposal must build');
    }
    const later = profileWith(resolvedImplStrugglingDebugEvidence());
    const needs = detectLearningNeeds({ profile: later, graph: graph(), now: NOW2 });
    const { fresh, stale } = partitionPendingByFreshness(
      [freshProposal, requested, acceptGoal(freshProposal, { profile, now: NOW2 })],
      needs,
    );
    // Active goals are not pending at all; the learner request stays fresh;
    // the lapsed implementation proposal is stale.
    expect(fresh.map((g) => g.goalId)).to.deep.equal([requested.goalId]);
    expect(stale.map((g) => g.goalId)).to.deep.equal([freshProposal.goalId]);
  });
});

// ---------------------------------------------------------------------------
// Provenance resolution + formatting
// ---------------------------------------------------------------------------

describe('Proposal provenance (answerable "based on what?")', () => {
  function basisEvidence(): LearnerEvidence[] {
    return [
      ev({
        timestamp: '2026-03-01T10:00:00.000Z',
        evidenceId: 'ev_f1h_prov_1',
        evidenceType: 'IMPLEMENTATION_FAILURE',
        attemptId: 'att_prov_1',
        problemId: 'prob_alpha',
        provenance: { source: 'attempt-outcome', sourceId: 'att_prov_1' },
      }),
      ev({
        timestamp: '2026-03-02T10:00:00.000Z',
        evidenceId: 'ev_f1h_prov_2',
        evidenceType: 'IMPLEMENTATION_FAILURE',
        attemptId: 'att_prov_2',
        problemId: 'prob_beta',
        provenance: { source: 'attempt-outcome', sourceId: 'att_prov_2' },
      }),
    ];
  }

  function proposalWithBasis(evidenceIds: string[]): LearningGoal {
    const evidence = strugglingImplEvidence();
    const profile = profileWith(evidence);
    const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW1 });
    const need = needs.find((n) => n.entityIds.includes(BFS) && n.dimension === 'implementation')!;
    const proposal = proposeGoalFromNeed(need, { graph: graph(), now: NOW1 })!;
    return {
      ...proposal,
      evidenceBasis: { ...proposal.evidenceBasis, evidenceIds: [...evidenceIds] },
    };
  }

  it('resolves basis IDs to attempts, problems, and latest time', () => {
    const provenance = resolveProposalProvenance(
      proposalWithBasis(['ev_f1h_prov_1', 'ev_f1h_prov_2']),
      basisEvidence(),
    );
    expect(provenance.attemptIds).to.deep.equal(['att_prov_1', 'att_prov_2']);
    expect(provenance.problemIds).to.deep.equal(['prob_alpha', 'prob_beta']);
    expect(provenance.latestTimestamp).to.equal('2026-03-02T10:00:00.000Z');
    expect(provenance.resolvedCount).to.equal(2);
  });

  it('never fabricates sources for unresolvable IDs', () => {
    const provenance = resolveProposalProvenance(proposalWithBasis(['ev_gone_1']), basisEvidence());
    expect(provenance.attemptIds).to.deep.equal([]);
    expect(provenance.problemIds).to.deep.equal([]);
    expect(provenance.latestTimestamp).to.be.null;
    expect(provenance.resolvedCount).to.equal(0);
  });

  it('formats an evidence-derived line with titles, count, and date', () => {
    const line = formatProvenanceLine(
      proposalWithBasis(['ev_f1h_prov_1', 'ev_f1h_prov_2']),
      resolveProposalProvenance(proposalWithBasis(['ev_f1h_prov_1', 'ev_f1h_prov_2']), basisEvidence()),
      (problemId) => (problemId === 'prob_alpha' ? 'Alpha Problem' : problemId === 'prob_beta' ? 'Beta Problem' : null),
    );
    expect(line).to.be.a('string');
    expect(line!).to.contain('Alpha Problem');
    expect(line!).to.contain('Beta Problem');
    expect(line!).to.contain('2 encounter(s)');
    expect(line!).to.contain('2026-03-02');
  });

  it('falls back to counts when nothing resolves, without inventing titles', () => {
    const line = formatProvenanceLine(
      proposalWithBasis(['ev_gone_1', 'ev_gone_2']),
      resolveProposalProvenance(proposalWithBasis(['ev_gone_1', 'ev_gone_2']), basisEvidence()),
      () => null,
    );
    expect(line).to.contain('2 past encounter(s)');
    expect(line).to.not.contain('prob');
  });

  it('cites the request itself for learner-owned goals', () => {
    const profile = profileWith([]);
    const requested = proposeGoalFromRequest(
      { entityIds: [BFS], dimension: 'implementation', learnerStatement: 'Drill BFS grids.' },
      { graph: graph(), profile, now: NOW1 },
    )!;
    const line = formatProvenanceLine(requested, resolveProposalProvenance(requested, []), () => null);
    expect(line).to.contain('Based on your request');
    expect(line).to.contain('Drill BFS grids.');
  });

  it('bounds the line length', () => {
    const profile = profileWith([]);
    const requested = proposeGoalFromRequest(
      { entityIds: [BFS], dimension: 'implementation', learnerStatement: `x`.repeat(500) },
      { graph: graph(), profile, now: NOW1 },
    )!;
    const line = formatProvenanceLine(requested, resolveProposalProvenance(requested, []), () => null)!;
    expect(line.length).to.be.lessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Serialized proposal chain
// ---------------------------------------------------------------------------

describe('Post-problem proposal chain (single-flight, stale-safe)', () => {
  it('proposes after an attempt end when a need detects', async () => {
    const dir = tmpDir('codesense-test-f1h-propose');
    clean(dir);
    try {
      const ports = await chainPorts(dir, profileWith(strugglingImplEvidence()), NOW1);
      const result = await proposeGoalForAttemptEnd(ports);
      expect(result.action).to.equal('proposed');
      if (result.action !== 'proposed') {
        throw new Error('expected proposed');
      }
      expect(result.proposal.status).to.equal('proposed');
      expect(result.proposal.targetKey).to.equal(`${BFS}|implementation`);
      expect(await ports.goalStore.listGoals()).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('Problem B, same need still current: no duplicate proposal', async () => {
    const dir = tmpDir('codesense-test-f1h-nodup');
    clean(dir);
    try {
      const ports = await chainPorts(dir, profileWith(strugglingImplEvidence()), NOW1);
      const first = await proposeGoalForAttemptEnd(ports);
      if (first.action !== 'proposed') {
        throw new Error('expected first proposal');
      }
      const second = await proposeGoalForAttemptEnd({ ...ports, nowIso: () => NOW2 });
      expect(second.action).to.equal('suppressed-pending');
      if (second.action !== 'suppressed-pending') {
        throw new Error('expected suppression');
      }
      expect(second.proposal.goalId).to.equal(first.proposal.goalId);
      expect(await ports.goalStore.listGoals()).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('Problem B, different need: a new proposal is allowed', async () => {
    const dir = tmpDir('codesense-test-f1h-newneed');
    clean(dir);
    try {
      const profile1 = profileWith(strugglingImplEvidence());
      const ports = await chainPorts(dir, profile1, NOW1);
      const first = await proposeGoalForAttemptEnd(ports);
      if (first.action !== 'proposed') {
        throw new Error('expected first proposal');
      }
      // Learner accepts the implementation goal; later evidence shows a
      // debugging need instead.
      await ports.goalStore.upsertGoal(acceptGoal(first.proposal, { profile: profile1, now: NOW1 }));
      const profile2 = profileWith(resolvedImplStrugglingDebugEvidence());
      await ports.modelStore.saveProfile(profile2);
      const second = await proposeGoalForAttemptEnd({ ...ports, nowIso: () => NOW2 });
      expect(second.action).to.equal('proposed');
      if (second.action !== 'proposed') {
        throw new Error('expected second proposal');
      }
      expect(second.proposal.targetKey).to.equal(`${BFS}|debugging`);
      expect(await ports.goalStore.listGoals()).to.have.lengthOf(2);
    } finally {
      clean(dir);
    }
  });

  it('stale pending must not suppress a legitimate new proposal', async () => {
    const dir = tmpDir('codesense-test-f1h-stale');
    clean(dir);
    try {
      const profile1 = profileWith(strugglingImplEvidence());
      const ports = await chainPorts(dir, profile1, NOW1);
      const first = await proposeGoalForAttemptEnd(ports);
      if (first.action !== 'proposed') {
        throw new Error('expected first proposal');
      }
      const before = JSON.stringify(await ports.goalStore.getGoal(first.proposal.goalId));
      // New evidence: the implementation need lapsed, debugging struggles.
      const profile2 = profileWith(resolvedImplStrugglingDebugEvidence());
      await ports.modelStore.saveProfile(profile2);
      const second = await proposeGoalForAttemptEnd({ ...ports, nowIso: () => NOW2 });
      expect(second.action).to.equal('proposed');
      if (second.action !== 'proposed') {
        throw new Error('stale pending must not suppress the new need');
      }
      expect(second.proposal.targetKey).to.equal(`${BFS}|debugging`);
      // The stale proposal is preserved untouched for the learner to decide on.
      expect(JSON.stringify(await ports.goalStore.getGoal(first.proposal.goalId))).to.equal(before);
      expect(await ports.goalStore.listGoals()).to.have.lengthOf(2);
    } finally {
      clean(dir);
    }
  });

  it('overlapping endProblem chains cannot create duplicate proposals', async () => {
    const dir = tmpDir('codesense-test-f1h-overlap');
    clean(dir);
    try {
      const ports = await chainPorts(dir, profileWith(strugglingImplEvidence()), NOW1);
      const results = await Promise.all([
        proposeGoalForAttemptEnd(ports),
        proposeGoalForAttemptEnd(ports),
        proposeGoalForAttemptEnd(ports),
        proposeGoalForAttemptEnd(ports),
        proposeGoalForAttemptEnd(ports),
      ]);
      const proposed = results.filter((r) => r.action === 'proposed');
      const suppressed = results.filter((r) => r.action === 'suppressed-pending');
      expect(proposed).to.have.lengthOf(1);
      expect(suppressed).to.have.lengthOf(4);
      expect(await ports.goalStore.listGoals()).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('missing profile and failing stores degrade to silence, never throw', async () => {
    const dir = tmpDir('codesense-test-f1h-failopen');
    clean(dir);
    try {
      const fresh: GoalChainPorts = {
        goalStore: new LocalGoalStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => NOW1,
      };
      const missing = await proposeGoalForAttemptEnd(fresh);
      expect(missing.action).to.equal('none');
      if (missing.action === 'none') {
        expect(missing.reason).to.equal('no-profile');
      }
      const broken: GoalChainPorts = {
        goalStore: {
          upsertGoal: async () => {
            throw new Error('disk gone');
          },
          getGoal: async () => null,
          listGoals: async () => {
            throw new Error('disk gone');
          },
        } as GoalStore,
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => NOW1,
      };
      const failed = await proposeGoalForAttemptEnd(broken);
      expect(failed.action).to.equal('none');
    } finally {
      clean(dir);
    }
  });

  it('reload does not resurrect stale recommendations incorrectly', async () => {
    const dir = tmpDir('codesense-test-f1h-reload');
    clean(dir);
    try {
      const ports = await chainPorts(dir, profileWith(strugglingImplEvidence()), NOW1);
      const first = await proposeGoalForAttemptEnd(ports);
      if (first.action !== 'proposed') {
        throw new Error('expected first proposal');
      }
      // Fresh process view of the same persisted state: same verdicts.
      const reloaded = new LocalGoalStore(dir);
      const goals = await reloaded.listGoals();
      expect(goals).to.have.lengthOf(1);
      const profile = profileWith(strugglingImplEvidence());
      const needs = detectLearningNeeds({ profile, graph: graph(), now: NOW2 });
      expect(isProposalFresh(goals[0] as LearningGoal, needs)).to.be.true;
      const later = profileWith(resolvedImplStrugglingDebugEvidence());
      const laterNeeds = detectLearningNeeds({ profile: later, graph: graph(), now: NOW2 });
      expect(isProposalFresh(goals[0] as LearningGoal, laterNeeds)).to.be.false;
    } finally {
      clean(dir);
    }
  });
});
