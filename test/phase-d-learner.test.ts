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
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import type { Attempt } from 'codesense/attempts/attempt';
import type { AIEvaluation } from 'codesense/ai/aiTypes';
import {
  EVIDENCE_CONFIDENCES,
  EVIDENCE_DIMENSIONS,
  EVIDENCE_SOURCES,
  EVIDENCE_TYPES,
  isKnownEvidenceConfidence,
  isKnownEvidenceDimension,
  isKnownEvidenceSource,
  isKnownEvidenceType,
} from 'codesense/learner/learnerTypes';
import {
  MAX_EVIDENCE_TEXT_CHARS,
  generateEvidenceId,
  parseLearnerEvidence,
  truncateEvidenceText,
  validateLearnerEvidence,
} from 'codesense/learner/learnerEvidence';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import {
  emptyLearnerProfile,
  parseLearnerProfile,
} from 'codesense/learner/learnerModel';
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import {
  frameworkFamily,
  mistakeIdFor,
  rebuildLearnerModel,
} from 'codesense/learner/learnerModelUpdater';
import {
  buildLearnerNotesForPrompt,
  getEvidenceForEntity,
  getLearnerKnowledge,
  getLearnerKnowledgeForEntities,
  getLearnerSummary,
  getLearnerTrajectory,
  getRecentEvidence,
  getRecentlyImprovedEntities,
  getRecurringMistakes,
  getWeakOrUncertainEntities,
} from 'codesense/learner/learnerQueries';
import {
  extractAttemptEvidence,
  extractEvaluationEvidence,
  extractMistakeEvidence,
  extractRecognitionEvidence,
  extractReplyEvidence,
  helpLevelForIntervention,
  maxHelpLevel,
  syncAttemptToLearnerModel,
  syncEvaluationToLearnerModel,
  syncRecordsToLearnerModel,
} from 'codesense/learner/learnerFeeds';
import type { EvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import type { LearnerModelStore } from 'codesense/learner/learnerModelStore';

/**
 * Phase D — Learner Model.
 *
 * Machine-enforced properties live here: evidence-first inference with
 * mandatory provenance, conservative aggregation (no verdicts from single
 * signals), explicit uncertainty, dimension separation, recurring-mistake
 * lifecycle, trajectory preservation, deterministic rebuilds, and the
 * query surface Phase E will consume.
 */

const BFS = 'framework.bfs';
const GRID_BFS = 'form.grid-bfs';
const MULTI_BFS = 'form.multisource-bfs';
const GRAPH_TOPIC = 'topic.graphs';
const CONNECTED = 'concept.connected-components';
const QUEUE_FIFO = 'concept.queue-fifo';
const VISITED = 'tactic.visited-on-enqueue';
const DIST_PROP = 'pattern.distance-time-propagation';

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
    evidenceId: `ev_test_${evidenceCounter}`,
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
    statement: 'Grid rotting problem statement.',
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

function ports(dir: string, now = '2026-04-01T00:00:00.000Z') {
  return {
    evidenceStore: new LocalLearnerEvidenceStore(dir) as EvidenceStore,
    modelStore: new LocalLearnerModelStore(dir) as LearnerModelStore,
    graph: graph(),
    nowIso: () => now,
    dir,
  };
}

// ---------------------------------------------------------------------------
// Evidence: validation & provenance
// ---------------------------------------------------------------------------

describe('Phase D evidence model (traceable, strictly shaped)', () => {
  it('accepts well-formed evidence with provenance', () => {
    const record = ev({ timestamp: '2026-03-01T00:00:01.000Z' });
    expect(record.evidenceId).to.match(/^ev_test_/);
    expect(record.schemaVersion).to.equal(1);
    expect(record.provenance.source).to.equal('attempt-outcome');
    expect(record.provenance.sourceId).to.equal('att_1');
    expect(EVIDENCE_TYPES.length).to.be.greaterThan(10);
    expect(EVIDENCE_SOURCES).to.include('attempt-outcome');
    expect(EVIDENCE_DIMENSIONS).to.include('transfer');
    expect(EVIDENCE_CONFIDENCES).to.deep.equal(['low', 'medium', 'high']);
    expect(isKnownEvidenceType('EXPOSURE')).to.be.true;
    expect(isKnownEvidenceType('MASTERY')).to.be.false;
    expect(isKnownEvidenceSource('ai-diagnosis')).to.be.true;
    expect(isKnownEvidenceDimension('debugging')).to.be.true;
    expect(isKnownEvidenceDimension('mastery')).to.be.false;
    expect(isKnownEvidenceConfidence('high')).to.be.true;
    expect(generateEvidenceId()).to.match(/^ev_/);
  });

  it('rejects malformed evidence (never persisted half-shaped)', () => {
    const at = '2026-03-01T00:00:01.000Z';
    const missing: unknown[] = [
      { timestamp: at }, // missing everything
      { timestamp: at, evidenceId: 'x', schemaVersion: 1 }, // missing entities, texts, etc.
      { timestamp: '', evidenceId: 'x', schemaVersion: 1 }, // blank time
    ];
    for (const raw of missing) {
      expect(validateLearnerEvidence(raw, { graph: graph() }), JSON.stringify(raw)).to.be.null;
    }
    const validBase = {
      evidenceId: 'x',
      schemaVersion: 1,
      timestamp: at,
      sessionId: null,
      attemptId: null,
      problemId: null,
      entityIds: [BFS],
      evidenceType: 'EXPOSURE',
      source: 'attempt-outcome',
      observation: 'something happened',
      interpretation: 'it means something',
      confidence: 'low',
      provenance: { source: 'attempt-outcome', sourceId: null },
    };
    const bad: Array<Record<string, unknown>> = [
      { ...validBase, evidenceId: '' }, // blank id
      { ...validBase, schemaVersion: 999 }, // wrong schema
      { ...validBase, entityIds: [] }, // no entities
      { ...validBase, entityIds: ['nope.nope'] }, // invented id
      { ...validBase, entityIds: ['  '] }, // blank id
      { ...validBase, evidenceType: 'MASTERY' }, // unknown type
      { ...validBase, source: 'vibes' }, // unknown source
      { ...validBase, observation: 'x'.repeat(MAX_EVIDENCE_TEXT_CHARS + 1) }, // essay smuggling
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'EXPOSURE',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'certain',
        provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'EXPOSURE',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        // missing provenance
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'IMPLEMENTATION_SUCCESS',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        helpLevel: 'hint', provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'HELP_REQUIRED',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'HELP_REQUIRED',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        helpLevel: 'none', provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'EXPOSURE',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        mistakeCategory: 'off-by-one', provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'RECURRING_MISTAKE',
        source: 'mistake-report', observation: 'o', interpretation: 'i', confidence: 'low',
        provenance: { source: 'mistake-report', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'IMPLEMENTATION_FAILURE',
        source: 'attempt-outcome', observation: 'o', interpretation: 'i', confidence: 'low',
        mistakeCategory: 'Not A Category!!', provenance: { source: 'attempt-outcome', sourceId: null },
      },
      {
        timestamp: at, evidenceId: 'x', schemaVersion: 1, entityIds: [BFS], evidenceType: 'RECURRING_MISTAKE',
        source: 'mistake-report', observation: 'o', interpretation: 'i', confidence: 'low',
        mistakeCategory: 'off-by-one', dimension: 'exposure',
        provenance: { source: 'mistake-report', sourceId: null },
      },
    ];
    for (const raw of bad) {
      expect(validateLearnerEvidence(raw, { graph: graph() }), JSON.stringify(raw)).to.be.null;
    }
  });

  it('bounds evidence text (builders truncate, validators reject essays)', () => {
    expect(truncateEvidenceText('  hello  ')).to.equal('hello');
    const long = 'x'.repeat(MAX_EVIDENCE_TEXT_CHARS + 50);
    expect(truncateEvidenceText(long).length).to.be.lessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS);
    expect(
      validateLearnerEvidence(
        {
          evidenceId: 'ev_long',
          schemaVersion: 1,
          timestamp: '2026-03-01T00:00:01.000Z',
          sessionId: null,
          attemptId: null,
          problemId: null,
          entityIds: [BFS],
          evidenceType: 'EXPOSURE',
          source: 'attempt-outcome',
          observation: long,
          interpretation: 'i',
          confidence: 'low',
          provenance: { source: 'attempt-outcome', sourceId: null },
        },
        { graph: graph() },
      ),
    ).to.be.null;
  });

  it('parses stored history leniently (ontology evolution never breaks loads)', () => {
    const record = ev({ timestamp: '2026-03-01T00:00:01.000Z' });
    const roundTrip = parseLearnerEvidence(JSON.parse(JSON.stringify(record)) as unknown);
    expect(roundTrip).to.deep.equal(record);
    // Unknown entity IDs still load (history outlives ontology edits).
    const evolved = { ...record, entityIds: ['framework.teleportation'] };
    expect(parseLearnerEvidence(evolved)?.entityIds).to.deep.equal(['framework.teleportation']);
    // Strict validation still refuses to WRITE invented IDs.
    expect(validateLearnerEvidence(evolved, { graph: graph() })).to.be.null;
    expect(parseLearnerEvidence(null)).to.be.null;
    expect(parseLearnerEvidence({ nope: true })).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// Evidence store: append-oriented local persistence
// ---------------------------------------------------------------------------

describe('Phase D evidence store (append-only history)', () => {
  it('appends, lists chronologically, counts, and filters by entity', async () => {
    const dir = tmpDir('codesense-test-phase-d-evidence');
    clean(dir);
    try {
      const store = new LocalLearnerEvidenceStore(dir);
      expect(await store.countEvidence()).to.equal(0);
      expect(await store.listEvidence()).to.deep.equal([]);
      const first = ev({ timestamp: '2026-03-01T00:00:02.000Z', evidenceId: 'ev_b' });
      const second = ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_a', entityIds: [GRID_BFS] });
      await store.appendEvidence(first);
      await store.appendEvidence(second);
      expect(await store.countEvidence()).to.equal(2);
      const listed = await store.listEvidence();
      expect(listed.map((e) => e.evidenceId)).to.deep.equal(['ev_a', 'ev_b']);
      expect(await store.listEvidenceForEntity(BFS)).to.have.lengthOf(1);
      expect(await store.listEvidenceForEntity(GRID_BFS)).to.have.lengthOf(1);
      expect(await store.listEvidenceForEntity('topic.graphs')).to.deep.equal([]);
      // Re-appending the same id is a no-op (idempotent sync retries).
      await store.appendEvidence(first);
      expect(await store.countEvidence()).to.equal(2);
    } finally {
      clean(dir);
    }
  });

  it('skips corrupt rows instead of failing the whole history', async () => {
    const dir = tmpDir('codesense-test-phase-d-evidence-corrupt');
    clean(dir);
    try {
      const store = new LocalLearnerEvidenceStore(dir);
      await store.appendEvidence(ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_ok' }));
      const file = path.join(dir, '.codesense', 'learner-evidence.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
      onDisk.push({ garbage: true }, null, 'nope');
      fs.writeFileSync(file, JSON.stringify(onDisk));
      const listed = await store.listEvidence();
      expect(listed.map((e) => e.evidenceId)).to.deep.equal(['ev_ok']);
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Updater: conservative aggregation boundaries
// ---------------------------------------------------------------------------

describe('Phase D aggregation (conservative, explainable)', () => {
  it('unknown genuinely means unknown (no evidence, no record)', () => {
    const profile = rebuildLearnerModel([], graph(), { now: '2026-04-01T00:00:00.000Z' });
    expect(profile.knowledgeStates).to.deep.equal([]);
    expect(profile.recurringMistakes).to.deep.equal([]);
    expect(profile.totalEvidenceCount).to.equal(0);
    expect(profile.learnerId).to.equal('local-learner');
  });

  it('exposure does not imply mastery', () => {
    const profile = rebuildLearnerModel(
      [ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceType: 'EXPOSURE', confidence: 'high' })],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state).to.not.be.undefined;
    expect(state.status).to.equal('exposed');
    expect(state.exposure.level).to.equal('EXPOSED');
    expect(state.implementation.level).to.equal('UNKNOWN');
    expect(state.conceptual.level).to.equal('UNKNOWN');
    expect(state.supportingEvidenceIds).to.deep.equal([]);
    expect(state.status).to.not.equal('demonstrated');
    expect(state.status).to.not.equal('strong');
  });

  it('one failure does not create a weakness verdict', () => {
    const profile = rebuildLearnerModel(
      [
        ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceType: 'EXPOSURE', confidence: 'high' }),
        ev({ timestamp: '2026-03-01T00:00:02.000Z', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.implementation.level).to.equal('EXPOSED');
    expect(state.implementation.confidence).to.equal('low');
    expect(state.implementation.negativeEvidenceIds).to.have.lengthOf(1);
    expect(state.implementation.positiveEvidenceIds).to.deep.equal([]);
    expect(state.status).to.equal('developing');
    expect(state.status).to.not.equal('struggling');
  });

  it('one success does not create mastery', () => {
    const profile = rebuildLearnerModel(
      [
        ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceType: 'INDEPENDENT_SUCCESS', confidence: 'medium', helpLevel: 'none' }),
        ev({ timestamp: '2026-03-01T00:00:02.000Z', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.independence.level).to.equal('EMERGING');
    expect(state.implementation.level).to.equal('EMERGING');
    expect(state.status).to.equal('developing');
    expect(state.status).to.not.equal('demonstrated');
    expect(state.status).to.not.equal('strong');
  });

  it('a single high-confidence item can never establish DEMONSTRATED or STRONG', () => {
    // Regression: weight 3 from one high-confidence record used to hit the
    // DEMONSTRATED threshold (net ≥ 3) on its own. Corroboration across
    // encounters is required — a lone record caps at EMERGING.
    const lone = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z',
          evidenceId: 'ev_lone_high',
          entityIds: [BFS],
          evidenceType: 'TRANSFER_SUCCESS',
          confidence: 'high',
          problemId: 'prob_x',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const single = lone.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(single.transfer.positiveWeight).to.equal(3);
    expect(single.transfer.level).to.equal('EMERGING');
    expect(single.transfer.confidence).to.equal('low');
    expect(single.status).to.equal('developing');
    expect(single.status).to.not.equal('demonstrated');
    expect(single.status).to.not.equal('strong');
    // Same holds on any other dimension: one high implementation success.
    const loneImpl = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z',
          evidenceId: 'ev_lone_impl',
          entityIds: [BFS],
          evidenceType: 'IMPLEMENTATION_SUCCESS',
          confidence: 'high',
          problemId: 'prob_x',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    expect(loneImpl.knowledgeStates.find((s) => s.entityId === BFS)!.implementation.level).to.equal('EMERGING');
    // Corroboration still strengthens: a second high from another problem.
    const pair = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z',
          evidenceId: 'ev_pair_1',
          entityIds: [BFS],
          evidenceType: 'TRANSFER_SUCCESS',
          confidence: 'high',
          problemId: 'prob_x',
        }),
        ev({
          timestamp: '2026-03-02T00:00:01.000Z',
          evidenceId: 'ev_pair_2',
          entityIds: [BFS],
          evidenceType: 'TRANSFER_SUCCESS',
          confidence: 'high',
          problemId: 'prob_y',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    expect(pair.knowledgeStates.find((s) => s.entityId === BFS)!.transfer.level).to.equal('STRONG');
  });

  it('repeated agreeing evidence strengthens level and confidence', () => {
    const records = [1, 2, 3].map((n) =>
      ev({
        timestamp: `2026-03-0${n}T00:00:00.000Z`,
        evidenceId: `ev_rep_${n}`,
        evidenceType: 'INDEPENDENT_SUCCESS',
        confidence: 'medium',
        helpLevel: 'none',
        attemptId: `att_${n}`,
        problemId: `prob_${n}`,
      }),
    );
    const profile = rebuildLearnerModel(records, graph(), { now: '2026-04-01T00:00:00.000Z' });
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.independence.level).to.equal('STRONG');
    expect(state.independence.confidence).to.equal('high');
    expect(state.status).to.equal('strong');
    expect(state.supportingEvidenceIds).to.have.lengthOf(3);
    expect(state.contradictingEvidenceIds).to.deep.equal([]);
  });

  it('contradictory evidence is represented, confidence capped', () => {
    const profile = rebuildLearnerModel(
      [
        ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_c1', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
        ev({ timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_c2', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
        ev({ timestamp: '2026-03-03T00:00:01.000Z', evidenceId: 'ev_c3', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
        ev({ timestamp: '2026-03-04T00:00:01.000Z', evidenceId: 'ev_c4', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.implementation.positiveEvidenceIds).to.have.lengthOf(2);
    expect(state.implementation.negativeEvidenceIds).to.have.lengthOf(2);
    expect(state.implementation.confidence).to.equal('low');
    expect(state.supportingEvidenceIds).to.have.lengthOf(2);
    expect(state.contradictingEvidenceIds).to.have.lengthOf(2);
    expect(state.status).to.equal('developing');
  });

  it('repeated negative evidence flags struggling (single failure never does)', () => {
    const struggling = rebuildLearnerModel(
      [1, 2, 3].map((n) =>
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_neg_${n}`,
          evidenceType: 'IMPLEMENTATION_FAILURE',
          confidence: 'low',
        }),
      ),
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = struggling.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.status).to.equal('struggling');
    expect(state.implementation.level).to.equal('EXPOSED');
    // Two failures: difficulty recorded, still no flag.
    const two = rebuildLearnerModel(
      [1, 2].map((n) =>
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_two_${n}`,
          evidenceType: 'IMPLEMENTATION_FAILURE',
          confidence: 'low',
        }),
      ),
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    expect(two.knowledgeStates.find((s) => s.entityId === BFS)!.status).to.equal('developing');
  });

  it('old failures are outweighed by new successes (no decay, no deletion)', () => {
    const records: LearnerEvidence[] = [
      ev({ timestamp: '2026-01-01T00:00:01.000Z', evidenceId: 'ev_old_1', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ev({ timestamp: '2026-01-02T00:00:01.000Z', evidenceId: 'ev_old_2', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ev({ timestamp: '2026-01-03T00:00:01.000Z', evidenceId: 'ev_old_3', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ...[4, 5, 6, 7, 8].map((n) =>
        ev({
          timestamp: `2026-03-0${n}T00:00:00.000Z`,
          evidenceId: `ev_new_${n}`,
          evidenceType: 'INDEPENDENT_SUCCESS',
          confidence: 'medium',
          helpLevel: 'none',
          problemId: `prob_new_${n}`,
        }),
      ),
    ];
    const profile = rebuildLearnerModel(records, graph(), { now: '2026-04-01T00:00:00.000Z' });
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    // History preserved: all 8 records still cited.
    expect(state.implementation.negativeEvidenceIds).to.have.lengthOf(3);
    expect(state.supportingEvidenceIds.length).to.be.greaterThan(0);
    // Current state reflects the turnaround, not the old verdict.
    expect(state.status).to.not.equal('struggling');
    expect(['mixed', 'developing', 'demonstrated', 'strong']).to.include(state.status);
    // Trajectory shows the improvement explicitly.
    const improved = state.trajectory.filter(
      (t) => t.at.localeCompare('2026-03-01T00:00:00.000Z') > 0,
    );
    expect(improved.length).to.be.greaterThan(0);
  });

  it('rebuilds are deterministic and never mutate input', () => {
    const records = [
      ev({ timestamp: '2026-03-02T00:00:00.000Z', evidenceId: 'ev_z', evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
      ev({ timestamp: '2026-03-01T00:00:00.000Z', evidenceId: 'ev_a', evidenceType: 'EXPOSURE', confidence: 'high' }),
      ev({ timestamp: '2026-03-03T00:00:00.000Z', evidenceId: 'ev_m', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
    ];
    const snapshot = JSON.stringify(records);
    const first = rebuildLearnerModel(records, graph(), { now: '2026-04-01T00:00:00.000Z' });
    const second = rebuildLearnerModel([...records].reverse(), graph(), { now: '2026-04-01T00:00:00.000Z' });
    expect(JSON.stringify(records)).to.equal(snapshot);
    expect(second).to.deep.equal(first);
  });
});

// ---------------------------------------------------------------------------
// Updater: dimensions stay separate (cross-dimensional diagnosis)
// ---------------------------------------------------------------------------

describe('Phase D dimensions (no collapsing)', () => {
  it('routes each evidence type to exactly one dimension', () => {
    const at = '2026-03-01T00:00:00.000Z';
    const profile = rebuildLearnerModel(
      [
        ev({ timestamp: `${at.slice(0, 11)}00:00:01.000Z`, evidenceId: 'ev_r', evidenceType: 'RECOGNITION', confidence: 'low' }),
        ev({ timestamp: `${at.slice(0, 11)}00:00:02.000Z`, evidenceId: 'ev_cs', evidenceType: 'CONCEPTUAL_SUCCESS', confidence: 'medium' }),
        ev({ timestamp: `${at.slice(0, 11)}00:00:03.000Z`, evidenceId: 'ev_ds', evidenceType: 'DEBUGGING_SUCCESS', confidence: 'medium' }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.recognition.positiveEvidenceIds).to.deep.equal(['ev_r']);
    expect(state.conceptual.positiveEvidenceIds).to.deep.equal(['ev_cs']);
    expect(state.debugging.positiveEvidenceIds).to.deep.equal(['ev_ds']);
    expect(state.implementation.positiveEvidenceIds).to.deep.equal([]);
    expect(state.implementation.level).to.equal('UNKNOWN');
    expect(state.transfer.level).to.equal('UNKNOWN');
    expect(state.independence.level).to.equal('UNKNOWN');
  });

  it('keeps framework recognition apart from form implementation difficulty', () => {
    const profile = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_rec',
          entityIds: [BFS], evidenceType: 'RECOGNITION', confidence: 'medium', problemId: 'prob_a',
        }),
        ev({
          timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_impl_fail',
          entityIds: [MULTI_BFS], evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low', problemId: 'prob_b',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const framework = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    const form = profile.knowledgeStates.find((s) => s.entityId === MULTI_BFS)!;
    expect(framework.recognition.positiveEvidenceIds).to.deep.equal(['ev_rec']);
    expect(framework.status).to.not.equal('struggling');
    expect(form.implementation.negativeEvidenceIds).to.deep.equal(['ev_impl_fail']);
    // The new-form failure after family success also marks transfer strain.
    expect(form.transfer.negativeEvidenceIds).to.deep.equal(['ev_impl_fail']);
  });

  it('detects transfer across problems in one framework family', () => {
    const profile = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_fam_1',
          entityIds: [BFS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', problemId: 'prob_a',
        }),
        ev({
          timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_fam_2',
          entityIds: [GRID_BFS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', problemId: 'prob_b',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const form = profile.knowledgeStates.find((s) => s.entityId === GRID_BFS)!;
    expect(form.transfer.positiveEvidenceIds).to.deep.equal(['ev_fam_2']);
    expect(form.implementation.positiveEvidenceIds).to.deep.equal(['ev_fam_2']);
    // Same-problem repetition is practice, not transfer.
    const sameProblem = rebuildLearnerModel(
      [
        ev({
          timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_sp_1',
          entityIds: [BFS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', problemId: 'prob_a',
        }),
        ev({
          timestamp: '2026-03-02T00:00:01.000Z', evidenceId: 'ev_sp_2',
          entityIds: [GRID_BFS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', problemId: 'prob_a',
        }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    expect(sameProblem.knowledgeStates.find((s) => s.entityId === GRID_BFS)!.transfer.level).to.equal('UNKNOWN');
    // Framework family membership itself is graph-derived, not hardcoded.
    expect(frameworkFamily(graph(), GRID_BFS)).to.include(BFS);
    expect(frameworkFamily(graph(), BFS)).to.include(GRID_BFS);
    expect(frameworkFamily(graph(), GRAPH_TOPIC)).to.deep.equal([GRAPH_TOPIC]);
  });
});

// ---------------------------------------------------------------------------
// Updater: help ladder
// ---------------------------------------------------------------------------

describe('Phase D help ladder (independent vs helped success)', () => {
  it('distinguishes independent success from hint- and explanation-backed success', async () => {
    const problem = problemFixture();
    const classification = classificationFixture(problem);
    const dir = tmpDir('codesense-test-phase-d-help');
    clean(dir);
    try {
      const p = ports(dir);
      const attempt = (state: Attempt['currentState'], id: string) =>
        attemptFixture(id, problem.problemId, state, '2026-03-01T00:00:00.000Z');
      const hintEval: AIEvaluation = { ...evaluationFixture({ evaluationId: 'eval_hint' }), interventionType: 'HINT' };
      const explEval: AIEvaluation = {
        ...evaluationFixture({ evaluationId: 'eval_expl' }),
        interventionType: 'EXPLANATION',
        diagnosis: {
          ...evaluationFixture().diagnosis,
          recommendedInteraction: 'CONCEPT_REVIEW' as const,
        },
      };
      await syncAttemptToLearnerModel(p, {
        attempt: attempt('Got AC Independently', 'att_ind'),
        problem,
        classification,
        evaluations: [],
      });
      await syncAttemptToLearnerModel(p, {
        attempt: attempt('Got AC with Help', 'att_hint'),
        problem,
        classification,
        evaluations: [hintEval],
      });
      await syncAttemptToLearnerModel(p, {
        attempt: attempt('Got AC with Help', 'att_expl'),
        problem,
        classification,
        evaluations: [explEval],
      });
      const history = await p.evidenceStore.listEvidence();
      const helpRecords = history.filter((e) => e.evidenceType === 'HELP_REQUIRED');
      expect(helpRecords.map((e) => e.helpLevel).sort()).to.deep.equal(['explanation', 'hint']);
      expect(history.filter((e) => e.evidenceType === 'INDEPENDENT_SUCCESS')).to.have.lengthOf(1);
      const profile = rebuildLearnerModel(history, graph(), { now: '2026-04-01T00:00:00.000Z' });
      const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
      // Explanation-level help weighs more than a hint (medium/2 vs low/1),
      // both recorded against independence with the level preserved.
      expect(state.independence.negativeWeight).to.equal(3);
      expect(state.independence.positiveWeight).to.equal(2);
      expect(state.independence.positiveEvidenceIds).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('maps intervention types to help levels deterministically', () => {
    expect(helpLevelForIntervention('SOCRATIC_QUESTION')).to.equal('socratic');
    expect(helpLevelForIntervention('HINT')).to.equal('hint');
    expect(helpLevelForIntervention('EXPLANATION')).to.equal('explanation');
    expect(helpLevelForIntervention('CONCEPT_REVIEW')).to.equal('explanation');
    expect(helpLevelForIntervention('DEBUGGING_HELP')).to.equal('explanation');
    expect(helpLevelForIntervention('SOLUTION_GUIDANCE')).to.equal('solution');
    expect(helpLevelForIntervention('NONE')).to.equal('none');
    expect(helpLevelForIntervention('ACKNOWLEDGE')).to.equal('none');
    expect(maxHelpLevel([])).to.equal('none');
    const silent = evaluationFixture({ evaluationId: 'eval_s', shouldIntervene: false, interventionType: 'NONE' });
    expect(maxHelpLevel([silent])).to.equal('none');
    const hint = evaluationFixture({ evaluationId: 'eval_h' });
    const solution = evaluationFixture({ evaluationId: 'eval_sol', interventionType: 'SOLUTION_GUIDANCE' });
    expect(maxHelpLevel([hint, solution])).to.equal('solution');
  });

  it('records learner-reported help even with nothing observed (level unknown)', async () => {
    const dir = tmpDir('codesense-test-phase-d-help-unknown');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      await syncAttemptToLearnerModel(p, {
        attempt: attemptFixture('att_u', problem.problemId, 'Got AC with Help', '2026-03-01T00:00:00.000Z'),
        problem,
        classification: classificationFixture(problem),
        evaluations: [],
      });
      const history = await p.evidenceStore.listEvidence();
      const help = history.filter((e) => e.evidenceType === 'HELP_REQUIRED');
      expect(help).to.have.lengthOf(1);
      expect(help[0].helpLevel).to.equal('unknown');
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Updater: recurring mistakes
// ---------------------------------------------------------------------------

describe('Phase D mistake patterns (single vs recurring vs resolved)', () => {
  function mistakeRecord(n: number, at: string, attemptId: string) {
    return extractMistakeEvidence(graph(), {
      category: 'forgot-visited-marking',
      entityIds: [BFS],
      dimension: 'implementation',
      observation: `Forgot visited marking (sighting ${n}).`,
      attemptId,
      problemId: 'prob_1',
      timestamp: at,
      confidence: 'medium',
    })!;
  }

  it('treats one sighting as a fact, two as a pattern', async () => {
    const dir = tmpDir('codesense-test-phase-d-mistakes');
    clean(dir);
    try {
      const p = ports(dir);
      await syncRecordsToLearnerModel(p, [mistakeRecord(1, '2026-03-01T00:00:00.000Z', 'att_1')]);
      let profile = await p.modelStore.loadProfile();
      expect(profile!.recurringMistakes).to.have.lengthOf(1);
      expect(profile!.recurringMistakes[0].status).to.equal('single');
      expect(profile!.recurringMistakes[0].confidence).to.equal('low');
      expect(getRecurringMistakes(profile!)).to.deep.equal([]);
      await syncRecordsToLearnerModel(p, [mistakeRecord(2, '2026-03-02T00:00:00.000Z', 'att_2')]);
      profile = await p.modelStore.loadProfile();
      const pattern = profile!.recurringMistakes[0];
      expect(pattern.status).to.equal('recurring');
      expect(pattern.confidence).to.equal('medium');
      expect(pattern.occurrences).to.have.lengthOf(2);
      expect(pattern.resolvedAt).to.be.null;
      expect(pattern.mistakeId).to.equal(mistakeIdFor('forgot-visited-marking', [BFS]));
      expect(getRecurringMistakes(profile!)).to.have.lengthOf(1);
      expect(getRecurringMistakes(profile!, 'topic.graphs')).to.deep.equal([]);
      expect(getRecurringMistakes(profile!, BFS)).to.have.lengthOf(1);
    } finally {
      clean(dir);
    }
  });

  it('resolves after sustained clean work and reopens on relapse', async () => {
    const dir = tmpDir('codesense-test-phase-d-mistake-resolve');
    clean(dir);
    try {
      const p = ports(dir);
      await syncRecordsToLearnerModel(p, [
        mistakeRecord(1, '2026-03-01T00:00:00.000Z', 'att_1'),
        mistakeRecord(2, '2026-03-02T00:00:00.000Z', 'att_2'),
      ]);
      // Two later implementation successes in the same area.
      await syncRecordsToLearnerModel(p, [
        ev({ timestamp: '2026-03-03T00:00:00.000Z', evidenceId: 'ev_clean_1', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', attemptId: 'att_3' }),
        ev({ timestamp: '2026-03-04T00:00:00.000Z', evidenceId: 'ev_clean_2', evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'medium', attemptId: 'att_4' }),
      ]);
      let profile = await p.modelStore.loadProfile();
      let pattern = profile!.recurringMistakes[0];
      expect(pattern.status).to.equal('resolved');
      expect(pattern.resolvedAt).to.equal('2026-03-04T00:00:00.000Z');
      expect(pattern.occurrences).to.have.lengthOf(2);
      expect(getRecurringMistakes(profile!)).to.deep.equal([]);
      expect(getRecurringMistakes(profile!, undefined, true)).to.have.lengthOf(1);
      // Relapse reopens with full history intact.
      await syncRecordsToLearnerModel(p, [mistakeRecord(3, '2026-03-05T00:00:00.000Z', 'att_5')]);
      profile = await p.modelStore.loadProfile();
      pattern = profile!.recurringMistakes[0];
      expect(pattern.status).to.equal('recurring');
      expect(pattern.resolvedAt).to.be.null;
      expect(pattern.occurrences).to.have.lengthOf(3);
      expect(pattern.confidence).to.equal('high');
    } finally {
      clean(dir);
    }
  });

  it('uses stable mistake ids per category and entity set', () => {
    expect(mistakeIdFor('off-by-one', [BFS])).to.equal(mistakeIdFor('off-by-one', [BFS]));
    expect(mistakeIdFor('off-by-one', [BFS])).to.not.equal(mistakeIdFor('off-by-one', [GRID_BFS]));
    expect(mistakeIdFor('off-by-one', [BFS])).to.not.equal(mistakeIdFor('wrong-base-case', [BFS]));
    expect(mistakeIdFor('off-by-one', [GRID_BFS, BFS])).to.equal(mistakeIdFor('off-by-one', [BFS, GRID_BFS]));
  });
});

// ---------------------------------------------------------------------------
// Trajectory, queries, and the Phase E surface
// ---------------------------------------------------------------------------

describe('Phase D trajectory and queries', () => {
  async function progressingHistory(): Promise<{ dir: string; entityId: string }> {
    const dir = tmpDir('codesense-test-phase-d-trajectory');
    clean(dir);
    const p = ports(dir);
    const problem = problemFixture();
    const classification = classificationFixture(problem);
    const endings: Array<{ id: string; state: Attempt['currentState']; at: string }> = [
      { id: 'att_t1', state: 'Got WA', at: '2026-03-01T00:00:00.000Z' },
      { id: 'att_t2', state: 'Got WA', at: '2026-03-02T00:00:00.000Z' },
      { id: 'att_t3', state: 'Got AC with Help', at: '2026-03-03T00:00:00.000Z' },
      { id: 'att_t4', state: 'Got AC Independently', at: '2026-03-04T00:00:00.000Z' },
    ];
    for (const ending of endings) {
      await syncAttemptToLearnerModel(p, {
        attempt: attemptFixture(ending.id, problem.problemId, ending.state, ending.at),
        problem,
        classification,
        evaluations: [],
      });
    }
    return { dir, entityId: BFS };
  }

  it('records chronological struggle → improvement → success transitions', async () => {
    const { dir, entityId } = await progressingHistory();
    try {
      const p = ports(dir);
      const profile = (await p.modelStore.loadProfile())!;
      const history = await p.evidenceStore.listEvidence();
      const trajectory = getLearnerTrajectory(profile, history, entityId);
      expect(trajectory.entityId).to.equal(entityId);
      expect(trajectory.state).to.not.be.null;
      expect(trajectory.entries.length).to.be.greaterThan(2);
      const times = trajectory.entries.map((e) => e.at);
      expect([...times].sort()).to.deep.equal(times);
      // Every transition cites the evidence that caused it.
      for (const entry of trajectory.entries) {
        expect(entry.evidenceIds.length).to.be.greaterThan(0);
      }
      // Evidence behind the trajectory is fully retrievable.
      expect(trajectory.evidence.length).to.be.greaterThan(0);
      expect(trajectory.evidence.every((e) => e.entityIds.includes(entityId))).to.be.true;
      // Improvement after March 2nd is detectable (the t3/t4 turnarounds).
      expect(getRecentlyImprovedEntities(profile, '2026-03-02T00:00:00.000Z')).to.include(entityId);
      // Nothing improved after the whole window.
      expect(getRecentlyImprovedEntities(profile, '2026-03-04T00:00:00.000Z')).to.deep.equal([]);
      // Unknown entities yield empty trajectories, never errors.
      // (topic.graphs genuinely has exposure here, so use a never-seen id.)
      const empty = getLearnerTrajectory(profile, history, 'framework.never-seen');
      expect(empty.state).to.be.null;
      expect(empty.entries).to.deep.equal([]);
    } finally {
      clean(dir);
    }
  });

  it('answers the standard Phase E questions', async () => {
    const { dir, entityId } = await progressingHistory();
    try {
      const p = ports(dir);
      const profile = (await p.modelStore.loadProfile())!;
      const history = await p.evidenceStore.listEvidence();
      expect(getLearnerKnowledge(profile, entityId)).to.not.be.null;
      expect(getLearnerKnowledge(profile, 'framework.never-seen')).to.be.null;
      expect(getLearnerKnowledgeForEntities(profile, [entityId, 'framework.never-seen'])[0]).to.not.be.null;
      expect(getLearnerKnowledgeForEntities(profile, [entityId, 'framework.never-seen'])[1]).to.be.null;
      const forEntity = getEvidenceForEntity(history, entityId);
      expect(forEntity.length).to.be.greaterThan(0);
      const times = forEntity.map((e) => e.timestamp);
      expect([...times].sort()).to.deep.equal(times);
      const recent = getRecentEvidence(history, entityId, 2);
      expect(recent).to.have.lengthOf(2);
      // Newest-first (ties possible: one attempt emits a same-stamp batch).
      expect(recent[0].timestamp.localeCompare(recent[1].timestamp)).to.be.greaterThan(-1);
      expect(getRecentEvidence(history, null, 1000).length).to.equal(history.length);
      const summary = getLearnerSummary(profile);
      expect(summary.totalEvidence).to.equal(history.length);
      expect(summary.entitiesTracked).to.be.greaterThan(0);
      expect(summary.byStatus.developing + summary.byStatus.demonstrated + summary.byStatus.strong)
        .to.be.greaterThan(0);
      expect(summary.ontologyVersion).to.equal(graph().ontologyVersion);
      expect(summary.updatedAt).to.equal('2026-04-01T00:00:00.000Z');
    } finally {
      clean(dir);
    }
  });

  it('flags weak or uncertain entities for attention', () => {
    const profile = rebuildLearnerModel(
      [
        ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_w1', entityIds: [BFS], evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
        ev({ timestamp: '2026-03-01T00:00:02.000Z', evidenceId: 'ev_w2', entityIds: [BFS], evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
        ev({ timestamp: '2026-03-01T00:00:03.000Z', evidenceId: 'ev_w3', entityIds: [BFS], evidenceType: 'IMPLEMENTATION_FAILURE', confidence: 'low' }),
        ev({ timestamp: '2026-03-01T00:00:04.000Z', evidenceId: 'ev_w4', entityIds: [GRID_BFS], evidenceType: 'IMPLEMENTATION_SUCCESS', confidence: 'low' }),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const weak = getWeakOrUncertainEntities(profile);
    expect(weak.map((s) => s.entityId)).to.include(BFS);
    expect(weak[0].entityId).to.equal(BFS);
    expect(weak.map((s) => s.entityId)).to.include(GRID_BFS);
  });
});

// ---------------------------------------------------------------------------
// Phase C integration: classification → evidence
// ---------------------------------------------------------------------------

describe('Phase D Phase C integration (problem knowledge ≠ learner ability)', () => {
  it('derives exposure from classification without claiming ability', async () => {
    const dir = tmpDir('codesense-test-phase-d-integration');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const classification = classificationFixture(problem);
      const outcome = await syncAttemptToLearnerModel(p, {
        attempt: attemptFixture('att_i1', problem.problemId, 'Got AC Independently', '2026-03-01T00:00:00.000Z'),
        problem,
        classification,
        evaluations: [],
      });
      expect(outcome.error).to.be.undefined;
      expect(outcome.stored).to.be.greaterThan(0);
      const history = await p.evidenceStore.listEvidence();
      const exposure = history.filter((e) => e.evidenceType === 'EXPOSURE');
      expect(exposure).to.have.lengthOf(1);
      // Exposure spans every classified bucket (encountered = encountered)…
      expect(exposure[0].entityIds).to.include(GRAPH_TOPIC);
      expect(exposure[0].entityIds).to.include(VISITED);
      expect(exposure[0].entityIds).to.include(QUEUE_FIFO);
      // …while ability claims stay scoped off topics/tactics/prerequisites.
      for (const record of history.filter((e) => e.evidenceType !== 'EXPOSURE')) {
        expect(record.entityIds).to.not.include(GRAPH_TOPIC);
        expect(record.entityIds).to.not.include(VISITED);
        expect(record.entityIds).to.not.include(QUEUE_FIFO);
      }
      const profile = rebuildLearnerModel(history, graph(), { now: '2026-04-01T00:00:00.000Z' });
      // Topics are encounter context: tracked, never ability-graded.
      expect(profile.knowledgeStates.find((s) => s.entityId === GRAPH_TOPIC)!.status).to.equal('exposed');
    } finally {
      clean(dir);
    }
  });

  it('refuses to invent entities: unclassified problems yield no evidence', async () => {
    const dir = tmpDir('codesense-test-phase-d-unclassified');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const outcome = await syncAttemptToLearnerModel(p, {
        attempt: attemptFixture('att_u1', problem.problemId, 'Got AC Independently', '2026-03-01T00:00:00.000Z'),
        problem,
        classification: null,
        evaluations: [],
      });
      expect(outcome.stored).to.equal(0);
      expect(await p.evidenceStore.countEvidence()).to.equal(0);
      expect((await p.modelStore.loadProfile())!.knowledgeStates).to.deep.equal([]);
    } finally {
      clean(dir);
    }
  });

  it('degrades gracefully on classifications referencing unknown entities', () => {
    const problem = problemFixture();
    const good = classificationFixture(problem);
    const dirty: ProblemClassification = {
      ...good,
      topics: [{ entityId: 'topic.lost-in-space', confidence: 'high' }],
    };
    const records = extractAttemptEvidence(graph(), {
      attempt: attemptFixture('att_d1', problem.problemId, 'Got WA', '2026-03-01T00:00:00.000Z'),
      problem,
      classification: dirty,
      evaluations: [],
    });
    // Exposure (tainted by the unknown id) drops out; honest outcome stays.
    expect(records.some((r) => r.evidenceType === 'EXPOSURE')).to.be.false;
    expect(records.some((r) => r.evidenceType === 'IMPLEMENTATION_FAILURE')).to.be.true;
    for (const record of records) {
      expect(record.entityIds).to.not.include('topic.lost-in-space');
    }
  });
});

// ---------------------------------------------------------------------------
// AI boundary: grounded hypotheses only, silence is not evidence
// ---------------------------------------------------------------------------

describe('Phase D AI integration boundary (CodeSense owns the model)', () => {
  function syncEval(dir: string, evaluation: AIEvaluation) {
    const p = ports(dir);
    const problem = problemFixture();
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    return syncEvaluationToLearnerModel(p, {
      evaluation,
      attempt,
      classification: classificationFixture(problem),
    }).then(async (outcome) => ({ outcome, history: await p.evidenceStore.listEvidence() }));
  }

  it('ignores silent evaluations entirely', async () => {
    const dir = tmpDir('codesense-test-phase-d-ai-silent');
    clean(dir);
    try {
      const silent = evaluationFixture({
        evaluationId: 'eval_silent',
        shouldIntervene: false,
        interventionType: 'NONE',
        message: '',
        requiresLearnerResponse: false,
        diagnosis: {
          observedEvidence: [],
          hypothesis: '',
          confidence: 'low',
          unknowns: [],
          recommendedInteraction: 'NONE' as const,
        },
      });
      const { outcome, history } = await syncEval(dir, silent);
      expect(outcome.stored).to.equal(0);
      expect(history).to.deep.equal([]);
    } finally {
      clean(dir);
    }
  });

  it('requires observed evidence before a hypothesis becomes evidence', async () => {
    const dir = tmpDir('codesense-test-phase-d-ai-ungrounded');
    clean(dir);
    try {
      const ungrounded = evaluationFixture({
        evaluationId: 'eval_ungrounded',
        diagnosis: {
          ...evaluationFixture().diagnosis,
          observedEvidence: [],
        },
      });
      const { outcome, history } = await syncEval(dir, ungrounded);
      expect(outcome.stored).to.equal(0);
      expect(history).to.deep.equal([]);
    } finally {
      clean(dir);
    }
  });

  it('caps AI confidence and localizes by recommended interaction', async () => {
    const dir = tmpDir('codesense-test-phase-d-ai-grounded');
    clean(dir);
    try {
      const confident = evaluationFixture({
        evaluationId: 'eval_conf',
        diagnosis: {
          ...evaluationFixture().diagnosis,
          confidence: 'high',
          recommendedInteraction: 'DEBUGGING_HELP' as const,
        },
      });
      const { history } = await syncEval(dir, confident);
      expect(history).to.have.lengthOf(1);
      expect(history[0].evidenceType).to.equal('DEBUGGING_FAILURE');
      // High coach confidence is capped: hypotheses stay hypotheses.
      expect(history[0].confidence).to.equal('medium');
      expect(history[0].provenance.sourceId).to.equal('eval_conf');
      expect(history[0].provenance.source).to.equal('ai-diagnosis');
      const concept = evaluationFixture({
        evaluationId: 'eval_concept',
        interventionType: 'CONCEPT_REVIEW',
        diagnosis: {
          ...evaluationFixture().diagnosis,
          confidence: 'medium',
          recommendedInteraction: 'CONCEPT_REVIEW' as const,
        },
      });
      const dir2 = tmpDir('codesense-test-phase-d-ai-grounded-2');
      clean(dir2);
      try {
        const second = await syncEval(dir2, concept);
        expect(second.history).to.have.lengthOf(1);
        expect(second.history[0].evidenceType).to.equal('CONCEPTUAL_CONFUSION');
      } finally {
        clean(dir2);
      }
    } finally {
      clean(dir);
    }
  });

  it('makes no localizable claim for socratic turns', async () => {
    const dir = tmpDir('codesense-test-phase-d-ai-socratic');
    clean(dir);
    try {
      const problem = problemFixture();
      const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
      const classification = classificationFixture(problem);
      const socratic = evaluationFixture({
        evaluationId: 'eval_soc',
        interventionType: 'SOCRATIC_QUESTION',
        diagnosis: {
          ...evaluationFixture().diagnosis,
          recommendedInteraction: 'SOCRATIC_QUESTION' as const,
        },
      });
      // Pure extractor first: no evidence, and unclassified → nothing either.
      expect(extractEvaluationEvidence(graph(), { evaluation: socratic, attempt, classification })).to.deep.equal([]);
      expect(
        extractEvaluationEvidence(graph(), { evaluation: socratic, attempt, classification: null }),
      ).to.deep.equal([]);
      const { outcome, history } = await syncEval(dir, socratic);
      expect(outcome.stored).to.equal(0);
      expect(history).to.deep.equal([]);
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Conversation + recognition + mistakes: explicit APIs
// ---------------------------------------------------------------------------

describe('Phase D explicit evidence APIs (conversation, recognition, mistakes)', () => {
  function replyContext() {
    const problem = problemFixture();
    const message = {
      messageId: 'amsg_1',
      attemptId: 'att_1',
      timestamp: '2026-03-01T00:05:00.000Z',
      role: 'learner' as const,
      text: 'I know BFS, I just forgot how the queue API works here.',
    };
    const attempt = attemptFixture('att_1', problem.problemId, 'In Progress', '2026-03-01T00:00:00.000Z');
    return { problem, message, attempt, classification: classificationFixture(problem) };
  }

  it('assesses replies explicitly, never by parsing', () => {
    const { message, attempt, classification } = replyContext();
    const understood = extractReplyEvidence(graph(), {
      message, attempt, classification, assessment: 'demonstrates-understanding',
    });
    expect(understood).to.have.lengthOf(1);
    expect(understood[0].evidenceType).to.equal('CONCEPTUAL_SUCCESS');
    expect(understood[0].confidence).to.equal('medium');
    const confused = extractReplyEvidence(graph(), {
      message, attempt, classification, assessment: 'shows-confusion',
    });
    expect(confused[0].evidenceType).to.equal('CONCEPTUAL_CONFUSION');
    const friction = extractReplyEvidence(graph(), {
      message, attempt, classification, assessment: 'reports-implementation-friction',
    });
    expect(friction).to.have.lengthOf(1);
    expect(friction[0].evidenceType).to.equal('CONCEPTUAL_SUCCESS');
    expect(friction[0].confidence).to.equal('low');
    expect(friction[0].interpretation).to.contain('NO implementation claim');
    // Receipts are not knowledge: neutral assessments store nothing.
    expect(
      extractReplyEvidence(graph(), { message, attempt, classification, assessment: 'acknowledgement' }),
    ).to.deep.equal([]);
    expect(
      extractReplyEvidence(graph(), { message, attempt, classification, assessment: 'unassessable' }),
    ).to.deep.equal([]);
  });

  it('records recognition hits and misses without conflating them', () => {
    const hit = extractRecognitionEvidence(graph(), {
      entityIds: [BFS],
      verdict: 'recognized',
      observation: 'Learner named BFS before any hint.',
      attemptId: 'att_1',
      problemId: 'prob_1',
      timestamp: '2026-03-01T00:00:00.000Z',
    })!;
    expect(hit.evidenceType).to.equal('RECOGNITION');
    const profile = rebuildLearnerModel([hit], graph(), { now: '2026-04-01T00:00:00.000Z' });
    const state = profile.knowledgeStates.find((s) => s.entityId === BFS)!;
    expect(state.recognition.positiveEvidenceIds).to.deep.equal([hit.evidenceId]);
    expect(state.conceptual.level).to.equal('UNKNOWN');
    const miss = extractRecognitionEvidence(graph(), {
      entityIds: [BFS],
      verdict: 'missed',
      observation: 'Learner tried DFS on a shortest-path grid.',
      attemptId: 'att_2',
      problemId: 'prob_2',
      timestamp: '2026-03-02T00:00:00.000Z',
    })!;
    expect(miss.evidenceType).to.equal('CONCEPTUAL_CONFUSION');
  });

  it('builds mistake evidence with open-vocabulary categories', () => {
    const record = extractMistakeEvidence(graph(), {
      category: 'forgot-visited-marking',
      entityIds: [BFS, GRID_BFS],
      observation: 'Visited set omitted on a grid BFS.',
      attemptId: 'att_1',
      problemId: 'prob_1',
      timestamp: '2026-03-01T00:00:00.000Z',
    })!;
    expect(record.evidenceType).to.equal('RECURRING_MISTAKE');
    expect(record.mistakeCategory).to.equal('forgot-visited-marking');
    expect(record.dimension).to.equal('implementation');
    // Free-form categories are rejected at the boundary, not normalized.
    expect(
      extractMistakeEvidence(graph(), {
        category: 'Forgot visited!!!',
        entityIds: [BFS],
        observation: 'x',
        timestamp: '2026-03-01T00:00:00.000Z',
      }),
    ).to.be.null;
    expect(
      extractMistakeEvidence(graph(), {
        category: 'off-by-one',
        entityIds: ['nope.nope'],
        observation: 'x',
        timestamp: '2026-03-01T00:00:00.000Z',
      }),
    ).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// Persistence: profiles round-trip, history rebuilds state
// ---------------------------------------------------------------------------

describe('Phase D persistence (local, rebuildable)', () => {
  it('round-trips evidence and profile through disk', async () => {
    const dir = tmpDir('codesense-test-phase-d-persist');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      await syncAttemptToLearnerModel(p, {
        attempt: attemptFixture('att_p1', problem.problemId, 'Got AC Independently', '2026-03-01T00:00:00.000Z'),
        problem,
        classification: classificationFixture(problem),
        evaluations: [],
      });
      const evidence = await p.evidenceStore.listEvidence();
      const profile = await p.modelStore.loadProfile();
      expect(profile).to.not.be.null;
      // Fresh stores over the same directory see identical state.
      const q = ports(dir);
      expect(await q.evidenceStore.listEvidence()).to.deep.equal(evidence);
      expect(await q.modelStore.loadProfile()).to.deep.equal(profile);
      // Evidence history rebuilds the saved derived state exactly.
      const rebuilt = rebuildLearnerModel(await q.evidenceStore.listEvidence(), graph(), {
        now: '2026-04-01T00:00:00.000Z',
        previous: profile,
      });
      expect({ ...rebuilt, createdAt: profile!.createdAt }).to.deep.equal({
        ...profile,
        createdAt: profile!.createdAt,
      });
    } finally {
      clean(dir);
    }
  });

  it('recovers from corrupt or missing model files without touching evidence', async () => {
    const dir = tmpDir('codesense-test-phase-d-corrupt');
    clean(dir);
    try {
      const p = ports(dir);
      expect(await p.modelStore.loadProfile()).to.be.null;
      await p.evidenceStore.appendEvidence(
        ev({ timestamp: '2026-03-01T00:00:01.000Z', evidenceId: 'ev_keep' }),
      );
      const file = path.join(dir, '.codesense', 'learner-model.json');
      fs.writeFileSync(file, JSON.stringify([{ garbage: true }]));
      expect(await p.modelStore.loadProfile()).to.be.null;
      // Evidence survives; the profile rebuilds from it.
      expect(await p.evidenceStore.countEvidence()).to.equal(1);
      const rebuilt = rebuildLearnerModel(await p.evidenceStore.listEvidence(), graph(), {
        now: '2026-04-01T00:00:00.000Z',
      });
      expect(rebuilt.totalEvidenceCount).to.equal(1);
      // Malformed profiles are refused at the write boundary too.
      let threw = false;
      try {
        await p.modelStore.saveProfile({ nope: true } as unknown as never);
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    } finally {
      clean(dir);
    }
  });

  it('fails open on store errors (sync outcomes, never throws)', async () => {
    const brokenEvidence = {
      appendEvidence: async () => {
        throw new Error('disk gone');
      },
      appendEvidenceBatch: async () => {
        throw new Error('disk gone');
      },
      listEvidence: async () => {
        throw new Error('disk gone');
      },
      listEvidenceForEntity: async () => {
        throw new Error('disk gone');
      },
      countEvidence: async () => {
        throw new Error('disk gone');
      },
    } as unknown as EvidenceStore;
    const dir = tmpDir('codesense-test-phase-d-failopen');
    clean(dir);
    try {
      const p = ports(dir);
      const problem = problemFixture();
      const outcome = await syncAttemptToLearnerModel(
        { ...p, evidenceStore: brokenEvidence },
        {
          attempt: attemptFixture('att_f1', problem.problemId, 'Got WA', '2026-03-01T00:00:00.000Z'),
          problem,
          classification: classificationFixture(problem),
          evaluations: [],
        },
      );
      expect(outcome.stored).to.equal(0);
      expect(outcome.error).to.contain('disk gone');
    } finally {
      clean(dir);
    }
  });

  it('parses stored profiles strictly but tolerantly', () => {
    expect(parseLearnerProfile(null)).to.be.null;
    expect(parseLearnerProfile({})).to.be.null;
    const profile = emptyLearnerProfile('2026-04-01T00:00:00.000Z', graph());
    expect(parseLearnerProfile(JSON.parse(JSON.stringify(profile)) as unknown)).to.deep.equal(profile);
    expect(parseLearnerProfile({ ...profile, knowledgeStates: [{ bad: true }] })).to.be.null;
    expect(parseLearnerProfile({ ...profile, recurringMistakes: [{ bad: true }] })).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// Learner-context notes: bounded, honest, no fake precision
// ---------------------------------------------------------------------------

describe('Phase D coach digest (LearnerContext.notes)', () => {
  it('stays empty for a fresh learner (pre-Phase-D default preserved)', () => {
    const profile = emptyLearnerProfile('2026-04-01T00:00:00.000Z', graph());
    expect(buildLearnerNotesForPrompt(profile)).to.deep.equal([]);
  });

  it('summarizes beliefs with counts, caps length, avoids verdicts', () => {
    const profile = rebuildLearnerModel(
      [
        ...[1, 2, 3].map((n) =>
          ev({
            timestamp: `2026-03-0${n}T00:00:00.000Z`,
            evidenceId: `ev_s_${n}`,
            entityIds: [BFS],
            evidenceType: 'IMPLEMENTATION_FAILURE',
            confidence: 'low',
          }),
        ),
        ...[4, 5, 6].map((n) =>
          ev({
            timestamp: `2026-03-0${n}T00:00:00.000Z`,
            evidenceId: `ev_i_${n}`,
            entityIds: [GRID_BFS],
            evidenceType: 'INDEPENDENT_SUCCESS',
            confidence: 'medium',
            helpLevel: 'none',
            problemId: `prob_${n}`,
          }),
        ),
      ],
      graph(),
      { now: '2026-04-01T00:00:00.000Z' },
    );
    const notes = buildLearnerNotesForPrompt(profile);
    expect(notes.length).to.be.greaterThan(0);
    expect(notes.length).to.be.lessThanOrEqual(8);
    const joined = notes.join('\n');
    expect(joined).to.contain(BFS);
    expect(joined).to.contain(GRID_BFS);
    for (const note of notes) {
      expect(note.length).to.be.lessThanOrEqual(160);
    }
    // No fake precision, no verdicts, no mastery vocabulary.
    expect(joined).to.not.contain('%');
    expect(joined).to.not.match(/\bmastery\b/i);
    expect(joined).to.not.match(/\bweak\b/i);
  });
});
