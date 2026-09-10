import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type {
  ActivityIntent,
  ActivityKind,
  ActivityPurpose,
} from '../practice/activityTypes';
import type {
  GenerationRequest,
  GenerationRequestBasis,
  GenerationRequestBudget,
  GenerationRequestConstraints,
  GenerationSurfaceForm,
  RequestAcceptanceCriterion,
} from '../practice/generationRequest';
import { validateGenerationRequest } from '../practice/generationRequest';
import { DIAGNOSTIC_HYPOTHESIS_KINDS } from './diagnose';

/**
 * Phase I Stage 1 — GenerationSpecification (faithful transcription seam).
 *
 * A GenerationSpecification is what a generated artifact must satisfy. It
 * is a pure transcription of one F2 GenerationRequest: every F2-owned
 * field survives verbatim (deep structural equality), and I adds only
 * identity/versioning, the validation plan, and the sandbox gate state.
 * I never reinterprets, retargets, resequences, or weakens the request.
 *
 * Nothing here is persisted in Stage 1 (no store), nothing is learner
 * evidence, and nothing can start, save, recommend, or present an
 * activity. Stage 1 stops at this specification boundary.
 */

export const SPEC_SCHEMA_VERSION = 1;
export const SPEC_ID_PREFIX = 'spec_';

/**
 * Future validation stages a candidate must pass. Closed vocabulary for
 * Stage 1 only. `correctness` (reference-vs-tests agreement) requires an
 * approved sandbox and is therefore disabled while sandboxAvailable is
 * false — never silently, always explicitly.
 */
export type SpecValidationStage =
  | 'structural'
  | 'knowledge'
  | 'correctness'
  | 'pedagogical'
  | 'independent-critic';

export const SPEC_VALIDATION_STAGES: readonly SpecValidationStage[] = [
  'structural',
  'knowledge',
  'correctness',
  'pedagogical',
  'independent-critic',
];

export function isKnownSpecValidationStage(value: unknown): value is SpecValidationStage {
  return typeof value === 'string' && (SPEC_VALIDATION_STAGES as readonly string[]).includes(value);
}

export interface ValidationPlanEntry {
  stage: SpecValidationStage;
  enabled: boolean;
  requiresSandbox: boolean;
  note: string;
}

export interface GenerationSpecification {
  /** Stable deterministic id (`spec_<fnv(canonical request content)>`); same request → same id. */
  specId: string;
  /** Format version of this specification shape. */
  specVersion: number;
  /** Previous spec this replaces (linked, never mutated). Absent for first issue. */
  supersedesSpecId?: string;
  /** Sole Stage 1 origin. No alternative origins are invented here. */
  source: 'f2-generation-request';
  requestId: string;
  planId: string;
  goalId: string;
  /** Decision provenance transcribed from the request (never learner evidence). */
  basis: GenerationRequestBasis;
  activityRequirements: {
    kind: ActivityKind;
    intent: ActivityIntent;
    purpose: ActivityPurpose;
    targetEntityIds: string[];
    targetDimensions: EvidenceDimension[];
    surfaceForm: GenerationSurfaceForm;
    transferRequirement?: string;
    constraints: GenerationRequestConstraints;
    forbiddenShortcuts: string[];
    debugContext?: { brokenAttemptId: string };
  };
  /**
   * What the future activity should make observable (a wish, transcribed
   * from the request's discriminating evidence + targets). Never a claim
   * that the learner has demonstrated anything.
   */
  expectedEvidence: {
    dimensions: EvidenceDimension[];
    evidenceTypes: EvidenceType[];
    question: string;
    observableBehavior?: string;
  };
  acceptanceCriteria: RequestAcceptanceCriterion[];
  repetitionJustification?: string;
  budget: GenerationRequestBudget;
  issuedAt: string;
  provenance: {
    ontologyVersion: string;
    aggregatorVersion: string;
  };
  validationPlan: ValidationPlanEntry[];
  /**
   * Gate state at issue time. Literal `false`: enabling execution-gated
   * acceptance requires a code change under sandbox review — a spec can
   * never enable it by existing.
   */
  sandboxAvailable: false;
}

export interface GenerationSpecificationValidationError {
  reason: string;
}

export type SpecOutcome =
  | { ok: true; spec: GenerationSpecification }
  | { ok: false; error: GenerationSpecificationValidationError };

/** Deterministic FNV-1a hex (matches repo hashing style, dependency-free). */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical identity input for one validated request. Explicit fixed-order
 * serialization over every immutable request field — including requestId,
 * planId, and issuedAt, which are part of request identity — so materially
 * different content can never silently reuse an identity. Lossless by
 * construction: no field is deduplicated, reordered, omitted, or
 * reinterpreted (arrays keep their validated order). Relies on the
 * validator-normalized representation, whose construction order is fixed.
 */
function canonicalRequestInput(request: GenerationRequest): string {
  return JSON.stringify([
    request.requestId,
    request.planId,
    request.goalId,
    request.activityKind,
    request.intent,
    request.purpose,
    request.targetEntityIds,
    request.targetDimensions,
    request.surfaceForm,
    request.transferRequirement ?? null,
    request.constraints,
    request.forbiddenShortcuts,
    request.discriminatingEvidence,
    request.acceptanceCriteria,
    request.requestBasis,
    request.repetitionJustification ?? null,
    request.debugContext ?? null,
    request.budget,
    request.issuedAt,
    request.provenance,
  ]);
}

export function specIdForRequest(request: GenerationRequest): string {
  return `${SPEC_ID_PREFIX}${stableHash(canonicalRequestInput(request))}`;
}

/**
 * Deterministic validation plan: every stage is represented exactly once;
 * only the sandbox-dependent `correctness` acceptance gate is disabled,
 * explicitly, while no approved sandbox exists.
 */
export function buildValidationPlan(): ValidationPlanEntry[] {
  return [
    { stage: 'structural', enabled: true, requiresSandbox: false, note: 'Schema, fields, bounds, and internal consistency.' },
    { stage: 'knowledge', enabled: true, requiresSandbox: false, note: 'Canonical C entities; subset-of-goal discipline.' },
    {
      stage: 'correctness',
      enabled: false,
      requiresSandbox: true,
      note: 'Reference-vs-tests agreement requires an approved sandbox (sandboxAvailable=false).',
    },
    { stage: 'pedagogical', enabled: true, requiresSandbox: false, note: 'Static anti-template, surface-distance, and entity-delta predicates.' },
    { stage: 'independent-critic', enabled: true, requiresSandbox: false, note: 'Blind review for ambiguity, assumptions, and mismatch.' },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural validation for a specification object (round-trip checks;
 * never throws). Returns the normalized spec or null. Graph-dependent
 * canonical checks are the caller's responsibility (see transcription).
 */
export function validateGenerationSpecification(raw: unknown): GenerationSpecification | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.specId !== 'string' || raw.specId.trim().length === 0) {
    return null;
  }
  if (raw.specVersion !== SPEC_SCHEMA_VERSION) {
    return null;
  }
  if (raw.supersedesSpecId !== undefined) {
    if (typeof raw.supersedesSpecId !== 'string' || raw.supersedesSpecId.trim().length === 0) {
      return null;
    }
    if (raw.supersedesSpecId === raw.specId) {
      return null;
    }
  }
  if (raw.source !== 'f2-generation-request') {
    return null;
  }
  for (const key of ['requestId', 'planId', 'goalId', 'issuedAt'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).trim().length === 0) {
      return null;
    }
  }
  if (!isRecord(raw.basis) || !isRecord(raw.activityRequirements) || !isRecord(raw.expectedEvidence)) {
    return null;
  }
  if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length === 0) {
    return null;
  }
  if (!isRecord(raw.budget) || !isRecord(raw.provenance)) {
    return null;
  }
  if (!Array.isArray(raw.validationPlan)) {
    return null;
  }
  const stages = (raw.validationPlan as unknown[]).map((entry) =>
    isRecord(entry) ? (entry as Record<string, unknown>).stage : undefined,
  );
  if (
    stages.length !== SPEC_VALIDATION_STAGES.length ||
    !SPEC_VALIDATION_STAGES.every((stage) => stages.includes(stage))
  ) {
    return null;
  }
  for (const entry of raw.validationPlan as unknown[]) {
    if (!isRecord(entry) || typeof entry.enabled !== 'boolean' || typeof entry.requiresSandbox !== 'boolean' || typeof entry.note !== 'string') {
      return null;
    }
  }
  // Sandbox invariant: without an approved sandbox, the sandbox-gated
  // acceptance stage cannot be enabled — by anything, including this spec.
  if (raw.sandboxAvailable !== false) {
    return null;
  }
  const correctness = (raw.validationPlan as Array<Record<string, unknown>>).find(
    (entry) => entry.stage === 'correctness',
  );
  if (correctness === undefined || correctness.enabled !== false || correctness.requiresSandbox !== true) {
    return null;
  }
  const spec = raw as unknown as GenerationSpecification;
  return {
    ...spec,
    activityRequirements: {
      ...spec.activityRequirements,
      targetEntityIds: [...spec.activityRequirements.targetEntityIds],
      targetDimensions: [...spec.activityRequirements.targetDimensions],
      forbiddenShortcuts: [...spec.activityRequirements.forbiddenShortcuts],
      constraints: {
        ...spec.activityRequirements.constraints,
        languageScope: [...spec.activityRequirements.constraints.languageScope],
      },
    },
    expectedEvidence: {
      ...spec.expectedEvidence,
      dimensions: [...spec.expectedEvidence.dimensions],
      evidenceTypes: [...spec.expectedEvidence.evidenceTypes],
    },
    acceptanceCriteria: spec.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    budget: { ...spec.budget },
    provenance: { ...spec.provenance },
    validationPlan: spec.validationPlan.map((entry) => ({ ...entry })),
  };
}

export interface TranscriptionOptions {
  /** Live C graph for canonical-entity checks. */
  graph: KnowledgeGraph;
  /** ISO-8601 UTC now, for budget-expiry evaluation. */
  now: string;
  /** Previous spec this transcription replaces (linked, never mutated). */
  supersedesSpecId?: string;
}

/**
 * Faithful transcription of one F2 GenerationRequest into its
 * GenerationSpecification. Pure: validates, copies every F2-owned field
 * verbatim, and adds only I-owned identity/versioning/validation-plan.
 * Rejects (never repairs) malformed, contradictory, unknown-reference, or
 * expired requests.
 */
export function toGenerationSpecification(request: unknown, opts: TranscriptionOptions): SpecOutcome {
  const fail = (reason: string): SpecOutcome => ({ ok: false, error: { reason } });
  const validated: GenerationRequest | null = validateGenerationRequest(request);
  if (validated === null) {
    return fail('malformed generation request');
  }
  if (validated.budget.expiresAt !== undefined && Date.parse(validated.budget.expiresAt) <= Date.parse(opts.now)) {
    return fail('generation request expired');
  }
  for (const entityId of validated.targetEntityIds) {
    if (!opts.graph.hasEntity(entityId)) {
      return fail(`unknown entity "${entityId}"`);
    }
  }
  if (validated.requestBasis.basisKind === 'diagnostic') {
    for (const kind of validated.requestBasis.hypothesisKinds) {
      if (!(DIAGNOSTIC_HYPOTHESIS_KINDS as readonly string[]).includes(kind)) {
        return fail(`unknown hypothesis kind "${kind}"`);
      }
    }
  }
  if (opts.supersedesSpecId !== undefined) {
    if (opts.supersedesSpecId.trim().length === 0) {
      return fail('malformed supersedesSpecId');
    }
    if (opts.supersedesSpecId === specIdForRequest(validated)) {
      return fail('specification cannot supersede itself');
    }
  }
  const spec: GenerationSpecification = {
    specId: specIdForRequest(validated),
    specVersion: SPEC_SCHEMA_VERSION,
    ...(opts.supersedesSpecId !== undefined ? { supersedesSpecId: opts.supersedesSpecId } : {}),
    source: 'f2-generation-request',
    requestId: validated.requestId,
    planId: validated.planId,
    goalId: validated.goalId,
    basis: JSON.parse(JSON.stringify(validated.requestBasis)) as GenerationRequestBasis,
    activityRequirements: {
      kind: validated.activityKind,
      intent: validated.intent,
      purpose: validated.purpose,
      targetEntityIds: [...validated.targetEntityIds],
      targetDimensions: [...validated.targetDimensions],
      surfaceForm: validated.surfaceForm,
      ...(validated.transferRequirement !== undefined ? { transferRequirement: validated.transferRequirement } : {}),
      constraints: {
        ...validated.constraints,
        languageScope: [...validated.constraints.languageScope],
      },
      forbiddenShortcuts: [...validated.forbiddenShortcuts],
      ...(validated.debugContext !== undefined
        ? { debugContext: { brokenAttemptId: validated.debugContext.brokenAttemptId } }
        : {}),
    },
    expectedEvidence: {
      dimensions: [...validated.targetDimensions],
      evidenceTypes: [...validated.discriminatingEvidence.evidenceTypes],
      question: validated.discriminatingEvidence.question,
      ...(validated.discriminatingEvidence.observableBehavior !== undefined
        ? { observableBehavior: validated.discriminatingEvidence.observableBehavior }
        : {}),
    },
    acceptanceCriteria: validated.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    ...(validated.repetitionJustification !== undefined
      ? { repetitionJustification: validated.repetitionJustification }
      : {}),
    budget: { ...validated.budget },
    issuedAt: validated.issuedAt,
    provenance: { ...validated.provenance },
    validationPlan: buildValidationPlan(),
    sandboxAvailable: false,
  };
  if (validateGenerationSpecification(spec) === null) {
    return fail('transcribed specification failed structural validation');
  }
  return { ok: true, spec };
}
