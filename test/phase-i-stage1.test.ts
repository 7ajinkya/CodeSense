import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import * as generationRequestModule from 'codesense/practice/generationRequest';
import { validateGenerationRequest } from 'codesense/practice/generationRequest';
import type { GenerationRequest } from 'codesense/practice/generationRequest';
import * as generationSpecModule from 'codesense/generation/generationSpecification';
import {
  SPEC_SCHEMA_VERSION,
  buildValidationPlan,
  specIdForRequest,
  toGenerationSpecification,
  validateGenerationSpecification,
} from 'codesense/generation/generationSpecification';

/**
 * Phase I Stage 1 — GenerationSpecification contract (transcription only).
 *
 * Pins: F2 request validation, faithful field preservation, stable
 * identity, supersession linking, C/D/kind/payload refusal, expected-
 * evidence distinction, provenance, privacy minimization, anti-rote
 * preservation, sandbox-disabled invariance, and frozen boundaries
 * (no D/F1/F2/E/F3/G/H/C mutation, no generation engine, no sandbox).
 */

const BFS = 'framework.bfs';
const NOW = '2026-08-01T12:00:00.000Z';

const BANNED_OUTPUT_TERMS = [
  'does not understand',
  'lacks motivation',
  'weak at binary',
  'has not learned',
  'personality',
  'unable to learn',
  'mastery',
  'rote learner',
];

function graph(): KnowledgeGraph {
  return getDefaultKnowledgeGraph();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepFreeze(item);
      }
    } else {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function requestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'genreq_test_1',
    planId: 'plan_test_1',
    goalId: 'goal_test_1',
    activityKind: 'coding-problem',
    intent: 'conceptual-practice',
    purpose: 'diagnostic',
    targetEntityIds: [BFS],
    targetDimensions: ['conceptual'],
    surfaceForm: 'unfamiliar',
    transferRequirement: 'Present binary search outside sorted-array story context.',
    constraints: { timeLimitMs: 2000, languageScope: ['python'] },
    forbiddenShortcuts: ['blind middle-index template without an invariant check'],
    discriminatingEvidence: {
      evidenceTypes: ['CONCEPTUAL_SUCCESS', 'CONCEPTUAL_CONFUSION'],
      question: 'Can the learner state the boundary invariant under changed conventions?',
      observableBehavior: 'Written invariant before coding.',
    },
    acceptanceCriteria: [
      { criterionId: 'discriminating-case', description: 'At least one case separates template copies from invariant reasoning.' },
    ],
    requestBasis: {
      basisKind: 'diagnostic',
      hypothesisKinds: ['boundary-invariant-uncertainty', 'template-perturbation-possibility'],
      basisEvidenceIds: ['ev_1'],
    },
    repetitionJustification: 'Two same-form attempts converged without explanation; unfamiliar form required.',
    budget: { maxCandidates: 3, expiresAt: '2026-09-01T00:00:00.000Z' },
    issuedAt: '2026-08-01T10:00:00.000Z',
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1' },
    ...overrides,
  };
}

function transcribe(raw: Record<string, unknown>, now: string = NOW, supersedesSpecId?: string) {
  return toGenerationSpecification(raw, { graph: graph(), now, ...(supersedesSpecId !== undefined ? { supersedesSpecId } : {}) });
}

describe('Phase I Stage 1 — valid transcription and field preservation', () => {
  it('A. transcribes a valid GenerationRequest into a valid GenerationSpecification', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    expect(outcome.spec.source).to.equal('f2-generation-request');
    expect(outcome.spec.specVersion).to.equal(SPEC_SCHEMA_VERSION);
    expect(validateGenerationSpecification(outcome.spec)).to.not.equal(null);
  });

  it('B. preserves every F2-owned field verbatim (deep structural equality)', () => {
    const raw = requestFixture();
    const validated = validateGenerationRequest(raw) as GenerationRequest;
    const outcome = transcribe(raw);
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    const spec = outcome.spec;
    expect(spec.requestId).to.equal(validated.requestId);
    expect(spec.planId).to.equal(validated.planId);
    expect(spec.goalId).to.equal(validated.goalId);
    expect(spec.basis).to.deep.equal(validated.requestBasis);
    expect(spec.activityRequirements.kind).to.equal(validated.activityKind);
    expect(spec.activityRequirements.intent).to.equal(validated.intent);
    expect(spec.activityRequirements.purpose).to.equal(validated.purpose);
    expect(spec.activityRequirements.targetEntityIds).to.deep.equal(validated.targetEntityIds);
    expect(spec.activityRequirements.targetDimensions).to.deep.equal(validated.targetDimensions);
    expect(spec.activityRequirements.surfaceForm).to.equal(validated.surfaceForm);
    expect(spec.activityRequirements.transferRequirement).to.equal(validated.transferRequirement);
    expect(spec.activityRequirements.constraints).to.deep.equal(validated.constraints);
    expect(spec.activityRequirements.forbiddenShortcuts).to.deep.equal(validated.forbiddenShortcuts);
    expect(spec.expectedEvidence.dimensions).to.deep.equal(validated.targetDimensions);
    expect(spec.expectedEvidence.evidenceTypes).to.deep.equal(validated.discriminatingEvidence.evidenceTypes);
    expect(spec.expectedEvidence.question).to.equal(validated.discriminatingEvidence.question);
    expect(spec.expectedEvidence.observableBehavior).to.equal(validated.discriminatingEvidence.observableBehavior);
    expect(spec.acceptanceCriteria).to.deep.equal(validated.acceptanceCriteria);
    expect(spec.repetitionJustification).to.equal(validated.repetitionJustification);
    expect(spec.budget).to.deep.equal(validated.budget);
    expect(spec.issuedAt).to.equal(validated.issuedAt);
    expect(spec.provenance).to.deep.equal(validated.provenance);
  });

  it('C. derives stable identity deterministically from the request', () => {
    const first = transcribe(requestFixture());
    const second = transcribe(requestFixture());
    expect(first.ok && second.ok).to.equal(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected ok transcriptions');
    }
    expect(first.spec.specId).to.equal(second.spec.specId);
    const validated = validateGenerationRequest(requestFixture()) as GenerationRequest;
    expect(first.spec.specId).to.equal(specIdForRequest(validated));
    expect(JSON.stringify(first.spec)).to.equal(JSON.stringify(second.spec));
  });

  it('C2. materially different requests never share a spec identity', () => {
    const base = transcribe(requestFixture());
    expect(base.ok).to.equal(true);
    if (!base.ok) {
      throw new Error('expected ok transcription');
    }
    const variants: Record<string, unknown>[] = [
      requestFixture({ targetEntityIds: ['concept.queue-fifo'] }),
      requestFixture({ targetDimensions: ['implementation'] }),
      requestFixture({ intent: 'implementation-practice', targetDimensions: ['implementation'] }),
      requestFixture({ purpose: 'instructional' }),
      requestFixture({ constraints: { timeLimitMs: 4000, languageScope: ['python'] } }),
      requestFixture({
        acceptanceCriteria: [
          { criterionId: 'other-case', description: 'A different discriminating case.' },
        ],
      }),
      requestFixture({
        discriminatingEvidence: {
          evidenceTypes: ['IMPLEMENTATION_SUCCESS'],
          question: 'Can the learner implement the loop without errors?',
        },
      }),
    ];
    for (const variant of variants) {
      const outcome = transcribe(variant);
      expect(outcome.ok).to.equal(true);
      if (!outcome.ok) {
        throw new Error('expected ok transcription');
      }
      expect(outcome.spec.specId).to.not.equal(base.spec.specId);
    }
  });

  it('C3. requestId alone is insufficient: same id with different content diverges', () => {
    const base = transcribe(requestFixture());
    const altered = transcribe(requestFixture({ purpose: 'instructional' }));
    expect(base.ok && altered.ok).to.equal(true);
    if (!base.ok || !altered.ok) {
      throw new Error('expected ok transcriptions');
    }
    expect(base.spec.requestId).to.equal(altered.spec.requestId);
    expect(base.spec.specId).to.not.equal(altered.spec.specId);
  });

  it('D. links supersession explicitly without mutating the previous spec', () => {
    const first = transcribe(requestFixture());
    expect(first.ok).to.equal(true);
    if (!first.ok) {
      throw new Error('expected ok transcription');
    }
    const before = JSON.stringify(first.spec);
    const second = transcribe(requestFixture({ requestId: 'genreq_test_2' }), NOW, first.spec.specId);
    expect(second.ok).to.equal(true);
    if (!second.ok) {
      throw new Error('expected ok transcription');
    }
    expect(second.spec.supersedesSpecId).to.equal(first.spec.specId);
    expect(second.spec.specId).to.not.equal(first.spec.specId);
    expect(JSON.stringify(first.spec)).to.equal(before);
    expect('supersedesSpecId' in first.spec).to.equal(false);
    expect(transcribe(requestFixture(), NOW, first.spec.specId).ok).to.equal(false);
  });
});

describe('Phase I Stage 1 — refusal and fail-closed validation', () => {
  it('E. rejects unknown C entities without creating them', () => {
    const outcome = transcribe(requestFixture({ targetEntityIds: ['framework.nope'] }));
    expect(outcome.ok).to.equal(false);
    if (outcome.ok) {
      throw new Error('expected rejection');
    }
    expect(outcome.error.reason).to.include('unknown entity');
  });

  it('F. rejects unknown D dimensions without inventing them', () => {
    const outcome = transcribe(requestFixture({ targetDimensions: ['mastery'] }));
    expect(outcome.ok).to.equal(false);
  });

  it('G. rejects unsupported activity kinds', () => {
    expect(transcribe(requestFixture({ activityKind: 'micro-task' })).ok).to.equal(false);
    expect(transcribe(requestFixture({ activityKind: 'lecture' })).ok).to.equal(false);
  });

  it('H. accepts valid debugging-task requests and rejects payload exclusivity violations', () => {
    const debugging = transcribe(
      requestFixture({
        requestId: 'genreq_dbg_1',
        activityKind: 'debugging-task',
        intent: 'debugging-practice',
        debugContext: { brokenAttemptId: 'att_broken' },
      }),
    );
    expect(debugging.ok).to.equal(true);
    if (!debugging.ok) {
      throw new Error('expected ok transcription');
    }
    expect(debugging.spec.activityRequirements.debugContext).to.deep.equal({ brokenAttemptId: 'att_broken' });
    expect(transcribe(requestFixture({ debugContext: { brokenAttemptId: 'att_x' } })).ok).to.equal(false);
    expect(
      transcribe(requestFixture({ activityKind: 'debugging-task', debugContext: { brokenAttemptId: '' } })).ok,
    ).to.equal(false);
  });

  it('refuses expired requests and empty targeting or criteria', () => {
    expect(transcribe(requestFixture({ budget: { maxCandidates: 3, expiresAt: '2026-07-01T00:00:00.000Z' } })).ok).to.equal(
      false,
    );
    expect(transcribe(requestFixture({ targetEntityIds: [] })).ok).to.equal(false);
    expect(transcribe(requestFixture({ acceptanceCriteria: [] })).ok).to.equal(false);
    expect(transcribe(requestFixture({ requestBasis: { basisKind: 'f2-need' } })).ok).to.equal(false);
  });
});

describe('Phase I Stage 1 — evidence distinction, provenance, privacy, anti-rote', () => {
  it('I. represents expected evidence as a future observation requirement, never learner evidence', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    const serialized = JSON.stringify(outcome.spec);
    for (const key of ['"observation"', '"interpretation"', '"evidenceId"', '"confidence"', '"timestamp"']) {
      expect(serialized).to.not.include(key);
    }
    expect(outcome.spec.expectedEvidence.question).to.include('boundary invariant');
  });

  it('J. keeps request, plan, goal, and origin traceable', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    expect(outcome.spec.source).to.equal('f2-generation-request');
    expect(outcome.spec.requestId).to.equal('genreq_test_1');
    expect(outcome.spec.planId).to.equal('plan_test_1');
    expect(outcome.spec.goalId).to.equal('goal_test_1');
  });

  it('K. copies no learner history, conversation, telemetry, or code into the spec', () => {
    const smuggled = requestFixture({
      fullHistory: [{ attemptId: 'att_x' }],
      conversation: [{ text: 'hello' }],
      insertedText: 'm = l + 1',
      snapshot: 'while (l <= r): pass',
      telemetry: { events: [] },
    });
    const outcome = transcribe(smuggled);
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    const serialized = JSON.stringify(outcome.spec);
    for (const term of ['fullHistory', 'conversation', 'insertedText', 'snapshot', 'telemetry', 'hello', 'att_x']) {
      expect(serialized).to.not.include(term);
    }
    expect(Object.keys(outcome.spec).sort()).to.deep.equal(
      [
        'acceptanceCriteria',
        'activityRequirements',
        'basis',
        'budget',
        'expectedEvidence',
        'goalId',
        'issuedAt',
        'planId',
        'provenance',
        'repetitionJustification',
        'requestId',
        'sandboxAvailable',
        'source',
        'specId',
        'specVersion',
        'validationPlan',
      ].sort(),
    );
  });

  it('L. preserves surface form, transfer, repetition, and constraint-change requirements exactly', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    expect(outcome.spec.activityRequirements.surfaceForm).to.equal('unfamiliar');
    expect(outcome.spec.activityRequirements.transferRequirement).to.include('outside sorted-array');
    expect(outcome.spec.repetitionJustification).to.include('unfamiliar form required');
    expect(outcome.spec.activityRequirements.forbiddenShortcuts).to.deep.equal([
      'blind middle-index template without an invariant check',
    ]);
    expect(outcome.spec.activityRequirements.constraints).to.deep.equal({ timeLimitMs: 2000, languageScope: ['python'] });
  });

  it('binary-search motivating case preserves targeting without learner verdicts', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    const serialized = JSON.stringify(outcome.spec).toLowerCase();
    for (const term of BANNED_OUTPUT_TERMS) {
      expect(serialized).to.not.include(term);
    }
    expect(outcome.spec.basis).to.deep.equal({
      basisKind: 'diagnostic',
      hypothesisKinds: ['boundary-invariant-uncertainty', 'template-perturbation-possibility'],
      basisEvidenceIds: ['ev_1'],
    });
  });
});

describe('Phase I Stage 1 — sandbox-disabled invariance and boundaries', () => {
  it('M. sandbox-gated acceptance cannot become enabled by specification', () => {
    const outcome = transcribe(requestFixture());
    expect(outcome.ok).to.equal(true);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    expect(outcome.spec.sandboxAvailable).to.equal(false);
    const correctness = outcome.spec.validationPlan.find((entry) => entry.stage === 'correctness');
    expect(correctness?.enabled).to.equal(false);
    expect(correctness?.requiresSandbox).to.equal(true);
    expect(outcome.spec.validationPlan.map((entry) => entry.stage).sort()).to.deep.equal(
      ['structural', 'knowledge', 'correctness', 'pedagogical', 'independent-critic'].sort(),
    );
    expect(validateGenerationSpecification({ ...outcome.spec, sandboxAvailable: true })).to.equal(null);
    expect(
      validateGenerationSpecification({
        ...outcome.spec,
        validationPlan: buildValidationPlan().map((entry) =>
          entry.stage === 'correctness' ? { ...entry, enabled: true } : entry,
        ),
      }),
    ).to.equal(null);
    expect(validateGenerationSpecification({ ...outcome.spec, validationPlan: [] })).to.equal(null);
  });

  it('N. transcription mutates nothing and creates no engine artifacts', () => {
    const raw = deepFreeze(requestFixture());
    const before = JSON.stringify(raw);
    const outcome = transcribe(raw);
    expect(outcome.ok).to.equal(true);
    expect(JSON.stringify(raw)).to.equal(before);
    if (!outcome.ok) {
      throw new Error('expected ok transcription');
    }
    const serialized = JSON.stringify(outcome.spec);
    for (const key of ['"candidateId"', '"recommendationId"', '"linkedAttemptId"', '"status"', '"problemId"']) {
      expect(serialized).to.not.include(key);
    }
  });

  it('guards ownership structurally (no frozen-mutation or engine imports)', () => {
    const root = path.join(__dirname, '..', '..', '..');
    for (const file of [
      path.join(root, 'src', 'generation', 'generationSpecification.ts'),
      path.join(root, 'src', 'practice', 'generationRequest.ts'),
    ]) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const forbidden of [
        'transitionGoalStatus',
        'transitionPlanStatus',
        'linkAttemptToPlan',
        'proposeGoalFromNeed',
        'proposeGoalFromRequest',
        'acceptGoal',
        'syncAttemptToLearnerModel',
        'syncRecordsToLearnerModel',
        'appendEvidence',
        'upsertPlan',
        'upsertGoal',
        'upsertProgress',
        'planNextActivity',
        'evaluateActivityProgress',
        'recommendIntervention',
        'saveJsonArray',
        'loadJsonArray',
        'generationStore',
        'candidateStore',
        'recommendationQueue',
        'child_process',
        'spawn(',
        'execFile',
        'hypothesisStore',
      ]) {
        expect(source).to.not.include(forbidden);
      }
    }
    expect(fs.existsSync(path.join(root, 'src', 'generation', 'generationStore.ts'))).to.equal(false);
    expect(fs.existsSync(path.join(root, 'src', 'generation', 'sandbox.ts'))).to.equal(false);
  });

  it('exposes exactly the minimum Stage 1 API surface (allowlist tripwire)', () => {
    expect(Object.keys(generationSpecModule).sort()).to.deep.equal(
      [
        'SPEC_ID_PREFIX',
        'SPEC_SCHEMA_VERSION',
        'SPEC_VALIDATION_STAGES',
        'buildValidationPlan',
        'isKnownSpecValidationStage',
        'specIdForRequest',
        'toGenerationSpecification',
        'validateGenerationSpecification',
      ].sort(),
    );
    expect(Object.keys(generationRequestModule).sort()).to.deep.equal(
      [
        'GENERATION_SURFACE_FORMS',
        'MAX_CRITERION_ID_CHARS',
        'MAX_GENERATION_CANDIDATES',
        'MAX_REQUEST_CRITERIA',
        'MAX_REQUEST_ENTITY_IDS',
        'MAX_REQUEST_EVIDENCE_IDS',
        'MAX_REQUEST_HYPOTHESIS_KINDS',
        'MAX_REQUEST_ID_CHARS',
        'MAX_REQUEST_PROSE_CHARS',
        'MAX_REQUEST_SHORTCUTS',
        'MAX_REQUEST_TEXT_CHARS',
        'isKnownSurfaceForm',
        'validateGenerationRequest',
        'validateRequestConstraints',
      ].sort(),
    );
  });
});
