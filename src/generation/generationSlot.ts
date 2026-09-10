import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { ActivityPlan } from '../practice/activityTypes';
import { validateDebuggingTaskPayload } from '../practice/activityTypes';
import type { GenerationRequest } from '../practice/generationRequest';
import { validateGenerationRequest } from '../practice/generationRequest';
import type { GenerationSpecification } from './generationSpecification';
import { toGenerationSpecification } from './generationSpecification';
import type { CandidateGenerationContext, CandidateGenerator } from './candidateGenerator';
import { generateCandidate } from './candidateGenerator';
import type { CandidateValidationReport, GeneratedCandidate } from './generationCandidate';
import type { PedagogicalCritic, PedagogicalValidationResult } from './pedagogicalCritic';
import { validatePedagogically } from './pedagogicalCritic';

/**
 * Phase I Stage 4 — F2 generation-slot integration (planning stays F2-owned).
 *
 * Direction is strictly F2 → I → F2: F2 owns the plan slot and its
 * GenerationRequest; I transcribes, generates, validates, and returns a
 * filled slot. I never creates plans, never sequences activities, never
 * presents to the learner, never persists anything, and never calls the
 * generator more than once per resolution (a single attempt; a
 * `revise`/`reject` outcome is terminal for this call).
 *
 * Trust model: this module re-verifies wiring (IDs, kinds, verdicts,
 * flags) but does not re-run I-2/I-3 validation — callers pass the
 * validated artifacts the orchestrator itself produced.
 */

export type SlotResolutionStatus =
  | 'offerable'
  | 'generation-unavailable'
  | 'generation-rejected'
  | 'validation-rejected'
  | 'pedagogical-revise'
  | 'pedagogical-reject'
  | 'request-invalid'
  | 'slot-mismatch';

export interface SlotResolution {
  status: SlotResolutionStatus;
  /** Filled plan, present only when offerable. Returned, never persisted here. */
  plan?: ActivityPlan;
  specId?: string;
  candidateId?: string;
  requestId: string;
  planId: string;
  goalId: string;
  reason: string;
  stage2Report?: CandidateValidationReport;
  pedagogicalResult?: PedagogicalValidationResult;
  executionUnverified: true;
}

export type SlotFillOutcome =
  | { ok: true; plan: ActivityPlan }
  | { ok: false; error: { reason: string } };

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function baseResolution(
  status: SlotResolutionStatus,
  ids: { requestId: string; planId: string; goalId: string },
  reason: string,
): SlotResolution {
  return {
    status,
    requestId: ids.requestId,
    planId: ids.planId,
    goalId: ids.goalId,
    reason: clip(reason, 500),
    executionUnverified: true,
  };
}

/**
 * Verifies a GenerationRequest belongs to an F2 plan slot without
 * interpreting it: IDs/kind/intent/purpose must match, request targets
 * must stay inside the slot (subset, allowing focus), and the plan
 * dimension must be among the request dimensions. The slot must also be
 * unfilled. Pure function.
 */
export function checkSlotBinding(
  plan: ActivityPlan,
  request: GenerationRequest,
): { ok: true } | { ok: false; reason: string } {
  if (plan.planId !== request.planId) {
    return { ok: false, reason: 'plan/request planId mismatch' };
  }
  if (plan.goalId !== request.goalId) {
    return { ok: false, reason: 'plan/request goalId mismatch' };
  }
  if (plan.activityKind !== request.activityKind) {
    return { ok: false, reason: 'plan/request kind mismatch' };
  }
  if (plan.intent !== request.intent) {
    return { ok: false, reason: 'plan/request intent mismatch' };
  }
  if (plan.purpose !== request.purpose) {
    return { ok: false, reason: 'plan/request purpose mismatch' };
  }
  if (!request.targetEntityIds.every((id) => plan.entityIds.includes(id))) {
    return { ok: false, reason: 'request targets an entity outside the plan slot' };
  }
  if (!request.targetDimensions.includes(plan.dimension)) {
    return { ok: false, reason: 'plan dimension outside the request targets' };
  }
  if (plan.generatedArtifact !== undefined) {
    return { ok: false, reason: 'slot already filled' };
  }
  return { ok: true };
}

/**
 * Attaches an I-3-passed candidate to its F2 slot. Fills only: the plan
 * must already exist in `planned` status with no linked attempt, the
 * candidate wiring must match request/spec/result IDs, the pedagogical
 * verdict must be `pass`, and the execution-unverified boundary must
 * hold. Status is preserved (`planned`) — offering stays F2's decision.
 * Never persists; the caller (F2 side) owns storage. Pure function.
 */
export function fillGenerationSlot(
  plan: ActivityPlan,
  candidate: GeneratedCandidate,
  request: GenerationRequest,
  spec: GenerationSpecification,
  pedagogical: PedagogicalValidationResult,
  now: string,
): SlotFillOutcome {
  const fail = (reason: string): SlotFillOutcome => ({ ok: false, error: { reason } });
  const binding = checkSlotBinding(plan, request);
  if (!binding.ok) {
    return fail(binding.reason);
  }
  if (candidate.specId !== spec.specId) {
    return fail('candidate/spec mismatch');
  }
  if (spec.requestId !== request.requestId || spec.planId !== request.planId || spec.goalId !== request.goalId) {
    return fail('specification does not belong to this request');
  }
  if (
    candidate.provenance.requestId !== request.requestId ||
    candidate.provenance.planId !== request.planId ||
    candidate.provenance.goalId !== request.goalId
  ) {
    return fail('candidate provenance does not match the request slot');
  }
  if (pedagogical.verdict !== 'pass') {
    return fail(`pedagogical verdict ${pedagogical.verdict} is not offerable`);
  }
  if (pedagogical.candidateId !== candidate.candidateId || pedagogical.specId !== spec.specId) {
    return fail('pedagogical result does not match this candidate and specification');
  }
  if (pedagogical.executionUnverified !== true) {
    return fail('execution claim unexpected');
  }
  if (spec.sandboxAvailable !== false) {
    return fail('sandbox gate unexpected');
  }
  if (plan.status !== 'planned') {
    return fail(`plan status ${plan.status} cannot be filled`);
  }
  if (plan.linkedAttemptId !== null) {
    return fail('plan already linked to an attempt');
  }
  if (candidate.activityKind !== plan.activityKind) {
    return fail('candidate/plan kind mismatch');
  }
  // Debugging content mirrors into the plan-native payload so existing
  // consumers see a normal debugging plan; coding problems carry content
  // in the artifact itself (plans have no statement field by design).
  let debugPayload = plan.debugPayload;
  if (plan.activityKind === 'debugging-task') {
    const parsed = validateDebuggingTaskPayload(candidate.debugging);
    if (parsed === null) {
      return fail('candidate debugging payload invalid');
    }
    debugPayload = parsed;
  }
  return {
    ok: true,
    plan: {
      ...plan,
      ...(debugPayload !== undefined
        ? { debugPayload: { ...debugPayload, tests: [...debugPayload.tests] } }
        : {}),
      generatedArtifact: {
        candidateId: candidate.candidateId,
        specId: spec.specId,
        requestId: request.requestId,
        kind: plan.activityKind,
        title: candidate.title,
        taskDescription: candidate.taskDescription,
      },
      updatedAt: now,
      entityIds: [...plan.entityIds],
      expectedEvidenceTypes: [...plan.expectedEvidenceTypes],
      evidenceBasis: { ...plan.evidenceBasis, evidenceIds: [...plan.evidenceBasis.evidenceIds] },
      provenance: { ...plan.provenance },
    },
  };
}

export interface SlotResolutionArgs {
  plan: ActivityPlan;
  request: unknown;
  generator: CandidateGenerator;
  critic?: PedagogicalCritic;
  graph: KnowledgeGraph;
  context?: CandidateGenerationContext;
  now: string;
}

/**
 * Full I-4 resolution: validate request → verify slot binding → transcribe
 * → generate exactly once → I-2 → I-3 → fill on pass. Every failure maps
 * to a distinct terminal status; nothing retries, nothing persists, and
 * the filled plan is returned for F2 to store through its own store.
 */
export async function resolveGenerationSlot(args: SlotResolutionArgs): Promise<SlotResolution> {
  const ids = {
    requestId:
      typeof args.request === 'object' && args.request !== null
        ? String((args.request as Record<string, unknown>).requestId ?? 'unknown')
        : 'unknown',
    planId: args.plan.planId,
    goalId: args.plan.goalId,
  };
  const validated = validateGenerationRequest(args.request);
  if (validated === null) {
    return baseResolution('request-invalid', ids, 'GenerationRequest failed structural validation.');
  }
  const header = { requestId: validated.requestId, planId: validated.planId, goalId: validated.goalId };
  const binding = checkSlotBinding(args.plan, validated);
  if (!binding.ok) {
    return baseResolution('slot-mismatch', header, binding.reason);
  }
  const specOutcome = toGenerationSpecification(validated, { graph: args.graph, now: args.now });
  if (!specOutcome.ok) {
    return baseResolution('request-invalid', header, `Specification transcription refused: ${specOutcome.error.reason}.`);
  }
  const spec = specOutcome.spec;
  let generated: Awaited<ReturnType<typeof generateCandidate>>;
  try {
    generated = await generateCandidate(args.generator, spec, args.graph, args.context);
  } catch (err) {
    return {
      ...baseResolution(
        'generation-unavailable',
        header,
        `Generator threw: ${err instanceof Error ? err.message : String(err)}.`,
      ),
      specId: spec.specId,
    };
  }
  if (generated.status === 'unavailable') {
    return {
      ...baseResolution('generation-unavailable', header, generated.diagnostics.join('; ') || 'Generation unavailable.'),
      specId: spec.specId,
      stage2Report: generated.report,
    };
  }
  if (generated.status === 'rejected') {
    const malformed = generated.report.candidateId === 'unknown';
    return {
      ...baseResolution(
        malformed ? 'generation-rejected' : 'validation-rejected',
        header,
        generated.diagnostics.join('; ') || 'Candidate rejected.',
      ),
      specId: spec.specId,
      candidateId: malformed ? undefined : generated.report.candidateId,
      stage2Report: generated.report,
    };
  }
  const candidate = generated.candidate;
  if (candidate === undefined) {
    return {
      ...baseResolution('validation-rejected', header, 'Accepted without a candidate.'),
      specId: spec.specId,
      stage2Report: generated.report,
    };
  }
  let pedagogical: PedagogicalValidationResult;
  try {
    pedagogical = await validatePedagogically(spec, candidate, args.graph, args.critic);
  } catch (err) {
    return {
      ...baseResolution(
        'pedagogical-reject',
        header,
        `Pedagogical validation threw: ${err instanceof Error ? err.message : String(err)}.`,
      ),
      specId: spec.specId,
      candidateId: candidate.candidateId,
      stage2Report: generated.report,
    };
  }
  if (pedagogical.verdict !== 'pass') {
    return {
      ...baseResolution(
        pedagogical.verdict === 'revise' ? 'pedagogical-revise' : 'pedagogical-reject',
        header,
        `Pedagogical verdict ${pedagogical.verdict}; terminal for this resolution.`,
      ),
      specId: spec.specId,
      candidateId: candidate.candidateId,
      stage2Report: generated.report,
      pedagogicalResult: pedagogical,
    };
  }
  const filled = fillGenerationSlot(args.plan, candidate, validated, spec, pedagogical, args.now);
  if (!filled.ok) {
    return {
      ...baseResolution('slot-mismatch', header, filled.error.reason),
      specId: spec.specId,
      candidateId: candidate.candidateId,
      stage2Report: generated.report,
      pedagogicalResult: pedagogical,
    };
  }
  return {
    ...baseResolution('offerable', header, 'Candidate passed all gates and fills the F2 slot; execution unverified.'),
    plan: filled.plan,
    specId: spec.specId,
    candidateId: candidate.candidateId,
    stage2Report: generated.report,
    pedagogicalResult: pedagogical,
  };
}
