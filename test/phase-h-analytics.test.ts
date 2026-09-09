import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
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
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import type { LearnerProfile } from 'codesense/learner/learnerModel';
import { LocalProblemStore } from 'codesense/problems/problemStore';
import { LocalAttemptStore } from 'codesense/attempts/attemptStore';
import { LocalClassificationStore } from 'codesense/knowledge/classificationStore';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import { LocalGoalStore } from 'codesense/goals/goalStore';
import { LocalActivityPlanStore } from 'codesense/practice/activityStore';
import { LocalProgressStore } from 'codesense/progress/progressStore';
import { LocalReflectionStore } from 'codesense/reflection/reflectionStore';
import { proposeGoalFromRequest } from 'codesense/goals/goalProposal';
import { acceptGoal } from 'codesense/goals/goalLifecycle';
import type { LearningGoal } from 'codesense/goals/goalTypes';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import type { ActivityProgress } from 'codesense/progress/progressTypes';
import {
  createReflectionOffer,
  markReflectionEmitted,
  respondToReflection,
} from 'codesense/reflection/reflectionTypes';
import {
  LocalAnalyticsSource,
  loadAnalyticsSnapshot,
} from 'codesense/analytics/analyticsSource';
import type { AnalyticsSnapshot } from 'codesense/analytics/analyticsTypes';
import {
  entityHistory,
  evidenceAsOfAttempt,
  filterAttempts,
  filterEvidence,
  goalChainForGoal,
  progressTimelineForGoal,
} from 'codesense/analytics/analyticsQueries';
import {
  activityFrequency,
  countAttemptsByOutcome,
  countEvidenceByType,
  countPlansByPurpose,
  countProgressBySignal,
  countReflectionsByStatus,
  helpLevelBreakdown,
  practiceCoverage,
} from 'codesense/analytics/analyticsAggregates';
import { buildAnalyticsIndex } from 'codesense/analytics/analyticsIndex';
import {
  exportAnalyticsJson,
  exportAnalyticsMarkdown,
  validateExportProvenance,
} from 'codesense/analytics/analyticsExport';
import {
  renderEntityHistory,
  renderGoalProgress,
  renderLearningHistory,
  searchLearningHistory,
} from 'codesense/analytics/analyticsRender';

/**
 * Phase H V1 — Learning Analytics (read-only, deterministic, no AI).
 *
 * Pins: chronological ordering, filters, canonical joins, goal/activity/
 * progress chains, reflection 3-layer separation, duplicate/replay safety,
 * current-model vs historical evidence, export provenance, empty/malformed/
 * stale handling, privacy defaults, determinism, absence semantics, banned
 * mastery vocabulary, frozen D invariant (single positive -> at most EMERGING).
 */

const BFS = 'framework.bfs';
const GRAPH_TOPIC = 'topic.graphs';
const CONNECTED = 'concept.connected-components';
const QUEUE_FIFO = 'concept.queue-fifo';

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

function problemFixture(url: string, title: string): Problem {
  // Fixed `now` keeps exports byte-deterministic across fixture builds.
  return createManualProblem(url, { title, statement: `${title} statement.` }, '2026-04-01T09:00:00.000Z');
}

function classificationFixture(problem: Problem, at: string): ProblemClassification {
  const validated = validateClassificationPayload(
    {
      topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
      concepts: [{ entityId: CONNECTED, confidence: 'medium' }],
      frameworks: [{ entityId: BFS, confidence: 'high' }],
      forms: [],
      patterns: [],
      variants: [],
      tactics: [],
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
    classifiedAt: at,
    problemSourceUrl: problem.provenance.sourceUrl,
    source: 'ai',
  });
}

function attemptFixture(
  attemptId: string,
  problemId: string,
  startedAt: string,
  finalState: Attempt['currentState'],
  completedAt: string,
): Attempt {
  const attempt = createAttempt({ attemptId, problemId, sessionId: 'ses_test', startedAt });
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
  extra: Partial<LearnerEvidence> = {},
): LearnerEvidence {
  const parsed = validateLearnerEvidence(
    {
      evidenceId,
      schemaVersion: 1,
      timestamp,
      sessionId: 'ses_test',
      attemptId,
      problemId,
      entityIds: [BFS],
      evidenceType: type,
      source: 'attempt-outcome',
      observation: `observed ${evidenceId}`,
      interpretation: `interpreted ${evidenceId}`,
      confidence,
      provenance: { source: 'attempt-outcome', sourceId: attemptId },
      ...extra,
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
    { entityIds: [BFS], dimension: 'conceptual', learnerStatement: 'Get better at BFS.' },
    { graph: graph(), profile: null, now },
  );
  if (!proposed) {
    throw new Error('fixture goal must propose');
  }
  const profile = rebuildLearnerModel([], graph(), { now });
  return acceptGoal(proposed, { profile, now });
}

function planFixture(goal: LearningGoal, problem: Problem, now: string, planId: string): ActivityPlan {
  return {
    planId,
    goalId: goal.goalId,
    goalTargetKey: goal.targetKey,
    activityKind: 'coding-problem',
    problemId: problem.problemId,
    problemTitle: problem.title,
    intent: 'conceptual-practice',
    purpose: 'diagnostic',
    entityIds: [BFS],
    dimension: goal.dimension,
    rationale: 'Practice BFS conceptually on a fresh problem.',
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: now,
      ontologyVersion: graph().ontologyVersion,
      aggregatorVersion: '1',
      needId: null,
      goalSource: goal.source,
    },
    expectedEvidence: 'Attempt the problem; any outcome produces evidence.',
    expectedEvidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
    createdAt: now,
    updatedAt: now,
    status: 'offered',
    position: 0,
    sequenceLength: 1,
    sequenceId: 'seq_test',
    linkedAttemptId: null,
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1', catalogSize: 1 },
  };
}

function progressFixture(
  goal: LearningGoal,
  plan: ActivityPlan,
  attemptId: string,
  evaluatedAt: string,
  signal: ActivityProgress['progressSignal'],
): ActivityProgress {
  return {
    progressId: `prog_${goal.goalId}_${plan.planId}_${attemptId}`,
    goalId: goal.goalId,
    goalTargetKey: goal.targetKey,
    planId: plan.planId,
    linkedAttemptId: attemptId,
    goalSource: goal.source,
    dimension: goal.dimension,
    activity: {
      intent: plan.intent,
      purpose: plan.purpose,
      entityIds: [BFS],
      problemId: plan.problemId,
      problemTitle: plan.problemTitle,
    },
    baselineRef: {
      capturedAt: goal.progressBaseline?.capturedAt ?? evaluatedAt,
      profileUpdatedAt: goal.progressBaseline?.profileUpdatedAt ?? evaluatedAt,
    },
    activityEvidenceIds: [],
    weakEvidenceIds: [],
    goalRelevantNewIds: [],
    entities: [
      {
        entityId: BFS,
        baselineLevel: 'UNKNOWN',
        baselineConfidence: 'low',
        currentLevel: 'EMERGING',
        currentConfidence: 'low',
        positiveNewIds: [],
        negativeNewIds: [],
      },
    ],
    independence: {
      independent: false,
      helped: false,
      helpLevels: [],
      independentEvidenceIds: [],
      helpEvidenceIds: [],
    },
    positiveNewIds: [],
    negativeNewIds: [],
    progressSignal: signal,
    reassessment: 'continue',
    explanation: `Deterministic progress ${signal} for test.`,
    firstEvaluatedAt: evaluatedAt,
    evaluatedAt,
    evaluationCount: 1,
    evidenceFingerprint: `fp_${attemptId}`,
    signalHistory: [],
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1' },
  };
}

function snapshotFixture(): AnalyticsSnapshot {
  const problemA = problemFixture('https://example.com/a', 'Problem A');
  const problemB = problemFixture('https://example.com/b', 'Problem B');
  const attemptA = attemptFixture('att_a', problemA.problemId, '2026-04-01T10:00:00.000Z', 'Got AC Independently', '2026-04-01T11:00:00.000Z');
  const attemptB = attemptFixture('att_b', problemB.problemId, '2026-04-02T10:00:00.000Z', 'Got WA', '2026-04-02T11:00:00.000Z');
  const evA = evidenceFixture('ev_a', '2026-04-01T11:00:00.000Z', 'att_a', problemA.problemId, 'IMPLEMENTATION_SUCCESS', 'high');
  const evB = evidenceFixture('ev_b', '2026-04-02T11:00:00.000Z', 'att_b', problemB.problemId, 'CONCEPTUAL_CONFUSION', 'medium');
  const profile: LearnerProfile = rebuildLearnerModel([evA, evB], graph(), { now: '2026-04-03T00:00:00.000Z' });
  const rawGoal = goalFixture('2026-04-02T12:00:00.000Z');
  // Deterministic goal identity: uuids would break byte-determinism checks.
  const goal: LearningGoal = { ...rawGoal, goalId: 'goal_test' };
  const plan = planFixture(goal, problemB, '2026-04-02T13:00:00.000Z', 'plan_1');
  const linkedPlan: ActivityPlan = { ...plan, linkedAttemptId: 'att_b', status: 'started' };
  const progress = progressFixture(goal, linkedPlan, 'att_b', '2026-04-02T14:00:00.000Z', 'EVIDENCE_ADDED');
  const offered = createReflectionOffer({
    attemptId: 'att_b',
    problemId: problemB.problemId,
    sessionId: 'ses_test',
    problemTitle: 'Problem B',
    classificationStatus: 'classified',
    now: '2026-04-02T11:05:00.000Z',
  });
  const responded = respondToReflection(offered, { category: 'did-not-recognize-pattern', freeText: 'I did not see BFS.', now: '2026-04-02T11:06:00.000Z' });
  const reflection = markReflectionEmitted(responded, { evidenceIds: [], interpretation: null, now: '2026-04-02T11:07:00.000Z' });
  return {
    problems: [problemA, problemB],
    attempts: [attemptA, attemptB],
    classifications: [classificationFixture(problemA, '2026-04-01T09:00:00.000Z')],
    evidence: [evA, evB],
    profile,
    evaluations: [],
    conversationCounts: [],
    goals: [goal],
    plans: [linkedPlan],
    progress: [progress],
    reflections: [reflection],
    sessions: [{ sessionId: 'ses_test', startedAt: '2026-04-01T09:00:00.000Z', endedAt: null, eventCount: 2 }],
    ontologyVersion: graph().ontologyVersion,
    aggregatorVersion: '1',
    loadedAt: '2026-04-03T00:00:00.000Z',
    completeness: { complete: true, scope: 'full history', truncatedReasons: [], loadWarnings: [] },
    unresolvedIds: [],
  };
}

describe('Phase H — Learning Analytics V1', () => {
  describe('historical queries: ordering + filters + joins', () => {
    it('orders attempts chronologically with (startedAt, attemptId) tiebreak', () => {
      const snapshot = snapshotFixture();
      const views = filterAttempts(snapshot, {});
      expect(views.map((view) => view.attempt.attemptId)).to.deep.equal(['att_a', 'att_b']);
    });

    it('filters attempts by outcome and date window', () => {
      const snapshot = snapshotFixture();
      const onlyAC = filterAttempts(snapshot, { outcomes: ['Got AC Independently'] });
      expect(onlyAC.map((view) => view.attempt.attemptId)).to.deep.equal(['att_a']);
      const windowed = filterAttempts(snapshot, { from: '2026-04-02T00:00:00.000Z', to: '2026-04-02T23:59:59.999Z' });
      expect(windowed.map((view) => view.attempt.attemptId)).to.deep.equal(['att_b']);
    });

    it('joins attempt -> problem -> classification status without inventing rows', () => {
      const snapshot = snapshotFixture();
      const views = filterAttempts(snapshot, {});
      const byId = new Map(views.map((view) => [view.attempt.attemptId, view] as const));
      expect(byId.get('att_a')?.problem?.title).to.equal('Problem A');
      expect(byId.get('att_a')?.classificationStatus).to.equal('classified');
      expect(byId.get('att_b')?.classificationStatus).to.equal('unclassified');
    });

    it('filters evidence chronologically and by type', () => {
      const snapshot = snapshotFixture();
      const all = filterEvidence(snapshot, {});
      expect(all.map((record) => record.evidenceId)).to.deep.equal(['ev_a', 'ev_b']);
      const onlyConfusion = filterEvidence(snapshot, { evidenceTypes: ['CONCEPTUAL_CONFUSION'] });
      expect(onlyConfusion.map((record) => record.evidenceId)).to.deep.equal(['ev_b']);
    });

    it('unknown entity filter yields empty evidence (never a verdict)', () => {
      const snapshot = snapshotFixture();
      const none = filterEvidence(snapshot, { entityIds: ['pattern.no-such-thing'] });
      expect(none).to.deep.equal([]);
    });
  });

  describe('entity history: current D state vs historical evidence', () => {
    it('pairs D current pointer with chronological evidence', () => {
      const snapshot = snapshotFixture();
      const view = entityHistory(snapshot, BFS, { graphHasEntity: (id) => graph().hasEntity(id) });
      expect(view.knownInGraph).to.equal(true);
      expect(view.currentState).to.not.equal(null);
      expect(view.evidence.map((record) => record.evidenceId)).to.deep.equal(['ev_a', 'ev_b']);
      expect(view.absence).to.equal(null);
    });

    it('marks unknown graph IDs without dropping history', () => {
      const snapshot = snapshotFixture();
      const view = entityHistory(snapshot, 'framework.nope', { graphHasEntity: () => false });
      expect(view.knownInGraph).to.equal(false);
      expect(view.absence).to.equal('unknown-entity');
    });

    it('distinguishes no-record from current-state-note', () => {
      const empty: AnalyticsSnapshot = { ...snapshotFixture(), evidence: [], profile: null };
      const noRecord = entityHistory(empty, BFS, { graphHasEntity: () => true });
      expect(noRecord.absence).to.equal('no-record');
      const withEvidenceOnly: AnalyticsSnapshot = { ...snapshotFixture(), profile: null };
      const note = entityHistory(withEvidenceOnly, BFS, { graphHasEntity: () => true });
      expect(note.absence).to.equal('current-state-note');
      expect(note.evidence.length).to.equal(2);
    });

    it('answers "what evidence existed after attempt X" from timestamps, not today\'s profile', () => {
      const snapshot = snapshotFixture();
      const sliced = evidenceAsOfAttempt(snapshot, 'att_a');
      expect(sliced.found).to.equal(true);
      expect(sliced.evidence.map((record) => record.evidenceId)).to.deep.equal(['ev_a']);
      const missing = evidenceAsOfAttempt(snapshot, 'att_missing');
      expect(missing.found).to.equal(false);
    });
  });

  describe('goal / activity / progress chains', () => {
    it('links goal -> plans -> linked attempts -> progress -> reflections', () => {
      const snapshot = snapshotFixture();
      const goalId = snapshot.goals[0].goalId;
      const chain = goalChainForGoal(snapshot, goalId);
      expect(chain).to.not.equal(null);
      expect(chain?.plans.map((plan) => plan.planId)).to.deep.equal(['plan_1']);
      expect(chain?.attemptIds).to.deep.equal(['att_b']);
      expect(chain?.progress.map((record) => record.progressSignal)).to.deep.equal(['EVIDENCE_ADDED']);
      expect(chain?.goalSource).to.equal('learner-requested');
    });

    it('orders progress timelines oldest-first and preserves signal history shape', () => {
      const snapshot = snapshotFixture();
      const goalId = snapshot.goals[0].goalId;
      const timeline = progressTimelineForGoal(snapshot, goalId);
      expect(timeline.length).to.equal(1);
      expect(timeline[0].progress.linkedAttemptId).to.equal('att_b');
    });

    it('returns null for unknown goals (no-record, never invented)', () => {
      const snapshot = snapshotFixture();
      expect(goalChainForGoal(snapshot, 'goal_missing')).to.equal(null);
    });
  });

  describe('reflection provenance: three layers stay separate', () => {
    it('preserves raw words distinctly from interpretation and evidence', () => {
      const snapshot = snapshotFixture();
      const reflection = snapshot.reflections[0];
      expect(reflection.category).to.equal('did-not-recognize-pattern');
      expect(reflection.freeText).to.equal('I did not see BFS.');
      expect(reflection.interpretation).to.equal(null);
      expect(reflection.evidenceIds).to.deep.equal([]);
      expect(reflection.provenance.attemptId).to.equal('att_b');
    });
  });

  describe('aggregates: labeled families, counts with provenance', () => {
    it('labels activity vs evidence families and cites sources', () => {
      const snapshot = snapshotFixture();
      const now = '2026-04-03T00:00:00.000Z';
      const attempts = countAttemptsByOutcome(snapshot, {}, now);
      expect(attempts.length).to.equal(2);
      for (const aggregate of attempts) {
        expect(aggregate.family).to.equal('activity');
        expect(aggregate.provenance.sourceIds.length).to.be.greaterThan(0);
        expect(aggregate.label).to.include('(activity)');
      }
      const evidence = countEvidenceByType(snapshot, {}, now);
      for (const aggregate of evidence) {
        expect(aggregate.family).to.equal('evidence');
        expect(aggregate.label).to.include('(evidence)');
      }
    });

    it('names streaks as activity streaks and coverage as practice/exposure', () => {
      const snapshot = snapshotFixture();
      const now = '2026-04-03T00:00:00.000Z';
      const frequency = activityFrequency(snapshot, {}, now);
      expect(frequency.map((aggregate) => aggregate.key)).to.deep.equal([
        'activity.active-days',
        'activity.longest-streak-days',
      ]);
      expect(frequency[1].label).to.include('activity streak');
      const coverage = practiceCoverage(snapshot, {}, now);
      expect(coverage[0].label).to.include('practice/exposure coverage');
      const purposes = countPlansByPurpose(snapshot, {}, now);
      expect(purposes[0].label).to.include('F2 activity plans');
      const help = helpLevelBreakdown(snapshot, {}, now);
      expect(help).to.deep.equal([]);
    });

    it('never emits mastery vocabulary', () => {
      const snapshot = snapshotFixture();
      const now = '2026-04-03T00:00:00.000Z';
      const all = [
        ...countAttemptsByOutcome(snapshot, {}, now),
        ...countEvidenceByType(snapshot, {}, now),
        ...countProgressBySignal(snapshot, {}, now),
        ...countReflectionsByStatus(snapshot, {}, now),
        ...countPlansByPurpose(snapshot, {}, now),
        ...activityFrequency(snapshot, {}, now),
        ...practiceCoverage(snapshot, {}, now),
      ];
      const banned = ['mastery', 'score', ' 8.', '%', 'advanced', 'beginner', 'weak at', 'unable to'];
      for (const aggregate of all) {
        for (const term of banned) {
          expect(aggregate.label.toLowerCase()).to.not.include(term);
          expect(aggregate.key.toLowerCase()).to.not.include('mastery');
        }
      }
    });
  });

  describe('index: IDs only, required keys only', () => {
    it('builds ID references without duplicating records', () => {
      const snapshot = snapshotFixture();
      const index = buildAnalyticsIndex(snapshot);
      expect(index.attemptsByProblem.get(snapshot.attempts[0].problemId)).to.include('att_a');
      expect(index.evidenceByEntity.get(BFS)?.slice().sort()).to.deep.equal(['ev_a', 'ev_b']);
      expect(index.progressByGoal.get(snapshot.goals[0].goalId)?.length).to.equal(1);
      expect(index.reflectionsByAttempt.get('att_b')).to.equal(snapshot.reflections[0].reflectionId);
    });
  });

  describe('export: raw vs derived separated, provenance preserved', () => {
    it('exports JSON with raw records and derived aggregates', () => {
      const snapshot = snapshotFixture();
      const exported = exportAnalyticsJson(snapshot, {}, '2026-04-03T00:00:00.000Z');
      expect(exported.exportVersion).to.equal(1);
      expect(exported.raw.attempts.length).to.equal(2);
      expect(exported.raw.evidence.length).to.equal(2);
      expect(exported.derived.aggregates.length).to.be.greaterThan(0);
      expect(validateExportProvenance(exported)).to.equal(true);
    });

    it('exports Markdown with cited IDs and no banned vocabulary', () => {
      const snapshot = snapshotFixture();
      const markdown = exportAnalyticsMarkdown(snapshot, {}, '2026-04-03T00:00:00.000Z');
      expect(markdown).to.include('## Historical records');
      expect(markdown).to.include('## Derived analytics');
      expect(markdown).to.include('att_a');
      expect(markdown).to.include('ev_a');
      expect(markdown.toLowerCase()).to.not.include('mastery');
    });

    it('is byte-deterministic on the same fixture', () => {
      const first = JSON.stringify(exportAnalyticsJson(snapshotFixture(), {}, '2026-04-03T00:00:00.000Z'));
      const second = JSON.stringify(exportAnalyticsJson(snapshotFixture(), {}, '2026-04-03T00:00:00.000Z'));
      expect(first).to.equal(second);
    });

    it('excludes code snapshots and conversation text by construction', () => {
      const snapshot = snapshotFixture();
      const exported = exportAnalyticsJson(snapshot, {}, '2026-04-03T00:00:00.000Z');
      const serialized = JSON.stringify(exported);
      expect(serialized).to.not.include('snapshot');
      expect(exported.raw.conversationCounts).to.deep.equal([]);
    });
  });

  describe('render + search: deterministic presentation, no code search', () => {
    it('renders empty history without inventing data', () => {
      const empty: AnalyticsSnapshot = {
        ...snapshotFixture(),
        problems: [],
        attempts: [],
        evidence: [],
        goals: [],
        plans: [],
        progress: [],
        reflections: [],
        profile: null,
      };
      const text = renderLearningHistory(empty, {}, '2026-04-03T00:00:00.000Z');
      expect(text).to.include('No learning history yet');
    });

    it('renders goal and entity views with citations', () => {
      const snapshot = snapshotFixture();
      const goalText = renderGoalProgress(snapshot, snapshot.goals[0].goalId);
      expect(goalText).to.include(snapshot.goals[0].goalId);
      expect(goalText).to.include('EVIDENCE_ADDED');
      expect(renderGoalProgress(snapshot, 'goal_missing')).to.include('No record found');
      const entityText = renderEntityHistory(snapshot, BFS, (id) => graph().hasEntity(id));
      expect(entityText).to.include('ev_a');
      expect(entityText).to.include('what D currently believes');
    });

    it('searches titles/goals/reflections/evidence, never code', () => {
      const snapshot = snapshotFixture();
      expect(searchLearningHistory(snapshot, 'Problem A').problems.length).to.equal(1);
      expect(searchLearningHistory(snapshot, 'BFS').goals.length).to.equal(1);
      expect(searchLearningHistory(snapshot, 'did not see').reflections.length).to.equal(1);
      expect(searchLearningHistory(snapshot, 'observed ev_a').evidence).to.deep.equal(['ev_a']);
      expect(searchLearningHistory(snapshot, '   ').problems).to.deep.equal([]);
    });
  });

  describe('frozen D invariant + absence semantics', () => {
    it('one high-confidence positive yields at most EMERGING (no H regression)', () => {
      const problem = problemFixture('https://example.com/solo', 'Solo');
      const attempt = attemptFixture('att_solo', problem.problemId, '2026-05-01T10:00:00.000Z', 'Got AC Independently', '2026-05-01T11:00:00.000Z');
      const single = evidenceFixture('ev_solo', '2026-05-01T11:00:00.000Z', attempt.attemptId, problem.problemId, 'IMPLEMENTATION_SUCCESS', 'high');
      const profile = rebuildLearnerModel([single], graph(), { now: '2026-05-02T00:00:00.000Z' });
      const state = profile.knowledgeStates.find((candidate) => candidate.entityId === BFS);
      expect(state).to.not.equal(undefined);
      const rank = (level: string): number =>
        ({ UNKNOWN: 0, EXPOSED: 1, EMERGING: 2, DEMONSTRATED: 3, STRONG: 4 })[level] ?? -1;
      for (const dimension of ['recognition', 'conceptual', 'implementation', 'debugging', 'transfer', 'independence'] as const) {
        expect(rank(state?.[dimension].level ?? 'UNKNOWN')).to.be.at.most(2);
      }
    });

    it('says "No evidence found", never "has not learned"', () => {
      const snapshot = snapshotFixture();
      const text = renderEntityHistory(
        { ...snapshot, evidence: [], profile: null },
        BFS,
        () => true,
      );
      expect(text).to.include('No evidence found');
      expect(text.toLowerCase()).to.not.include('has not learned');
      expect(text.toLowerCase()).to.not.include('unlearned');
    });
  });

  describe('loading: eager V1 over real stores, fail-open, selective-ready', () => {
    it('loads a full snapshot from local stores without mutating them', async () => {
      const dir = tmpDir('codesense-h-analytics-full');
      clean(dir);
      const problem = problemFixture('https://example.com/h', 'H Problem');
      await new LocalProblemStore(dir).upsertProblem(problem);
      const attempt = attemptFixture('att_h', problem.problemId, '2026-06-01T10:00:00.000Z', 'Got WA', '2026-06-01T11:00:00.000Z');
      await new LocalAttemptStore(dir).saveAttempt(attempt);
      await new LocalClassificationStore(dir).saveClassification(classificationFixture(problem, '2026-06-01T09:00:00.000Z'));
      const evidence = evidenceFixture('ev_h', '2026-06-01T11:00:00.000Z', 'att_h', problem.problemId, 'CONCEPTUAL_CONFUSION', 'medium');
      await new LocalLearnerEvidenceStore(dir).appendEvidence(evidence);
      await new LocalLearnerModelStore(dir).saveProfile(rebuildLearnerModel([evidence], graph(), { now: '2026-06-02T00:00:00.000Z' }));
      const before = fs.readdirSync(dir).sort();
      const snapshot = await loadAnalyticsSnapshot(new LocalAnalyticsSource(dir));
      const after = fs.readdirSync(dir).sort();
      expect(snapshot.problems.length).to.equal(1);
      expect(snapshot.attempts.length).to.equal(1);
      expect(snapshot.evidence.length).to.equal(1);
      expect(snapshot.profile).to.not.equal(null);
      expect(snapshot.completeness.complete).to.equal(true);
      expect(after).to.deep.equal(before);
      clean(dir);
    });

    it('treats empty workspaces as empty history (never a throw)', async () => {
      const dir = tmpDir('codesense-h-analytics-empty');
      clean(dir);
      const snapshot = await loadAnalyticsSnapshot(new LocalAnalyticsSource(dir));
      expect(snapshot.problems).to.deep.equal([]);
      expect(snapshot.profile).to.equal(null);
      expect(renderLearningHistory(snapshot, {}, snapshot.loadedAt)).to.include('No learning history yet');
      clean(dir);
    });

    it('deduplicates reloaded evidence by stable ID before counting', async () => {
      const dir = tmpDir('codesense-h-analytics-dedupe');
      clean(dir);
      const problem = problemFixture('https://example.com/d', 'D Problem');
      await new LocalProblemStore(dir).upsertProblem(problem);
      const evidence = evidenceFixture('ev_same', '2026-06-01T11:00:00.000Z', null, problem.problemId, 'CONCEPTUAL_CONFUSION', 'medium');
      const store = new LocalLearnerEvidenceStore(dir);
      await store.appendEvidence(evidence);
      await store.appendEvidence(evidence);
      const snapshot = await loadAnalyticsSnapshot(new LocalAnalyticsSource(dir));
      expect(snapshot.evidence.filter((record) => record.evidenceId === 'ev_same').length).to.equal(1);
      clean(dir);
    });

    it('partial snapshots keep the same query contracts (selective-ready)', () => {
      const full = snapshotFixture();
      const partial: AnalyticsSnapshot = {
        ...full,
        evidence: full.evidence.slice(0, 1),
        completeness: { complete: false, scope: 'goal subset', truncatedReasons: ['test scope'], loadWarnings: [] },
      };
      expect(filterEvidence(partial, {}).length).to.equal(1);
      expect(filterAttempts(partial, {}).length).to.equal(2);
      expect(partial.completeness.complete).to.equal(false);
    });
  });
});
