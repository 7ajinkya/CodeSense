import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { MAX_DEBUG_SNAPSHOT_CHARS, MAX_DEBUG_TEST_CHARS } from '../practice/activityTypes';
import type { GenerationSpecification } from './generationSpecification';
import type { GeneratedCandidate, GenerationResult } from './generationCandidate';
import { candidateIdFor, rejectedUnknownResult, runStage2Validation } from './generationCandidate';

/**
 * Phase I Stage 2 — generator abstraction + deterministic fake + narrow AI seam.
 *
 * The generator receives the validated specification (plus an optional
 * bounded generation context) and nothing else: never the learner model,
 * evidence history, telemetry, conversation, analytics, or stores.
 * Diagnosis already happened upstream; the generator answers only "given
 * this exact specification, produce a candidate".
 *
 * No real AI provider is invoked anywhere in Stage 2. The AI-backed path
 * takes an injected transport (scripted in tests); a future caller may
 * adapt the shared chat-completions transport without touching this
 * module. `HttpChatReasoner` was deliberately NOT reused: it requires a
 * full telemetry-heavy AIContext, which would breach the spec-only
 * privacy boundary.
 */

export const FAKE_GENERATOR_ID = 'fake-deterministic';
export const FAKE_GENERATOR_VERSION = '1';
export const AI_GENERATOR_VERSION = '1';

/** Bounded extras a future caller may supply (e.g. motivating broken code by value). */
export interface CandidateGenerationContext {
  brokenSnapshot?: string;
  referenceFix?: string;
  tests?: string[];
}

export type GenerationCandidateResult =
  | { ok: true; candidate: unknown }
  | { ok: false; error: { reason: string; kind?: 'malformed-output' | 'provider-failure' } };

export interface CandidateGenerator {
  readonly generatorId: string;
  generate(
    specification: GenerationSpecification,
    context?: CandidateGenerationContext,
  ): GenerationCandidateResult | Promise<GenerationCandidateResult>;
}

function isNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validateGenerationContext(raw: CandidateGenerationContext | undefined): { ok: true } | { ok: false; reason: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'malformed generation context' };
  }
  if (raw.brokenSnapshot !== undefined && !isNonBlankBounded(raw.brokenSnapshot, MAX_DEBUG_SNAPSHOT_CHARS)) {
    return { ok: false, reason: 'malformed generation context' };
  }
  if (raw.referenceFix !== undefined && !isNonBlankBounded(raw.referenceFix, MAX_DEBUG_SNAPSHOT_CHARS)) {
    return { ok: false, reason: 'malformed generation context' };
  }
  if (raw.tests !== undefined) {
    if (
      !Array.isArray(raw.tests) ||
      raw.tests.length === 0 ||
      raw.tests.length > 24 ||
      raw.tests.some((test: unknown) => !isNonBlankBounded(test, MAX_DEBUG_TEST_CHARS))
    ) {
      return { ok: false, reason: 'malformed generation context' };
    }
  }
  return { ok: true };
}

export type FakeGenerationStep =
  | { mode: 'valid' }
  | { mode: 'raw'; payload: unknown }
  | { mode: 'failure'; reason: string };

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Deterministic fake generator for tests and offline validation of the
 * pipeline. Replays the scripted steps in order (defaulting to one valid
 * candidate); `raw` steps return arbitrary payloads to exercise the
 * validator, and `failure` steps simulate provider failure. The valid
 * candidate is built FROM the specification so non-trivial specs still
 * transcribe faithfully — never from learner state (none is reachable).
 */
export class FakeGenerator implements CandidateGenerator {
  readonly generatorId = FAKE_GENERATOR_ID;
  private readonly script: FakeGenerationStep[];
  private readonly generatorVersion: string;
  private calls = 0;

  constructor(script: FakeGenerationStep[] = [], opts: { generatorVersion?: string } = {}) {
    this.script = [...script];
    this.generatorVersion = opts.generatorVersion ?? FAKE_GENERATOR_VERSION;
  }

  generate(
    specification: GenerationSpecification,
    context?: CandidateGenerationContext,
  ): GenerationCandidateResult {
    this.calls += 1;
    const version = this.calls;
    const step = this.script.length > 0 ? (this.script.shift() as FakeGenerationStep) : { mode: 'valid' as const };
    if (step.mode === 'failure') {
      return { ok: false, error: { reason: step.reason, kind: 'provider-failure' } };
    }
    if (step.mode === 'raw') {
      return { ok: true, candidate: step.payload };
    }
    return { ok: true, candidate: buildValidCandidate(specification, version, this.generatorId, this.generatorVersion, context) };
  }
}

function defaultDebuggingPayload(
  specification: GenerationSpecification,
  context: CandidateGenerationContext | undefined,
): { brokenSnapshot: string; referenceFix: string; tests: string[] } {
  if (
    context !== undefined &&
    typeof context.brokenSnapshot === 'string' &&
    typeof context.referenceFix === 'string' &&
    Array.isArray(context.tests)
  ) {
    return {
      brokenSnapshot: context.brokenSnapshot,
      referenceFix: context.referenceFix,
      tests: [...(context.tests as string[])],
    };
  }
  const entity = specification.activityRequirements.targetEntityIds[0] ?? 'target';
  return {
    brokenSnapshot: `// broken ${entity} attempt\nwhile (l <= r):\n    m = (l + r) // 2`,
    referenceFix: `// fixed ${entity} attempt\nwhile (l < r):\n    m = (l + r) // 2`,
    tests: ['loop terminates on a two-element input', 'bounds never exclude the answer'],
  };
}

function buildValidCandidate(
  specification: GenerationSpecification,
  version: number,
  generatorId: string,
  generatorVersion: string,
  context: CandidateGenerationContext | undefined,
): GeneratedCandidate {
  const requirements = specification.activityRequirements;
  const entities = requirements.targetEntityIds.join(', ');
  const title = `Generated ${requirements.kind} for ${requirements.targetEntityIds[0] ?? 'target'}`;
  const taskDescription =
    `Solve the ${requirements.surfaceForm} ${requirements.kind} task exercising ${entities}. ` +
    specification.expectedEvidence.question;
  const candidate: GeneratedCandidate = {
    candidateId: candidateIdFor(specification.specId, version, title, taskDescription),
    candidateVersion: version,
    specId: specification.specId,
    activityKind: requirements.kind,
    title,
    taskDescription,
    targetEntityIds: [...requirements.targetEntityIds],
    targetDimensions: [...requirements.targetDimensions],
    surfaceForm: requirements.surfaceForm,
    ...(requirements.surfaceForm === 'unfamiliar'
      ? {
          surfaceEvidence: {
            contextDescription: 'Problem context reframed outside the familiar setting.',
            changedElements: ['problem context reframed outside the familiar setting'],
          },
        }
      : {}),
    constraints: { ...requirements.constraints, languageScope: [...requirements.constraints.languageScope] },
    forbiddenShortcuts: [...requirements.forbiddenShortcuts],
    expectedEvidence: {
      dimensions: [...specification.expectedEvidence.dimensions],
      evidenceTypes: [...specification.expectedEvidence.evidenceTypes],
      question: specification.expectedEvidence.question,
      ...(specification.expectedEvidence.observableBehavior !== undefined
        ? { observableBehavior: specification.expectedEvidence.observableBehavior }
        : {}),
    },
    intent: requirements.intent,
    purpose: requirements.purpose,
    acceptanceCriteria: specification.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    ...(requirements.kind === 'debugging-task'
      ? { debugging: defaultDebuggingPayload(specification, context) }
      : {}),
    provenance: {
      specId: specification.specId,
      requestId: specification.requestId,
      planId: specification.planId,
      goalId: specification.goalId,
      generatorId,
      generatorVersion,
    },
  };
  return candidate;
}

/** Tightly bounded candidate-generation prompt (pure, spec-only content). */
export interface CandidatePrompt {
  system: string;
  user: string;
}

const CANDIDATE_SYSTEM_PROMPT = [
  'You generate a single learning-activity candidate as structured JSON.',
  'Obey the generation specification exactly: kind, entities, dimensions, intent, purpose,',
  'surface form, constraints, forbidden shortcuts, expected evidence, and acceptance criteria.',
  'Do not judge learner weakness or mastery, do not choose goals or next activities,',
  'do not recommend the candidate, and do not claim pedagogical sufficiency.',
].join(' ');

/**
 * Pure prompt builder: the model sees the specification and nothing else —
 * never learner history, telemetry, conversation, or stores.
 */
export function buildCandidatePrompt(specification: GenerationSpecification): CandidatePrompt {
  const requirements = specification.activityRequirements;
  const lines = [
    `specification: ${specification.specId} (request ${specification.requestId}, plan ${specification.planId}, goal ${specification.goalId})`,
    `kind: ${requirements.kind}`,
    `target entities: ${requirements.targetEntityIds.join(', ')}`,
    `target dimensions: ${requirements.targetDimensions.join(', ')}`,
    `intent: ${requirements.intent}`,
    `purpose: ${requirements.purpose}`,
    `surface form: ${requirements.surfaceForm}`,
    ...(requirements.transferRequirement !== undefined ? [`transfer: ${requirements.transferRequirement}`] : []),
    `constraints: ${JSON.stringify(requirements.constraints)}`,
    `forbidden shortcuts: ${requirements.forbiddenShortcuts.join(' | ') || 'none'}`,
    `expected evidence: ${specification.expectedEvidence.question}`,
    `acceptance criteria: ${specification.acceptanceCriteria.map((criterion) => `${criterion.criterionId}: ${criterion.description}`).join(' | ')}`,
    'Return a single JSON object with: candidateVersion (integer >= 1), title, taskDescription,',
    'surfaceEvidence { contextDescription, changedElements[] } when unfamiliar, expectedEvidence echo,',
    'acceptanceCriteria echo, and debugging { brokenSnapshot, referenceFix, tests[] } for debugging-task only.',
  ];
  return { system: clip(CANDIDATE_SYSTEM_PROMPT, 2000), user: clip(lines.join('\n'), 6000) };
}

/**
 * Strict AI-output parsing: only JSON objects pass through to validation;
 * anything else is rejected here (never repaired, never mined for text).
 * Record-shaped-but-invalid payloads pass parsing and fail later at
 * structural validation — both paths refuse acceptance.
 */
export function parseAiCandidateOutput(raw: unknown): GenerationCandidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: { reason: 'malformed AI candidate output', kind: 'malformed-output' } };
  }
  return { ok: true, candidate: raw };
}

/** Minimal transport seam: prompt in, raw JSON out (throws on failure). */
export type CandidateTransport = (prompt: CandidatePrompt) => Promise<unknown>;

/**
 * AI-backed generator over an injected transport. No real provider lives
 * here and none is invoked by Stage 2 itself; tests script the transport
 * (malformed payloads, thrown failures). A future caller may adapt the
 * shared chat-completions transport without touching this module.
 */
export class AiCandidateGenerator implements CandidateGenerator {
  readonly generatorId: string;

  constructor(
    private readonly transport: CandidateTransport,
    opts: { generatorId?: string } = {},
  ) {
    this.generatorId = opts.generatorId ?? 'ai-candidate';
  }

  async generate(specification: GenerationSpecification): Promise<GenerationCandidateResult> {
    const prompt = buildCandidatePrompt(specification);
    let raw: unknown;
    try {
      raw = await this.transport(prompt);
    } catch (err) {
      return { ok: false, error: { reason: `candidate provider failure: ${err instanceof Error ? err.message : String(err)}`, kind: 'provider-failure' } };
    }
    return parseAiCandidateOutput(raw);
  }
}

function unavailableResult(specId: string, reason: string): GenerationResult {
  const clipped = clip(reason, 500);
  return {
    status: 'unavailable',
    report: {
      candidateId: 'unknown',
      specId,
      checks: [
        { check: 'structural', status: 'not-applicable', detail: 'Skipped: generation unavailable.' },
        { check: 'spec-conformance', status: 'not-applicable', detail: 'Skipped: generation unavailable.' },
        { check: 'knowledge-graph', status: 'not-applicable', detail: 'Skipped: generation unavailable.' },
        { check: 'execution', status: 'blocked', detail: 'Executable correctness cannot be established without an approved sandbox.' },
      ],
      verdict: 'unavailable',
    },
    diagnostics: [clipped],
  };
}

/**
 * Stage 2 pipeline entry: generate (spec-only input) then validate.
 * Provider failures and thrown generators become structured `unavailable`
 * results — never partial accepted candidates. Pure apart from the
 * generator call itself.
 */
export async function generateCandidate(
  generator: CandidateGenerator,
  specification: GenerationSpecification,
  graph: KnowledgeGraph,
  context?: CandidateGenerationContext,
): Promise<GenerationResult> {
  if (context !== undefined && validateGenerationContext(context).ok === false) {
    return unavailableResult(specification.specId, 'malformed generation context');
  }
  let produced: GenerationCandidateResult;
  try {
    produced = await generator.generate(specification, context);
  } catch (err) {
    return unavailableResult(specification.specId, `generator threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!produced.ok) {
    // Malformed generator output is a failed candidate (rejected); provider
    // failure is a missing capability (unavailable). Never conflated.
    if (produced.error.kind === 'malformed-output') {
      return rejectedUnknownResult(specification.specId, [`malformed generator output: ${produced.error.reason}`]);
    }
    return unavailableResult(specification.specId, `generation unavailable: ${produced.error.reason}`);
  }
  return runStage2Validation(specification, produced.candidate, graph);
}
