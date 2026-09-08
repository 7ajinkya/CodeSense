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
import type { AIEvaluation, AIConversationMessage } from 'codesense/ai/aiTypes';
import { coachMessage, learnerMessage } from 'codesense/ai/reasoners';
import {
  COACHING_PROMPT_VERSION,
  COACHING_SYSTEM_PROMPT,
  renderContextForPrompt,
} from 'codesense/ai/aiPrompt';
import { buildChatRequest } from 'codesense/ai/reasoners';
import type { AIContext } from 'codesense/context/aiContext';
import { buildAIContext } from 'codesense/context/aiContext';
import { FakeReasoner } from 'codesense/ai/reasoners';
import { runAiEvaluation } from 'codesense/ai/evaluationRunner';
import type { EvaluationPorts } from 'codesense/ai/evaluationRunner';
import { pollTriggers, createTriggerState } from 'codesense/triggers/triggerEngine';
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { rebuildLearnerModel } from 'codesense/learner/learnerModelUpdater';
import type { LearnerProfile } from 'codesense/learner/learnerModel';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import { extractMistakeEvidence, extractRecognitionEvidence, extractReplyEvidence, syncAttemptToLearnerModel } from 'codesense/learner/learnerFeeds';
import { syncRecordsToLearnerModel } from 'codesense/learner/learnerFeeds';
import {
  COACH_CONTRACT_VERSION,
  isKnownDifficultyType,
} from 'codesense/coach/coachTypes';
import type { DecisionInput } from 'codesense/coach/coachDecision';
import { ladderRank, recommendIntervention } from 'codesense/coach/coachDecision';
import {
  abandonmentStreakForProblem,
  deriveInterventionOutcome,
  detectLearnerSignals,
  previousInterventionForAttempt,
  summarizeCoachState,
} from 'codesense/coach/coachState';
import {
  MAX_COACH_ENTITIES,
  MAX_COACH_EVIDENCE_PER_ENTITY,
  buildCoachContext,
  difficultyForInteraction,
  summarizeCoachingTurn,
} from 'codesense/coach/coachContext';
import type { CoachContext } from 'codesense/coach/coachTypes';
import {
  MAX_BRIEFING_CHARS,
  renderCoachBriefing,
} from 'codesense/coach/coachPrompt';
import {
  ABANDONMENT_NOTE_THRESHOLD,
  buildAttemptFinalPackage,
  buildSessionFinalPackage,
  candidateToRecords,
} from 'codesense/coach/coachFinalization';
import {
  MAX_TRACE_EVENTS,
  LocalAiTraceStore,
  truncateTraceText,
} from 'codesense/ai/aiTrace';

/**
 * Phase E — Personalized Coach.
 *
 * Machine-enforced properties live here: bounded learner-aware context
 * assembly, diagnosis-before-intervention with uncertainty → question,
 * deterministic intervention recommendation on the frozen vocabulary,
 * short-lived derived coach state (no new persistence), qualitative
 * intervention outcomes, finalization through existing machinery, and a
 * secret-free AI trace. Phase D remains the sole writer of learner state;
 * Phase C knowledge is never mutated by learner behavior.
 */

const BFS = 'framework.bfs';
const GRID_BFS = 'form.grid-bfs';
const MULTI_BFS = 'form.multisource-bfs';
const QUEUE_FIFO = 'concept.queue-fifo';
const CONNECTED = 'concept.connected-components';
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
    evidenceId: `ev_coach_${evidenceCounter}`,
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

function problemFixture(): Problem {
  return createManualProblem('https://leetcode.com/problems/rotting-oranges/', {
    title: 'Rotting Oranges',
    statement: 'Grid rotting problem statement with examples.',
  });
}

function classificationFixture(problem: Problem): ProblemClassification {
  const validated = validateClassificationPayload(
    {
      topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
      concepts: [
        { entityId: CONNECTED, confidence: 'medium' },
        { entityId: QUEUE_FIFO, confidence: 'medium' },
      ],
      frameworks: [{ entityId: BFS, confidence: 'high' }],
      forms: [
        { entityId: GRID_BFS, confidence: 'high' },
        { entityId: MULTI_BFS, confidence: 'medium' },
      ],
      patterns: [],
      variants: [],
      tactics: [],
      prerequisites: [{ entityId: QUEUE_FIFO, confidence: 'medium' }],
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

function evaluationFixture(overrides: Record<string, unknown> = {}): AIEvaluation {
  return {
    evaluationId: 'eval_1',
    attemptId: 'att_1',
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
      unknowns: ['Whether this was a slip or a model confusion'],
      recommendedInteraction: 'DEBUGGING_HELP',
    },
    requiresLearnerResponse: false,
    ...overrides,
  } as AIEvaluation;
}

/** Profile where BFS implementation is STRONG via repeated successes. */
function strongBfsProfile(): { profile: LearnerProfile; evidence: LearnerEvidence[] } {
  const evidence = [1, 2, 3].map((n) =>
    ev({
      timestamp: `2026-02-0${n}T00:00:00.000Z`,
      evidenceId: `ev_strong_${n}`,
      entityIds: [BFS],
      evidenceType: 'IMPLEMENTATION_SUCCESS',
      confidence: 'medium',
      attemptId: `att_s${n}`,
      problemId: `prob_s${n}`,
    }),
  );
  const profile = rebuildLearnerModel(evidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
  const state = profile.knowledgeStates.find((s) => s.entityId === BFS);
  if (!state || (state.status !== 'strong' && state.status !== 'demonstrated')) {
    throw new Error(`strong fixture did not reach strength (got ${state?.status})`);
  }
  return { profile, evidence };
}

function baseDecisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    difficultyType: 'unknown',
    diagnosticConfidence: 'medium',
    hasUnknowns: false,
    learnerRelevance: [],
    prerequisiteStatuses: [],
    activeMistakeCategories: [],
    signals: { asksForSolution: false, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'none' },
    previousIntervention: null,
    previousOutcome: null,
    priorInterventionCount: 0,
    urgency: 'low',
    attemptState: 'In Progress',
    abandonmentStreak: 0,
    ...overrides,
  };
}

function coachContextFixture(overrides: Partial<CoachContext> = {}): CoachContext {
  return {
    contractVersion: COACH_CONTRACT_VERSION,
    attemptId: 'att_1',
    problemId: 'prob_1',
    triggerKind: 'idle',
    entityIds: [BFS, MULTI_BFS],
    learnerRelevance: [],
    prerequisiteStatuses: [],
    activeMistakeCategories: [],
    recentEvidence: [],
    previousIntervention: null,
    previousOutcome: null,
    priorInterventionCount: 0,
    signals: { asksForSolution: false, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'none' },
    abandonmentStreak: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Context assembly: bounded, deterministic, complete
// ---------------------------------------------------------------------------

describe('Phase E coach context (bounded learner-aware slice)', () => {
  function assemble(overrides: {
    classification?: ProblemClassification | null;
    profile?: LearnerProfile | null;
    evidence?: LearnerEvidence[];
    evaluations?: AIEvaluation[];
    conversation?: AIConversationMessage[];
  } = {}) {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    return buildCoachContext({
      attempt,
      problem,
      classification: overrides.classification === undefined ? classificationFixture(problem) : overrides.classification,
      profile: overrides.profile === undefined ? null : overrides.profile,
      evidence: overrides.evidence ?? [],
      evaluations: overrides.evaluations ?? [],
      conversation: overrides.conversation ?? [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
  }

  it('includes problem entities, relevance, evidence, mistakes, and situation', () => {
    const { profile, evidence } = strongBfsProfile();
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const evaluation = evaluationFixture();
    const conversation: AIConversationMessage[] = [
      coachMessage('att_1', 'What does the queue hold?', { timestamp: '2026-03-01T00:05:00.000Z', evaluationId: 'eval_1' }),
      learnerMessage('att_1', 'Not sure?', '2026-03-01T00:06:00.000Z'),
    ];
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [evaluation],
      conversation,
      previousAttempts: [],
      triggerKind: 'reply',
    });
    expect(ctx.attemptId).to.equal('att_1');
    expect(ctx.problemId).to.equal(problem.problemId);
    expect(ctx.triggerKind).to.equal('reply');
    expect(ctx.entityIds).to.include(BFS);
    expect(ctx.entityIds).to.include(MULTI_BFS);
    expect(ctx.learnerRelevance.map((r) => r.entityId)).to.include(BFS);
    expect(ctx.recentEvidence.length).to.be.greaterThan(0);
    expect(ctx.recentEvidence.every((e) => ctx.entityIds.includes(e.entityId))).to.be.true;
    expect(ctx.previousIntervention?.evaluationId).to.equal('eval_1');
    expect(ctx.previousOutcome?.responded).to.be.true;
    expect(ctx.priorInterventionCount).to.equal(1);
    expect(ctx.signals.asksQuestion).to.be.true;
  });

  it('stays valid and sparse with empty inputs (no history, no crash)', () => {
    const ctx = assemble({ profile: null, classification: null });
    expect(ctx.entityIds).to.deep.equal([]);
    expect(ctx.learnerRelevance).to.deep.equal([]);
    expect(ctx.recentEvidence).to.deep.equal([]);
    expect(ctx.activeMistakeCategories).to.deep.equal([]);
    expect(ctx.previousIntervention).to.be.null;
    expect(ctx.previousOutcome).to.be.null;
    expect(ctx.abandonmentStreak).to.equal(0);
    // Deterministic: rebuilt twice, identical output.
    const again = assemble({ profile: null, classification: null });
    expect(again).to.deep.equal(ctx);
  });

  it('bounds history no matter how much exists (deterministic caps)', () => {
    const manyEvidence: LearnerEvidence[] = [];
    for (let n = 0; n < 60; n++) {
      manyEvidence.push(
        ev({
          timestamp: `2026-02-${String((n % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
          evidenceId: `ev_flood_${n}`,
          entityIds: [n % 2 === 0 ? BFS : MULTI_BFS],
          evidenceType: n % 3 === 0 ? 'IMPLEMENTATION_FAILURE' : 'IMPLEMENTATION_SUCCESS',
          confidence: 'low',
          problemId: `prob_f${n % 5}`,
        }),
      );
    }
    const profile = rebuildLearnerModel(manyEvidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence: manyEvidence,
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    expect(ctx.entityIds.length).to.be.lessThanOrEqual(MAX_COACH_ENTITIES);
    for (const entityId of ctx.entityIds) {
      const count = ctx.recentEvidence.filter((e) => e.entityId === entityId).length;
      expect(count).to.be.lessThanOrEqual(MAX_COACH_EVIDENCE_PER_ENTITY);
    }
    // No raw history dump: excerpts carry bounded observations only.
    const text = JSON.stringify(ctx);
    expect(text.length).to.be.lessThan(60 * 500);
    // Same inputs rebuilt → identical context.
    const ctx2 = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence: manyEvidence,
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    expect(ctx2).to.deep.equal(ctx);
  });

  it('scopes mistakes and prerequisites to the current problem', () => {
    const mistakeEvidence = [
      ev({
        timestamp: '2026-02-01T00:00:00.000Z',
        evidenceId: 'ev_mm_1',
        entityIds: [BFS],
        evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium',
        mistakeCategory: 'forgot-visited-marking',
        dimension: 'implementation',
        source: 'mistake-report',
        provenance: { source: 'mistake-report', sourceId: null },
      }),
      ev({
        timestamp: '2026-02-02T00:00:00.000Z',
        evidenceId: 'ev_mm_2',
        entityIds: [BFS],
        evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium',
        mistakeCategory: 'forgot-visited-marking',
        dimension: 'implementation',
        source: 'mistake-report',
        provenance: { source: 'mistake-report', sourceId: null },
      }),
    ];
    const profile = rebuildLearnerModel(mistakeEvidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const ctx = assemble({ profile, evidence: mistakeEvidence });
    expect(ctx.activeMistakeCategories).to.deep.equal(['forgot-visited-marking']);
    expect(ctx.prerequisiteStatuses.map((p) => p.entityId)).to.include(QUEUE_FIFO);
    // Prerequisite without any learner record reads explicitly unknown.
    const queue = ctx.prerequisiteStatuses.find((p) => p.entityId === QUEUE_FIFO)!;
    expect(queue.status).to.equal('unknown');
  });
});

// ---------------------------------------------------------------------------
// B. Diagnosis: observed vs hypothesis, confidence, uncertainty → question
// ---------------------------------------------------------------------------

describe('Phase E diagnosis (observed before hypothesis, uncertainty first)', () => {
  function turnFor(
    evaluation: AIEvaluation,
    coachContext: CoachContext,
    attemptState = 'In Progress',
  ) {
    return summarizeCoachingTurn({ evaluation, coachContext, attemptState });
  }

  it('keeps observed facts separate from the quoted hypothesis', () => {
    const evaluation = evaluationFixture({
      diagnosis: {
        observedEvidence: ['distance array never updated after enqueue'],
        hypothesis: 'The learner may not connect BFS layers to shortest distance.',
        confidence: 'medium',
        unknowns: ['Whether they have seen level-order traversal before'],
        recommendedInteraction: 'SOCRATIC_QUESTION',
      },
    });
    const { diagnosis } = turnFor(evaluation, coachContextFixture());
    expect(diagnosis.observed).to.deep.equal(['distance array never updated after enqueue']);
    expect(diagnosis.hypothesis).to.equal('The learner may not connect BFS layers to shortest distance.');
    expect(diagnosis.confidence).to.equal('medium');
    expect(diagnosis.unknowns).to.deep.equal(['Whether they have seen level-order traversal before']);
    // The hypothesis text is quoted, never rewritten or hardened.
    expect(diagnosis.hypothesis).to.contain('may not');
  });

  it('routes low-confidence ambiguity to a question, not an explanation', () => {
    const evaluation = evaluationFixture({
      interventionType: 'HINT',
      diagnosis: {
        observedEvidence: ['unusual queue manipulation in edit v5'],
        hypothesis: 'Could be API unfamiliarity, a BFS misunderstanding, or an ordinary slip.',
        confidence: 'low',
        unknowns: ['Java API familiarity', 'BFS mental model', 'Whether the edit was exploratory'],
        recommendedInteraction: 'SOCRATIC_QUESTION',
      },
    });
    const { diagnosis, decision } = turnFor(evaluation, coachContextFixture());
    expect(diagnosis.confidence).to.equal('low');
    expect(diagnosis.pedagogicalObjective).to.equal('disambiguate');
    expect(decision.proposed).to.equal('SOCRATIC_QUESTION');
    expect(decision.rationale.join(' ')).to.contain('low');
  });

  it('never turns ambiguous implementation behavior into a conceptual verdict', () => {
    const evaluation = evaluationFixture({
      interventionType: 'DEBUGGING_HELP',
      diagnosis: {
        observedEvidence: ['queue re-created inside the loop at edit v3'],
        hypothesis: 'The learner may be re-creating the queue instead of reusing it.',
        confidence: 'low',
        unknowns: ['Whether this was a slip or a model confusion'],
        recommendedInteraction: 'DEBUGGING_HELP',
      },
    });
    const { diagnosis, decision } = turnFor(evaluation, coachContextFixture());
    expect(diagnosis.difficultyType).to.equal('debugging');
    // Learner relevance untouched by the ambiguity: no conceptual claim.
    expect(diagnosis.learnerRelevance).to.deep.equal([]);
    // Low confidence + open unknowns wins over the debugging default.
    expect(decision.proposed).to.equal('SOCRATIC_QUESTION');
  });

  it('maps recommended interactions to difficulty shapes deterministically', () => {
    expect(difficultyForInteraction('DEBUGGING_HELP', 'HINT')).to.equal('debugging');
    expect(difficultyForInteraction('CONCEPT_REVIEW', 'HINT')).to.equal('conceptual');
    expect(difficultyForInteraction('EXPLANATION', 'HINT')).to.equal('conceptual');
    expect(difficultyForInteraction('SOLUTION_GUIDANCE', 'HINT')).to.equal('conceptual');
    expect(difficultyForInteraction('HINT', 'HINT')).to.equal('implementation');
    expect(difficultyForInteraction('SOCRATIC_QUESTION', 'SOCRATIC_QUESTION')).to.equal('unknown');
    expect(difficultyForInteraction('NONE', 'NONE')).to.equal('unknown');
    expect(isKnownDifficultyType('transfer')).to.be.true;
    expect(isKnownDifficultyType('mastery')).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// C. Intervention selection: adaptive ladder, not a script
// ---------------------------------------------------------------------------

describe('Phase E intervention selection (adaptive, agency-preserving)', () => {
  it('gives a capable learner the smallest action, never reteaching', () => {
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'unknown',
        diagnosticConfidence: 'medium',
        learnerRelevance: [
          { entityId: BFS, status: 'strong', statusConfidence: 'high', activeDimensions: ['implementation:strong'], evidenceBalance: 'positive' },
          { entityId: MULTI_BFS, status: 'demonstrated', statusConfidence: 'medium', activeDimensions: ['implementation:demonstrated'], evidenceBalance: 'positive' },
        ],
      }),
    );
    expect(decision.proposed).to.equal('ACKNOWLEDGE');
    expect(decision.usedLearnerState).to.be.true;
    expect(decision.honorsExplicitRequest).to.be.false;
  });

  it('challenges rather than reteaches when strong knowledge meets difficulty', () => {
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'implementation',
        diagnosticConfidence: 'medium',
        learnerRelevance: [
          { entityId: BFS, status: 'strong', statusConfidence: 'high', activeDimensions: [], evidenceBalance: 'positive' },
        ],
      }),
    );
    expect(decision.proposed).to.equal('SOCRATIC_QUESTION');
    expect(decision.usedLearnerState).to.be.true;
  });

  it('targets a thin prerequisite instead of the current topic', () => {
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'conceptual',
        diagnosticConfidence: 'medium',
        learnerRelevance: [
          { entityId: BFS, status: 'developing', statusConfidence: 'low', activeDimensions: [], evidenceBalance: 'none' },
        ],
        prerequisiteStatuses: [{ entityId: QUEUE_FIFO, status: 'exposed', statusConfidence: 'low' }],
      }),
    );
    expect(decision.proposed).to.equal('EXPLANATION');
    expect(decision.usedLearnerState).to.be.true;
    expect(decision.rationale.join(' ')).to.contain(QUEUE_FIFO);
  });

  it('honors an explicit solution request only with corroborated struggle', () => {
    const strangerAsking = recommendIntervention(
      baseDecisionInput({
        signals: { asksForSolution: true, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'short' },
      }),
    );
    expect(strangerAsking.proposed).to.not.equal('SOLUTION_GUIDANCE');
    const stuckAsking = recommendIntervention(
      baseDecisionInput({
        attemptState: 'Got Stuck',
        signals: { asksForSolution: true, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'short' },
      }),
    );
    expect(stuckAsking.proposed).to.equal('SOLUTION_GUIDANCE');
    expect(stuckAsking.honorsExplicitRequest).to.be.true;
    // An explicit explanation request is never answered with a forced hint.
    const explainAsking = recommendIntervention(
      baseDecisionInput({
        signals: { asksForSolution: false, asksForExplanation: true, asksQuestion: true, replyLengthBucket: 'medium' },
      }),
    );
    expect(explainAsking.proposed).to.equal('EXPLANATION');
    expect(explainAsking.honorsExplicitRequest).to.be.true;
  });

  it('is not a rigid ladder: outcomes move strategy, not just rungs', () => {
    const afterFailedHint = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'implementation',
        diagnosticConfidence: 'medium',
        previousIntervention: {
          evaluationId: 'eval_1',
          timestamp: '2026-03-01T00:05:00.000Z',
          interventionType: 'HINT',
          triggerKind: 'idle',
          requiredResponse: false,
        },
        previousOutcome: {
          evaluationId: 'eval_1',
          responded: true,
          responseLatencyMs: 60000,
          transitionsAfter: [],
          outcome: 'no-progress',
        },
        priorInterventionCount: 1,
      }),
    );
    expect(afterFailedHint.proposed).to.equal('EXPLANATION');
    const afterProgress = recommendIntervention(
      baseDecisionInput({
        previousIntervention: {
          evaluationId: 'eval_1',
          timestamp: '2026-03-01T00:05:00.000Z',
          interventionType: 'HINT',
          triggerKind: 'idle',
          requiredResponse: false,
        },
        previousOutcome: {
          evaluationId: 'eval_1',
          responded: true,
          responseLatencyMs: 60000,
          transitionsAfter: [],
          outcome: 'progressed',
        },
        priorInterventionCount: 1,
      }),
    );
    expect(afterProgress.proposed).to.equal('ACKNOWLEDGE');
    // Unclear outcome holds the rung instead of escalating blindly.
    const unclear = recommendIntervention(
      baseDecisionInput({
        previousIntervention: {
          evaluationId: 'eval_1',
          timestamp: '2026-03-01T00:05:00.000Z',
          interventionType: 'HINT',
          triggerKind: 'idle',
          requiredResponse: false,
        },
        previousOutcome: {
          evaluationId: 'eval_1',
          responded: false,
          responseLatencyMs: null,
          transitionsAfter: [],
          outcome: 'unclear',
        },
        priorInterventionCount: 1,
      }),
    );
    expect(unclear.proposed).to.equal('HINT');
  });

  it('starts small on abandonment streaks and caps urgency below solutions', () => {
    const streak = recommendIntervention(baseDecisionInput({ abandonmentStreak: 3 }));
    expect(streak.proposed).to.equal('ACKNOWLEDGE');
    expect(streak.usedLearnerState).to.be.true;
    const urgent = recommendIntervention(
      baseDecisionInput({ difficultyType: 'implementation', diagnosticConfidence: 'medium', urgency: 'high' }),
    );
    expect(ladderRank(urgent.proposed)).to.be.lessThan(3);
    expect(urgent.proposed).to.not.equal('SOLUTION_GUIDANCE');
  });

  it('exposes a stable ladder ordering for escalation math', () => {
    expect(ladderRank('SOCRATIC_QUESTION')).to.equal(0);
    expect(ladderRank('HINT')).to.equal(1);
    expect(ladderRank('EXPLANATION')).to.equal(2);
    expect(ladderRank('DEBUGGING_HELP')).to.equal(2);
    expect(ladderRank('SOLUTION_GUIDANCE')).to.equal(3);
    expect(ladderRank('ACKNOWLEDGE')).to.equal(-1);
    expect(ladderRank('NONE')).to.equal(-1);
  });
});

// ---------------------------------------------------------------------------
// D. Longitudinal personalization: same problem, different learner
// ---------------------------------------------------------------------------

describe('Phase E longitudinal personalization (history changes coaching)', () => {
  function briefingFor(profile: LearnerProfile | null, evidence: LearnerEvidence[]) {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    return buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
  }

  function decideFor(briefing: CoachContext, difficulty: 'unknown' | 'conceptual' = 'unknown') {
    return recommendIntervention(
      baseDecisionInput({
        difficultyType: difficulty,
        diagnosticConfidence: 'medium',
        learnerRelevance: briefing.learnerRelevance,
        prerequisiteStatuses: briefing.prerequisiteStatuses,
        activeMistakeCategories: briefing.activeMistakeCategories,
      }),
    );
  }

  it('produces materially different briefings and decisions per learner state', () => {
    const { profile: strongProfile, evidence: strongEvidence } = strongBfsProfile();
    const strongBriefing = briefingFor(strongProfile, strongEvidence);
    const freshBriefing = briefingFor(null, []);
    // Briefings differ: one names sustained evidence, the other admits none.
    expect(strongBriefing.learnerRelevance.map((r) => r.entityId)).to.include(BFS);
    expect(freshBriefing.learnerRelevance).to.deep.equal([]);
    expect(freshBriefing.recentEvidence).to.deep.equal([]);
    expect(renderCoachBriefing(strongBriefing)).to.contain(BFS);
    expect(renderCoachBriefing(freshBriefing)).to.contain('No prior learner history');
    // Decisions differ: strength acknowledged vs. open question.
    expect(decideFor(strongBriefing).proposed).to.equal('ACKNOWLEDGE');
    expect(decideFor(freshBriefing).proposed).to.equal('SOCRATIC_QUESTION');
    expect(decideFor(strongBriefing).usedLearnerState).to.be.true;
    expect(decideFor(freshBriefing).usedLearnerState).to.be.false;
  });

  it('targets the gap by entity instead of reteaching the topic', () => {
    const evidence = [
      ev({
        timestamp: '2026-02-01T00:00:00.000Z',
        evidenceId: 'ev_gap_1',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_a',
      }),
      ev({
        timestamp: '2026-02-02T00:00:00.000Z',
        evidenceId: 'ev_gap_2',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_b',
      }),
      ev({
        timestamp: '2026-02-03T00:00:00.000Z',
        evidenceId: 'ev_gap_3',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_c',
      }),
      ev({
        timestamp: '2026-02-04T00:00:00.000Z',
        evidenceId: 'ev_gap_4',
        entityIds: [MULTI_BFS],
        evidenceType: 'IMPLEMENTATION_FAILURE',
        confidence: 'low',
        problemId: 'prob_d',
      }),
    ];
    const profile = rebuildLearnerModel(evidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const briefing = briefingFor(profile, evidence);
    const byId = new Map(briefing.learnerRelevance.map((r) => [r.entityId, r.status] as const));
    expect(byId.get(BFS)).to.equal('strong');
    expect(byId.get(MULTI_BFS)).to.not.equal('strong');
    // The briefing names both, so the model can aim at the variant gap.
    const text = renderCoachBriefing(briefing);
    expect(text).to.contain(`${BFS}: strong`);
    expect(text).to.contain(MULTI_BFS);
    expect(text).to.not.contain('No prior learner history');
  });

  it('never confuses problem knowledge with learner ability', () => {
    const { profile, evidence } = strongBfsProfile();
    const briefing = briefingFor(profile, evidence);
    // Briefing references learner states, never rewrites classification.
    const problem = problemFixture();
    const classification = classificationFixture(problem);
    expect(classification.frameworks).to.deep.equal([{ entityId: BFS, confidence: 'high' }]);
    expect(briefing.learnerRelevance.every((r) => typeof r.status === 'string')).to.be.true;
    expect(JSON.stringify(briefing)).to.not.contain('mastery');
  });
});

// ---------------------------------------------------------------------------
// E. Conversation as a diagnostic instrument (without silent persistence)
// ---------------------------------------------------------------------------

describe('Phase E conversation loop (uncertainty reduction without leakage)', () => {
  function openAttempt(): Attempt {
    const problem = problemFixture();
    return attemptFixture('att_1', problem.problemId, 'Got Stuck', '2026-03-01T00:00:00.000Z');
  }

  it('a reply updates derived coach state and can change the next move', () => {
    const attempt = openAttempt();
    const evaluation = evaluationFixture({
      interventionType: 'HINT',
      requiresLearnerResponse: true,
      diagnosis: {
        observedEvidence: ['repeated boundary edits with no passing run'],
        hypothesis: 'The window invariant may not be established.',
        confidence: 'medium',
        unknowns: [],
        recommendedInteraction: 'HINT',
      },
    });
    const conversation: AIConversationMessage[] = [
      coachMessage('att_1', 'What should hold at the left edge?', {
        timestamp: '2026-03-01T00:05:00.000Z',
        evaluationId: 'eval_1',
      }),
      learnerMessage('att_1', 'I think left counts distinct but shrink breaks it?', '2026-03-01T00:07:00.000Z'),
    ];
    const state = summarizeCoachState({
      attemptId: 'att_1',
      evaluations: [evaluation],
      conversation,
      attempt,
      previousAttempts: [],
      now: '2026-03-01T00:08:00.000Z',
    });
    expect(state.previousIntervention?.interventionType).to.equal('HINT');
    expect(state.previousOutcome?.responded).to.be.true;
    expect(state.previousOutcome?.outcome).to.equal('no-progress');
    expect(state.signals.asksQuestion).to.be.true;
    // Next move escalates (same hint did not visibly help) instead of repeating.
    const next = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'implementation',
        diagnosticConfidence: 'medium',
        previousIntervention: state.previousIntervention,
        previousOutcome: state.previousOutcome,
        priorInterventionCount: 1,
        signals: state.signals,
      }),
    );
    expect(next.proposed).to.equal('EXPLANATION');
  });

  it('visible progress after a reply is acknowledged, not piled onto', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'Got AC Independently', '2026-03-01T00:10:00.000Z');
    const evaluation = evaluationFixture();
    const conversation: AIConversationMessage[] = [
      coachMessage('att_1', 'What does the queue hold?', {
        timestamp: '2026-03-01T00:05:00.000Z',
        evaluationId: 'eval_1',
      }),
      learnerMessage('att_1', 'Frontier nodes — fixed it!', '2026-03-01T00:07:00.000Z'),
    ];
    const state = summarizeCoachState({
      attemptId: 'att_1',
      evaluations: [evaluation],
      conversation,
      attempt,
      previousAttempts: [],
      now: '2026-03-01T00:11:00.000Z',
    });
    expect(state.previousOutcome?.outcome).to.equal('progressed');
    const next = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'unknown',
        diagnosticConfidence: 'medium',
        previousIntervention: state.previousIntervention,
        previousOutcome: state.previousOutcome,
        priorInterventionCount: 1,
      }),
    );
    expect(next.proposed).to.equal('ACKNOWLEDGE');
  });

  it('derives outcome states honestly (abandoned vs unclear vs replied)', () => {
    const evaluation = evaluationFixture();
    const attempt = openAttempt();
    const silent = deriveInterventionOutcome({ evaluation, conversation: [], attempt });
    expect(silent.responded).to.be.false;
    expect(silent.responseLatencyMs).to.be.null;
    expect(silent.outcome).to.equal('unclear');
    const abandoned = attemptFixture('att_9', attempt.problemId, 'Abandoned / Continue Later', '2026-03-01T00:09:00.000Z');
    const gaveUp = deriveInterventionOutcome({ evaluation, conversation: [], attempt: abandoned });
    expect(gaveUp.outcome).to.equal('abandoned');
  });

  it('detects only conservative signals, never traits or affect', () => {
    expect(
      detectLearnerSignals([learnerMessage('att_1', 'Just give me the answer please', '2026-03-01T00:01:00.000Z')])
        .asksForSolution,
    ).to.be.true;
    expect(
      detectLearnerSignals([learnerMessage('att_1', 'Can you explain why this loops?', '2026-03-01T00:01:00.000Z')])
        .asksForExplanation,
    ).to.be.true;
    const plain = detectLearnerSignals([learnerMessage('att_1', 'ok trying now', '2026-03-01T00:01:00.000Z')]);
    expect(plain.asksForSolution).to.be.false;
    expect(plain.asksForExplanation).to.be.false;
    expect(plain.asksQuestion).to.be.false;
    expect(detectLearnerSignals([]).replyLengthBucket).to.equal('none');
    // State derivation is pure over existing stores — no store handles taken.
    const state = summarizeCoachState({
      attemptId: 'att_1',
      evaluations: [],
      conversation: [],
      attempt: openAttempt(),
      previousAttempts: [],
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(state.contractVersion).to.equal(COACH_CONTRACT_VERSION);
    expect(state.previousIntervention).to.be.null;
    expect(state.abandonmentStreak).to.equal(0);
  });
});

// ---------------------------------------------------------------------------
// F. Implementation mistakes vs algorithmic weakness
// ---------------------------------------------------------------------------

describe('Phase E mistake vs concept distinction', () => {
  it('surfaces a recurring habit without weakening the algorithm state', () => {
    const evidence = [
      ev({
        timestamp: '2026-02-01T00:00:00.000Z',
        evidenceId: 'ev_hab_1',
        entityIds: [BFS],
        evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium',
        mistakeCategory: 'forgot-visited-marking',
        dimension: 'implementation',
        source: 'mistake-report',
        provenance: { source: 'mistake-report', sourceId: null },
      }),
      ev({
        timestamp: '2026-02-02T00:00:00.000Z',
        evidenceId: 'ev_hab_2',
        entityIds: [BFS],
        evidenceType: 'RECURRING_MISTAKE',
        confidence: 'medium',
        mistakeCategory: 'forgot-visited-marking',
        dimension: 'implementation',
        source: 'mistake-report',
        provenance: { source: 'mistake-report', sourceId: null },
      }),
      ev({
        timestamp: '2026-02-03T00:00:00.000Z',
        evidenceId: 'ev_hab_3',
        entityIds: [BFS],
        evidenceType: 'CONCEPTUAL_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_c',
      }),
      ev({
        timestamp: '2026-02-04T00:00:00.000Z',
        evidenceId: 'ev_hab_4',
        entityIds: [BFS],
        evidenceType: 'CONCEPTUAL_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_d',
      }),
      ev({
        timestamp: '2026-02-05T00:00:00.000Z',
        evidenceId: 'ev_hab_5',
        entityIds: [BFS],
        evidenceType: 'CONCEPTUAL_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_e',
      }),
    ];
    const profile = rebuildLearnerModel(evidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    expect(ctx.activeMistakeCategories).to.deep.equal(['forgot-visited-marking']);
    const conceptual = ctx.learnerRelevance.find((r) => r.entityId === BFS);
    expect(conceptual).to.not.be.undefined;
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'debugging',
        diagnosticConfidence: 'medium',
        learnerRelevance: ctx.learnerRelevance,
        activeMistakeCategories: ctx.activeMistakeCategories,
      }),
    );
    expect(decision.proposed).to.equal('DEBUGGING_HELP');
    expect(decision.rationale.join(' ')).to.contain('forgot-visited-marking');
    expect(decision.rationale.join(' ')).to.contain('naming the habit instead of reteaching');
    expect(decision.proposed).to.not.equal('CONCEPT_REVIEW');
    expect(decision.proposed).to.not.equal('EXPLANATION');
  });
});

// ---------------------------------------------------------------------------
// G/H. End Problem / End Session finalization through existing machinery
// ---------------------------------------------------------------------------

describe('Phase E finalization (complete handoff, no verdicts, no duplication)', () => {
  function finalizedAttempt(
    attemptId: string,
    finalState: Attempt['currentState'],
    at: string,
    evaluations: AIEvaluation[] = [],
  ) {
    const problem = problemFixture();
    const attempt = attemptFixture(attemptId, problem.problemId, finalState, at);
    const conversation: AIConversationMessage[] =
      evaluations.length > 0
        ? [
            coachMessage(attemptId, 'coach turn', { timestamp: at, evaluationId: evaluations[0]?.evaluationId }),
            learnerMessage(attemptId, 'learner turn', at),
          ]
        : [];
    return { problem, attempt, evaluations, conversation };
  }

  it('packages a finished attempt completely from existing records', () => {
    const { problem, attempt, evaluations, conversation } = finalizedAttempt(
      'att_f1',
      'Got AC with Help',
      '2026-03-01T00:10:00.000Z',
      [evaluationFixture({ evaluationId: 'eval_f1', attemptId: 'att_f1' })],
    );
    const evidence = [
      ev({ timestamp: '2026-03-01T00:10:00.000Z', evidenceId: 'ev_fin_1', attemptId: 'att_f1', problemId: problem.problemId }),
    ];
    const pkg = buildAttemptFinalPackage({
      attempt,
      problem,
      classification: classificationFixture(problem),
      evaluations,
      conversation,
      evidence,
      previousAttempts: [],
    });
    expect(pkg.attemptId).to.equal('att_f1');
    expect(pkg.problemId).to.equal(problem.problemId);
    expect(pkg.finalState).to.equal('Got AC with Help');
    expect(pkg.stateHistory.length).to.be.greaterThan(0);
    expect(pkg.interventions).to.have.lengthOf(1);
    expect(pkg.interventions[0]?.evaluationId).to.equal('eval_f1');
    expect(pkg.conversationCounts).to.deep.equal({ coach: 1, learner: 1 });
    expect(pkg.learnerReplies).to.equal(1);
    expect(pkg.classificationPresent).to.be.true;
    expect(pkg.evidenceIds).to.deep.equal(['ev_fin_1']);
    expect(pkg.abandonmentNote).to.be.null;
    expect(pkg.durationMs).to.not.be.null;
  });

  it('treats a lone abandonment as signal, repeated ones as a noted pattern', () => {
    const single = finalizedAttempt('att_a1', 'Abandoned / Continue Later', '2026-03-01T00:10:00.000Z');
    const singlePkg = buildAttemptFinalPackage({
      ...single,
      classification: null,
      evaluations: [],
      conversation: [],
      evidence: [],
      previousAttempts: [],
    });
    expect(singlePkg.finalState).to.equal('Abandoned / Continue Later');
    expect(singlePkg.abandonmentNote).to.be.null;
    // No weakness verdict anywhere in the package: states, notes, or flags.
    expect(JSON.stringify(singlePkg)).to.not.contain('weak');
    expect(JSON.stringify(singlePkg)).to.not.contain('struggling');

    const problem = problemFixture();
    const third = attemptFixture('att_a3', problem.problemId, 'Abandoned / Continue Later', '2026-03-03T00:10:00.000Z');
    const prior = [
      attemptFixture('att_a1', problem.problemId, 'Abandoned / Continue Later', '2026-03-01T00:10:00.000Z'),
      attemptFixture('att_a2', problem.problemId, 'Abandoned / Continue Later', '2026-03-02T00:10:00.000Z'),
    ];
    const streakPkg = buildAttemptFinalPackage({
      attempt: third,
      problem,
      classification: null,
      evaluations: [],
      conversation: [],
      evidence: [],
      previousAttempts: prior,
    });
    expect(streakPkg.abandonmentNote).to.contain('3 consecutive abandonments');
    expect(streakPkg.abandonmentNote).to.contain('not a verdict');
    // A non-abandon terminal breaks the streak reading.
    const recovered = attemptFixture('att_a4', problem.problemId, 'Got AC Independently', '2026-03-04T00:10:00.000Z');
    const recoveredPkg = buildAttemptFinalPackage({
      attempt: recovered,
      problem,
      classification: null,
      evaluations: [],
      conversation: [],
      evidence: [],
      previousAttempts: [...prior, third],
    });
    expect(recoveredPkg.abandonmentNote).to.be.null;
  });

  it('routes candidates only through existing Phase D validators', () => {
    const ok = candidateToRecords(
      { payload: { category: 'x', entityIds: [BFS] }, route: 'mistake-report', reason: 'test' },
      {
        mistakeReport: (payload) => {
          const p = payload as { category?: unknown; entityIds?: unknown };
          if (typeof p.category !== 'string' || !Array.isArray(p.entityIds)) {
            return null;
          }
          return extractMistakeEvidence(graph(), {
            category: p.category,
            entityIds: p.entityIds as string[],
            observation: 'candidate sighting',
            timestamp: '2026-03-01T00:00:00.000Z',
          });
        },
        recognition: () => null,
        replyAssessment: () => [],
        records: () => [],
      },
    );
    expect(ok).to.have.lengthOf(1);
    expect(ok[0]?.mistakeCategory).to.equal('x');
    // Garbage candidates validate to nothing — never smuggled into storage.
    const bad = candidateToRecords(
      { payload: { nope: true }, route: 'mistake-report', reason: 'test' },
      {
        mistakeReport: () => null,
        recognition: () => null,
        replyAssessment: () => [],
        records: () => [],
      },
    );
    expect(bad).to.deep.equal([]);
    expect(candidateToRecords({ payload: {}, route: 'records', reason: 't' }, {
      mistakeReport: () => null,
      recognition: () => null,
      replyAssessment: () => [],
      records: () => [],
    })).to.deep.equal([]);
  });

  it('finalizes interrupted attempts through the same evidence machinery', async () => {
    const dir = tmpDir('codesense-test-phase-e-interrupt');
    clean(dir);
    try {
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const open = createAttempt({ attemptId: 'att_int', problemId: problem.problemId, sessionId: 'ses_1', startedAt: '2026-03-01T00:00:00.000Z' });
      const { interrupted } = interruptAttempt(open, '2026-03-01T00:30:00.000Z');
      expect(interrupted).to.be.true;
      expect(open.currentState).to.equal('Abandoned / Continue Later');
      // Same sync entry point End Problem uses — no parallel pipeline.
      const evidenceStore = new LocalLearnerEvidenceStore(dir);
      const modelStore = new LocalLearnerModelStore(dir);
      const outcome = await syncAttemptToLearnerModel(
        { evidenceStore, modelStore, graph: graph(), nowIso: () => '2026-03-01T00:30:00.000Z' },
        { attempt: open, problem, classification, evaluations: [] },
      );
      expect(outcome.error).to.be.undefined;
      expect(outcome.stored).to.be.greaterThan(0);
      const history = await evidenceStore.listEvidence();
      expect(history.every((e) => e.attemptId === 'att_int')).to.be.true;
      // The finalized package still treats it as signal, not verdict.
      const pkg = buildAttemptFinalPackage({
        attempt: open,
        problem,
        classification,
        evaluations: [],
        conversation: [],
        evidence: history,
        previousAttempts: [],
      });
      expect(pkg.finalState).to.equal('Abandoned / Continue Later');
      expect(pkg.abandonmentNote).to.be.null;
    } finally {
      clean(dir);
    }
  });

  it('rolls sessions up by reference without duplicating evidence', () => {
    const problem = problemFixture();
    const attempts = [
      attemptFixture('att_s1', problem.problemId, 'Got AC Independently', '2026-03-01T00:10:00.000Z'),
      attemptFixture('att_s2', problem.problemId, 'Abandoned / Continue Later', '2026-03-01T00:20:00.000Z'),
      attemptFixture('att_s3', problem.problemId, 'Abandoned / Continue Later', '2026-03-02T00:20:00.000Z'),
    ];
    const evaluations = [evaluationFixture({ evaluationId: 'eval_s1', attemptId: 'att_s1' })];
    const pkg = buildSessionFinalPackage({
      sessionId: 'ses_1',
      startedAt: '2026-03-01T00:00:00.000Z',
      endedAt: '2026-03-02T00:30:00.000Z',
      attempts,
      evaluations,
    });
    expect(pkg.problemIds).to.deep.equal([problem.problemId]);
    expect(pkg.attemptOutcomes).to.have.lengthOf(3);
    expect(pkg.evaluationsCount).to.equal(1);
    expect(pkg.interventionsCount).to.equal(1);
    // Session package carries counts + references only — no evidence rows.
    expect(JSON.stringify(pkg)).to.not.contain('observation');
    expect(pkg.abandonmentNote).to.contain('2 abandoned attempts');
    const calm = buildSessionFinalPackage({
      sessionId: 'ses_2',
      startedAt: '2026-03-01T00:00:00.000Z',
      endedAt: null,
      attempts: [attempts[0]!],
      evaluations: [],
    });
    expect(calm.abandonmentNote).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// I. Trigger regression (frozen semantics untouched by Phase E)
// ---------------------------------------------------------------------------

describe('Phase E trigger regression (10-min idle / 45-min hard, no cooldown)', () => {
  const MIN = 60 * 1000;

  it('keeps idle epochs consumable-once with no cooldown', () => {
    const state = createTriggerState(0, 0);
    const first = pollTriggers(state, 10 * MIN);
    expect(first.eligible).to.be.true;
    expect(first.kind).to.equal('idle');
    const immediate = pollTriggers(state, 10 * MIN + 1000);
    expect(immediate.eligible).to.be.false;
  });

  it('keeps the 45-minute hard boundary absolute and single-fire', () => {
    const state = createTriggerState(0, 0);
    const atBoundary = pollTriggers(state, 45 * MIN);
    expect(atBoundary.eligible).to.be.true;
    expect(atBoundary.kind).to.equal('hard45');
    // The hard45 instance never refires; a later poll may surface idle
    // (a different, independently-consumed condition), but never hard45.
    const after = pollTriggers(state, 45 * MIN + 1000);
    expect(after.kind).to.not.equal('hard45');
  });

  it('resets the lifecycle for a fresh attempt (end-problem semantics)', () => {
    const first = createTriggerState(0, 0);
    pollTriggers(first, 45 * MIN);
    const second = createTriggerState(45 * MIN, 45 * MIN);
    const early = pollTriggers(second, 45 * MIN + 5 * MIN);
    expect(early.eligible).to.be.false;
    expect(early.kind).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// Prompt: versioned appendix + briefing render, existing contract intact
// ---------------------------------------------------------------------------

describe('Phase E prompt (learner-aware briefing, style kept)', () => {
  it('bumps the version and teaches personalized-coach discipline', () => {
    expect(COACHING_PROMPT_VERSION).to.equal(4);
    for (const key of [
      'Coach briefing',
      'Never reteach',
      'Reducing uncertainty',
      'Honor explicit requests',
      'never label the learner',
      'canonical solution knowledge never justifies',
    ]) {
      expect(COACHING_SYSTEM_PROMPT, key).to.contain(key);
    }
    // Pre-Phase-E contract intact.
    for (const key of ['Socratic', 'shouldIntervene', 'chain-of-thought', 'observed starting state']) {
      expect(COACHING_SYSTEM_PROMPT, key).to.contain(key);
    }
  });

  it('renders an honest empty briefing instead of inventing history', () => {
    const text = renderCoachBriefing(coachContextFixture());
    expect(text).to.contain('No prior learner history');
    expect(text).to.not.contain('strong');
    expect(text.length).to.be.lessThanOrEqual(MAX_BRIEFING_CHARS);
  });

  it('renders states, mistakes, outcomes, and requests with caps', () => {
    const briefing = coachContextFixture({
      learnerRelevance: [
        { entityId: BFS, status: 'strong', statusConfidence: 'high', activeDimensions: ['implementation:strong'], evidenceBalance: 'positive' },
        { entityId: MULTI_BFS, status: 'developing', statusConfidence: 'low', activeDimensions: [], evidenceBalance: 'none' },
      ],
      activeMistakeCategories: ['forgot-visited-marking'],
      recentEvidence: [
        { entityId: BFS, evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', timestamp: '2026-03-01T00:00:00.000Z', observation: 'Solved cleanly.' },
      ],
      previousIntervention: {
        evaluationId: 'eval_1',
        timestamp: '2026-03-01T00:05:00.000Z',
        interventionType: 'HINT',
        triggerKind: 'idle',
        requiredResponse: false,
      },
      previousOutcome: {
        evaluationId: 'eval_1',
        responded: true,
        responseLatencyMs: 30000,
        transitionsAfter: [],
        outcome: 'no-progress',
      },
      signals: { asksForSolution: false, asksForExplanation: true, asksQuestion: true, replyLengthBucket: 'medium' },
      abandonmentStreak: 2,
    });
    const text = renderCoachBriefing(briefing);
    expect(text).to.contain(`${BFS}: strong`);
    expect(text).to.contain('forgot-visited-marking');
    expect(text).to.contain('did not visibly help');
    expect(text).to.contain('asked for an explanation');
    expect(text).to.contain('2 consecutive abandonments');
    expect(text).to.not.contain('weak');
    expect(text.length).to.be.lessThanOrEqual(MAX_BRIEFING_CHARS);
    // Deterministic render.
    expect(renderCoachBriefing(briefing)).to.equal(text);
  });

  it('attaches the briefing to AI context without disturbing the base render', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const base: AIContext = buildAIContext({ problem, attempt, previousAttempts: [], edits: [], checkpoints: [], sessionEvents: [] });
    expect(base.coachBriefing).to.be.undefined;
    const baseText = renderContextForPrompt(base);
    expect(baseText).to.not.contain('Coach briefing');
    const briefed: AIContext = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: [],
      checkpoints: [],
      sessionEvents: [],
      coachBriefing: coachContextFixture(),
    });
    const briefedText = renderContextForPrompt(briefed);
    expect(briefedText).to.contain('## Coach briefing');
    expect(briefedText).to.contain('No prior learner history');
    // Base sections render identically with the briefing appended after.
    expect(briefedText.startsWith(baseText)).to.be.true;
  });

  it('flows through the request builder to the existing reasoner contract', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const ctx = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: [],
      checkpoints: [],
      sessionEvents: [],
      coachBriefing: coachContextFixture(),
    });
    const request = buildChatRequest('test-model', ctx);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages).to.have.lengthOf(2);
    expect(messages[1]?.content).to.contain('## Coach briefing');
    expect(request.response_format).to.deep.equal({ type: 'json_object' });
  });
});

// ---------------------------------------------------------------------------
// AI trace: ordered, capped, secret-free, never load-bearing
// ---------------------------------------------------------------------------

describe('Phase E AI trace (debug aid, never learner data)', () => {
  function tracePorts(dir: string, script: unknown[]) {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const staged: string[] = [];
    const ports: EvaluationPorts = {
      nowIso: () => '2026-03-01T00:10:00.000Z',
      getActiveAttempt: () => ({ attempt, problem }),
      buildContext: async () =>
        buildAIContext({ problem, attempt, previousAttempts: [], edits: [], checkpoints: [], sessionEvents: [] }),
      reasoner: new FakeReasoner(script),
      saveEvaluation: async () => undefined,
      appendConversation: async () => undefined,
      isAttemptStillActive: () => true,
      timeoutMs: 1000,
      onTrace: (event) => {
        staged.push(event.stage);
      },
    };
    return { ports, attempt, staged };
  }

  it('emits ordered stages for a successful turn', async () => {
    const dir = tmpDir('codesense-test-phase-e-trace-unused');
    clean(dir);
    try {
      const { ports, staged } = tracePorts(dir, [
        {
          shouldIntervene: true,
          interventionType: 'HINT',
          urgency: 'low',
          message: 'Try the queue.',
          reasoningSignals: { observedApproach: 'bfs', suspectedIssue: null, confidence: 0.5, relevantEvidence: ['e1'] },
          diagnosis: {
            observedEvidence: ['edit v2 touched enqueue'],
            hypothesis: 'Queue handling may be off.',
            confidence: 'medium',
            unknowns: ['api familiarity'],
            recommendedInteraction: 'HINT',
          },
          requiresLearnerResponse: false,
        },
      ]);
      const outcome = await runAiEvaluation(ports, { attemptId: 'att_1', triggerKind: 'idle', reason: 'test' });
      expect(outcome.status).to.equal('evaluated');
      expect(staged).to.deep.equal([
        'context-assembled',
        'request-sent',
        'response-received',
        'validation-passed',
        'completed',
      ]);
    } finally {
      clean(dir);
    }
  });

  it('traces failures and stays silent without a sink', async () => {
    const { ports, staged } = tracePorts(tmpDir('codesense-test-phase-e-trace-fail'), [new Error('down')]);
    const outcome = await runAiEvaluation(ports, { attemptId: 'att_1', triggerKind: 'idle', reason: 'test' });
    expect(outcome.status).to.equal('failed');
    expect(staged[staged.length - 1]).to.equal('completed');
    // No sink, no problem: ports without onTrace evaluate identically.
    const problem = problemFixture();
    const attempt = attemptFixture('att_9', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const bare: EvaluationPorts = {
      nowIso: () => '2026-03-01T00:10:00.000Z',
      getActiveAttempt: () => ({ attempt, problem }),
      buildContext: async () =>
        buildAIContext({ problem, attempt, previousAttempts: [], edits: [], checkpoints: [], sessionEvents: [] }),
      reasoner: new FakeReasoner([]),
      saveEvaluation: async () => undefined,
      appendConversation: async () => undefined,
      isAttemptStillActive: () => true,
      timeoutMs: 1000,
    };
    const silent = await runAiEvaluation(bare, { attemptId: 'att_9', triggerKind: 'idle', reason: 'test' });
    expect(silent.status).to.equal('evaluated');
  });

  it('a throwing sink never breaks evaluation', async () => {
    const { ports } = tracePorts(tmpDir('codesense-test-phase-e-trace-throw'), []);
    const throwing: EvaluationPorts = {
      ...ports,
      onTrace: () => {
        throw new Error('sink explosion');
      },
    };
    const outcome = await runAiEvaluation(throwing, { attemptId: 'att_1', triggerKind: 'idle', reason: 'test' });
    expect(outcome.status).to.equal('evaluated');
  });

  it('persists a capped ring and refuses secret-bearing events', async () => {
    const dir = tmpDir('codesense-test-phase-e-trace-store');
    clean(dir);
    try {
      const store = new LocalAiTraceStore(dir);
      expect(await store.listTrace()).to.deep.equal([]);
      // Seed a full ring with one direct write, then verify the store
      // enforces the cap on append (keeps newest, drops oldest).
      const file = path.join(dir, '.codesense', 'ai-trace.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const seeded = [];
      for (let n = 0; n < MAX_TRACE_EVENTS + 5; n++) {
        seeded.push({
          traceId: `trace_${String(n).padStart(4, '0')}`,
          at: '2026-03-01T00:00:00.000Z',
          stage: 'completed',
          attemptId: 'att_1',
          evaluationId: null,
          triggerKind: 'idle',
          summary: `turn ${n}`,
        });
      }
      fs.writeFileSync(file, JSON.stringify(seeded));
      await store.appendTrace({
        traceId: 'trace_newest',
        at: '2026-03-01T01:00:00.000Z',
        stage: 'completed',
        attemptId: 'att_1',
        evaluationId: null,
        triggerKind: 'idle',
        summary: 'newest turn',
      });
      const kept = await store.listTrace();
      expect(kept.length).to.equal(MAX_TRACE_EVENTS);
      expect(kept[0]?.traceId).to.equal('trace_0006');
      expect(kept[kept.length - 1]?.traceId).to.equal('trace_newest');
      expect(await store.listTraceForAttempt('att_1')).to.have.lengthOf(MAX_TRACE_EVENTS);
      expect(await store.listTraceForAttempt('att_other')).to.deep.equal([]);
      let refused = false;
      try {
        await store.appendTrace({
          traceId: 'trace_evil',
          at: '2026-03-01T02:00:00.000Z',
          stage: 'request-sent',
          attemptId: null,
          evaluationId: null,
          triggerKind: null,
          summary: 'Authorization: Bearer sk-test-secret-key',
        });
      } catch {
        refused = true;
      }
      expect(refused).to.be.true;
      expect(truncateTraceText('  hello   world  ', 50)).to.equal('hello world');
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Separation audit: C asks knowledge, D holds evidence, E coaches now
// ---------------------------------------------------------------------------

describe('Phase E separation audit (C vs D vs E responsibilities)', () => {
  it('learner behavior never mutates problem knowledge', () => {
    const problem = problemFixture();
    const before = JSON.stringify(classificationFixture(problem));
    // Run behavior through evidence + coaching layers.
    const evidence = [
      ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_sep_1', entityIds: [BFS], evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
    ];
    const profile = rebuildLearnerModel(evidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const attempt = attemptFixture('att_1', problem.problemId, 'Got Stuck', '2026-03-01T00:00:00.000Z');
    buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [evaluationFixture()],
      conversation: [learnerMessage('att_1', "I didn't realize this was multi-source BFS.", '2026-03-01T00:06:00.000Z')],
      previousAttempts: [],
      triggerKind: 'reply',
    });
    // Classification bytes identical: recognition failure changed learner
    // evidence, never the knowledge graph record.
    expect(JSON.stringify(classificationFixture(problem))).to.equal(before);
  });

  it('coach modules never write learner state (pure derivation only)', () => {
    const { profile, evidence } = strongBfsProfile();
    const profileBefore = JSON.stringify(profile);
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [evaluationFixture()],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    summarizeCoachingTurn({ evaluation: evaluationFixture(), coachContext: ctx, attemptState: 'In Progress' });
    renderCoachBriefing(ctx);
    buildAttemptFinalPackage({
      attempt,
      problem,
      classification: classificationFixture(problem),
      evaluations: [evaluationFixture()],
      conversation: [],
      evidence,
      previousAttempts: [],
    });
    // Nothing above takes a store or mutates its inputs.
    expect(JSON.stringify(profile)).to.equal(profileBefore);
  });

  it('AI output stays advisory: recommendation and choice travel separately', () => {
    const evaluation = evaluationFixture({ interventionType: 'EXPLANATION' });
    const { decision } = summarizeCoachingTurn({
      evaluation,
      coachContext: coachContextFixture(),
      attemptState: 'In Progress',
    });
    // Fresh learner + debugging/medium input recommends debugging help,
    // while the model's own EXPLANATION choice passes through untouched.
    expect(decision.proposed).to.equal('DEBUGGING_HELP');
    expect(evaluation.interventionType).to.equal('EXPLANATION');
  });
});

// ---------------------------------------------------------------------------
// Audit hardening: focused behavioral pins for the five core guarantees
// Area 1 — diagnosis-before-intervention precedence and objective coverage
// ---------------------------------------------------------------------------

describe('Phase E audit: diagnosis hard rules and objective mapping', () => {
  it('low confidence without open unknowns falls back to difficulty defaults', () => {
    // Gating is on uncertainty (low + unknowns), not on low alone: with no
    // rival explanations listed, the debugging default still applies.
    const decision = recommendIntervention(
      baseDecisionInput({ difficultyType: 'debugging', diagnosticConfidence: 'low', hasUnknowns: false }),
    );
    expect(decision.proposed).to.equal('DEBUGGING_HELP');
  });

  it('uncertainty outranks even sustained positive evidence', () => {
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'implementation',
        diagnosticConfidence: 'low',
        hasUnknowns: true,
        learnerRelevance: [
          { entityId: BFS, status: 'strong', statusConfidence: 'high', activeDimensions: ['implementation:strong'], evidenceBalance: 'positive' },
        ],
      }),
    );
    expect(decision.proposed).to.equal('SOCRATIC_QUESTION');
    expect(decision.usedLearnerState).to.be.false;
  });

  it('maps every pedagogical objective to a reachable situation', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const base = {
      evaluation: evaluationFixture(),
      coachContext: coachContextFixture(),
      attemptState: 'In Progress',
    };
    const objectiveForSignals = (
      signals: CoachContext['signals'],
      ctxOverride: Partial<CoachContext> = {},
      evalOverride: Record<string, unknown> = {},
    ): string => {
      const evaluation = evaluationFixture(evalOverride);
      const { diagnosis } = summarizeCoachingTurn({
        evaluation,
        coachContext: { ...coachContextFixture(), signals, ...ctxOverride },
        attemptState: 'In Progress',
      });
      return diagnosis.pedagogicalObjective;
    };
    const none = { asksForSolution: false, asksForExplanation: false, asksQuestion: false, replyLengthBucket: 'none' } as const;
    void attempt;
    void base;
    // honor-request beats everything else.
    expect(
      objectiveForSignals({ ...none, asksForSolution: true }, {}, { interventionType: 'HINT' }),
    ).to.equal('honor-request');
    // Recent progress on this attempt is acknowledged.
    expect(
      objectiveForSignals(none, {
        previousOutcome: {
          evaluationId: 'eval_1',
          responded: true,
          responseLatencyMs: 1000,
          transitionsAfter: [],
          outcome: 'progressed',
        },
      }),
    ).to.equal('acknowledge-progress');
    // Abandonment streak reconnects (no progress, no request).
    expect(objectiveForSignals(none, { abandonmentStreak: 3 })).to.equal('reconnect');
    // Low confidence disambiguates.
    expect(
      objectiveForSignals(none, {}, {
        diagnosis: {
          observedEvidence: ['odd edit'],
          hypothesis: 'Unclear.',
          confidence: 'low',
          unknowns: ['x'],
          recommendedInteraction: 'SOCRATIC_QUESTION',
        },
      }),
    ).to.equal('disambiguate');
    // Debugging difficulty unblocks.
    expect(
      objectiveForSignals(none, {}, {
        diagnosis: {
          observedEvidence: ['edit v2 touched enqueue'],
          hypothesis: 'Queue handling may be off.',
          confidence: 'medium',
          unknowns: [],
          recommendedInteraction: 'DEBUGGING_HELP',
        },
      }),
    ).to.equal('unstick-debugging');
    // Sustained strength consolidates.
    expect(
      objectiveForSignals(none, {
        learnerRelevance: [
          { entityId: BFS, status: 'strong', statusConfidence: 'high', activeDimensions: [], evidenceBalance: 'positive' },
        ],
      }, {
        diagnosis: {
          observedEvidence: ['edit v2 touched enqueue'],
          hypothesis: 'Minor slip.',
          confidence: 'medium',
          unknowns: [],
          recommendedInteraction: 'HINT',
        },
      }),
    ).to.equal('consolidate');
    // Otherwise the gap is targeted.
    expect(
      objectiveForSignals(none, {}, {
        diagnosis: {
          observedEvidence: ['edit v2 touched enqueue'],
          hypothesis: 'Queue handling may be off.',
          confidence: 'medium',
          unknowns: [],
          recommendedInteraction: 'HINT',
        },
      }),
    ).to.equal('target-gap');
  });
});

// ---------------------------------------------------------------------------
// Audit hardening, Area 2 — mixed profiles brief both sides honestly
// ---------------------------------------------------------------------------

describe('Phase E audit: mixed learner states stay differentiated', () => {
  it('briefs strength and difficulty side by side without blending', () => {
    const evidence = [
      ev({
        timestamp: '2026-02-01T00:00:00.000Z',
        evidenceId: 'ev_mix_1',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_a',
      }),
      ev({
        timestamp: '2026-02-02T00:00:00.000Z',
        evidenceId: 'ev_mix_2',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_b',
      }),
      ev({
        timestamp: '2026-02-03T00:00:00.000Z',
        evidenceId: 'ev_mix_3',
        entityIds: [BFS],
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        confidence: 'medium',
        problemId: 'prob_c',
      }),
      ev({
        timestamp: '2026-02-04T00:00:00.000Z',
        evidenceId: 'ev_mix_4',
        entityIds: [MULTI_BFS],
        evidenceType: 'IMPLEMENTATION_FAILURE',
        confidence: 'low',
        problemId: 'prob_d',
      }),
      ev({
        timestamp: '2026-02-05T00:00:00.000Z',
        evidenceId: 'ev_mix_5',
        entityIds: [MULTI_BFS],
        evidenceType: 'IMPLEMENTATION_FAILURE',
        confidence: 'low',
        problemId: 'prob_e',
      }),
      ev({
        timestamp: '2026-02-06T00:00:00.000Z',
        evidenceId: 'ev_mix_6',
        entityIds: [MULTI_BFS],
        evidenceType: 'IMPLEMENTATION_FAILURE',
        confidence: 'low',
        problemId: 'prob_f',
      }),
    ];
    const profile = rebuildLearnerModel(evidence, graph(), { now: '2026-03-01T00:00:00.000Z' });
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile,
      evidence,
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    const byId = new Map(ctx.learnerRelevance.map((r) => [r.entityId, r] as const));
    expect(byId.get(BFS)?.status).to.equal('strong');
    expect(byId.get(MULTI_BFS)?.status).to.equal('struggling');
    const text = renderCoachBriefing(ctx);
    expect(text).to.contain(`${BFS}: strong`);
    expect(text).to.contain(`${MULTI_BFS}: struggling`);
    // One entity's struggle never rewrites the other's line.
    expect(text).to.not.contain(`${BFS}: struggling`);
    expect(text).to.not.contain(`${MULTI_BFS}: strong`);
  });

  it('recommendations are deterministic for identical inputs', () => {
    const input = baseDecisionInput({
      difficultyType: 'debugging',
      diagnosticConfidence: 'medium',
      learnerRelevance: [
        { entityId: BFS, status: 'developing', statusConfidence: 'low', activeDimensions: [], evidenceBalance: 'mixed' },
      ],
      activeMistakeCategories: ['forgot-visited-marking'],
    });
    expect(recommendIntervention(input)).to.deep.equal(recommendIntervention(input));
  });
});

// ---------------------------------------------------------------------------
// Audit hardening, Area 3 — the feedback loop across turns
// ---------------------------------------------------------------------------

describe('Phase E audit: feedback control over consecutive turns', () => {
  function turnOne() {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const evaluation = evaluationFixture({
      interventionType: 'HINT',
      diagnosis: {
        observedEvidence: ['repeated boundary edits with no passing run'],
        hypothesis: 'The window invariant may not be established.',
        confidence: 'medium',
        unknowns: [],
        recommendedInteraction: 'HINT',
      },
    });
    const ctx = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile: null,
      evidence: [],
      evaluations: [],
      conversation: [],
      previousAttempts: [],
      triggerKind: 'idle',
    });
    return { problem, attempt, evaluation, ctx };
  }

  it('escalates turn two after a replied-but-stalled turn one', () => {
    const { problem, attempt, evaluation, ctx } = turnOne();
    const first = summarizeCoachingTurn({ evaluation, coachContext: ctx, attemptState: 'In Progress' });
    expect(first.decision.proposed).to.equal('HINT');
    // Learner replies, still stuck: turn two sees the outcome and moves.
    const conversation: AIConversationMessage[] = [
      coachMessage('att_1', 'What should hold at the left edge?', {
        timestamp: '2026-03-01T00:05:00.000Z',
        evaluationId: 'eval_1',
      }),
      learnerMessage('att_1', 'Tried that, still failing?', '2026-03-01T00:07:00.000Z'),
    ];
    const ctx2 = buildCoachContext({
      attempt,
      problem,
      classification: classificationFixture(problem),
      profile: null,
      evidence: [],
      evaluations: [evaluation],
      conversation,
      previousAttempts: [],
      triggerKind: 'reply',
    });
    expect(ctx2.previousOutcome?.outcome).to.equal('no-progress');
    const second = summarizeCoachingTurn({ evaluation, coachContext: ctx2, attemptState: 'Got Stuck' });
    expect(second.decision.proposed).to.equal('EXPLANATION');
    expect(renderCoachBriefing(ctx2)).to.contain('did not visibly help');
  });

  it('caps repeated no-progress below a full solution without a request', () => {
    // Isolated decision input: previous EXPLANATION went nowhere, no
    // explicit solution request. Escalation alone must not mint a solution.
    const decision = recommendIntervention(
      baseDecisionInput({
        difficultyType: 'conceptual',
        diagnosticConfidence: 'medium',
        previousIntervention: {
          evaluationId: 'eval_1',
          timestamp: '2026-03-01T00:05:00.000Z',
          interventionType: 'EXPLANATION',
          triggerKind: 'idle',
          requiredResponse: false,
        },
        previousOutcome: {
          evaluationId: 'eval_1',
          responded: true,
          responseLatencyMs: 60000,
          transitionsAfter: [],
          outcome: 'no-progress',
        },
        priorInterventionCount: 2,
        attemptState: 'Got Stuck',
      }),
    );
    expect(decision.proposed).to.equal('SOCRATIC_QUESTION');
    expect(decision.honorsExplicitRequest).to.be.false;
    expect(decision.rationale.join(' ')).to.contain('re-disambiguate');
  });

  it('stale replies before the intervention do not count as responses', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const evaluation = evaluationFixture({ timestamp: '2026-03-01T00:10:00.000Z' });
    const state = summarizeCoachState({
      attemptId: 'att_1',
      evaluations: [evaluation],
      conversation: [learnerMessage('att_1', 'Old message.', '2026-03-01T00:01:00.000Z')],
      attempt,
      previousAttempts: [],
      now: '2026-03-01T00:11:00.000Z',
    });
    expect(state.previousOutcome?.responded).to.be.false;
    expect(state.previousOutcome?.outcome).to.equal('unclear');
  });
});

// ---------------------------------------------------------------------------
// Audit hardening, Area 4 — streak counting and candidate routes
// ---------------------------------------------------------------------------

describe('Phase E audit: streaks trail honestly, every candidate route validates', () => {
  function abandoned(id: string, day: string): Attempt {
    const problem = problemFixture();
    return attemptFixture(id, problem.problemId, 'Abandoned / Continue Later', `2026-03-${day}T00:10:00.000Z`);
  }

  function succeeded(id: string, day: string): Attempt {
    const problem = problemFixture();
    return attemptFixture(id, problem.problemId, 'Got AC Independently', `2026-03-${day}T00:10:00.000Z`);
  }

  it('counts only the trailing run of abandonments', () => {
    expect(abandonmentStreakForProblem([])).to.equal(0);
    expect(
      abandonmentStreakForProblem([abandoned('a1', '01'), abandoned('a2', '02'), abandoned('a3', '03')]),
    ).to.equal(3);
    // A later success breaks the streak: only trailing abandonments count.
    expect(
      abandonmentStreakForProblem([abandoned('a1', '01'), abandoned('a2', '02'), succeeded('a3', '03')]),
    ).to.equal(0);
    expect(
      abandonmentStreakForProblem([succeeded('a1', '01'), abandoned('a2', '02'), abandoned('a3', '03')]),
    ).to.equal(2);
    expect(abandonmentStreakForProblem([abandoned('a1', '01')])).to.equal(1);
  });

  it('validates recognition candidates through Phase D rules', () => {
    const good = candidateToRecords(
      {
        payload: {
          entityIds: [BFS],
          verdict: 'recognized',
          observation: 'Learner named BFS unprompted.',
          timestamp: '2026-03-01T00:00:00.000Z',
        },
        route: 'recognition',
        reason: 'test',
      },
      {
        mistakeReport: () => null,
        recognition: (payload) => {
          const p = payload as { entityIds?: unknown; verdict?: unknown; observation?: unknown; timestamp?: unknown };
          if (!Array.isArray(p.entityIds) || (p.verdict !== 'recognized' && p.verdict !== 'missed')) {
            return null;
          }
          return extractRecognitionEvidence(graph(), {
            entityIds: p.entityIds as string[],
            verdict: p.verdict,
            observation: typeof p.observation === 'string' ? p.observation : 'candidate',
            timestamp: typeof p.timestamp === 'string' ? p.timestamp : '2026-03-01T00:00:00.000Z',
          });
        },
        replyAssessment: () => [],
        records: () => [],
      },
    );
    expect(good).to.have.lengthOf(1);
    expect(good[0]?.evidenceType).to.equal('RECOGNITION');
    const bad = candidateToRecords(
      { payload: { entityIds: ['not-an-entity'], verdict: 'recognized' }, route: 'recognition', reason: 'test' },
      {
        mistakeReport: () => null,
        recognition: (payload) => {
          const p = payload as { entityIds?: unknown };
          if (!Array.isArray(p.entityIds)) {
            return null;
          }
          return extractRecognitionEvidence(graph(), {
            entityIds: p.entityIds as string[],
            verdict: 'recognized',
            observation: 'candidate',
            timestamp: '2026-03-01T00:00:00.000Z',
          });
        },
        replyAssessment: () => [],
        records: () => [],
      },
    );
    expect(bad).to.deep.equal([]);
  });

  it('validates reply-assessment candidates through Phase D rules', () => {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const message = learnerMessage('att_1', 'I see — the queue holds the frontier.', '2026-03-01T00:06:00.000Z');
    const classification = classificationFixture(problem);
    const assessed = candidateToRecords(
      { payload: { kind: 'understood' }, route: 'reply-assessment', reason: 'test' },
      {
        mistakeReport: () => null,
        recognition: () => null,
        replyAssessment: (payload) => {
          const p = payload as { kind?: unknown };
          if (p.kind !== 'understood') {
            return [];
          }
          return extractReplyEvidence(graph(), {
            message,
            attempt,
            classification,
            assessment: 'demonstrates-understanding',
          });
        },
        records: () => [],
      },
    );
    expect(assessed).to.have.lengthOf(1);
    expect(assessed[0]?.evidenceType).to.equal('CONCEPTUAL_SUCCESS');
    // Unassessable chatter yields nothing — receipts are not knowledge.
    const empty = candidateToRecords(
      { payload: { kind: 'shrug' }, route: 'reply-assessment', reason: 'test' },
      {
        mistakeReport: () => null,
        recognition: () => null,
        replyAssessment: () => [],
        records: () => [],
      },
    );
    expect(empty).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// Audit hardening, Area 5 — trace correlation and open-attempt honesty
// ---------------------------------------------------------------------------

describe('Phase E audit: one turn, one trace id; open attempts stay open', () => {
  function tracedPorts(script: unknown[]) {
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const seen: Array<{ traceId: string; stage: string; evaluationId: string | null }> = [];
    const ports: EvaluationPorts = {
      nowIso: () => '2026-03-01T00:10:00.000Z',
      getActiveAttempt: () => ({ attempt, problem }),
      buildContext: async () =>
        buildAIContext({ problem, attempt, previousAttempts: [], edits: [], checkpoints: [], sessionEvents: [] }),
      reasoner: new FakeReasoner(script),
      saveEvaluation: async () => undefined,
      appendConversation: async () => undefined,
      isAttemptStillActive: () => true,
      timeoutMs: 1000,
      onTrace: (event) => {
        seen.push({ traceId: event.traceId, stage: event.stage, evaluationId: event.evaluationId });
      },
    };
    return { ports, seen };
  }

  it('correlates every stage of one turn under a single trace id', async () => {
    const { ports, seen } = tracedPorts([
      {
        shouldIntervene: true,
        interventionType: 'HINT',
        urgency: 'low',
        message: 'Try the queue.',
        reasoningSignals: { observedApproach: 'bfs', suspectedIssue: null, confidence: 0.5, relevantEvidence: ['e1'] },
        diagnosis: {
          observedEvidence: ['edit v2 touched enqueue'],
          hypothesis: 'Queue handling may be off.',
          confidence: 'medium',
          unknowns: ['api familiarity'],
          recommendedInteraction: 'HINT',
        },
        requiresLearnerResponse: false,
      },
    ]);
    const outcome = await runAiEvaluation(ports, { attemptId: 'att_1', triggerKind: 'idle', reason: 'test' });
    expect(outcome.status).to.equal('evaluated');
    expect(seen.length).to.be.greaterThan(0);
    const ids = new Set(seen.map((e) => e.traceId));
    expect([...ids]).to.have.lengthOf(1);
    const [only] = [...ids];
    expect(only?.startsWith('trace_')).to.be.true;
    // Late stages carry the evaluation id for store-level joins.
    const validated = seen.filter((e) => e.stage === 'validation-passed' || e.stage === 'completed');
    expect(validated.length).to.be.greaterThan(0);
    for (const event of validated) {
      expect(event.evaluationId).to.be.a('string');
    }
  });

  it('lists open attempts honestly without completing them', () => {
    const problem = problemFixture();
    const open = attemptFixture('att_open', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    const before = JSON.stringify(open);
    const pkg = buildSessionFinalPackage({
      sessionId: 'ses_1',
      startedAt: '2026-03-01T00:00:00.000Z',
      endedAt: null,
      attempts: [open],
      evaluations: [],
    });
    expect(pkg.attemptOutcomes).to.have.lengthOf(1);
    expect(pkg.attemptOutcomes[0]?.completedAt).to.be.null;
    expect(pkg.attemptOutcomes[0]?.finalState).to.equal('In Progress');
    // Packaging is read-only: the attempt object is untouched.
    expect(JSON.stringify(open)).to.equal(before);
  });
});
