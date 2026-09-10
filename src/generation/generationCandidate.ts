import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import { isKnownEvidenceDimension, isKnownEvidenceType } from '../learner/learnerTypes';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type {
  ActivityIntent,
  ActivityKind,
  ActivityPurpose,
  DebuggingTaskPayload,
} from '../practice/activityTypes';
import {
  isKnownActivityIntent,
  isKnownActivityKind,
  isKnownActivityPurpose,
  validateDebuggingTaskPayload,
} from '../practice/activityTypes';
import type { GenerationRequestConstraints, GenerationSurfaceForm, RequestAcceptanceCriterion } from '../practice/generationRequest';
import { isKnownSurfaceForm, validateRequestConstraints } from '../practice/generationRequest';
import type { GenerationSpecification } from './generationSpecification';

/**
 * Phase I Stage 2 — generated candidate model + validation (no execution).
 *
 * A GeneratedCandidate is an untrusted artifact proposal: it becomes
 * meaningful only after passing structural, specification-conformance, and
 * knowledge-graph validation here. Executable correctness is explicitly
 * OUT of reach (no sandbox): execution-dependent acceptance stays blocked.
 * Pedagogical acceptance and independent criticism belong to later stages.
 *
 * Nothing here is persisted, nothing is learner evidence, and nothing can
 * start, recommend, or present an activity.
 */

export const CANDIDATE_ID_PREFIX = 'cand_';

/** Bounds keep candidates finite; validators reject over-long input. */
export const MAX_CANDIDATE_TITLE_CHARS = 280;
export const MAX_CANDIDATE_STATEMENT_CHARS = 6000;
export const MAX_CANDIDATE_SHORTCUTS = 24;
export const MAX_CANDIDATE_SURFACE_ELEMENTS = 12;
export const MAX_CANDIDATE_TEXT_CHARS = 500;
export const MAX_CANDIDATE_ID_CHARS = 120;
export const MAX_CHECK_DETAIL_CHARS = 500;
export const MAX_MISMATCHES = 12;

export interface CandidateProvenance {
  specId: string;
  requestId: string;
  planId: string;
  goalId: string;
  generatorId: string;
  generatorVersion: string;
}

/** Explicit structural marker of what was changed for an unfamiliar form. */
export interface CandidateSurfaceEvidence {
  contextDescription: string;
  changedElements: string[];
}

export interface CandidateExpectedEvidence {
  dimensions: EvidenceDimension[];
  evidenceTypes: EvidenceType[];
  question: string;
  observableBehavior?: string;
}

export interface GeneratedCandidate {
  /** Stable deterministic id (`cand_<fnv(specId|version|title|statement)>`). */
  candidateId: string;
  /** Generation attempt number (≥1); distinguishes retries of one spec. */
  candidateVersion: number;
  specId: string;
  activityKind: ActivityKind;
  title: string;
  taskDescription: string;
  targetEntityIds: string[];
  targetDimensions: EvidenceDimension[];
  surfaceForm: GenerationSurfaceForm;
  surfaceEvidence?: CandidateSurfaceEvidence;
  constraints: GenerationRequestConstraints;
  forbiddenShortcuts: string[];
  expectedEvidence: CandidateExpectedEvidence;
  intent: ActivityIntent;
  purpose: ActivityPurpose;
  acceptanceCriteria: RequestAcceptanceCriterion[];
  /** Required exactly for `debugging-task`; forbidden for `coding-problem`. */
  debugging?: DebuggingTaskPayload;
  provenance: CandidateProvenance;
}

export type ValidationCheckName = 'structural' | 'spec-conformance' | 'knowledge-graph' | 'execution';

export const VALIDATION_CHECK_NAMES: readonly ValidationCheckName[] = [
  'structural',
  'spec-conformance',
  'knowledge-graph',
  'execution',
];

export type ValidationCheckStatus = 'pass' | 'fail' | 'blocked' | 'not-applicable';

export interface ValidationCheck {
  check: ValidationCheckName;
  status: ValidationCheckStatus;
  detail: string;
}

export interface CandidateValidationReport {
  candidateId: string;
  specId: string;
  checks: ValidationCheck[];
  verdict: 'accepted' | 'rejected' | 'unavailable';
}

export type GenerationStatus = 'accepted' | 'rejected' | 'unavailable';

export interface GenerationResult {
  status: GenerationStatus;
  /** Present only when accepted; rejected/unavailable carry the report only. */
  candidate?: GeneratedCandidate;
  report: CandidateValidationReport;
  diagnostics: string[];
}

/** Deterministic FNV-1a hex (matches repo hashing style, dependency-free). */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function candidateIdFor(specId: string, candidateVersion: number, title: string, taskDescription: string): string {
  return `${CANDIDATE_ID_PREFIX}${stableHash(`${specId}|${candidateVersion}|${title}|${taskDescription}`)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonBlankBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function uniqueIds(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function check(check: ValidationCheckName, status: ValidationCheckStatus, detail: string): ValidationCheck {
  return { check, status, detail: clip(detail, MAX_CHECK_DETAIL_CHARS) };
}

/**
 * Strict structural validation for candidate objects (never throws).
 * Returns the normalized candidate or null. Knowledge/specification
 * conformance are separate layers, not smuggled in here.
 */
export function validateGeneratedCandidate(raw: unknown): GeneratedCandidate | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!isNonBlankBounded(raw.candidateId, MAX_CANDIDATE_ID_CHARS)) {
    return null;
  }
  if (typeof raw.candidateVersion !== 'number' || !Number.isInteger(raw.candidateVersion) || raw.candidateVersion < 1) {
    return null;
  }
  if (!isNonBlankBounded(raw.specId, MAX_CANDIDATE_ID_CHARS)) {
    return null;
  }
  // Only the approved Stage-I kinds are accepted; anything else (including
  // any future micro-task kind) fails closed here.
  if (!isKnownActivityKind(raw.activityKind)) {
    return null;
  }
  if (!isNonBlankBounded(raw.title, MAX_CANDIDATE_TITLE_CHARS)) {
    return null;
  }
  if (!isNonBlankBounded(raw.taskDescription, MAX_CANDIDATE_STATEMENT_CHARS)) {
    return null;
  }
  const entityIds: unknown = raw.targetEntityIds;
  if (
    !isStringArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.some((id) => id.trim().length === 0) ||
    !uniqueIds(entityIds)
  ) {
    return null;
  }
  const dimensions: unknown = raw.targetDimensions;
  if (
    !isStringArray(dimensions) ||
    dimensions.length === 0 ||
    !dimensions.every((d) => isKnownEvidenceDimension(d)) ||
    !uniqueIds(dimensions)
  ) {
    return null;
  }
  if (!isKnownSurfaceForm(raw.surfaceForm)) {
    return null;
  }
  let surfaceEvidence: CandidateSurfaceEvidence | undefined;
  if (raw.surfaceEvidence !== undefined) {
    if (!isRecord(raw.surfaceEvidence)) {
      return null;
    }
    const surface = raw.surfaceEvidence as Record<string, unknown>;
    if (!isNonBlankBounded(surface.contextDescription, MAX_CANDIDATE_TEXT_CHARS)) {
      return null;
    }
    if (
      !isStringArray(surface.changedElements) ||
      (surface.changedElements as string[]).length > MAX_CANDIDATE_SURFACE_ELEMENTS ||
      (surface.changedElements as string[]).some((e) => !isNonBlankBounded(e, MAX_CANDIDATE_TEXT_CHARS))
    ) {
      return null;
    }
    surfaceEvidence = {
      contextDescription: surface.contextDescription as string,
      changedElements: [...(surface.changedElements as string[])],
    };
  }
  const constraints = validateRequestConstraints(raw.constraints);
  if (constraints === null) {
    return null;
  }
  const shortcuts: unknown = raw.forbiddenShortcuts;
  if (
    !Array.isArray(shortcuts) ||
    shortcuts.length > MAX_CANDIDATE_SHORTCUTS ||
    shortcuts.some((s: unknown) => !isNonBlankBounded(s, MAX_CANDIDATE_TEXT_CHARS))
  ) {
    return null;
  }
  const expected: unknown = raw.expectedEvidence;
  if (!isRecord(expected)) {
    return null;
  }
  const expectedRecord = expected as Record<string, unknown>;
  if (
    !isStringArray(expectedRecord.dimensions) ||
    (expectedRecord.dimensions as string[]).length === 0 ||
    !(expectedRecord.dimensions as string[]).every((d) => isKnownEvidenceDimension(d))
  ) {
    return null;
  }
  if (
    !isStringArray(expectedRecord.evidenceTypes) ||
    (expectedRecord.evidenceTypes as string[]).length === 0 ||
    !(expectedRecord.evidenceTypes as string[]).every((t) => isKnownEvidenceType(t))
  ) {
    return null;
  }
  if (!isNonBlankBounded(expectedRecord.question, MAX_CANDIDATE_TEXT_CHARS)) {
    return null;
  }
  if (
    expectedRecord.observableBehavior !== undefined &&
    !isNonBlankBounded(expectedRecord.observableBehavior, MAX_CANDIDATE_TEXT_CHARS)
  ) {
    return null;
  }
  if (!isKnownActivityIntent(raw.intent)) {
    return null;
  }
  if (!isKnownActivityPurpose(raw.purpose)) {
    return null;
  }
  const criteria: unknown = raw.acceptanceCriteria;
  if (!Array.isArray(criteria)) {
    return null;
  }
  for (const item of criteria) {
    if (!isRecord(item)) {
      return null;
    }
    const criterion = item as Record<string, unknown>;
    if (
      typeof criterion.criterionId !== 'string' ||
      criterion.criterionId.length === 0 ||
      criterion.criterionId.length > 80 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(criterion.criterionId) ||
      !isNonBlankBounded(criterion.description, MAX_CANDIDATE_TEXT_CHARS)
    ) {
      return null;
    }
  }
  // Kind/payload exclusivity mirrors the F2 plan contract: debugging tasks
  // carry a validated debugging payload; coding problems must not.
  let debugging: DebuggingTaskPayload | undefined;
  if (raw.activityKind === 'debugging-task') {
    const parsed = validateDebuggingTaskPayload(raw.debugging);
    if (parsed === null) {
      return null;
    }
    debugging = parsed;
  } else if (raw.debugging !== undefined) {
    return null;
  }
  const provenance: unknown = raw.provenance;
  if (!isRecord(provenance)) {
    return null;
  }
  const provenanceRecord = provenance as Record<string, unknown>;
  for (const key of ['specId', 'requestId', 'planId', 'goalId', 'generatorId', 'generatorVersion'] as const) {
    if (!isNonBlankBounded(provenanceRecord[key], MAX_CANDIDATE_ID_CHARS)) {
      return null;
    }
  }
  return {
    candidateId: raw.candidateId as string,
    candidateVersion: raw.candidateVersion as number,
    specId: raw.specId as string,
    activityKind: raw.activityKind as ActivityKind,
    title: raw.title as string,
    taskDescription: raw.taskDescription as string,
    targetEntityIds: [...(entityIds as string[])],
    targetDimensions: [...(dimensions as EvidenceDimension[])],
    surfaceForm: raw.surfaceForm as GenerationSurfaceForm,
    ...(surfaceEvidence !== undefined ? { surfaceEvidence } : {}),
    constraints,
    forbiddenShortcuts: [...(shortcuts as string[])],
    expectedEvidence: {
      dimensions: [...(expectedRecord.dimensions as EvidenceDimension[])],
      evidenceTypes: [...(expectedRecord.evidenceTypes as EvidenceType[])],
      question: expectedRecord.question as string,
      ...(typeof expectedRecord.observableBehavior === 'string'
        ? { observableBehavior: expectedRecord.observableBehavior as string }
        : {}),
    },
    intent: raw.intent as ActivityIntent,
    purpose: raw.purpose as ActivityPurpose,
    acceptanceCriteria: (criteria as Array<Record<string, unknown>>).map((criterion) => ({
      criterionId: criterion.criterionId as string,
      description: criterion.description as string,
    })),
    ...(debugging !== undefined ? { debugging } : {}),
    provenance: {
      specId: provenanceRecord.specId as string,
      requestId: provenanceRecord.requestId as string,
      planId: provenanceRecord.planId as string,
      goalId: provenanceRecord.goalId as string,
      generatorId: provenanceRecord.generatorId as string,
      generatorVersion: provenanceRecord.generatorVersion as string,
    },
  };
}

function sortedEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Permissive-construction templates: explicit ways of recommending a
 * banned shortcut. Deterministic proxy with documented limits — it catches
 * direct recommendations, not paraphrases or implications. Judging real
 * pedagogical mismatch belongs to the later critic, not this check.
 */
const PERMISSIVE_TEMPLATES = ['you may', 'you can', 'feel free to', 'go ahead and', 'allowed to', 'permitted to'];

function explicitlyPermits(text: string, shortcut: string): boolean {
  const normalized = text.toLowerCase();
  const target = shortcut.trim().toLowerCase();
  if (target.length === 0) {
    return false;
  }
  for (const template of PERMISSIVE_TEMPLATES) {
    const pattern = new RegExp(`${template}\\b[^.]{0,80}${escapeRegExp(target)}`, 'i');
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Specification conformance: the candidate may elaborate the spec but may
 * not weaken, remove, contradict, or silently retarget it. Returns the
 * list of mismatches (bounded); empty means conformant. Pure function.
 */
export function validateCandidateConformance(
  spec: GenerationSpecification,
  candidate: GeneratedCandidate,
): { ok: true } | { ok: false; mismatches: string[] } {
  const mismatches: string[] = [];
  const push = (detail: string): void => {
    if (mismatches.length < MAX_MISMATCHES) {
      mismatches.push(clip(detail, MAX_CHECK_DETAIL_CHARS));
    }
  };
  if (candidate.activityKind !== spec.activityRequirements.kind) {
    push(`kind mismatch: candidate is "${candidate.activityKind}", specification requires "${spec.activityRequirements.kind}"`);
  }
  if (!sortedEqual(candidate.targetEntityIds, spec.activityRequirements.targetEntityIds)) {
    push('target entities differ from the specification targets');
  }
  if (!sortedEqual(candidate.targetDimensions, spec.activityRequirements.targetDimensions)) {
    push('target dimensions differ from the specification targets');
  }
  if (candidate.surfaceForm !== spec.activityRequirements.surfaceForm) {
    push(`surface form mismatch: candidate is "${candidate.surfaceForm}", specification requires "${spec.activityRequirements.surfaceForm}"`);
  }
  if (
    spec.activityRequirements.surfaceForm === 'unfamiliar' &&
    (candidate.surfaceEvidence === undefined || candidate.surfaceEvidence.changedElements.length === 0)
  ) {
    push('unfamiliar surface form requires explicit changed-elements evidence');
  }
  if (JSON.stringify(candidate.constraints) !== JSON.stringify(spec.activityRequirements.constraints)) {
    push('constraints differ from the specification constraints');
  }
  for (const shortcut of spec.activityRequirements.forbiddenShortcuts) {
    if (!candidate.forbiddenShortcuts.includes(shortcut)) {
      push(`forbidden shortcut dropped: "${shortcut}"`);
    }
  }
  const text = `${candidate.title}\n${candidate.taskDescription}`;
  for (const shortcut of spec.activityRequirements.forbiddenShortcuts) {
    if (explicitlyPermits(text, shortcut)) {
      push(`candidate explicitly permits forbidden shortcut: "${shortcut}"`);
    }
  }
  if (!sortedEqual(candidate.expectedEvidence.dimensions, spec.expectedEvidence.dimensions)) {
    push('expected-evidence dimensions differ from the specification');
  }
  if (!sortedEqual(candidate.expectedEvidence.evidenceTypes, spec.expectedEvidence.evidenceTypes)) {
    push('expected-evidence types differ from the specification');
  }
  if (candidate.expectedEvidence.question !== spec.expectedEvidence.question) {
    push('expected-evidence question differs from the specification');
  }
  const specObservable = spec.expectedEvidence.observableBehavior;
  const candidateObservable = candidate.expectedEvidence.observableBehavior;
  if ((specObservable ?? null) !== (candidateObservable ?? null)) {
    push('expected observable behavior differs from the specification');
  }
  if (candidate.intent !== spec.activityRequirements.intent) {
    push(`intent mismatch: candidate is "${candidate.intent}", specification requires "${spec.activityRequirements.intent}"`);
  }
  if (candidate.purpose !== spec.activityRequirements.purpose) {
    push(`purpose mismatch: candidate is "${candidate.purpose}", specification requires "${spec.activityRequirements.purpose}"`);
  }
  // Acceptance criteria: every specified criterion must survive with its
  // description intact; extras are permitted (strengthening, not weakening).
  for (const criterion of spec.acceptanceCriteria) {
    const match = candidate.acceptanceCriteria.find((item) => item.criterionId === criterion.criterionId);
    if (!match) {
      push(`acceptance criterion removed: "${criterion.criterionId}"`);
    } else if (match.description !== criterion.description) {
      push(`acceptance criterion reinterpreted: "${criterion.criterionId}"`);
    }
  }
  if (candidate.provenance.specId !== spec.specId) {
    push('candidate provenance does not reference this specification');
  }
  if (mismatches.length > 0) {
    return { ok: false, mismatches };
  }
  return { ok: true };
}

/**
 * C knowledge validation against the frozen graph: every candidate target
 * entity must resolve. The specification carries no entity-type demands,
 * so existence is the check; generated content can only reference the
 * frozen ontology, never extend it.
 */
export function validateCandidateKnowledge(
  candidate: GeneratedCandidate,
  graph: KnowledgeGraph,
): { ok: true } | { ok: false; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const entityId of candidate.targetEntityIds) {
    if (!graph.hasEntity(entityId)) {
      if (mismatches.length < MAX_MISMATCHES) {
        mismatches.push(clip(`unknown entity "${entityId}"`, MAX_CHECK_DETAIL_CHARS));
      }
    }
  }
  if (mismatches.length > 0) {
    return { ok: false, mismatches };
  }
  return { ok: true };
}

function rejectedReport(
  candidateId: string,
  specId: string,
  checks: ValidationCheck[],
  diagnostics: string[],
): GenerationResult {
  return {
    status: 'rejected',
    report: { candidateId, specId, checks, verdict: 'rejected' },
    diagnostics: diagnostics.slice(0, MAX_MISMATCHES).map((line) => clip(line, MAX_CHECK_DETAIL_CHARS)),
  };
}

/**
 * Rejection without a candidate object (e.g. malformed generator output):
 * structural failure is recorded against an unknown candidate id so the
 * report stays traceable to the specification. Never acceptance.
 */
export function rejectedUnknownResult(specId: string, diagnostics: string[]): GenerationResult {
  return rejectedReport(
    'unknown',
    specId,
    [
      check('structural', 'fail', 'Generator output was malformed; no candidate could be formed.'),
      check('spec-conformance', 'not-applicable', 'Skipped: no candidate formed.'),
      check('knowledge-graph', 'not-applicable', 'Skipped: no candidate formed.'),
      check('execution', 'blocked', 'Executable correctness cannot be established without an approved sandbox.'),
    ],
    diagnostics,
  );
}

/**
 * Stage 2 validation pipeline: structural → specification-conformance →
 * knowledge-graph, with execution explicitly blocked (no sandbox).
 * A candidate is accepted only if every enabled gate passes. Pure function.
 */
export function runStage2Validation(
  spec: GenerationSpecification,
  candidateRaw: unknown,
  graph: KnowledgeGraph,
): GenerationResult {
  const candidate = validateGeneratedCandidate(candidateRaw);
  if (candidate === null) {
    return rejectedReport(
      isRecord(candidateRaw) && typeof candidateRaw.candidateId === 'string' ? candidateRaw.candidateId : 'unknown',
      spec.specId,
      [
        check('structural', 'fail', 'Candidate is structurally malformed.'),
        check('spec-conformance', 'not-applicable', 'Skipped: structural validation failed.'),
        check('knowledge-graph', 'not-applicable', 'Skipped: structural validation failed.'),
        check('execution', 'blocked', 'Executable correctness cannot be established without an approved sandbox.'),
      ],
      ['Candidate failed structural validation.'],
    );
  }
  const conformance = validateCandidateConformance(spec, candidate);
  if (!conformance.ok) {
    return rejectedReport(candidate.candidateId, spec.specId, [
      check('structural', 'pass', 'Candidate is structurally well-formed.'),
      check('spec-conformance', 'fail', conformance.mismatches.join('; ')),
      check('knowledge-graph', 'not-applicable', 'Skipped: specification conformance failed.'),
      check('execution', 'blocked', 'Executable correctness cannot be established without an approved sandbox.'),
    ], conformance.mismatches);
  }
  const knowledge = validateCandidateKnowledge(candidate, graph);
  if (!knowledge.ok) {
    return rejectedReport(candidate.candidateId, spec.specId, [
      check('structural', 'pass', 'Candidate is structurally well-formed.'),
      check('spec-conformance', 'pass', 'Candidate satisfies the specification.'),
      check('knowledge-graph', 'fail', knowledge.mismatches.join('; ')),
      check('execution', 'blocked', 'Executable correctness cannot be established without an approved sandbox.'),
    ], knowledge.mismatches);
  }
  return {
    status: 'accepted',
    candidate,
    report: {
      candidateId: candidate.candidateId,
      specId: spec.specId,
      checks: [
        check('structural', 'pass', 'Candidate is structurally well-formed.'),
        check('spec-conformance', 'pass', 'Candidate satisfies the specification.'),
        check('knowledge-graph', 'pass', 'All target entities resolve against the frozen graph.'),
        check('execution', 'blocked', 'Executable correctness cannot be established without an approved sandbox.'),
      ],
      verdict: 'accepted',
    },
    diagnostics: ['Candidate passed all Stage-2-enabled gates; executable correctness remains unverified.'],
  };
}
