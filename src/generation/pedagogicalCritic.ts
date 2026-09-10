import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { GeneratedCandidate } from './generationCandidate';
import { validateGeneratedCandidate } from './generationCandidate';
import type { GenerationSpecification } from './generationSpecification';
import { validateGenerationSpecification } from './generationSpecification';
import {
  PEDAGOGICAL_CRITERIA,
  PEDAGOGICAL_RUBRIC_VERSION,
  PEDAGOGICAL_VALIDATOR_VERSION,
  detectOutOfScopeReferences,
  isKnownPedagogicalCriterion,
  isLoadBearingCriterion,
  runDeterministicPedagogicalChecks,
} from './pedagogicalChecks';
import type {
  DeterministicPedagogicalFinding,
  PedagogicalCriterion,
} from './pedagogicalChecks';

/**
 * Phase I Stage 3 — independent pedagogical critic (no execution).
 *
 * The critic judges whether an already I-2-validated candidate is a
 * pedagogically credible realization of its specification. It never
 * decides what the learner needs, never plans, never recommends, never
 * creates evidence, and never claims executable correctness — every
 * result carries `executionUnverified: true` so later stages cannot
 * mistake credibility for correctness.
 *
 * Independence is architectural, not statistical: the critic receives a
 * critic-view candidate with generator identity stripped, never sees
 * generator reasoning, prompts, justification, learner state, telemetry,
 * conversation, or stores. A generator's self-praise cannot influence a
 * verdict it never reaches.
 */

export type CriticConfidence = 'high' | 'medium' | 'low';

/**
 * `criticConfidence` is confidence in this judgment about this candidate.
 * It is not learner confidence, D evidence confidence, goal confidence,
 * mastery, or any learner attribute. It is never persisted on
 * learner-linked state.
 */
export interface PedagogicalCriterionResult {
  criterion: PedagogicalCriterion;
  status: 'pass' | 'fail' | 'uncertain';
  criticConfidence: CriticConfidence;
  reason: string;
  source: 'deterministic' | 'critic';
}

export type PedagogicalVerdict = 'pass' | 'revise' | 'reject';

export interface PedagogicalValidationResult {
  specId: string;
  candidateId: string;
  verdict: PedagogicalVerdict;
  /** Exactly one result per rubric criterion, in rubric order. */
  criteria: PedagogicalCriterionResult[];
  hardFailures: string[];
  provenance: {
    validatorVersion: string;
    rubricVersion: string;
    criticId: string;
  };
  /**
   * Always true: pedagogical credibility is not executable correctness.
   * Later stages must establish correctness independently.
   */
  executionUnverified: true;
}

export const MAX_CRITIC_REASON_CHARS = 500;
export const FAKE_CRITIC_ID = 'fake-critic';

/** Candidate minus generator identity: praise has nowhere to travel. */
export type CriticCandidateView = Omit<GeneratedCandidate, 'provenance'> & {
  provenance: Omit<GeneratedCandidate['provenance'], 'generatorId' | 'generatorVersion'>;
};

export function toCriticView(candidate: GeneratedCandidate): CriticCandidateView {
  const { generatorId: _droppedId, generatorVersion: _droppedVersion, ...traceability } = candidate.provenance;
  void _droppedId;
  void _droppedVersion;
  return { ...candidate, provenance: { ...traceability } };
}

export interface CriticInput {
  specification: GenerationSpecification;
  candidate: CriticCandidateView;
  rubricVersion: number;
}

export interface CriticPrompt {
  system: string;
  user: string;
}

/** Minimal transport seam: prompt in, raw findings out (throws on failure). */
export type CriticTransport = (prompt: CriticPrompt) => Promise<unknown>;

export interface PedagogicalCritic {
  readonly criticId: string;
  review(input: CriticInput): Promise<unknown>;
}

/** Versioned judging questions: the critic's entire frame of reference. */
const RUBRIC_TEXT: Record<PedagogicalCriterion, string> = {
  'target-engagement':
    'Does solving the activity genuinely require the specified target capability, not merely mention it?',
  'evidence-observability':
    'Could interaction with this activity plausibly produce the requested evidence types?',
  'transfer-anti-rote':
    'Where unfamiliar transfer is required, is the change meaningful rather than cosmetic? Cite concrete text.',
  'shortcut-resistance':
    'Can the activity be completed while bypassing the intended skill via paraphrased shortcuts, brute force, or a complete scaffold?',
  'challenge-purpose-fit':
    'Is the challenge appropriate for the declared purpose: attributable failure for diagnostic, novel-but-solvable application for instructional transfer, localizable fault for debugging?',
  'internal-consistency':
    'Do statement, constraints, targets, expected behavior, and evidence tell the same pedagogical story?',
  'debugging-genuineness':
    'For debugging tasks: does fixing require localization and invariant reasoning about one meaningful fault family?',
};

const CRITIC_SYSTEM_PROMPT = [
  'You judge whether a generated learning activity credibly realizes its generation specification.',
  'Judge ONLY realization of the given specification: kind, targets, intent, purpose, surface form,',
  'constraints, forbidden shortcuts, expected evidence, and acceptance criteria.',
  'Never invent additional requirements (e.g. skills the specification does not name).',
  'Never judge the learner, mastery, goals, or next activities.',
  'Return one finding per rubric criterion, each with status pass|fail|uncertain,',
  'confidence high|medium|low in YOUR judgment, and a bounded reason citing candidate or specification text.',
  'Use uncertain whenever you cannot reliably establish a criterion; never manufacture certainty.',
].join(' ');

/**
 * Pure prompt builder: specification + critic-view candidate + rubric.
 * No learner state, telemetry, conversation, stores, generator reasoning,
 * prompts, justification, other candidates, or prior verdicts travel here.
 * Inputs are already bounded by Stage 1/2 validators, so no truncation
 * silently reshapes them.
 */
export function buildCriticPrompt(specification: GenerationSpecification, candidate: CriticCandidateView): CriticPrompt {
  const rubricLines = PEDAGOGICAL_CRITERIA.map(
    (criterion) => `- ${criterion} (rubric v${PEDAGOGICAL_RUBRIC_VERSION}): ${RUBRIC_TEXT[criterion]}`,
  );
  const user = [
    `specification: ${JSON.stringify(specification)}`,
    `candidate: ${JSON.stringify(candidate)}`,
    `rubric:\n${rubricLines.join('\n')}`,
  ].join('\n');
  return { system: CRITIC_SYSTEM_PROMPT, user };
}

export interface ValidatedCriticFinding {
  criterion: PedagogicalCriterion;
  status: 'pass' | 'fail' | 'uncertain';
  criticConfidence: CriticConfidence;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Strict critic-output parsing: exactly seven findings covering the full
 * rubric with no duplicates, known names, valid statuses/confidences, and
 * bounded reasons. Anything else fails closed (never repaired, never
 * mined). Unknown extra fields are ignored per repository convention.
 */
export function parseCriticFindings(raw: unknown): { ok: true; findings: ValidatedCriticFinding[] } | { ok: false; reason: string } {
  if (!isRecord(raw) || !Array.isArray(raw.findings) || raw.findings.length !== PEDAGOGICAL_CRITERIA.length) {
    return { ok: false, reason: 'malformed critic output: expected exactly seven findings' };
  }
  const seen = new Set<string>();
  const findings: ValidatedCriticFinding[] = [];
  for (const item of raw.findings) {
    if (!isRecord(item)) {
      return { ok: false, reason: 'malformed critic output: finding must be an object' };
    }
    if (!isKnownPedagogicalCriterion(item.criterion)) {
      return { ok: false, reason: 'malformed critic output: unknown criterion' };
    }
    if (seen.has(item.criterion as string)) {
      return { ok: false, reason: 'malformed critic output: duplicate criterion' };
    }
    seen.add(item.criterion as string);
    if (item.status !== 'pass' && item.status !== 'fail' && item.status !== 'uncertain') {
      return { ok: false, reason: 'malformed critic output: invalid status' };
    }
    if (item.criticConfidence !== 'high' && item.criticConfidence !== 'medium' && item.criticConfidence !== 'low') {
      return { ok: false, reason: 'malformed critic output: invalid confidence' };
    }
    if (!isNonBlankBounded(item.reason, MAX_CRITIC_REASON_CHARS)) {
      return { ok: false, reason: 'malformed critic output: invalid reason' };
    }
    findings.push({
      criterion: item.criterion,
      status: item.status,
      criticConfidence: item.criticConfidence,
      reason: clip(item.reason as string, MAX_CRITIC_REASON_CHARS),
    });
  }
  return { ok: true, findings };
}

export interface DroppedCriticFinding {
  criterion: PedagogicalCriterion;
  reason: string;
  outOfScope: string[];
}

/**
 * Scope rule: findings citing canonical capabilities outside the
 * specification targets are dropped (the spec is authoritative; the
 * critic may not invent requirements). Dropped findings never influence
 * the verdict — not even by outvoting.
 */
export function applyScopeRule(
  findings: ValidatedCriticFinding[],
  spec: GenerationSpecification,
  graph: KnowledgeGraph,
): { kept: ValidatedCriticFinding[]; dropped: DroppedCriticFinding[] } {
  const kept: ValidatedCriticFinding[] = [];
  const dropped: DroppedCriticFinding[] = [];
  for (const finding of findings) {
    const outOfScope = detectOutOfScopeReferences(
      finding.reason,
      spec.activityRequirements.targetEntityIds,
      graph,
    );
    if (outOfScope.length > 0) {
      dropped.push({ criterion: finding.criterion, reason: finding.reason, outOfScope });
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}

export interface VerdictInputs {
  deterministic: DeterministicPedagogicalFinding[];
  findings: ValidatedCriticFinding[];
  dropped: PedagogicalCriterion[];
  criticUnavailableReason?: string;
}

/**
 * Pure verdict resolution over validation results — never over execution
 * order. Precedence: deterministic fail on load-bearing criteria rejects;
 * other deterministic fails floor at revise; high-confidence critic fails
 * on load-bearing criteria reject; other critic fails floor at revise;
 * any uncertainty floors at revise; pass requires everything resolved.
 * AI pass never overrides a deterministic fail.
 */
export function resolveVerdict(inputs: VerdictInputs): {
  results: PedagogicalCriterionResult[];
  verdict: PedagogicalVerdict;
  hardFailures: string[];
} {
  const deterministicByCriterion = new Map(inputs.deterministic.map((finding) => [finding.criterion, finding] as const));
  const findingsByCriterion = new Map(inputs.findings.map((finding) => [finding.criterion, finding] as const));
  const dropped = new Set(inputs.dropped);
  const results: PedagogicalCriterionResult[] = PEDAGOGICAL_CRITERIA.map((criterion) => {
    const decided = deterministicByCriterion.get(criterion);
    if (decided) {
      return { criterion, status: decided.status, criticConfidence: 'high', reason: decided.reason, source: 'deterministic' as const };
    }
    const finding = findingsByCriterion.get(criterion);
    if (finding) {
      return {
        criterion,
        status: finding.status,
        criticConfidence: finding.criticConfidence,
        reason: finding.reason,
        source: 'critic' as const,
      };
    }
    return {
      criterion,
      status: 'uncertain' as const,
      criticConfidence: 'low' as const,
      reason: dropped.has(criterion)
        ? 'Critic provided only out-of-scope findings for this criterion; dropped per scope rule.'
        : inputs.criticUnavailableReason ?? 'No valid critic finding for this criterion.',
      source: 'critic' as const,
    };
  });
  const hardFailures = inputs.deterministic
    .filter((finding) => finding.status === 'fail')
    .map((finding) => finding.reason);
  let verdict: PedagogicalVerdict = 'pass';
  if (results.some((result) => result.source === 'deterministic' && result.status === 'fail' && isLoadBearingCriterion(result.criterion))) {
    verdict = 'reject';
  } else if (results.some((result) => result.source === 'deterministic' && result.status === 'fail')) {
    verdict = 'revise';
  }
  if (verdict !== 'reject') {
    const criticFails = results.filter((result) => result.source === 'critic' && result.status === 'fail');
    if (criticFails.some((result) => isLoadBearingCriterion(result.criterion) && result.criticConfidence === 'high')) {
      verdict = 'reject';
    } else if (criticFails.length > 0 && verdict === 'pass') {
      verdict = 'revise';
    }
  }
  if (verdict === 'pass' && results.some((result) => result.status === 'uncertain')) {
    verdict = 'revise';
  }
  return { results, verdict, hardFailures };
}

export type FakeCriticStep =
  | { mode: 'pass-all' }
  | { mode: 'findings'; findings: unknown[] }
  | { mode: 'raw'; payload: unknown }
  | { mode: 'failure'; reason: string };

/**
 * Deterministic scripted critic for tests and offline validation.
 * Replays steps in order (defaulting to all-pass findings), records every
 * input it saw (privacy assertions inspect these), and throws on failure
 * steps so the pipeline exercises its transport-failure path.
 */
export class FakeCritic implements PedagogicalCritic {
  readonly criticId = 'fake-critic';
  readonly seen: CriticInput[] = [];
  private readonly script: FakeCriticStep[];

  constructor(script: FakeCriticStep[] = []) {
    this.script = [...script];
  }

  async review(input: CriticInput): Promise<unknown> {
    this.seen.push(input);
    const step = this.script.length > 0 ? (this.script.shift() as FakeCriticStep) : { mode: 'pass-all' as const };
    if (step.mode === 'failure') {
      throw new Error(step.reason);
    }
    if (step.mode === 'raw') {
      return step.payload;
    }
    if (step.mode === 'findings') {
      return { findings: step.findings };
    }
    return {
      findings: PEDAGOGICAL_CRITERIA.map((criterion) => ({
        criterion,
        status: 'pass',
        criticConfidence: 'high',
        reason: `Scripted pass for ${criterion}.`,
      })),
    };
  }
}

/**
 * Critic over an injected transport. No real provider lives here; tests
 * script the transport. A future caller may adapt the shared
 * chat-completions transport without touching this module.
 */
export class AiCritic implements PedagogicalCritic {
  readonly criticId: string;

  constructor(
    private readonly transport: CriticTransport,
    opts: { criticId?: string } = {},
  ) {
    this.criticId = opts.criticId ?? 'ai-critic';
  }

  async review(input: CriticInput): Promise<unknown> {
    return this.transport(buildCriticPrompt(input.specification, input.candidate));
  }
}

function malformedResult(
  specId: string,
  candidateId: string,
  reason: string,
  criticId: string,
): PedagogicalValidationResult {
  return {
    specId,
    candidateId,
    verdict: 'reject',
    criteria: PEDAGOGICAL_CRITERIA.map((criterion) => ({
      criterion,
      status: 'fail' as const,
      criticConfidence: 'high' as const,
      reason: clip(reason, MAX_CRITIC_REASON_CHARS),
      source: 'deterministic' as const,
    })),
    hardFailures: [clip(reason, MAX_CRITIC_REASON_CHARS)],
    provenance: {
      validatorVersion: String(PEDAGOGICAL_VALIDATOR_VERSION),
      rubricVersion: String(PEDAGOGICAL_RUBRIC_VERSION),
      criticId,
    },
    executionUnverified: true,
  };
}

/**
 * Stage 3 pipeline entry: deterministic pedagogical checks, then the
 * independent critic (when provided), then pure verdict resolution.
 * Malformed inputs fail closed without invoking any critic. Missing or
 * failing critics degrade to uncertainty (revise floor), never to pass.
 * No regeneration, recommendation, persistence, or execution exists here.
 */
export async function validatePedagogically(
  specRaw: unknown,
  candidateRaw: unknown,
  graph: KnowledgeGraph,
  critic?: PedagogicalCritic,
): Promise<PedagogicalValidationResult> {
  const criticId = critic?.criticId ?? 'none';
  const spec = validateGenerationSpecification(specRaw);
  const candidate = validateGeneratedCandidate(candidateRaw);
  if (spec === null || candidate === null) {
    return malformedResult(
      'unknown',
      'unknown',
      spec === null ? 'Malformed specification input.' : 'Malformed candidate input.',
      criticId,
    );
  }
  const deterministic = runDeterministicPedagogicalChecks(spec, candidate, graph);
  let findings: ValidatedCriticFinding[] = [];
  let dropped: PedagogicalCriterion[] = [];
  let criticUnavailableReason: string | undefined;
  if (critic !== undefined) {
    let raw: unknown;
    try {
      raw = await critic.review({
        specification: spec,
        candidate: toCriticView(candidate),
        rubricVersion: PEDAGOGICAL_RUBRIC_VERSION,
      });
    } catch (err) {
      raw = undefined;
      criticUnavailableReason = `Critic transport failed: ${err instanceof Error ? err.message : String(err)}.`;
    }
    if (raw !== undefined) {
      const parsed = parseCriticFindings(raw);
      if (!parsed.ok) {
        criticUnavailableReason = `Critic output malformed: ${parsed.reason}.`;
      } else {
        const scoped = applyScopeRule(parsed.findings, spec, graph);
        findings = scoped.kept;
        dropped = scoped.dropped.map((entry) => entry.criterion);
      }
    }
  } else {
    criticUnavailableReason = 'No critic provided.';
  }
  const resolved = resolveVerdict({ deterministic, findings, dropped, criticUnavailableReason });
  return {
    specId: spec.specId,
    candidateId: candidate.candidateId,
    verdict: resolved.verdict,
    criteria: resolved.results,
    hardFailures: resolved.hardFailures,
    provenance: {
      validatorVersion: String(PEDAGOGICAL_VALIDATOR_VERSION),
      rubricVersion: String(PEDAGOGICAL_RUBRIC_VERSION),
      criticId,
    },
    executionUnverified: true,
  };
}

