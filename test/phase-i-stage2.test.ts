import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { toGenerationSpecification } from 'codesense/generation/generationSpecification';
import type { GenerationSpecification } from 'codesense/generation/generationSpecification';
import * as candidateModule from 'codesense/generation/generationCandidate';
import {
  candidateIdFor,
  runStage2Validation,
  validateCandidateConformance,
  validateCandidateKnowledge,
  validateGeneratedCandidate,
} from 'codesense/generation/generationCandidate';
import type { GeneratedCandidate } from 'codesense/generation/generationCandidate';
import * as generatorModule from 'codesense/generation/candidateGenerator';
import {
  AiCandidateGenerator,
  FakeGenerator,
  buildCandidatePrompt,
  generateCandidate,
  parseAiCandidateOutput,
} from 'codesense/generation/candidateGenerator';

/**
 * Phase I Stage 2 — generation engine + structural/knowledge validation.
 *
 * Pins: valid generation → accepted; determinism; malformed/unknown/
 * mismatched candidates → rejected; debugging-task semantics; coding/
 * debugging isolation; privacy (spec-only input); provenance; sandbox
 * fail-closed (execution always blocked, never executed); no learner
 * evidence/model mutation; no persistence; no critic/pedagogy/UI.
 */

const BFS = 'framework.bfs';
const QUEUE_FIFO = 'concept.queue-fifo';
const NOW = '2026-08-10T12:00:00.000Z';

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

function requestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'genreq_stage2_1',
    planId: 'plan_stage2_1',
    goalId: 'goal_stage2_1',
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
    requestBasis: {
      basisKind: 'diagnostic',
      hypothesisKinds: ['boundary-invariant-uncertainty', 'template-perturbation-possibility'],
      basisEvidenceIds: ['ev_1'],
    },
    budget: { maxCandidates: 3, expiresAt: '2026-09-01T00:00:00.000Z' },
    issuedAt: '2026-08-10T10:00:00.000Z',
    provenance: { ontologyVersion: graph().ontologyVersion, aggregatorVersion: '1' },
    ...overrides,
  };
}

function specFixture(overrides: Record<string, unknown> = {}): GenerationSpecification {
  const outcome = toGenerationSpecification(requestFixture(overrides), { graph: graph(), now: NOW });
  expect(outcome.ok).to.equal(true);
  if (!outcome.ok) {
    throw new Error(`fixture spec must transcribe: ${outcome.error.reason}`);
  }
  return outcome.spec;
}

async function validCandidate(spec?: GenerationSpecification): Promise<GeneratedCandidate> {
  const target = spec ?? specFixture();
  const result = await generateCandidate(new FakeGenerator(), target, graph());
  expect(result.status).to.equal('accepted');
  if (result.candidate === undefined) {
    throw new Error('accepted result must carry the candidate');
  }
  return result.candidate;
}

describe('Phase I Stage 2 — generation and acceptance', () => {
  it('A. valid specification → valid candidate → accepted with execution blocked', async () => {
    const spec = specFixture();
    const result = await generateCandidate(new FakeGenerator(), spec, graph());
    expect(result.status).to.equal('accepted');
    expect(result.candidate?.specId).to.equal(spec.specId);
    expect(result.report.verdict).to.equal('accepted');
    const byCheck = new Map(result.report.checks.map((entry) => [entry.check, entry.status] as const));
    expect(byCheck.get('structural')).to.equal('pass');
    expect(byCheck.get('spec-conformance')).to.equal('pass');
    expect(byCheck.get('knowledge-graph')).to.equal('pass');
    expect(byCheck.get('execution')).to.equal('blocked');
  });

  it('B. same specification + deterministic fake generator → same identity and provenance', async () => {
    const spec = specFixture();
    const first = await validCandidate(spec);
    const second = await validCandidate(spec);
    expect(first.candidateId).to.equal(second.candidateId);
    expect(JSON.stringify(first)).to.equal(JSON.stringify(second));
    expect(first.candidateId).to.equal(candidateIdFor(spec.specId, 1, first.title, first.taskDescription));
    expect(first.provenance).to.deep.equal({
      specId: spec.specId,
      requestId: spec.requestId,
      planId: spec.planId,
      goalId: spec.goalId,
      generatorId: 'fake-deterministic',
      generatorVersion: '1',
    });
  });

  it('C. malformed candidate output → rejected, never accepted', async () => {
    const spec = specFixture();
    for (const payload of [null, 'not json', 42, [], {}, { candidateId: 'cand_x' }]) {
      const result = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload }]), spec, graph());
      expect(result.status).to.equal('rejected');
      expect(result.candidate).to.equal(undefined);
      expect(result.report.verdict).to.equal('rejected');
    }
  });

  it('D. candidate with unknown C entity → rejected at knowledge validation', async () => {
    const candidate = await validCandidate();
    const tampered = { ...candidate, targetEntityIds: ['framework.nope'] };
    expect(validateCandidateKnowledge(tampered, graph()).ok).to.equal(false);
    // Pipeline layer also refuses (conformance trips first on retargeting).
    const spec = specFixture();
    expect((await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: tampered }]), spec, graph())).status).to.equal(
      'rejected',
    );
  });

  it('E. candidate contradicting the target dimension → rejected', async () => {
    const spec = specFixture();
    const candidate = await validCandidate(spec);
    const tampered = { ...candidate, targetDimensions: ['implementation'] };
    const result = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: tampered }]), spec, graph());
    expect(result.status).to.equal('rejected');
  });

  it('F. debugging-task spec with coding-problem candidate → rejected (kind mismatch)', async () => {
    const debuggingSpec = specFixture({
      requestId: 'genreq_stage2_dbg',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
      debugContext: { brokenAttemptId: 'att_broken' },
    });
    const codingCandidate = await validCandidate(specFixture());
    const result = await generateCandidate(
      new FakeGenerator([{ mode: 'raw', payload: codingCandidate }]),
      debuggingSpec,
      graph(),
    );
    expect(result.status).to.equal('rejected');
    expect(result.diagnostics.join(' ')).to.include('kind mismatch');
  });

  it('G. candidate explicitly permitting a forbidden shortcut → rejected', async () => {
    const spec = specFixture();
    const candidate = await validCandidate(spec);
    const tampered = {
      ...candidate,
      taskDescription: `${candidate.taskDescription} You may use library binary search to solve it quickly.`,
    };
    const result = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: tampered }]), spec, graph());
    expect(result.status).to.equal('rejected');
    expect(result.diagnostics.join(' ')).to.include('forbidden shortcut');
  });

  it('H. valid debugging candidate accepted; malformed debugging payload rejected', async () => {
    const spec = specFixture({
      requestId: 'genreq_stage2_dbg2',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
      debugContext: { brokenAttemptId: 'att_broken' },
    });
    const accepted = await generateCandidate(
      new FakeGenerator(),
      spec,
      graph(),
      { brokenSnapshot: 'while (l <= r): pass', referenceFix: 'while (l < r): pass', tests: ['terminates'] },
    );
    expect(accepted.status).to.equal('accepted');
    expect(accepted.candidate?.debugging?.tests).to.deep.equal(['terminates']);
    const candidate = await validCandidate(spec);
    const broken = { ...candidate, debugging: { brokenSnapshot: 'x', referenceFix: 'y', tests: [] } };
    expect(validateGeneratedCandidate(broken)).to.equal(null);
    const missing = { ...candidate };
    delete (missing as unknown as Record<string, unknown>).debugging;
    expect(validateGeneratedCandidate(missing)).to.equal(null);
  });

  it('I. coding problem carrying debugging-only payload → rejected (no cross-contamination)', async () => {
    const spec = specFixture();
    const candidate = await validCandidate(spec);
    const tampered = {
      ...candidate,
      debugging: { brokenSnapshot: 'x', referenceFix: 'y', tests: ['t'] },
    };
    expect(validateGeneratedCandidate(tampered)).to.equal(null);
    const result = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: tampered }]), spec, graph());
    expect(result.status).to.equal('rejected');
  });

  it('J. each specification field mismatch is detected (entity, dimension, kind, purpose, constraint, shortcut, criterion)', async () => {
    const spec = specFixture();
    const base = await validCandidate(spec);
    const variants: Array<{ name: string; mutate: (candidate: GeneratedCandidate) => unknown }> = [
      { name: 'entity', mutate: (c) => ({ ...c, targetEntityIds: [QUEUE_FIFO] }) },
      { name: 'dimension', mutate: (c) => ({ ...c, targetDimensions: ['transfer'] }) },
      {
        name: 'kind',
        mutate: (c) => {
          const copy = { ...c, activityKind: 'debugging-task' as const };
          delete (copy as unknown as Record<string, unknown>).debugging;
          return copy;
        },
      },
      { name: 'purpose', mutate: (c) => ({ ...c, purpose: 'instructional' as const }) },
      {
        name: 'constraint',
        mutate: (c) => ({ ...c, constraints: { timeLimitMs: 9999, languageScope: ['python'] } }),
      },
      { name: 'shortcut-dropped', mutate: (c) => ({ ...c, forbiddenShortcuts: [] }) },
      { name: 'criterion-removed', mutate: (c) => ({ ...c, acceptanceCriteria: [] }) },
      {
        name: 'criterion-reworded',
        mutate: (c) => ({
          ...c,
          acceptanceCriteria: [{ criterionId: 'discriminating-case', description: 'Something easier.' }],
        }),
      },
    ];
    for (const variant of variants) {
      const result = await generateCandidate(
        new FakeGenerator([{ mode: 'raw', payload: variant.mutate(base) }]),
        spec,
        graph(),
      );
      expect(result.status, variant.name).to.equal('rejected');
    }
  });

  it('K. unknown C entity fails closed at the knowledge layer', () => {
    const candidate: GeneratedCandidate = {
      candidateId: 'cand_probe',
      candidateVersion: 1,
      specId: 'spec_probe',
      activityKind: 'coding-problem',
      title: 'Probe',
      taskDescription: 'Probe task.',
      targetEntityIds: ['pattern.no-such-thing'],
      targetDimensions: ['conceptual'],
      surfaceForm: 'familiar',
      constraints: { languageScope: ['python'] },
      forbiddenShortcuts: [],
      expectedEvidence: { dimensions: ['conceptual'], evidenceTypes: ['CONCEPTUAL_SUCCESS'], question: 'Q?' },
      intent: 'conceptual-practice',
      purpose: 'diagnostic',
      acceptanceCriteria: [],
      provenance: {
        specId: 'spec_probe',
        requestId: 'genreq_probe',
        planId: 'plan_probe',
        goalId: 'goal_probe',
        generatorId: 'probe',
        generatorVersion: '1',
      },
    };
    const outcome = validateCandidateKnowledge(candidate, graph());
    expect(outcome.ok).to.equal(false);
  });

  it('L. C graph is never mutated by generation or validation', async () => {
    const before = JSON.stringify({
      count: graph().entityCount,
      entity: graph().getEntity(BFS),
    });
    const spec = specFixture();
    await generateCandidate(new FakeGenerator(), spec, graph());
    const candidate = await validCandidate(spec);
    validateCandidateConformance(spec, candidate);
    validateCandidateKnowledge(candidate, graph());
    expect(JSON.stringify({ count: graph().entityCount, entity: graph().getEntity(BFS) })).to.equal(before);
  });

  it('M. generation creates no learner evidence and touches no stores', async () => {
    const spec = specFixture();
    const result = await generateCandidate(new FakeGenerator(), spec, graph());
    const serialized = JSON.stringify(result);
    for (const key of ['"evidenceId"', '"observation"', '"interpretation"', '"LearnerEvidence"', '"progressSignal"']) {
      expect(serialized).to.not.include(key);
    }
    expect(result.candidate === undefined || !('attemptId' in result.candidate)).to.equal(true);
  });
});

describe('Phase I Stage 2 — sandbox, AI seam, privacy, provenance', () => {
  it('N. no D state is read or mutated (spec-only pipeline)', async () => {
    const spec = specFixture();
    const result = await generateCandidate(new FakeGenerator(), spec, graph());
    expect(result.status).to.equal('accepted');
    const serialized = JSON.stringify(result);
    for (const key of ['"knowledgeStates"', '"totalEvidenceCount"', '"learnerId"']) {
      expect(serialized).to.not.include(key);
    }
  });

  it('O. generated executable-looking content is never executed', async () => {
    const spec = specFixture({
      requestId: 'genreq_stage2_exec',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
      debugContext: { brokenAttemptId: 'att_exec' },
    });
    const hostile = {
      brokenSnapshot: 'import os; os._exit(42)',
      referenceFix: 'process.exit(42); eval("boom")',
      tests: ['exits immediately'],
    };
    const result = await generateCandidate(new FakeGenerator(), spec, graph(), hostile);
    // If anything executed the payload, this process would be dead.
    expect(result.status).to.equal('accepted');
    expect(process.exitCode).to.equal(undefined);
  });

  it('P. correctness-dependent acceptance stays blocked, never passed', async () => {
    const result = await generateCandidate(new FakeGenerator(), specFixture(), graph());
    const execution = result.report.checks.find((entry) => entry.check === 'execution');
    expect(execution?.status).to.equal('blocked');
    expect(result.report.checks.some((entry) => entry.status === 'pass' && entry.check === 'execution')).to.equal(false);
  });

  it('Q. malformed AI output → rejected; prompt carries spec only', async () => {
    expect(parseAiCandidateOutput('not json').ok).to.equal(false);
    expect(parseAiCandidateOutput(null).ok).to.equal(false);
    expect(parseAiCandidateOutput([1, 2]).ok).to.equal(false);
    const seen: unknown[] = [];
    const generator = new AiCandidateGenerator(async (prompt) => {
      seen.push(prompt);
      return 'still not json';
    });
    const result = await generateCandidate(generator, specFixture(), graph());
    expect(result.status).to.equal('rejected');
    expect(result.candidate).to.equal(undefined);
    const prompt = seen[0] as { system: string; user: string };
    expect(prompt.user).to.include('genreq_stage2_1');
    const promptText = JSON.stringify(prompt).toLowerCase();
    for (const term of ['local-learner', 'evidenceid', 'telemetry', 'conversation']) {
      expect(promptText).to.not.include(term);
    }
  });

  it('R. provider failure → structured unavailable, no partial candidate', async () => {
    const generator = new AiCandidateGenerator(async () => {
      throw new Error('provider down');
    });
    const result = await generateCandidate(generator, specFixture(), graph());
    expect(result.status).to.equal('unavailable');
    expect(result.candidate).to.equal(undefined);
    expect(result.report.verdict).to.equal('unavailable');
    const throwing = {
      generatorId: 'throwing',
      generate: (): never => {
        throw new Error('boom');
      },
    };
    const thrown = await generateCandidate(throwing, specFixture(), graph());
    expect(thrown.status).to.equal('unavailable');
    expect(thrown.candidate).to.equal(undefined);
  });

  it('S. generation input is the specification plus bounded context — nothing else', async () => {
    const spec = specFixture();
    const seen: Array<{ specification: unknown; context: unknown }> = [];
    const generator = new FakeGenerator();
    const original = generator.generate.bind(generator);
    const recording = {
      generatorId: generator.generatorId,
      generate: (specification: unknown, context: unknown) => {
        seen.push({ specification, context });
        return original(specification as GenerationSpecification, context as never);
      },
    };
    await generateCandidate(recording, spec, graph());
    expect(seen.length).to.equal(1);
    expect(Object.keys(seen[0] as object).sort()).to.deep.equal(['context', 'specification']);
    expect((seen[0] as { specification: GenerationSpecification }).specification.specId).to.equal(spec.specId);
  });

  it('T. accepted and rejected results stay traceable to spec/request/plan/goal', async () => {
    const spec = specFixture();
    const accepted = await generateCandidate(new FakeGenerator(), spec, graph());
    expect(accepted.report.specId).to.equal(spec.specId);
    expect(accepted.report.candidateId).to.equal(accepted.candidate?.candidateId);
    const rejected = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: null }]), spec, graph());
    expect(rejected.report.specId).to.equal(spec.specId);
    expect(rejected.report.candidateId).to.equal('unknown');
  });
});

describe('Phase I Stage 2 — binary-search diagnostic-intent regression', () => {
  it('preserves unfamiliar transfer targeting and never emits learner verdicts', async () => {
    const spec = specFixture();
    const result = await generateCandidate(new FakeGenerator(), spec, graph());
    expect(result.status).to.equal('accepted');
    if (result.candidate === undefined) {
      throw new Error('expected accepted candidate');
    }
    expect(result.candidate.surfaceForm).to.equal('unfamiliar');
    expect(result.candidate.forbiddenShortcuts).to.deep.equal(['library binary search']);
    expect(result.candidate.expectedEvidence.question).to.include('boundary invariant');
    expect(result.candidate.surfaceEvidence?.changedElements.length ?? 0).to.be.greaterThan(0);
    const serialized = JSON.stringify(result).toLowerCase();
    for (const term of BANNED_OUTPUT_TERMS) {
      expect(serialized).to.not.include(term);
    }
    // A tampered familiar-form rewrite of the same diagnostic intent is refused.
    const tampered = { ...result.candidate, surfaceForm: 'familiar' as const };
    const rewrite = await generateCandidate(new FakeGenerator([{ mode: 'raw', payload: tampered }]), spec, graph());
    expect(rewrite.status).to.equal('rejected');
  });
});

describe('Phase I Stage 2 — frozen boundaries and public API', () => {
  it('imports no subsystem implementation (vocabulary and validators only)', () => {
    const root = path.join(__dirname, '..', '..', '..');
    // Allowed import sources: frozen vocabulary/types, pure validators, and
    // the F2 request + Stage 1 spec contracts Stage 2 is specified to read.
    const allowedSources = [
      '../learner/learnerTypes',
      '../knowledge/ontologyStore',
      '../practice/activityTypes',
      '../practice/generationRequest',
      './generationSpecification',
      './generationCandidate',
      './diagnose',
    ];
    for (const file of [
      path.join(root, 'src', 'generation', 'generationCandidate.ts'),
      path.join(root, 'src', 'generation', 'candidateGenerator.ts'),
    ]) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const line of source.split('\n')) {
        const match = line.match(/^\s*import .* from '([^']+)'/);
        if (match) {
          expect(allowedSources, `import source in ${path.basename(file)}`).to.include(match[1]);
        }
      }
      // Execution primitives are banned everywhere in Stage 2, including
      // comments: generated code must never be executed by any path.
      for (const forbidden of [
        'eval(',
        'Function(',
        'child_process',
        'spawn(',
        'execFile',
        'node:vm',
        'saveJsonArray',
        'loadJsonArray',
      ]) {
        expect(source).to.not.include(forbidden);
      }
    }
  });

  it('exposes exactly the minimum Stage 2 API surface (allowlist tripwire)', () => {
    expect(Object.keys(candidateModule).sort()).to.deep.equal(
      [
        'CANDIDATE_ID_PREFIX',
        'MAX_CANDIDATE_ID_CHARS',
        'MAX_CANDIDATE_SHORTCUTS',
        'MAX_CANDIDATE_STATEMENT_CHARS',
        'MAX_CANDIDATE_SURFACE_ELEMENTS',
        'MAX_CANDIDATE_TEXT_CHARS',
        'MAX_CANDIDATE_TITLE_CHARS',
        'MAX_CHECK_DETAIL_CHARS',
        'MAX_MISMATCHES',
        'VALIDATION_CHECK_NAMES',
        'candidateIdFor',
        'rejectedUnknownResult',
        'runStage2Validation',
        'validateCandidateConformance',
        'validateCandidateKnowledge',
        'validateGeneratedCandidate',
      ].sort(),
    );
    expect(Object.keys(generatorModule).sort()).to.deep.equal(
      [
        'AI_GENERATOR_VERSION',
        'AiCandidateGenerator',
        'FAKE_GENERATOR_ID',
        'FAKE_GENERATOR_VERSION',
        'FakeGenerator',
        'buildCandidatePrompt',
        'generateCandidate',
        'parseAiCandidateOutput',
      ].sort(),
    );
  });
});
