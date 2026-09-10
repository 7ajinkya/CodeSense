import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { toGenerationSpecification } from 'codesense/generation/generationSpecification';
import type { GenerationSpecification } from 'codesense/generation/generationSpecification';
import { FakeGenerator, generateCandidate } from 'codesense/generation/candidateGenerator';
import type { GeneratedCandidate } from 'codesense/generation/generationCandidate';
import {
  PEDAGOGICAL_CRITERIA,
  detectOutOfScopeReferences,
  runDeterministicPedagogicalChecks,
} from 'codesense/generation/pedagogicalChecks';
import type { PedagogicalCriterion } from 'codesense/generation/pedagogicalChecks';
import * as checksModule from 'codesense/generation/pedagogicalChecks';
import * as criticModule from 'codesense/generation/pedagogicalCritic';
import {
  AiCritic,
  FakeCritic,
  buildCriticPrompt,
  parseCriticFindings,
  resolveVerdict,
  toCriticView,
  validatePedagogically,
} from 'codesense/generation/pedagogicalCritic';


/**
 * Phase I Stage 3 — pedagogical validation + independent critic.
 *
 * Pins: seven-criterion rubric behavior, deterministic pre-gates with
 * honest limits, critic independence/privacy, scope-creep dropping,
 * precedence and uncertainty policy, binary-search transfer and debugging
 * canonical cases, execution/persistence boundaries, and export tripwires.
 * No numeric standing of any kind exists anywhere in this layer.
 */

const BS = 'framework.binary-search';
const RECURSION = 'framework.recursion';
const NOW = '2026-08-20T12:00:00.000Z';

function graph(): KnowledgeGraph {
  return getDefaultKnowledgeGraph();
}

function requestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'genreq_stage3_1',
    planId: 'plan_stage3_1',
    goalId: 'goal_stage3_1',
    activityKind: 'coding-problem',
    intent: 'conceptual-practice',
    purpose: 'diagnostic',
    targetEntityIds: [BS],
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
    issuedAt: '2026-08-20T10:00:00.000Z',
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

async function candidateFixture(spec?: GenerationSpecification): Promise<GeneratedCandidate> {
  const target = spec ?? specFixture();
  const result = await generateCandidate(new FakeGenerator(), target, graph());
  expect(result.status).to.equal('accepted');
  if (result.candidate === undefined) {
    throw new Error('fixture candidate must be accepted');
  }
  return result.candidate;
}

function finding(
  criterion: PedagogicalCriterion,
  status: 'pass' | 'fail' | 'uncertain',
  reason: string,
  criticConfidence: 'high' | 'medium' | 'low' = 'high',
): Record<string, unknown> {
  return { criterion, status, criticConfidence, reason };
}

function passAllFindings(): Record<string, unknown>[] {
  return PEDAGOGICAL_CRITERIA.map((criterion) =>
    finding(criterion, 'pass', `Scripted pass for ${criterion}.`),
  );
}

async function validateWithFindings(
  spec: GenerationSpecification,
  candidate: GeneratedCandidate,
  findings: Record<string, unknown>[],
) {
  return validatePedagogically(spec, candidate, graph(), new FakeCritic([{ mode: 'findings', findings }]));
}

describe('Phase I Stage 3 — rubric coverage (each criterion isolated)', () => {
  it('fails exactly the targeted criterion while others pass', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const findings = passAllFindings().map((entry) =>
      entry.criterion === 'evidence-observability'
        ? finding('evidence-observability', 'fail', 'Task ships the full solution; nothing remains observable.', 'medium')
        : entry,
    );
    const result = await validateWithFindings(spec, candidate, findings);
    const byCriterion = new Map(result.criteria.map((entry) => [entry.criterion, entry] as const));
    expect(byCriterion.get('evidence-observability')?.status).to.equal('fail');
    expect(byCriterion.get('evidence-observability')?.source).to.equal('critic');
    for (const criterion of PEDAGOGICAL_CRITERIA) {
      if (criterion !== 'evidence-observability') {
        expect(byCriterion.get(criterion)?.status).to.equal('pass');
      }
    }
    expect(result.verdict).to.equal('revise');
    expect(result.executionUnverified).to.equal(true);
  });

  it('resolves uncertainty without manufacturing certainty', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const findings = passAllFindings().map((entry) =>
      entry.criterion === 'challenge-purpose-fit'
        ? finding('challenge-purpose-fit', 'uncertain', 'Cannot tell from text alone whether noise dominates.')
        : entry,
    );
    const result = await validateWithFindings(spec, candidate, findings);
    expect(result.criteria.find((entry) => entry.criterion === 'challenge-purpose-fit')?.status).to.equal('uncertain');
    expect(result.verdict).to.equal('revise');
  });

  it('passes all seven with sources recorded and provenance versioned', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const result = await validateWithFindings(spec, candidate, passAllFindings());
    expect(result.criteria.map((entry) => entry.criterion)).to.deep.equal([...PEDAGOGICAL_CRITERIA]);
    expect(result.criteria.every((entry) => entry.status === 'pass')).to.equal(true);
    expect(result.verdict).to.equal('pass');
    expect(result.provenance).to.deep.equal({ validatorVersion: '1', rubricVersion: '1', criticId: 'fake-critic' });
    expect(result.hardFailures).to.deep.equal([]);
    expect(result.specId).to.equal(spec.specId);
    expect(result.candidateId).to.equal(candidate.candidateId);
  });
});

describe('Phase I Stage 3 — deterministic pre-gates and their limits', () => {
  it('fails target-engagement only on obvious vocabulary omission', () => {
    const spec = specFixture();
    expect(graph().hasEntity(BS)).to.equal(true);
    const offTopic = {
      title: 'Merge the sorted halves',
      taskDescription: 'Sort the array using merge sort and count inversions while merging runs together.',
    };
    const findings = runDeterministicPedagogicalChecks(
      spec,
      { title: offTopic.title, taskDescription: offTopic.taskDescription } as GeneratedCandidate,
      graph(),
    );
    expect(findings.some((entry) => entry.criterion === 'target-engagement' && entry.status === 'fail')).to.equal(true);
  });

  it('does not claim genuine requirement from vocabulary presence', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    // Fake text mentions the entity, so no deterministic failure fires here.
    const findings = runDeterministicPedagogicalChecks(spec, candidate, graph());
    expect(findings.some((entry) => entry.criterion === 'target-engagement')).to.equal(false);
    // The genuine-requirement judgment still belongs to the critic.
    const result = await validateWithFindings(
      spec,
      candidate,
      passAllFindings().map((entry) =>
        entry.criterion === 'target-engagement'
          ? finding('target-engagement', 'fail', 'Text names binary search but the steps never use it.', 'medium')
          : entry,
      ),
    );
    expect(result.criteria.find((entry) => entry.criterion === 'target-engagement')?.source).to.equal('critic');
    expect(result.verdict).to.equal('revise');
  });

  it('fails closed on malformed inputs without invoking the critic', async () => {
    const critic = new FakeCritic();
    const result = await validatePedagogically({ nope: true }, { nope: true }, graph(), critic);
    expect(result.verdict).to.equal('reject');
    expect(result.criteria).to.have.lengthOf(7);
    expect(result.criteria.every((entry) => entry.status === 'fail')).to.equal(true);
    expect(result.hardFailures.length).to.be.greaterThan(0);
    expect(result.executionUnverified).to.equal(true);
    expect(critic.seen).to.have.lengthOf(0);
  });

  it('flags reference-fix leakage and identical broken/fixed artifacts deterministically', async () => {
    const spec = specFixture({
      requestId: 'genreq_stage3_dbg',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
    });
    const candidate = await candidateFixture(spec);
    expect(candidate.debugging).to.not.equal(undefined);
    const leaked = {
      ...candidate,
      taskDescription: `${candidate.taskDescription}\nFixed version:\n${candidate.debugging?.referenceFix ?? ''}`,
    };
    const leakage = runDeterministicPedagogicalChecks(spec, leaked, graph());
    expect(leakage.some((entry) => entry.criterion === 'evidence-observability' && entry.status === 'fail')).to.equal(true);
    const identical = {
      ...candidate,
      debugging: { ...(candidate.debugging as object), referenceFix: candidate.debugging?.brokenSnapshot },
    };
    const sameness = runDeterministicPedagogicalChecks(spec, identical as GeneratedCandidate, graph());
    expect(sameness.some((entry) => entry.criterion === 'debugging-genuineness' && entry.status === 'fail')).to.equal(true);
  });

  it('fails linkage when the candidate points at another specification', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const relinked = { ...candidate, specId: 'spec_elsewhere' };
    const findings = runDeterministicPedagogicalChecks(spec, relinked, graph());
    expect(findings.some((entry) => entry.criterion === 'internal-consistency' && entry.status === 'fail')).to.equal(true);
  });
});

describe('Phase I Stage 3 — binary-search transfer canonical cases', () => {
  it('cosmetic rename fails transfer-anti-rote and rejects', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const cosmetic = {
      ...candidate,
      title: 'Binary search with left, right, middle',
      taskDescription:
        'Implement binary search over a sorted array using left, right, and middle variables. Binary search halves the interval until found.',
      surfaceEvidence: {
        contextDescription: 'Renamed variables only.',
        changedElements: ['renamed l/r/m to left/right/middle'],
      },
    };
    const result = await validateWithFindings(
      spec,
      cosmetic,
      passAllFindings().map((entry) =>
        entry.criterion === 'transfer-anti-rote'
          ? finding(
              'transfer-anti-rote',
              'fail',
              'Only variable names changed; the sorted-array framing, invariant, and boundary mechanics are identical.',
            )
          : entry,
      ),
    );
    expect(result.criteria.find((entry) => entry.criterion === 'transfer-anti-rote')?.status).to.equal('fail');
    expect(result.verdict).to.equal('reject');
  });

  it('meaningful transfer passes where every other criterion passes', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const meaningful = {
      ...candidate,
      taskDescription:
        'Binary search over a rotated production quota table: reason about the changed monotonicity boundary convention to locate the quota transition. Binary search invariant must be restated for the new mechanics.',
      surfaceEvidence: {
        contextDescription: 'Quota-table framing with a shifted boundary convention.',
        changedElements: ['rotated quota-table context', 'shifted boundary convention', 'restated invariant demand'],
      },
    };
    const result = await validateWithFindings(spec, meaningful, passAllFindings());
    expect(result.verdict).to.equal('pass');
    expect(result.criteria.find((entry) => entry.criterion === 'transfer-anti-rote')?.status).to.equal('pass');
    expect(result.criteria.find((entry) => entry.criterion === 'target-engagement')?.status).to.equal('pass');
    expect(result.criteria.find((entry) => entry.criterion === 'evidence-observability')?.status).to.equal('pass');
  });
});

describe('Phase I Stage 3 — debugging-task canonical cases', () => {
  it('trivial syntax break does not pass where meaningful debugging is required', async () => {
    const spec = specFixture({
      requestId: 'genreq_stage3_dbg2',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
    });
    const candidate = await candidateFixture(spec);
    const trivial = {
      ...candidate,
      debugging: {
        brokenSnapshot: 'while (l < r)\n    m = (l + r) // 2',
        referenceFix: 'while (l < r):\n    m = (l + r) // 2',
        tests: ['parses without syntax errors'],
      },
    };
    const result = await validateWithFindings(
      spec,
      trivial,
      passAllFindings().map((entry) =>
        entry.criterion === 'debugging-genuineness'
          ? finding('debugging-genuineness', 'fail', 'Single missing colon; no localization or invariant reasoning required.')
          : entry,
      ),
    );
    expect(result.criteria.find((entry) => entry.criterion === 'debugging-genuineness')?.status).to.equal('fail');
    expect(result.verdict).to.not.equal('pass');
  });

  it('genuine boundary/invariant fault passes where the spec supports it', async () => {
    const spec = specFixture({
      requestId: 'genreq_stage3_dbg3',
      activityKind: 'debugging-task',
      intent: 'debugging-practice',
    });
    const candidate = await candidateFixture(spec);
    const genuine = {
      ...candidate,
      debugging: {
        brokenSnapshot: 'while (l <= r):\n    m = (l + r) // 2\n    updating bounds inconsistently',
        referenceFix: 'while (l < r):\n    m = (l + r) // 2\n    updating bounds against the invariant',
        tests: ['loop terminates on a two-element input', 'failing edge reproduces before the fix'],
      },
    };
    const result = await validateWithFindings(spec, genuine, passAllFindings());
    expect(result.criteria.find((entry) => entry.criterion === 'debugging-genuineness')?.status).to.equal('pass');
  });
});

describe('Phase I Stage 3 — precedence, determinism, and uncertainty', () => {
  it('deterministic fail beats AI pass; deterministic outcome wins ties', () => {
    const detFail = [{ criterion: 'internal-consistency' as PedagogicalCriterion, status: 'fail' as const, reason: 'Points elsewhere.' }];
    const allPass = PEDAGOGICAL_CRITERIA.map((criterion) => ({
      criterion,
      status: 'pass' as const,
      criticConfidence: 'high' as const,
      reason: `ok ${criterion}.`,
    }));
    const peripheral = resolveVerdict({ deterministic: detFail, findings: allPass, dropped: [] });
    expect(peripheral.verdict).to.equal('revise');
    const loadBearing = resolveVerdict({
      deterministic: [{ criterion: 'target-engagement', status: 'fail', reason: 'No vocab.' }],
      findings: allPass,
      dropped: [],
    });
    expect(loadBearing.verdict).to.equal('reject');
    expect(loadBearing.hardFailures).to.have.lengthOf(1);
  });

  it('critic outcomes resolve per rule: high load-bearing fail rejects, others revise', () => {
    const strong = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: criterion === 'shortcut-resistance' ? ('fail' as const) : ('pass' as const),
        criticConfidence: 'high' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(strong.verdict).to.equal('reject');
    const soft = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: criterion === 'shortcut-resistance' ? ('fail' as const) : ('pass' as const),
        criticConfidence: 'medium' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(soft.verdict).to.equal('revise');
    const peripheralFail = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: criterion === 'challenge-purpose-fit' ? ('fail' as const) : ('pass' as const),
        criticConfidence: 'high' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(peripheralFail.verdict).to.equal('revise');
  });

  it('uncertainty never passes: load-bearing and peripheral alike floor at revise', () => {
    const loadUncertain = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: criterion === 'evidence-observability' ? ('uncertain' as const) : ('pass' as const),
        criticConfidence: 'low' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(loadUncertain.verdict).to.equal('revise');
    const peripheralUncertain = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: criterion === 'internal-consistency' ? ('uncertain' as const) : ('pass' as const),
        criticConfidence: 'low' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(peripheralUncertain.verdict).to.equal('revise');
    const clean = resolveVerdict({
      deterministic: [],
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        criticConfidence: 'high' as const,
        reason: `judged ${criterion}.`,
      })),
      dropped: [],
    });
    expect(clean.verdict).to.equal('pass');
  });

  it('verdict is independent of finding order and pipeline repetition', async () => {
    const reversed: Record<string, unknown>[] = [...passAllFindings()].reverse().map((entry, index) => ({
      ...entry,
      reason: `Scripted pass ${index}.`,
    }));
    const forward = resolveVerdict({
      deterministic: [],
      findings: passAllFindings().map((entry) => ({
        criterion: entry.criterion as PedagogicalCriterion,
        status: 'pass' as const,
        criticConfidence: 'high' as const,
        reason: entry.reason as string,
      })),
      dropped: [],
    });
    const backward = resolveVerdict({
      deterministic: [],
      findings: reversed.map((entry) => ({
        criterion: entry.criterion as PedagogicalCriterion,
        status: 'pass' as const,
        criticConfidence: 'high' as const,
        reason: entry.reason as string,
      })),
      dropped: [],
    });
    expect(backward.verdict).to.equal(forward.verdict);
    expect(backward.hardFailures).to.deep.equal(forward.hardFailures);
    expect(
      backward.results.map((entry) => `${entry.criterion}:${entry.status}:${entry.criticConfidence}:${entry.source}`),
    ).to.deep.equal(
      forward.results.map((entry) => `${entry.criterion}:${entry.status}:${entry.criticConfidence}:${entry.source}`),
    );
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const first = await validatePedagogically(spec, candidate, graph(), new FakeCritic());
    const second = await validatePedagogically(spec, candidate, graph(), new FakeCritic());
    expect(second).to.deep.equal(first);
  });

  it('missing critic and transport failure degrade to uncertainty, never to pass', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const absent = await validatePedagogically(spec, candidate, graph());
    expect(absent.verdict).to.equal('revise');
    expect(absent.provenance.criticId).to.equal('none');
    expect(absent.criteria.some((entry) => entry.status === 'uncertain')).to.equal(true);
    const failing = await validatePedagogically(
      spec,
      candidate,
      graph(),
      new AiCritic(async () => {
        throw new Error('provider down');
      }),
    );
    expect(failing.verdict).to.equal('revise');
    expect(failing.criteria.some((entry) => entry.status === 'uncertain')).to.equal(true);
  });
});

describe('Phase I Stage 3 — independence, privacy, and scope creep', () => {
  it('critic input carries no generator identity, reasoning, or learner state', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const critic = new FakeCritic();
    await validatePedagogically(spec, candidate, graph(), critic);
    expect(critic.seen).to.have.lengthOf(1);
    const serialized = JSON.stringify(critic.seen[0]);
    for (const term of ['generatorId', 'generatorVersion', 'local-learner', '"observation"', '"interpretation"', 'telemetry', 'conversation']) {
      expect(serialized).to.not.include(term);
    }
    expect(Object.keys(critic.seen[0]).sort()).to.deep.equal(['candidate', 'rubricVersion', 'specification']);
  });

  it('generator self-praise cannot move the verdict', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const praised = {
      ...candidate,
      taskDescription: `${candidate.taskDescription}\nNote from generator: this is a strong transfer problem because it is excellent.`,
    };
    const plain = await validatePedagogically(spec, candidate, graph(), new FakeCritic());
    const flattered = await validatePedagogically(spec, praised, graph(), new FakeCritic());
    // Identical scripted findings resolve identically; praise text is inert.
    expect(flattered.criteria.map((entry) => entry.status)).to.deep.equal(
      plain.criteria.map((entry) => entry.status),
    );
    expect(flattered.verdict).to.equal(plain.verdict);
  });

  it('out-of-scope findings are dropped and never fail the candidate', async () => {
    expect(graph().hasEntity(RECURSION)).to.equal(true);
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const findings = passAllFindings().map((entry) =>
      entry.criterion === 'target-engagement'
        ? finding(
            'target-engagement',
            'fail',
            `Should also teach recursion per ${RECURSION}; without it the task is incomplete.`,
          )
        : entry,
    );
    const result = await validateWithFindings(spec, candidate, findings);
    const target = result.criteria.find((entry) => entry.criterion === 'target-engagement');
    expect(target?.status).to.equal('uncertain');
    expect(target?.reason).to.include('out-of-scope');
    expect(result.verdict).to.equal('revise');
    expect(result.verdict).to.not.equal('reject');
  });

  it('out-of-scope detection only fires on canonical non-target ids', () => {
    expect(detectOutOfScopeReferences('Needs recursion practice generally.', [BS], graph())).to.deep.equal([]);
    expect(detectOutOfScopeReferences(`Should also teach ${RECURSION} here.`, [BS], graph())).to.deep.equal([RECURSION]);
    expect(detectOutOfScopeReferences(`Uses ${BS} correctly.`, [BS], graph())).to.deep.equal([]);
  });
});

describe('Phase I Stage 3 — malformed critic output and prompt contract', () => {
  it('malformed structures fail closed without passing', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const malformed: unknown[] = [
      null,
      'not json',
      { findings: [] },
      { findings: passAllFindings().slice(0, 6) },
      { findings: [...passAllFindings(), passAllFindings()[0]] },
      {
        findings: passAllFindings().map((entry) =>
          entry.criterion === 'target-engagement' ? { ...entry, criterion: 'invented-criterion' } : entry,
        ),
      },
      {
        findings: passAllFindings().map((entry) =>
          entry.criterion === 'target-engagement' ? { ...entry, status: 'maybe' } : entry,
        ),
      },
      {
        findings: passAllFindings().map((entry) =>
          entry.criterion === 'target-engagement' ? { ...entry, criticConfidence: 'certain' } : entry,
        ),
      },
      {
        findings: passAllFindings().map((entry) =>
          entry.criterion === 'target-engagement' ? { ...entry, reason: '  ' } : entry,
        ),
      },
      {
        findings: passAllFindings().map((entry) =>
          entry.criterion === 'target-engagement' ? { ...entry, reason: 'x'.repeat(501) } : entry,
        ),
      },
    ];
    for (const payload of malformed) {
      const result = await validatePedagogically(spec, candidate, graph(), new FakeCritic([{ mode: 'raw', payload }]));
      expect(result.verdict).to.not.equal('pass');
      expect(result.criteria.some((entry) => entry.status === 'uncertain' || entry.status === 'fail')).to.equal(true);
    }
  });

  it('duplicate criteria fail closed', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const duplicated = [...passAllFindings()];
    duplicated[0] = passAllFindings()[1];
    const parsed = (await import('codesense/generation/pedagogicalCritic')).parseCriticFindings({ findings: duplicated });
    expect(parsed.ok).to.equal(false);
  });

  it('prompt carries specification, critic-view candidate, and rubric — nothing else', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const critic = new FakeCritic();
    await validatePedagogically(spec, candidate, graph(), critic);
    const prompt = buildCriticPrompt(spec, critic.seen[0]?.candidate ?? toCriticView(candidate));
    expect(prompt.system.toLowerCase()).to.include('rubric');
    expect(prompt.user).to.include(spec.specId);
    expect(prompt.user).to.include(candidate.candidateId);
    const promptText = JSON.stringify(prompt).toLowerCase();
    // Opaque provenance ids (spec/request/plan/goal/evidence ids) are traceability, not
    // content; what must never travel is evidence record content, telemetry, or conversation.
    for (const term of ['local-learner', '"observation"', '"interpretation"', 'telemetry', 'conversation', 'generatorid']) {
      expect(promptText).to.not.include(term);
    }
  });

  it('extra unsupported finding fields follow the lenient repository convention', async () => {
    const parsed = (await import('codesense/generation/pedagogicalCritic')).parseCriticFindings({
      findings: passAllFindings().map((entry) => ({ ...entry, extraField: 'ignored' })),
    });
    expect(parsed.ok).to.equal(true);
  });
});

describe('Phase I Stage 3 — boundaries, tripwires, and execution marker', () => {
  it('every result carries executionUnverified: true on all paths', async () => {
    const spec = specFixture();
    const candidate = await candidateFixture(spec);
    const paths = [
      await validatePedagogically(spec, candidate, graph(), new FakeCritic()),
      await validatePedagogically(spec, candidate, graph()),
      await validatePedagogically({ nope: true }, { nope: true }, graph(), new FakeCritic()),
    ];
    for (const result of paths) {
      expect(result.executionUnverified).to.equal(true);
    }
  });

  it('result shape is exact: no persistence, recommendation, or standing fields', async () => {
    const result = await validatePedagogically(specFixture(), await candidateFixture(), graph(), new FakeCritic());
    expect(Object.keys(result).sort()).to.deep.equal(
      ['candidateId', 'criteria', 'executionUnverified', 'hardFailures', 'provenance', 'specId', 'verdict'].sort(),
    );
    const serialized = JSON.stringify(result).toLowerCase();
    for (const term of ['attemptid', 'store', 'recommend', 'queue', 'mastery']) {
      expect(serialized).to.not.include(term);
    }
  });

  it('new modules import no subsystem implementation, stores, or execution', () => {
    const root = path.join(__dirname, '..', '..', '..');
    for (const file of [
      path.join(root, 'src', 'generation', 'pedagogicalChecks.ts'),
      path.join(root, 'src', 'generation', 'pedagogicalCritic.ts'),
    ]) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const line of source.split('\n')) {
        const match = line.match(/^\s*import .* from '([^']+)'/);
        if (match) {
          expect(
            [
              '../knowledge/ontologyStore',
              './generationSpecification',
              './generationCandidate',
              './pedagogicalChecks',
              '../practice/activityTypes',
            ],
            `import source in ${path.basename(file)}`,
          ).to.include(match[1]);
        }
      }
      for (const forbidden of [
        'eval(',
        'Function(',
        'child_process',
        'spawn(',
        'execFile',
        'node:vm',
        'saveJsonArray',
        'loadJsonArray',
        '.json',
      ]) {
        expect(source).to.not.include(forbidden);
      }
    }
  });

  it('no numeric standing exists in code or outputs', async () => {
    const root = path.join(__dirname, '..', '..', '..');
    for (const file of [
      path.join(root, 'src', 'generation', 'pedagogicalChecks.ts'),
      path.join(root, 'src', 'generation', 'pedagogicalCritic.ts'),
    ]) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const term of ['score', 'rating', 'weight', 'percent']) {
        expect(source.toLowerCase()).to.not.include(term);
      }
    }
    const result = await validatePedagogically(specFixture(), await candidateFixture(), graph(), new FakeCritic());
    expect(JSON.stringify(result)).to.not.match(/"(pedagogicalScore|quality|transferScore|rating|weight)"\s*:/);
  });

  it('exposes exactly the minimum Stage 3 API surface (allowlist tripwire)', () => {
    expect(Object.keys(checksModule).sort()).to.deep.equal(
      [
        'LOAD_BEARING_CRITERIA',
        'MAX_PEDAGOGICAL_REASON_CHARS',
        'PEDAGOGICAL_CRITERIA',
        'PEDAGOGICAL_RUBRIC_VERSION',
        'PEDAGOGICAL_VALIDATOR_VERSION',
        'detectOutOfScopeReferences',
        'isKnownPedagogicalCriterion',
        'isLoadBearingCriterion',
        'runDeterministicPedagogicalChecks',
      ].sort(),
    );
    expect(Object.keys(criticModule).sort()).to.deep.equal(
      [
        'AiCritic',
        'FAKE_CRITIC_ID',
        'FakeCritic',
        'MAX_CRITIC_REASON_CHARS',
        'applyScopeRule',
        'buildCriticPrompt',
        'parseCriticFindings',
        'resolveVerdict',
        'toCriticView',
        'validatePedagogically',
      ].sort(),
    );
  });
});
