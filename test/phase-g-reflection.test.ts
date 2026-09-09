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
import { validateLearnerEvidence } from 'codesense/learner/learnerEvidence';
import type { LearnerEvidence } from 'codesense/learner/learnerEvidence';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from 'codesense/learner/learnerModelStore';
import {
  REFLECTION_CATEGORIES,
  createReflectionOffer,
  dismissReflection,
  isKnownReflectionCategory,
  markReflectionEmitted,
  parseReflection,
  reflectionIdForAttempt,
  respondToReflection,
  truncateReflectionText,
  validateReflectionInterpretation,
} from 'codesense/reflection/reflectionTypes';
import { LocalReflectionStore } from 'codesense/reflection/reflectionStore';
import { extractReflectionEvidence } from 'codesense/reflection/reflectionEvidence';
import {
  dismissReflectionOffer,
  offerReflectionForAttemptEnd,
  submitReflectionResponse,
} from 'codesense/reflection/reflectionChain';
import {
  FakeReflectionStructuringReasoner,
  proposeReflectionInterpretation,
  validateReflectionAiCandidate,
} from 'codesense/reflection/reflectionPrompt';

/**
 * Phase G — Structured Reflection (deterministic path, no AI).
 *
 * Pins: explicit learner input is preserved distinctly from AI/telemetry
 * observation; only validated explicit input becomes `human-curated`
 * evidence; one reflection per attempt with exact attempt/problem
 * provenance; duplicate/reload/stale handling; idempotent emission.
 */

const BFS = 'framework.bfs';
const MULTI_BFS = 'form.multisource-bfs';
const GRAPH_TOPIC = 'topic.graphs';
const CONNECTED = 'concept.connected-components';
const QUEUE_FIFO = 'concept.queue-fifo';
const VISITED = 'tactic.visited-on-enqueue';
const DIST_PROP = 'pattern.distance-time-propagation';

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

function problemFixture(url: string, title: string): Problem {
  return createManualProblem(url, { title, statement: `${title} statement.` });
}

function classificationFixture(problem: Problem): ProblemClassification {
  const validated = validateClassificationPayload(
    {
      topics: [{ entityId: GRAPH_TOPIC, confidence: 'high' }],
      concepts: [
        { entityId: CONNECTED, confidence: 'medium' },
        { entityId: QUEUE_FIFO, confidence: 'high' },
      ],
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

function aiObservationEvidence(attempt: Attempt): LearnerEvidence {
  const raw = {
    evidenceId: 'ev_ai_obs_1',
    schemaVersion: 1,
    timestamp: '2026-03-01T00:05:00.000Z',
    sessionId: 'ses_1',
    attemptId: attempt.attemptId,
    problemId: attempt.problemId,
    entityIds: [BFS],
    evidenceType: 'DEBUGGING_FAILURE',
    source: 'ai-diagnosis',
    observation: 'Coach grounded a DEBUGGING_HELP in: queue re-created inside the loop.',
    interpretation: 'Uncertain debugging-difficulty hypothesis.',
    confidence: 'medium',
    provenance: { source: 'ai-diagnosis', sourceId: 'eval_1' },
  };
  const parsed = validateLearnerEvidence(raw, { graph: graph() });
  if (!parsed) {
    throw new Error('ai observation fixture must validate');
  }
  return parsed;
}

describe('Phase G reflection types', () => {
  it('exposes exactly the six approved categories', () => {
    expect([...REFLECTION_CATEGORIES].sort()).to.deep.equal(
      [
        'debugging-mistake',
        'did-not-recognize-pattern',
        'knew-idea-struggled-implement',
        'other',
        'understood-after-hint',
        'unsure-why-worked',
      ].sort(),
    );
  });

  it('creates deterministic reflection ids per attempt', () => {
    expect(reflectionIdForAttempt('att_1')).to.equal('refl_att_1');
    expect(reflectionIdForAttempt('att_1')).to.equal(reflectionIdForAttempt('att_1'));
    expect(reflectionIdForAttempt('att_1')).to.not.equal(reflectionIdForAttempt('att_2'));
  });

  it('runs the offered -> responded -> evidence-emitted lifecycle', () => {
    const now = '2026-05-01T00:00:00.000Z';
    const offered = createReflectionOffer({
      attemptId: 'att_1',
      problemId: 'prob_1',
      sessionId: 'ses_1',
      problemTitle: 'Rotting Oranges',
      classificationStatus: 'classified',
      now,
    });
    expect(offered.status).to.equal('offered');
    expect(offered.category).to.equal(null);
    const responded = respondToReflection(offered, {
      category: 'debugging-mistake',
      freeText: ' forgot visited ',
      now: '2026-05-01T00:01:00.000Z',
    });
    expect(responded.status).to.equal('responded');
    expect(responded.freeText).to.equal('forgot visited');
    const emitted = markReflectionEmitted(responded, {
      evidenceIds: ['ev_1'],
      interpretation: null,
      now: '2026-05-01T00:02:00.000Z',
    });
    expect(emitted.status).to.equal('evidence-emitted');
    expect(emitted.evidenceIds).to.deep.equal(['ev_1']);
  });

  it('rejects invalid transitions by throwing', () => {
    const offered = createReflectionOffer({
      attemptId: 'att_1',
      problemId: 'prob_1',
      sessionId: null,
      problemTitle: null,
      classificationStatus: 'unclassified',
      now: '2026-05-01T00:00:00.000Z',
    });
    expect(() => dismissReflection(markReflectionEmitted(
      respondToReflection(offered, { category: 'other', now: '2026-05-01T00:01:00.000Z' }),
      { evidenceIds: [], interpretation: null, now: '2026-05-01T00:02:00.000Z' },
    ), '2026-05-01T00:03:00.000Z')).to.throw();
    expect(() =>
      respondToReflection(offered, { category: 'bogus' as never, now: '2026-05-01T00:01:00.000Z' }),
    ).to.throw();
    expect(isKnownReflectionCategory('bogus')).to.equal(false);
  });

  it('truncates long free text instead of rejecting it', () => {
    expect(truncateReflectionText('  hi  ')).to.equal('hi');
    const long = truncateReflectionText('x'.repeat(600));
    expect(long.length).to.be.lessThanOrEqual(500);
  });

  it('round-trips through lenient parse and drops bad rows', () => {
    const offered = createReflectionOffer({
      attemptId: 'att_1',
      problemId: 'prob_1',
      sessionId: 'ses_1',
      problemTitle: 'T',
      classificationStatus: 'classified',
      goalId: 'goal_1',
      planId: null,
      progressSignal: 'IMPROVING',
      now: '2026-05-01T00:00:00.000Z',
    });
    expect(parseReflection(JSON.parse(JSON.stringify(offered)))).to.deep.equal(offered);
    expect(parseReflection({ nope: true })).to.equal(null);
    expect(parseReflection({ ...offered, status: 'bogus' })).to.equal(null);
    expect(parseReflection({ ...offered, category: 'bogus' })).to.equal(null);
  });

  it('validates interpretations deterministically (graph-checked, capped, gated)', () => {
    const g = graph();
    // Valid deterministic interpretation.
    expect(
      validateReflectionInterpretation(
        {
          entityIds: [BFS],
          dimension: 'implementation',
          evidenceType: 'RECURRING_MISTAKE',
          mistakeCategory: 'forgot-visited-marking',
          confidence: 'medium',
          aiAssisted: false,
          learnerConfirmed: false,
        },
        { graph: g },
      ),
    ).to.not.equal(null);
    // Unknown entity rejected.
    expect(
      validateReflectionInterpretation(
        {
          entityIds: ['framework.does-not-exist'],
          dimension: 'conceptual',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'low',
          aiAssisted: false,
          learnerConfirmed: false,
        },
        { graph: g },
      ),
    ).to.equal(null);
    // High confidence capped (rejected).
    expect(
      validateReflectionInterpretation(
        {
          entityIds: [BFS],
          dimension: 'conceptual',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'high',
          aiAssisted: false,
          learnerConfirmed: false,
        },
        { graph: g },
      ),
    ).to.equal(null);
    // Unconfirmed AI proposal rejected.
    expect(
      validateReflectionInterpretation(
        {
          entityIds: [BFS],
          dimension: 'conceptual',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'low',
          aiAssisted: true,
          learnerConfirmed: false,
        },
        { graph: g },
      ),
    ).to.equal(null);
    // Non-emittable type rejected.
    expect(
      validateReflectionInterpretation(
        {
          entityIds: [BFS],
          dimension: 'implementation',
          evidenceType: 'IMPLEMENTATION_SUCCESS',
          confidence: 'low',
          aiAssisted: false,
          learnerConfirmed: false,
        },
        { graph: g },
      ),
    ).to.equal(null);
  });
});

describe('Phase G reflection store', () => {
  it('persists, round-trips, and looks up by attempt', async () => {
    const dir = tmpDir('codesense-g-store-1');
    clean(dir);
    const store = new LocalReflectionStore(dir);
    const offer = createReflectionOffer({
      attemptId: 'att_store_1',
      problemId: 'prob_store_1',
      sessionId: 'ses_1',
      problemTitle: 'P',
      classificationStatus: 'classified',
      now: '2026-05-01T00:00:00.000Z',
    });
    await store.upsertReflection(offer);
    expect(await store.getReflection(offer.reflectionId)).to.deep.equal(offer);
    expect(await store.getReflectionForAttempt('att_store_1')).to.deep.equal(offer);
    expect(await store.getReflectionForAttempt('att_missing')).to.equal(null);
    expect(await store.listReflections()).to.have.length(1);
    clean(dir);
  });

  it('refuses malformed writes and skips corrupt rows on read', async () => {
    const dir = tmpDir('codesense-g-store-2');
    clean(dir);
    const store = new LocalReflectionStore(dir);
    let threw = false;
    try {
      await store.upsertReflection({ nope: true } as never);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    // Hand-written corrupt row must not break loading.
    fs.mkdirSync(path.join(dir, '.codesense'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.codesense', 'reflections.json'),
      JSON.stringify([{ nope: true }], null, 2),
    );
    expect(await store.listReflections()).to.deep.equal([]);
    clean(dir);
  });
});

describe('Phase G deterministic evidence mapping', () => {
  it('maps each concrete category to the expected D type with human-curated provenance', () => {
    const g = graph();
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Rotting Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_map_1', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const cases: Array<{ category: 'knew-idea-struggled-implement' | 'did-not-recognize-pattern' | 'understood-after-hint' | 'debugging-mistake' | 'unsure-why-worked'; type: string }> = [
      { category: 'knew-idea-struggled-implement', type: 'CONCEPTUAL_SUCCESS' },
      { category: 'did-not-recognize-pattern', type: 'CONCEPTUAL_CONFUSION' },
      { category: 'understood-after-hint', type: 'CONCEPTUAL_SUCCESS' },
      { category: 'debugging-mistake', type: 'RECURRING_MISTAKE' },
      { category: 'unsure-why-worked', type: 'CONCEPTUAL_CONFUSION' },
    ];
    for (const c of cases) {
      const records = extractReflectionEvidence(g, {
        reflectionId: 'refl_att_map_1',
        category: c.category,
        freeText: 'I knew BFS but forgot visited.',
        interpretation: null,
        attempt,
        problem,
        classification,
        sessionId: 'ses_1',
        timestamp: '2026-05-01T00:10:00.000Z',
      });
      expect(records, c.category).to.have.length(1);
      const record = records[0]!;
      expect(record.evidenceType).to.equal(c.type);
      expect(record.source).to.equal('human-curated');
      expect(record.provenance).to.deep.equal({ source: 'human-curated', sourceId: 'refl_att_map_1' });
      expect(record.attemptId).to.equal(attempt.attemptId);
      expect(record.problemId).to.equal(problem.problemId);
      expect(record.observation).to.contain('Learner reflection');
      expect(record.observation).to.contain(c.category);
    }
  });

  it('emits nothing for `other` without a confirmed interpretation, and nothing when unclassified', () => {
    const g = graph();
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Rotting Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_map_2', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    expect(
      extractReflectionEvidence(g, {
        reflectionId: 'refl_att_map_2',
        category: 'other',
        freeText: 'Something happened.',
        interpretation: null,
        attempt,
        problem,
        classification,
        sessionId: 'ses_1',
        timestamp: '2026-05-01T00:10:00.000Z',
      }),
    ).to.deep.equal([]);
    expect(
      extractReflectionEvidence(g, {
        reflectionId: 'refl_att_map_2',
        category: 'debugging-mistake',
        freeText: null,
        interpretation: null,
        attempt,
        problem,
        classification: null,
        sessionId: 'ses_1',
        timestamp: '2026-05-01T00:10:00.000Z',
      }),
    ).to.deep.equal([]);
  });

  it('mints stable evidence ids across reprocessing', () => {
    const g = graph();
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Rotting Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_map_3', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const input = {
      reflectionId: 'refl_att_map_3',
      category: 'debugging-mistake' as const,
      freeText: null,
      interpretation: null,
      attempt,
      problem,
      classification,
      sessionId: 'ses_1',
      timestamp: '2026-05-01T00:10:00.000Z',
    };
    const first = extractReflectionEvidence(g, input);
    const second = extractReflectionEvidence(g, { ...input, timestamp: '2026-05-02T00:10:00.000Z' });
    expect(first).to.have.length(1);
    expect(second).to.have.length(1);
    expect(first[0]!.evidenceId).to.equal(second[0]!.evidenceId);
  });
});

describe('Phase G reflection chain', () => {
  it('offers, responds, and emits exactly one human-curated record', async () => {
    const dir = tmpDir('codesense-g-chain-1');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Rotting Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_g1', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const reflectionStore = new LocalReflectionStore(dir);
    const offer = await offerReflectionForAttemptEnd(
      { reflectionStore, nowIso: () => '2026-05-01T00:00:00.000Z' },
      { attempt, problem, classificationStatus: 'classified' },
    );
    expect(offer.action).to.equal('offered');
    const submit = await submitReflectionResponse(
      {
        reflectionStore,
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      { attempt, problem, classification, category: 'debugging-mistake', freeText: 'forgot visited' },
    );
    expect(submit.action).to.equal('emitted');
    if (submit.action !== 'emitted') {
      throw new Error('expected emitted');
    }
    expect(submit.stored).to.equal(1);
    const evidence = await new LocalLearnerEvidenceStore(dir).listEvidence();
    expect(evidence).to.have.length(1);
    expect(evidence[0]!.source).to.equal('human-curated');
    expect(evidence[0]!.provenance.sourceId).to.equal('refl_att_g1');
    clean(dir);
  });

  it('keeps consecutive attempts A/B isolated (either response order)', async () => {
    const dir = tmpDir('codesense-g-chain-ab');
    clean(dir);
    const problemA = problemFixture('https://leetcode.com/problems/number-of-islands/', 'Islands');
    const problemB = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classA = classificationFixture(problemA);
    const classB = classificationFixture(problemB);
    const attA = attemptFixture('att_ab_A', problemA.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const attB = attemptFixture('att_ab_B', problemB.problemId, 'Got AC Independently', '2026-05-02T00:00:00.000Z');
    const ports = (now: string) => ({
      reflectionStore: new LocalReflectionStore(dir),
      evidenceStore: new LocalLearnerEvidenceStore(dir),
      modelStore: new LocalLearnerModelStore(dir),
      graph: graph(),
      nowIso: () => now,
    });
    const offerPorts = { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' };
    expect((await offerReflectionForAttemptEnd(offerPorts, { attempt: attA, problem: problemA, classificationStatus: 'classified' })).action).to.equal('offered');
    expect((await offerReflectionForAttemptEnd(offerPorts, { attempt: attB, problem: problemB, classificationStatus: 'classified' })).action).to.equal('offered');
    // Respond to A AFTER B ended: attribution must stay with A.
    const resB = await submitReflectionResponse(
      ports('2026-05-02T00:10:00.000Z'),
      { attempt: attB, problem: problemB, classification: classB, category: 'knew-idea-struggled-implement', freeText: 'B note' },
    );
    const resA = await submitReflectionResponse(
      ports('2026-05-02T00:11:00.000Z'),
      { attempt: attA, problem: problemA, classification: classA, category: 'debugging-mistake', freeText: 'A note' },
    );
    expect(resB.action).to.equal('emitted');
    expect(resA.action).to.equal('emitted');
    const evidence = await new LocalLearnerEvidenceStore(dir).listEvidence();
    expect(evidence).to.have.length(2);
    const forA = evidence.filter((e) => e.attemptId === attA.attemptId);
    const forB = evidence.filter((e) => e.attemptId === attB.attemptId);
    expect(forA).to.have.length(1);
    expect(forB).to.have.length(1);
    expect(forA[0]!.problemId).to.equal(problemA.problemId);
    expect(forB[0]!.problemId).to.equal(problemB.problemId);
    expect(forA[0]!.provenance.sourceId).to.equal('refl_att_ab_A');
    expect(forB[0]!.provenance.sourceId).to.equal('refl_att_ab_B');
    expect(forA[0]!.observation).to.contain('A note');
    expect(forB[0]!.observation).to.contain('B note');
    clean(dir);
  });

  it('is idempotent across duplicate offers and duplicate submits', async () => {
    const dir = tmpDir('codesense-g-chain-idem');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_idem', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const offerPorts = { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' };
    expect((await offerReflectionForAttemptEnd(offerPorts, { attempt, problem, classificationStatus: 'classified' })).action).to.equal('offered');
    expect((await offerReflectionForAttemptEnd(offerPorts, { attempt, problem, classificationStatus: 'classified' })).action).to.equal('already-exists');
    const submitPorts = () => ({
      reflectionStore: new LocalReflectionStore(dir),
      evidenceStore: new LocalLearnerEvidenceStore(dir),
      modelStore: new LocalLearnerModelStore(dir),
      graph: graph(),
      nowIso: () => '2026-05-01T00:10:00.000Z',
    });
    const input = { attempt, problem, classification, category: 'unsure-why-worked' as const, freeText: null };
    expect((await submitReflectionResponse(submitPorts(), input)).action).to.equal('emitted');
    expect((await submitReflectionResponse(submitPorts(), input)).action).to.equal('already-emitted');
    expect(await new LocalLearnerEvidenceStore(dir).listEvidence()).to.have.length(1);
    clean(dir);
  });

  it('survives reload: pending offered rows remain answerable', async () => {
    const dir = tmpDir('codesense-g-chain-reload');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_reload', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    await offerReflectionForAttemptEnd(
      { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' },
      { attempt, problem, classificationStatus: 'classified' },
    );
    // "Reload": brand-new store instances over the same directory.
    const submit = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-03T00:00:00.000Z',
      },
      { attempt, problem, classification, category: 'did-not-recognize-pattern', freeText: 'late note' },
    );
    expect(submit.action).to.equal('emitted');
    clean(dir);
  });

  it('rejects stale callbacks carrying the wrong problem for a stored attempt row', async () => {
    const dir = tmpDir('codesense-g-chain-stale');
    clean(dir);
    const problemA = problemFixture('https://leetcode.com/problems/number-of-islands/', 'Islands');
    const problemB = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classB = classificationFixture(problemB);
    const attA = attemptFixture('att_stale_A', problemA.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    await offerReflectionForAttemptEnd(
      { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' },
      { attempt: attA, problem: problemA, classificationStatus: 'classified' },
    );
    // Stale UI callback: attempt A's row but problem B's identity.
    const res = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      { attempt: attA, problem: problemB, classification: classB, category: 'debugging-mistake', freeText: null },
    );
    expect(res.action).to.equal('none');
    expect(await new LocalLearnerEvidenceStore(dir).listEvidence()).to.have.length(0);
    clean(dir);
  });

  it('dismisses without evidence and never re-offers', async () => {
    const dir = tmpDir('codesense-g-chain-dismiss');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const attempt = attemptFixture('att_dis', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const offerPorts = { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' };
    await offerReflectionForAttemptEnd(offerPorts, { attempt, problem, classificationStatus: 'classified' });
    expect((await dismissReflectionOffer(offerPorts, attempt.attemptId)).action).to.equal('dismissed');
    expect((await dismissReflectionOffer(offerPorts, attempt.attemptId)).action).to.equal('already-settled');
    const submit = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      {
        attempt,
        problem,
        classification: classificationFixture(problem),
        category: 'debugging-mistake',
        freeText: null,
      },
    );
    expect(submit.action).to.equal('dismissed');
    expect(await new LocalLearnerEvidenceStore(dir).listEvidence()).to.have.length(0);
    clean(dir);
  });

  it('keeps explicit learner statements distinct from contradicting AI observations', async () => {
    const dir = tmpDir('codesense-g-chain-contra');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_contra', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    // Seed a contradicting AI observation first (debugging difficulty).
    const evidenceStore = new LocalLearnerEvidenceStore(dir);
    const modelStore = new LocalLearnerModelStore(dir);
    await evidenceStore.appendEvidenceBatch([aiObservationEvidence(attempt)]);
    // Learner explicitly reports conceptual recognition failure instead.
    const submit = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore,
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      {
        attempt,
        problem,
        classification,
        category: 'did-not-recognize-pattern',
        freeText: 'I knew BFS but forgot visited before pushing.',
      },
    );
    expect(submit.action).to.equal('emitted');
    const evidence = await new LocalLearnerEvidenceStore(dir).listEvidence();
    expect(evidence).to.have.length(2);
    const ai = evidence.filter((e) => e.source === 'ai-diagnosis');
    const learner = evidence.filter((e) => e.source === 'human-curated');
    expect(ai).to.have.length(1);
    expect(learner).to.have.length(1);
    expect(learner[0]!.evidenceType).to.equal('CONCEPTUAL_CONFUSION');
    expect(ai[0]!.evidenceType).to.equal('DEBUGGING_FAILURE');
    expect(learner[0]!.provenance.sourceId).to.equal('refl_att_contra');
    clean(dir);
  });

  it('does not offer reflections for unfinished attempts', async () => {
    const dir = tmpDir('codesense-g-chain-active');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const active = createAttempt({
      attemptId: 'att_active',
      problemId: problem.problemId,
      sessionId: 'ses_1',
      startedAt: '2026-05-01T00:00:00.000Z',
    });
    const res = await offerReflectionForAttemptEnd(
      { reflectionStore: new LocalReflectionStore(dir), nowIso: () => '2026-05-01T00:00:00.000Z' },
      { attempt: active, problem, classificationStatus: 'classified' },
    );
    expect(res.action).to.equal('none');
    clean(dir);
  });
});

describe('Phase G optional AI structuring (enhancement only)', () => {
  const AI_INPUT = {
    category: 'debugging-mistake' as const,
    freeText: 'I knew BFS but forgot to mark visited before pushing.',
    problemTitle: 'Rotting Oranges',
  };

  it('validates AI candidates (accept, abstain, unknown entity, dimension mismatch)', () => {
    const g = graph();
    expect(
      validateReflectionAiCandidate(
        {
          entityIds: [BFS],
          dimension: 'debugging',
          evidenceType: 'RECURRING_MISTAKE',
          mistakeCategory: 'forgot-visited-marking',
          confidence: 'medium',
        },
        { graph: g },
      ),
    ).to.not.equal(null);
    expect(validateReflectionAiCandidate({ abstain: true }, { graph: g })).to.equal(null);
    expect(
      validateReflectionAiCandidate(
        {
          entityIds: ['framework.does-not-exist'],
          dimension: 'conceptual',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'low',
        },
        { graph: g },
      ),
    ).to.equal(null);
    // Dimension/evidence-type mismatch rejected.
    expect(
      validateReflectionAiCandidate(
        {
          entityIds: [BFS],
          dimension: 'debugging',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'low',
        },
        { graph: g },
      ),
    ).to.equal(null);
    // High confidence rejected (capped).
    expect(
      validateReflectionAiCandidate(
        {
          entityIds: [BFS],
          dimension: 'conceptual',
          evidenceType: 'CONCEPTUAL_CONFUSION',
          confidence: 'high',
        },
        { graph: g },
      ),
    ).to.equal(null);
  });

  it('proposes through fakes: success, abstain, provider failure, malformed, invalid entity', async () => {
    const g = graph();
    const ok = await proposeReflectionInterpretation(
      {
        reasoner: new FakeReflectionStructuringReasoner([
          {
            entityIds: [BFS],
            dimension: 'debugging',
            evidenceType: 'RECURRING_MISTAKE',
            mistakeCategory: 'forgot-visited-marking',
            confidence: 'medium',
          },
        ]),
        graph: g,
        model: 'test-model',
      },
      AI_INPUT,
    );
    expect(ok.status).to.equal('proposed');

    const abstained = await proposeReflectionInterpretation(
      { reasoner: new FakeReflectionStructuringReasoner([{ abstain: true }]), graph: g, model: 'm' },
      AI_INPUT,
    );
    expect(abstained.status).to.equal('abstained');

    const failed = await proposeReflectionInterpretation(
      { reasoner: new FakeReflectionStructuringReasoner([new Error('down')]), graph: g, model: 'm' },
      AI_INPUT,
    );
    expect(failed.status).to.equal('failed');

    const malformed = await proposeReflectionInterpretation(
      { reasoner: new FakeReflectionStructuringReasoner([{ nonsense: 1 }]), graph: g, model: 'm' },
      AI_INPUT,
    );
    expect(malformed.status).to.equal('failed');

    const invalidEntity = await proposeReflectionInterpretation(
      {
        reasoner: new FakeReflectionStructuringReasoner([
          {
            entityIds: ['framework.does-not-exist'],
            dimension: 'conceptual',
            evidenceType: 'CONCEPTUAL_CONFUSION',
            confidence: 'low',
          },
        ]),
        graph: g,
        model: 'm',
      },
      AI_INPUT,
    );
    expect(invalidEntity.status).to.equal('failed');
  });

  it('emits refined evidence for a learner-confirmed AI interpretation', async () => {
    const dir = tmpDir('codesense-g-ai-confirm');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_ai_ok', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const res = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      {
        attempt,
        problem,
        classification,
        category: 'debugging-mistake',
        freeText: 'I knew BFS but forgot to mark visited before pushing.',
        interpretation: {
          entityIds: [BFS],
          dimension: 'debugging',
          evidenceType: 'RECURRING_MISTAKE',
          mistakeCategory: 'forgot-visited-marking',
          confidence: 'medium',
          aiAssisted: true,
          learnerConfirmed: true,
        },
      },
    );
    expect(res.action).to.equal('emitted');
    const evidence = await new LocalLearnerEvidenceStore(dir).listEvidence();
    expect(evidence).to.have.length(1);
    expect(evidence[0]!.mistakeCategory).to.equal('forgot-visited-marking');
    expect(evidence[0]!.entityIds).to.deep.equal([BFS]);
    clean(dir);
  });

  it('falls back to the deterministic path when the AI proposal is unconfirmed or fails', async () => {
    const dir = tmpDir('codesense-g-ai-fallback');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    // Unconfirmed AI proposal must be ignored (deterministic category wins).
    const attempt1 = attemptFixture('att_ai_fb1', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const res1 = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      {
        attempt: attempt1,
        problem,
        classification,
        category: 'debugging-mistake',
        freeText: 'forgot visited',
        interpretation: {
          entityIds: [BFS],
          dimension: 'debugging',
          evidenceType: 'RECURRING_MISTAKE',
          mistakeCategory: 'forgot-visited-marking',
          confidence: 'medium',
          aiAssisted: true,
          learnerConfirmed: false,
        },
      },
    );
    expect(res1.action).to.equal('emitted');
    const evidence = await new LocalLearnerEvidenceStore(dir).listEvidence();
    expect(evidence).to.have.length(1);
    // Deterministic default category used, not the unconfirmed refinement.
    expect(evidence[0]!.mistakeCategory).to.equal('debugging-mistake');
    clean(dir);
  });

  it('preserves raw input for `other` when AI abstains (no invented evidence)', async () => {
    const dir = tmpDir('codesense-g-ai-abstain');
    clean(dir);
    const problem = problemFixture('https://leetcode.com/problems/rotting-oranges/', 'Oranges');
    const classification = classificationFixture(problem);
    const attempt = attemptFixture('att_ai_abs', problem.problemId, 'Got WA', '2026-05-01T00:00:00.000Z');
    const res = await submitReflectionResponse(
      {
        reflectionStore: new LocalReflectionStore(dir),
        evidenceStore: new LocalLearnerEvidenceStore(dir),
        modelStore: new LocalLearnerModelStore(dir),
        graph: graph(),
        nowIso: () => '2026-05-01T00:10:00.000Z',
      },
      {
        attempt,
        problem,
        classification,
        category: 'other',
        freeText: 'Not sure what to say.',
        interpretation: null,
      },
    );
    expect(res.action).to.equal('validated-no-evidence');
    if (res.action !== 'validated-no-evidence') {
      throw new Error('expected validated-no-evidence');
    }
    expect(res.reflection.freeText).to.equal('Not sure what to say.');
    expect(await new LocalLearnerEvidenceStore(dir).listEvidence()).to.have.length(0);
    clean(dir);
  });
});
