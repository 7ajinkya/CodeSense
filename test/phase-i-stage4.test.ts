import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { toGenerationSpecification } from 'codesense/generation/generationSpecification';
import type { GenerationSpecification } from 'codesense/generation/generationSpecification';
import { FakeGenerator } from 'codesense/generation/candidateGenerator';
import type { CandidateGenerator, CandidateGenerationContext } from 'codesense/generation/candidateGenerator';
import type { GeneratedCandidate } from 'codesense/generation/generationCandidate';
import { FakeCritic } from 'codesense/generation/pedagogicalCritic';
import type { PedagogicalValidationResult } from 'codesense/generation/pedagogicalCritic';
import type { ActivityPlan } from 'codesense/practice/activityTypes';
import { parseActivityPlan } from 'codesense/practice/activityStore';
import { LocalActivityPlanStore } from 'codesense/practice/activityStore';
import { offerPlan } from 'codesense/practice/activityLifecycle';
import type { GenerationRequest } from 'codesense/practice/generationRequest';
import { validateGenerationRequest } from 'codesense/practice/generationRequest';
import * as slotModule from 'codesense/generation/generationSlot';
import {
  checkSlotBinding,
  fillGenerationSlot,
  resolveGenerationSlot,
} from 'codesense/generation/generationSlot';

/**
 * Phase I Stage 4 — F2 generation-slot integration boundary.
 *
 * Pins: F2 request → I transcription → one generation call → I-2 → I-3 →
 * filled F2 slot, with ownership intact (F2 plans, I validates), no retry,
 * no queue, no persistence, no execution claims, and no learner-state
 * access beyond the request itself.
 */

const BFS = 'framework.bfs';
const NOW = '2026-08-10T12:00:00.000Z';

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

function requestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'genreq_stage4_1',
    planId: 'plan_stage4_1',
    goalId: 'goal_stage4_1',
    activityKind: 'coding-problem',
    intent: 'conceptual-practice',
    purpose: 'diagnostic',
    targetEntityIds: [BFS],
    targetDimensions: ['conceptual'],
    surfaceForm: 'unfamiliar',
    transferRequirement: 'Present binary search outside sorted-array story context.',
    constraints: { timeLimitMs: 2000, languageScope: ['python'] },
    forbiddenShortcuts: ['library binary search'],
    discriminatingEvidence: {
      evidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
      question: 'Can the learner state the boundary invariant under changed conventions?',
    },
    acceptanceCriteria: [
      { criterionId: 'discriminating-case', description: 'At least one case separates template copies from invariant reasoning.' },
    ],
    requestBasis: { basisKind: 'established-need', needId: 'need_1', summary: 'Corroborated boundary need.' },
    budget: { maxCandidates: 3, expiresAt: '2026-09-01T00:00:00.000Z' },
    issuedAt: '2026-08-10T10:00:00.000Z',
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1' },
    ...overrides,
  };
}

function validRequest(overrides: Record<string, unknown> = {}): GenerationRequest {
  const parsed = validateGenerationRequest(requestFixture(overrides));
  expect(parsed, 'fixture request must validate').to.not.equal(null);
  return parsed as GenerationRequest;
}

function planFixture(request: GenerationRequest, overrides: Partial<ActivityPlan> = {}): ActivityPlan {
  return {
    planId: request.planId,
    goalId: request.goalId,
    goalTargetKey: 'framework.bfs|conceptual',
    activityKind: request.activityKind,
    problemId: 'prob_stage4_1',
    problemTitle: 'Binary search practice',
    intent: request.intent,
    purpose: request.purpose,
    entityIds: [...request.targetEntityIds],
    dimension: 'conceptual',
    rationale: 'F2-selected practice slot awaiting generation.',
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: NOW,
      ontologyVersion: graph().ontologyVersion,
      aggregatorVersion: '1',
      needId: null,
      goalSource: 'learner-requested',
    },
    expectedEvidence: 'Attempt the activity.',
    expectedEvidenceTypes: ['CONCEPTUAL_SUCCESS'],
    createdAt: NOW,
    updatedAt: NOW,
    status: 'planned',
    position: 0,
    sequenceLength: 1,
    sequenceId: 'seq_stage4_1',
    linkedAttemptId: null,
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1', catalogSize: 0 },
    ...overrides,
  };
}

function specFixture(request?: GenerationRequest): GenerationSpecification {
  const target = request ?? validRequest();
  const outcome = toGenerationSpecification(target, { graph: graph(), now: NOW });
  expect(outcome.ok, 'fixture spec must transcribe').to.equal(true);
  if (!outcome.ok) {
    throw new Error(`fixture spec must transcribe: ${outcome.error.reason}`);
  }
  return outcome.spec;
}

class CountingGenerator extends FakeGenerator {
  generateCalls = 0;

  generate(specification: GenerationSpecification, context?: CandidateGenerationContext) {
    this.generateCalls += 1;
    return super.generate(specification, context);
  }
}

function passCritic(): FakeCritic {
  return new FakeCritic();
}

function reviseCritic(): FakeCritic {
  return new FakeCritic([
    {
      mode: 'findings',
      findings: [
        { criterion: 'target-engagement', status: 'pass', criticConfidence: 'high', reason: 'Engages the target.' },
        { criterion: 'evidence-observability', status: 'pass', criticConfidence: 'high', reason: 'Observable.' },
        {
          criterion: 'transfer-anti-rote',
          status: 'uncertain',
          criticConfidence: 'low',
          reason: 'Cannot tell whether the transfer is meaningful.',
        },
        { criterion: 'shortcut-resistance', status: 'pass', criticConfidence: 'high', reason: 'Resists shortcuts.' },
        { criterion: 'challenge-purpose-fit', status: 'pass', criticConfidence: 'high', reason: 'Fits purpose.' },
        { criterion: 'internal-consistency', status: 'pass', criticConfidence: 'high', reason: 'Consistent.' },
        { criterion: 'debugging-genuineness', status: 'pass', criticConfidence: 'high', reason: 'N/A for coding task.' },
      ],
    },
  ]);
}

function rejectCritic(): FakeCritic {
  return new FakeCritic([
    {
      mode: 'findings',
      findings: [
        { criterion: 'target-engagement', status: 'pass', criticConfidence: 'high', reason: 'Engages the target.' },
        { criterion: 'evidence-observability', status: 'pass', criticConfidence: 'high', reason: 'Observable.' },
        {
          criterion: 'transfer-anti-rote',
          status: 'fail',
          criticConfidence: 'high',
          reason: 'Cosmetic rename of the same surface form.',
        },
        { criterion: 'shortcut-resistance', status: 'pass', criticConfidence: 'high', reason: 'Resists shortcuts.' },
        { criterion: 'challenge-purpose-fit', status: 'pass', criticConfidence: 'high', reason: 'Fits purpose.' },
        { criterion: 'internal-consistency', status: 'pass', criticConfidence: 'high', reason: 'Consistent.' },
        { criterion: 'debugging-genuineness', status: 'pass', criticConfidence: 'high', reason: 'N/A for coding task.' },
      ],
    },
  ]);
}

describe('Phase I Stage 4 — valid integration fills the F2 slot', () => {
  it('A. request → spec → candidate → I-2 → I-3 pass → offerable filled slot', async () => {
    const request = validRequest();
    const plan = planFixture(request);
    const result = await resolveGenerationSlot({
      plan,
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    expect(result.plan, 'offerable carries the filled plan').to.not.equal(undefined);
    expect(result.executionUnverified).to.equal(true);
    const filled = result.plan as ActivityPlan;
    expect(filled.status).to.equal('planned');
    expect(filled.planId).to.equal(request.planId);
    expect(filled.generatedArtifact?.candidateId).to.equal(result.candidateId);
    expect(filled.generatedArtifact?.specId).to.equal(result.specId);
    expect(filled.generatedArtifact?.requestId).to.equal(request.requestId);
    expect(filled.generatedArtifact?.kind).to.equal('coding-problem');
    expect(filled.generatedArtifact?.title.length ?? 0).to.be.greaterThan(0);
    expect(filled.generatedArtifact?.taskDescription.length ?? 0).to.be.greaterThan(0);
    expect(filled.updatedAt).to.equal(NOW);
    expect(filled.linkedAttemptId).to.equal(null);
    expect(result.stage2Report?.verdict).to.equal('accepted');
    expect(result.pedagogicalResult?.verdict).to.equal('pass');
    expect(result.pedagogicalResult?.executionUnverified).to.equal(true);
  });

  it('B. goal/plan/request/spec/candidate stay connected end to end', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    expect(result.requestId).to.equal(request.requestId);
    expect(result.planId).to.equal(request.planId);
    expect(result.goalId).to.equal(request.goalId);
    const filled = result.plan as ActivityPlan;
    expect(filled.goalId).to.equal(result.goalId);
    expect(filled.generatedArtifact?.requestId).to.equal(result.requestId);
    expect(filled.generatedArtifact?.specId).to.equal(result.specId);
    expect(result.pedagogicalResult?.candidateId).to.equal(result.candidateId);
    expect(result.pedagogicalResult?.specId).to.equal(result.specId);
  });

  it('debugging-task slots mirror validated debugging content into the native payload', async () => {
    const request = validRequest({
      requestId: 'genreq_stage4_dbg',
      planId: 'plan_stage4_dbg',
      goalId: 'goal_stage4_dbg',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
      debugContext: { brokenAttemptId: 'att_broken_1' },
    });
    const plan = planFixture(request, {
      debugPayload: {
        brokenSnapshot: 'placeholder broken code',
        referenceFix: 'placeholder fixed code',
        tests: ['placeholder test'],
      },
    });
    const result = await resolveGenerationSlot({
      plan,
      request: requestFixture({
        requestId: 'genreq_stage4_dbg',
        planId: 'plan_stage4_dbg',
        goalId: 'goal_stage4_dbg',
        activityKind: 'debugging-task',
        intent: 'debugging-practice',
        debugContext: { brokenAttemptId: 'att_broken_1' },
      }),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    const filled = result.plan as ActivityPlan;
    expect(filled.debugPayload?.brokenSnapshot.length ?? 0).to.be.greaterThan(0);
    expect(filled.debugPayload?.referenceFix.length ?? 0).to.be.greaterThan(0);
    expect(filled.debugPayload?.tests.length ?? 0).to.be.greaterThan(0);
    expect(filled.generatedArtifact?.kind).to.equal('debugging-task');
  });
});

describe('Phase I Stage 4 — preservation, refusal, and terminal failures', () => {
  it('C. mismatched plan/request fields refuse without silent replacement', async () => {
    const request = validRequest();
    const mismatches: Array<{ name: string; plan: ActivityPlan }> = [
      { name: 'planId', plan: planFixture(request, { planId: 'plan_other' }) },
      { name: 'goalId', plan: planFixture(request, { goalId: 'goal_other' }) },
      { name: 'kind', plan: planFixture(request, { activityKind: 'debugging-task' }) },
      { name: 'intent', plan: planFixture(request, { intent: 'implementation-practice' }) },
      { name: 'purpose', plan: planFixture(request, { purpose: 'instructional' }) },
      { name: 'entities', plan: planFixture(request, { entityIds: ['concept.queue-fifo'] }) },
      { name: 'dimension', plan: planFixture(request, { dimension: 'implementation' }) },
    ];
    for (const mismatch of mismatches) {
      const result = await resolveGenerationSlot({
        plan: mismatch.plan,
        request: requestFixture(),
        generator: new FakeGenerator(),
        critic: passCritic(),
        graph: graph(),
        now: NOW,
      });
      expect(result.status, mismatch.name).to.equal('slot-mismatch');
      expect(result.plan, mismatch.name).to.equal(undefined);
    }
  });

  it('C0. slot binding accepts the bound slot and rejects anything else', () => {
    const request = validRequest();
    expect(checkSlotBinding(planFixture(request), request)).to.deep.equal({ ok: true });
    expect(checkSlotBinding(planFixture(request, { planId: 'plan_x' }), request).ok).to.equal(false);
    expect(checkSlotBinding(planFixture(request, { generatedArtifact: { candidateId: 'c', specId: 's', requestId: 'r', kind: 'coding-problem', title: 't', taskDescription: 'd' } }), request).ok).to.equal(false);
  });

  it('C2. a specification from another request cannot fill this slot', async () => {
    const request = validRequest();
    const plan = planFixture(request);
    const otherRequest = validRequest({ requestId: 'genreq_other', planId: 'plan_other', goalId: 'goal_other' });
    const otherSpec = specFixture(otherRequest);
    expect(otherSpec.requestId).to.not.equal(request.requestId);
    const probeCandidate: GeneratedCandidate = {
      candidateId: 'cand_probe',
      candidateVersion: 1,
      specId: otherSpec.specId,
      activityKind: 'coding-problem',
      title: 'Probe',
      taskDescription: 'Probe task.',
      targetEntityIds: ['framework.bfs'],
      targetDimensions: ['conceptual'],
      surfaceForm: 'unfamiliar',
      surfaceEvidence: { contextDescription: 'Reframed.', changedElements: ['reframed context'] },
      constraints: { languageScope: ['python'] },
      forbiddenShortcuts: ['library binary search'],
      expectedEvidence: {
        dimensions: ['conceptual'],
        evidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
        question: 'Can the learner state the boundary invariant under changed conventions?',
      },
      intent: 'conceptual-practice',
      purpose: 'diagnostic',
      acceptanceCriteria: [
        { criterionId: 'discriminating-case', description: 'At least one case separates template copies from invariant reasoning.' },
      ],
      provenance: {
        specId: otherSpec.specId,
        requestId: otherRequest.requestId,
        planId: otherRequest.planId,
        goalId: otherRequest.goalId,
        generatorId: 'probe',
        generatorVersion: '1',
      },
    };
    const probePedagogical: PedagogicalValidationResult = {
      specId: otherSpec.specId,
      candidateId: 'cand_probe',
      verdict: 'pass',
      criteria: [],
      hardFailures: [],
      provenance: { validatorVersion: '1', rubricVersion: '1', criticId: 'probe' },
      executionUnverified: true,
    };
    const filled = fillGenerationSlot(plan, probeCandidate, request, otherSpec, probePedagogical, NOW);
    expect(filled.ok).to.equal(false);
  });

  it('D. pedagogical reject blocks the slot without offering', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: rejectCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('pedagogical-reject');
    expect(result.plan).to.equal(undefined);
    expect(result.pedagogicalResult?.verdict).to.equal('reject');
  });

  it('E. pedagogical revise is terminal with exactly one generator call', async () => {
    const request = validRequest();
    const generator = new CountingGenerator();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator,
      critic: reviseCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('pedagogical-revise');
    expect(result.plan).to.equal(undefined);
    expect(generator.generateCalls).to.equal(1);
  });

  it('F. revise never triggers regeneration', async () => {
    const request = validRequest();
    const generator = new CountingGenerator();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await resolveGenerationSlot({
        plan: planFixture(request),
        request: requestFixture(),
        generator: new CountingGenerator(),
        critic: reviseCritic(),
        graph: graph(),
        now: NOW,
      });
      expect(result.status).to.equal('pedagogical-revise');
    }
    const single = new CountingGenerator();
    await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: single,
      critic: reviseCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(single.generateCalls).to.equal(1);
    expect(generator.generateCalls).to.equal(0);
  });

  it('G. provider failure yields unavailable without an offerable slot', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator([{ mode: 'failure', reason: 'provider down' }]),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('generation-unavailable');
    expect(result.plan).to.equal(undefined);
  });

  it('H. malformed generation output cannot become an activity', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator([{ mode: 'raw', payload: { nope: true } }]),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('generation-rejected');
    expect(result.plan).to.equal(undefined);
  });

  it('request-invalid and slot-mismatch never invoke generation', async () => {
    const request = validRequest();
    const blind: CandidateGenerator = {
      generatorId: 'must-not-run',
      generate: (): never => {
        throw new Error('generator must not be invoked');
      },
    };
    const invalid = await resolveGenerationSlot({
      plan: planFixture(request),
      request: { nope: true },
      generator: blind,
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(invalid.status).to.equal('request-invalid');
    const mismatched = await resolveGenerationSlot({
      plan: planFixture(request, { planId: 'plan_elsewhere' }),
      request: requestFixture(),
      generator: blind,
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(mismatched.status).to.equal('slot-mismatch');
  });
});

describe('Phase I Stage 4 — execution boundary and F2 ownership', () => {
  it('I/J. offerable results stay execution-unverified with the sandbox gate intact', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    expect(result.executionUnverified).to.equal(true);
    expect(result.reason.toLowerCase()).to.include('unverified');
    expect(result.reason.toLowerCase()).to.not.include('correct');
    expect(result.reason.toLowerCase()).to.not.include('safe to run');
    expect(result.pedagogicalResult?.executionUnverified).to.equal(true);
    const spec = specFixture();
    expect(spec.sandboxAvailable).to.equal(false);
  });

  it('K. filled slots persist through the F2 store and lifecycle untouched otherwise', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    const filled = result.plan as ActivityPlan;
    expect(parseActivityPlan(filled)).to.not.equal(null);
    const dir = tmpDir('codesense-test-i4-ownership');
    clean(dir);
    const store = new LocalActivityPlanStore(dir);
    await store.upsertPlan(filled);
    const reloaded = await store.getPlan(filled.planId);
    expect(reloaded?.generatedArtifact).to.deep.equal(filled.generatedArtifact);
    const offered = offerPlan(filled, NOW);
    expect(offered.status).to.equal('offered');
    expect(offered.generatedArtifact).to.deep.equal(filled.generatedArtifact);
    expect(offered.linkedAttemptId).to.equal(null);
    clean(dir);
  });

  it('K2. filled slots refuse already-started, linked, or pre-filled plans', () => {
    const request = validRequest();
    const spec = specFixture();
    const candidate: GeneratedCandidate = {
      candidateId: 'cand_probe_2',
      candidateVersion: 1,
      specId: spec.specId,
      activityKind: 'coding-problem',
      title: 'Probe',
      taskDescription: 'Probe task.',
      targetEntityIds: ['framework.bfs'],
      targetDimensions: ['conceptual'],
      surfaceForm: 'unfamiliar',
      surfaceEvidence: { contextDescription: 'Reframed.', changedElements: ['reframed context'] },
      constraints: { languageScope: ['python'] },
      forbiddenShortcuts: ['library binary search'],
      expectedEvidence: {
        dimensions: ['conceptual'],
        evidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
        question: 'Can the learner state the boundary invariant under changed conventions?',
      },
      intent: 'conceptual-practice',
      purpose: 'diagnostic',
      acceptanceCriteria: [
        { criterionId: 'discriminating-case', description: 'At least one case separates template copies from invariant reasoning.' },
      ],
      provenance: {
        specId: spec.specId,
        requestId: request.requestId,
        planId: request.planId,
        goalId: request.goalId,
        generatorId: 'probe',
        generatorVersion: '1',
      },
    };
    const pedagogical: PedagogicalValidationResult = {
      specId: spec.specId,
      candidateId: 'cand_probe_2',
      verdict: 'pass',
      criteria: [],
      hardFailures: [],
      provenance: { validatorVersion: '1', rubricVersion: '1', criticId: 'probe' },
      executionUnverified: true,
    };
    const base = planFixture(request);
    expect(fillGenerationSlot({ ...base, status: 'offered' }, { ...candidate }, request, spec, pedagogical, NOW).ok).to.equal(false);
    expect(fillGenerationSlot({ ...base, linkedAttemptId: 'att_1' }, { ...candidate }, request, spec, pedagogical, NOW).ok).to.equal(false);
    expect(
      fillGenerationSlot({ ...base, generatedArtifact: { candidateId: 'c', specId: 's', requestId: 'r', kind: 'coding-problem', title: 't', taskDescription: 'd' } }, { ...candidate }, request, spec, pedagogical, NOW).ok,
    ).to.equal(false);
  });

  it('L. generator and critic see only spec/candidate inputs, never learner state', async () => {
    const request = validRequest();
    const seenSpecs: unknown[] = [];
    const recording: CandidateGenerator = {
      generatorId: 'recording',
      generate: async (specification: unknown) => {
        seenSpecs.push(specification);
        const inner = new FakeGenerator();
        return inner.generate(
          specification as Parameters<FakeGenerator['generate']>[0],
          undefined,
        );
      },
    };
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: recording,
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    expect(seenSpecs).to.have.lengthOf(1);
    const serialized = JSON.stringify(seenSpecs[0]).toLowerCase();
    for (const term of ['local-learner', 'telemetry', 'conversation history', 'reflection', 'evidence history']) {
      expect(serialized).to.not.include(term);
    }
  });
});

describe('Phase I Stage 4 — bypass resistance', () => {
  it('cannot bypass F2: an I result without a valid slot relationship is unusable', async () => {
    const request = validRequest();
    const foreign = planFixture(request, { planId: 'plan_foreign', goalId: 'goal_foreign' });
    const result = await resolveGenerationSlot({
      plan: foreign,
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('slot-mismatch');
    expect(result.plan).to.equal(undefined);
  });

  it('cannot bypass I-3: I-2-accepted candidates with pedagogical rejection stay unofferable', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: rejectCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('pedagogical-reject');
    expect(result.plan).to.equal(undefined);
    expect(result.stage2Report?.verdict).to.equal('accepted');
  });

  it('cannot bypass the execution boundary: offerable never means verified', async () => {
    const request = validRequest();
    const result = await resolveGenerationSlot({
      plan: planFixture(request),
      request: requestFixture(),
      generator: new FakeGenerator(),
      critic: passCritic(),
      graph: graph(),
      now: NOW,
    });
    expect(result.status).to.equal('offerable');
    const text = `${result.reason} ${JSON.stringify(result.plan?.generatedArtifact ?? {})}`.toLowerCase();
    expect(text).to.not.include('verified correct');
    expect(text).to.not.include('safe to run');
    expect(text).to.not.include('execution passed');
    expect(result.executionUnverified).to.equal(true);
  });
});

describe('Phase I Stage 4 — export boundary and scope hygiene', () => {
  it('exposes exactly the minimum I-4 surface', () => {
    expect(Object.keys(slotModule).sort()).to.deep.equal(
      ['checkSlotBinding', 'fillGenerationSlot', 'resolveGenerationSlot'].sort(),
    );
  });

  it('introduces no planner, queue, retry, persistence, execution, or scoring surface', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const source = fs.readFileSync(path.join(root, 'src', 'generation', 'generationSlot.ts'), 'utf-8');
    for (const line of source.split('\n')) {
      const match = line.match(/^\s*import .* from '([^']+)'/);
      if (match) {
        expect(
          [
            '../knowledge/ontologyStore',
            '../practice/activityTypes',
            '../practice/generationRequest',
            './generationSpecification',
            './candidateGenerator',
            './generationCandidate',
            './pedagogicalCritic',
          ],
          `import source in generationSlot.ts`,
        ).to.include(match[1]);
      }
    }
    for (const forbidden of [
      'LocalActivityPlanStore',
      'upsertPlan',
      'recommend',
      'queue',
      'retry',
      'regenerat',
      'child_process',
      'spawn(',
      'execFile',
      'eval(',
      'confidence',
      'mastery',
      'weakness',
      'difficulty',
      'curriculum',
      'LearnerEvidence',
      'appendEvidence',
      'syncAttempt',
      'transitionGoal',
      'transitionPlan',
      'linkAttemptToPlan',
      'offerPlan',
      'startPlan',
      'local-learner',
    ]) {
      expect(source).to.not.include(forbidden);
    }
  });
});
