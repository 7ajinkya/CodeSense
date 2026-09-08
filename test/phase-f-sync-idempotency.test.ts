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
  interruptAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt } from 'codesense/attempts/attempt';
import type { AIEvaluation } from 'codesense/ai/aiTypes';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import type { EvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import type { LearnerModelStore } from 'codesense/learner/learnerModelStore';
import {
  extractAttemptEvidence,
  syncAttemptToLearnerModel,
} from 'codesense/learner/learnerFeeds';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import { detectLearningNeeds } from 'codesense/goals/needDetection';
import { proposeGoalFromNeed } from 'codesense/goals/goalProposal';
import { acceptGoal } from 'codesense/goals/goalLifecycle';
import { buildPracticeCatalog } from 'codesense/practice/activityCatalog';
import { planNextActivity } from 'codesense/practice/activityPlanner';
import { linkAttemptToPlan, offerPlan, startPlan } from 'codesense/practice/activityLifecycle';
import { evaluateActivityProgress } from 'codesense/progress/progressEvaluation';

/**
 * Phase F — Duplicate Attempt Evidence Sync Fix.
 *
 * Regression coverage for the integration invariant:
 *
 *   one finalized attempt → one authoritative D evidence synchronization.
 *
 * Background: `endProblem` used to trigger two sync passes for the same
 * attempt (one direct, one via the F1 goal chain), and every pass minted
 * fresh random evidence IDs — so the evidence store (which dedupes by ID
 * only) kept both copies and the learner model double-counted them.
 * Attempt-derived evidence IDs are now stable per attempt, so repeated
 * passes collapse onto the same authoritative records.
 */

const BFS = 'framework.bfs';
const GRAPH_TOPIC = 'topic.graphs';
const CONNECTED = 'concept.connected-components';
const QUEUE_FIFO = 'concept.queue-fifo';
const MULTI_BFS = 'form.multisource-bfs';
const DIST_PROP = 'pattern.distance-time-propagation';
const VISITED = 'tactic.visited-on-enqueue';

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

function problemFixture(): Problem {
  return createManualProblem('https://leetcode.com/problems/rotting-oranges-sync/', {
    title: 'Rotting Oranges (sync)',
    statement: 'Grid rotting problem statement for sync tests.',
  });
}

function classificationFixture(problem: Problem): ProblemClassification {
  const validated = validateClassificationPayload(
    {
      topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
      concepts: [{ entityId: CONNECTED, confidence: 'medium' }],
      frameworks: [{ entityId: BFS, confidence: 'high' }],
      forms: [{ entityId: MULTI_BFS, confidence: 'medium' }],
      patterns: [{ entityId: DIST_PROP, confidence: 'medium' }],
      variants: [],
      tactics: [{ entityId: VISITED, confidence: 'high' }],
      prerequisites: [{ entityId: QUEUE_FIFO, confidence: 'high' }],
      solutionFamilies: [{ entityId: BFS, confidence: 'high' }],
      curriculumMappings: [],
      confidence: 'high',
    },
    { graph: graph() },
  );
  if (!validated.ok) {
    throw new Error('fixture classification must validate');
  }
  return finalizeClassification(validated.value, {
    problemId: problem.problemId,
    ontologyVersion: graph().ontologyVersion,
    classifierVersion: '1',
    classifiedAt: '2026-03-01T00:00:00.000Z',
    problemSourceUrl: problem.provenance.sourceUrl,
    source: 'ai',
  });
}

function attemptFixture(
  attemptId: string,
  problemId: string,
  finalState: Attempt['currentState'],
  at: string,
): Attempt {
  const attempt = createAttempt({ attemptId, problemId, sessionId: 'ses_1', startedAt: at });
  if (finalState !== 'In Progress') {
    transitionAttemptState(attempt, finalState, 'learner', { timestamp: at });
    completeAttempt(attempt, at);
  }
  return attempt;
}

function hintEvaluation(attemptId: string): AIEvaluation {
  return {
    evaluationId: 'eval_hint_1',
    attemptId,
    timestamp: '2026-03-01T00:05:00.000Z',
    triggerKind: 'idle',
    shouldIntervene: true,
    interventionType: 'HINT',
    urgency: 'low',
    message: 'What does the queue hold right now?',
    reasoningSignals: {
      observedApproach: 'BFS attempt',
      suspectedIssue: 'queue handling',
      confidence: 0.5,
      relevantEvidence: ['edit v3 touched the queue'],
    },
    diagnosis: {
      observedEvidence: ['queue re-created inside the loop at edit v3'],
      hypothesis: 'The learner may be re-creating the queue instead of reusing it.',
      confidence: 'medium',
      unknowns: [],
      recommendedInteraction: 'DEBUGGING_HELP',
    },
    requiresLearnerResponse: false,
  } as AIEvaluation;
}

interface SyncPorts {
  evidenceStore: EvidenceStore;
  modelStore: LearnerModelStore;
  graph: KnowledgeGraph;
  nowIso(): string;
}

function ports(dir: string, now = '2026-04-01T00:00:00.000Z'): SyncPorts {
  return {
    evidenceStore: new LocalLearnerEvidenceStore(dir),
    modelStore: new LocalLearnerModelStore(dir),
    graph: graph(),
    nowIso: () => now,
  };
}

function evidenceIdsForAttempt(evidence: Array<{ attemptId: string | null; evidenceId: string }>, attemptId: string): string[] {
  return evidence
    .filter((e) => e.attemptId === attemptId)
    .map((e) => e.evidenceId)
    .sort();
}

// ---------------------------------------------------------------------------
// Bug reproduction: the endProblem double-sync path
// ---------------------------------------------------------------------------

describe('Phase F duplicate sync (one attempt → one authoritative sync)', () => {
  it('FAILS BEFORE FIX: two endProblem sync passes mint duplicate evidence', async () => {
    const dir = tmpDir('codesense-test-phase-f-double-sync');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const attempt = attemptFixture('att_dup_1', problem.problemId, 'Got WA', '2026-03-01T00:00:00.000Z');
      const input = { attempt, problem, classification, evaluations: [] };
      // Pass #1: endProblem's direct sync. Pass #2: the F1 chain's awaited sync of the SAME attempt.
      const first = await syncAttemptToLearnerModel(p, input);
      const second = await syncAttemptToLearnerModel(p, input);
      expect(first.error).to.be.undefined;
      expect(second.error).to.be.undefined;
      const history = await p.evidenceStore.listEvidence();
      // The second pass must not persist anything new.
      expect(second.stored).to.equal(0);
      // Stable attempt identity → identical record set, not two copies.
      expect(evidenceIdsForAttempt(history, attempt.attemptId)).to.have.lengthOf(first.stored);
      expect(history).to.have.lengthOf(first.totalEvidence);
    } finally {
      clean(dir);
    }
  });

  it('minting is deterministic for identical finalized inputs', () => {
    const problem = problemFixture();
    const classification = classificationFixture(problem);
    const args = {
      attempt: attemptFixture('att_det_1', problem.problemId, 'Got AC with Help', '2026-03-01T00:00:00.000Z'),
      problem,
      classification,
      evaluations: [hintEvaluation('att_det_1')],
    };
    const first = extractAttemptEvidence(graph(), args);
    const second = extractAttemptEvidence(graph(), args);
    expect(first.length).to.be.greaterThan(0);
    // Byte-identical records (IDs included): same attempt + same finalization → same evidence.
    expect(second).to.deep.equal(first);
  });

  it('Case A — same attempt synced twice leaves D evidence unchanged', async () => {
    const dir = tmpDir('codesense-test-phase-f-case-a');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const input = {
        attempt: attemptFixture('att_a_1', problem.problemId, 'Got AC Independently', '2026-03-01T00:00:00.000Z'),
        problem,
        classification,
        evaluations: [],
      };
      await syncAttemptToLearnerModel(p, input);
      const afterFirst = await p.evidenceStore.listEvidence();
      const profileFirst = await p.modelStore.loadProfile();
      await syncAttemptToLearnerModel(p, input);
      const afterSecond = await p.evidenceStore.listEvidence();
      const profileSecond = await p.modelStore.loadProfile();
      expect(afterSecond).to.deep.equal(afterFirst);
      expect(JSON.stringify(profileSecond)).to.equal(JSON.stringify(profileFirst));
    } finally {
      clean(dir);
    }
  });

  it('Case B — endProblem path: F1 and F3 consume one authoritative result', async () => {
    const dirA = tmpDir('codesense-test-phase-f-case-b-double');
    const dirB = tmpDir('codesense-test-phase-f-case-b-single');
    clean(dirA);
    clean(dirB);
    try {
      const setup = (dir: string) => {
        const p = ports(dir);
        const problem = problemFixture();
        const classification = classificationFixture(problem);
        return { p, problem, classification };
      };
      // Grounding attempts: the historical endProblem double pass (direct +
      // F1 chain) for each of three corroborating failures.
      const groundA = setup(dirA);
      const groundB = setup(dirB);
      const groundingAttempts: Attempt[] = [];
      for (const attemptId of ['att_b_0a', 'att_b_0b', 'att_b_0c']) {
        const attempt = attemptFixture(attemptId, groundA.problem.problemId, 'Got WA', '2026-03-01T00:00:00.000Z');
        groundingAttempts.push(attempt);
        const inputA = { attempt, problem: groundA.problem, classification: groundA.classification, evaluations: [] as AIEvaluation[] };
        await syncAttemptToLearnerModel(groundA.p, inputA);
        await syncAttemptToLearnerModel(groundA.p, inputA);
        const inputB = { attempt, problem: groundB.problem, classification: groundB.classification, evaluations: [] as AIEvaluation[] };
        await syncAttemptToLearnerModel(groundB.p, inputB);
      }
      // Double sync ≡ single sync: identical histories and identical profiles.
      const historyA = await groundA.p.evidenceStore.listEvidence();
      const historyB = await groundB.p.evidenceStore.listEvidence();
      expect(historyA).to.deep.equal(historyB);
      const profileA = (await groundA.p.modelStore.loadProfile())!;
      const profileB = (await groundB.p.modelStore.loadProfile())!;
      expect(JSON.stringify(profileA)).to.equal(JSON.stringify(profileB));
      // Each attempt contributed exactly one EXPOSURE and one failure record.
      expect(historyA.filter((e) => e.evidenceType === 'EXPOSURE')).to.have.lengthOf(3);
      expect(historyA.filter((e) => e.evidenceType === 'IMPLEMENTATION_FAILURE')).to.have.lengthOf(3);
      expect(historyA).to.have.lengthOf(6);
      // F1 consumes the authoritative state.
      const needs = detectLearningNeeds({ profile: profileA, graph: graph(), now: '2026-04-02T00:00:00.000Z' });
      const need = needs.find((n) => n.entityIds.includes(BFS));
      if (!need) {
        throw new Error('fixture must yield a BFS need');
      }
      const goal = acceptGoal(proposeGoalFromNeed(need, { graph: graph(), now: '2026-04-02T00:00:00.000Z' })!, {
        profile: profileA,
        now: '2026-04-02T00:00:00.000Z',
      });
      // F2 plans a justified repeat of the same problem; the planned
      // activity is then performed as a NEW attempt with its own single sync.
      const catalog = buildPracticeCatalog([groundA.problem], [groundA.classification]);
      const planned = planNextActivity({
        goal, graph: graph(), profile: profileA, evidence: historyA, catalog, attempts: groundingAttempts, priorPlans: [],
        allowRepeatProblemIds: [groundA.problem.problemId], now: '2026-04-03T00:00:00.000Z',
      });
      if (planned.status !== 'planned') {
        throw new Error(`fixture planning must succeed: ${planned.reason}`);
      }
      const attemptB = attemptFixture('att_b_1', groundA.problem.problemId, 'Got WA', '2026-04-04T00:00:00.000Z');
      await syncAttemptToLearnerModel(groundA.p, {
        attempt: attemptB, problem: groundA.problem, classification: groundA.classification, evaluations: [],
      });
      const fullHistory = await groundA.p.evidenceStore.listEvidence();
      const fullProfile = (await groundA.p.modelStore.loadProfile())!;
      const linked = startPlan(
        linkAttemptToPlan(offerPlan(planned.plans[0]!, '2026-04-03T00:00:00.000Z'), attemptB, '2026-04-04T10:00:00.000Z'),
        '2026-04-04T10:00:00.000Z',
      );
      // F3 consumes the same authoritative evidence through the planned activity.
      const evaluated = evaluateActivityProgress({
        goal, plan: linked, attempt: attemptB, evidence: fullHistory, profile: fullProfile, graph: graph(),
        priorProgress: [], now: '2026-04-05T00:00:00.000Z',
      });
      if (evaluated.status !== 'evaluated') {
        throw new Error('fixture evaluation must succeed');
      }
      // Only the new attempt's failure is new goal-dimension evidence — no duplicated IDs.
      const cited = [...evaluated.progress.positiveNewIds, ...evaluated.progress.negativeNewIds];
      expect(new Set(cited).size).to.equal(cited.length);
      expect(evaluated.progress.negativeNewIds).to.have.lengthOf(1);
      expect(fullHistory.filter((e) => e.attemptId === attemptB.attemptId)).to.have.lengthOf(2);
    } finally {
      clean(dirA);
      clean(dirB);
    }
  });

  it('Case C — a different attempt still produces its own legitimate evidence', async () => {
    const dir = tmpDir('codesense-test-phase-f-case-c');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const first = {
        attempt: attemptFixture('att_c_1', problem.problemId, 'Got WA', '2026-03-01T00:00:00.000Z'),
        problem, classification, evaluations: [],
      };
      const second = {
        attempt: attemptFixture('att_c_2', problem.problemId, 'Got WA', '2026-03-02T00:00:00.000Z'),
        problem, classification, evaluations: [],
      };
      const out1 = await syncAttemptToLearnerModel(p, first);
      const out2 = await syncAttemptToLearnerModel(p, second);
      expect(out1.stored).to.be.greaterThan(0);
      expect(out2.stored).to.equal(out1.stored);
      const history = await p.evidenceStore.listEvidence();
      expect(history).to.have.lengthOf(out1.stored + out2.stored);
      const ids1 = new Set(evidenceIdsForAttempt(history, 'att_c_1'));
      const ids2 = new Set(evidenceIdsForAttempt(history, 'att_c_2'));
      expect(ids1.size).to.be.greaterThan(0);
      expect(ids2.size).to.be.greaterThan(0);
      for (const id of ids1) {
        expect(ids2.has(id), `evidence ID collision across attempts: ${id}`).to.be.false;
      }
    } finally {
      clean(dir);
    }
  });

  it('Case D — legitimate multiple facets from one attempt remain intact', async () => {
    const dir = tmpDir('codesense-test-phase-f-case-d');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const independent = {
        attempt: attemptFixture('att_d_1', problem.problemId, 'Got AC Independently', '2026-03-01T00:00:00.000Z'),
        problem, classification, evaluations: [],
      };
      const helped = {
        attempt: attemptFixture('att_d_2', problem.problemId, 'Got AC with Help', '2026-03-02T00:00:00.000Z'),
        problem, classification, evaluations: [hintEvaluation('att_d_2')],
      };
      await syncAttemptToLearnerModel(p, independent);
      await syncAttemptToLearnerModel(p, independent);
      await syncAttemptToLearnerModel(p, helped);
      await syncAttemptToLearnerModel(p, helped);
      const history = await p.evidenceStore.listEvidence();
      const ind = evidenceIdsForAttempt(history, 'att_d_1');
      const hlp = evidenceIdsForAttempt(history, 'att_d_2');
      // Independent success keeps all three facets; helped keeps exposure + outcome + help.
      expect(history.filter((e) => e.attemptId === 'att_d_1').map((e) => e.evidenceType).sort()).to.deep.equal(
        ['EXPOSURE', 'IMPLEMENTATION_SUCCESS', 'INDEPENDENT_SUCCESS'],
      );
      expect(history.filter((e) => e.attemptId === 'att_d_2').map((e) => e.evidenceType).sort()).to.deep.equal(
        ['EXPOSURE', 'HELP_REQUIRED', 'IMPLEMENTATION_SUCCESS'],
      );
      expect(ind).to.have.lengthOf(3);
      expect(hlp).to.have.lengthOf(3);
      // D weights reflect single observations, not doubled syncs.
      const profile = rebuildLearnerModel(history, graph(), { now: '2026-04-01T00:00:00.000Z' });
      const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
      expect(state.implementation.positiveEvidenceIds).to.have.lengthOf(2);
      expect(state.implementation.negativeEvidenceIds).to.have.lengthOf(0);
    } finally {
      clean(dir);
    }
  });

  it('Case E — lifecycle still guards incomplete attempts; interrupted attempts sync stably', async () => {
    // The lifecycle never finalizes In Progress attempts (existing guard, locked in).
    const open = createAttempt({ attemptId: 'att_e_open', problemId: 'prob_x', sessionId: 'ses_1' });
    let threw = false;
    try {
      completeAttempt(open);
    } catch {
      threw = true;
    }
    expect(threw, 'In Progress attempts must not complete').to.be.true;
    // The deactivate path (interrupt → complete → sync) is stable under repetition.
    const dir = tmpDir('codesense-test-phase-f-case-e');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const pending = createAttempt({
        attemptId: 'att_e_1', problemId: problem.problemId, sessionId: 'ses_1', startedAt: '2026-03-01T00:00:00.000Z',
      });
      const { interrupted } = interruptAttempt(pending, '2026-03-01T01:00:00.000Z');
      expect(interrupted).to.be.true;
      const input = { attempt: pending, problem, classification, evaluations: [] };
      const first = await syncAttemptToLearnerModel(p, input);
      const second = await syncAttemptToLearnerModel(p, input);
      expect(first.stored).to.be.greaterThan(0);
      expect(second.stored).to.equal(0);
      expect((await p.evidenceStore.listEvidence()).length).to.equal(first.totalEvidence);
    } finally {
      clean(dir);
    }
  });

  it('differing inputs between passes preserve genuinely new observations', async () => {
    const dir = tmpDir('codesense-test-phase-f-race');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const attempt = attemptFixture('att_r_1', problem.problemId, 'Got AC with Help', '2026-03-01T00:00:00.000Z');
      // Pass 1 observes no coach help; pass 2 observes a hint given mid-attempt.
      await syncAttemptToLearnerModel(p, { attempt, problem, classification, evaluations: [] });
      await syncAttemptToLearnerModel(p, { attempt, problem, classification, evaluations: [hintEvaluation(attempt.attemptId)] });
      const history = await p.evidenceStore.listEvidence();
      const impl = history.filter((e) => e.attemptId === attempt.attemptId && e.evidenceType === 'IMPLEMENTATION_SUCCESS');
      const help = history.filter((e) => e.attemptId === attempt.attemptId && e.evidenceType === 'HELP_REQUIRED');
      // The shared outcome record collapses; the newly observed help level is kept.
      expect(impl).to.have.lengthOf(1);
      expect(help.map((e) => e.helpLevel).sort()).to.deep.equal(['hint', 'unknown']);
    } finally {
      clean(dir);
    }
  });
});
