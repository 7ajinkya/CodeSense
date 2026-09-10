import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { GeneratedCandidate } from './generationCandidate';
import type { GenerationSpecification } from './generationSpecification';

/**
 * Phase I Stage 3 — deterministic pedagogical predicates (no AI).
 *
 * These checks establish only what can actually be established
 * deterministically. Every check below either fails with a concrete,
 * citable reason or defers silently to the critic — a check never claims
 * a candidate is pedagogically good. In particular:
 *
 * - Target-vocabulary presence detects obvious omissions; it never proves
 *   the target skill is genuinely required (that judgment belongs to the
 *   critic under `target-engagement`).
 * - Stage 2 already owns structural `changedElements` presence; it is not
 *   re-checked here.
 * - Intent/purpose membership was established structurally in Stage 2;
 *   story-level fit belongs to the critic under `challenge-purpose-fit`
 *   and `internal-consistency`.
 */

export type PedagogicalCriterion =
  | 'target-engagement'
  | 'evidence-observability'
  | 'transfer-anti-rote'
  | 'shortcut-resistance'
  | 'challenge-purpose-fit'
  | 'internal-consistency'
  | 'debugging-genuineness';

/** Fixed deterministic order: every result set follows this sequence. */
export const PEDAGOGICAL_CRITERIA: readonly PedagogicalCriterion[] = [
  'target-engagement',
  'evidence-observability',
  'transfer-anti-rote',
  'shortcut-resistance',
  'challenge-purpose-fit',
  'internal-consistency',
  'debugging-genuineness',
];

export const PEDAGOGICAL_RUBRIC_VERSION = 1;
export const PEDAGOGICAL_VALIDATOR_VERSION = 1;

/** Criteria whose failure or uncertainty blocks acceptance the hardest. */
export const LOAD_BEARING_CRITERIA: readonly PedagogicalCriterion[] = [
  'target-engagement',
  'evidence-observability',
  'transfer-anti-rote',
  'shortcut-resistance',
];

export function isKnownPedagogicalCriterion(value: unknown): value is PedagogicalCriterion {
  return typeof value === 'string' && (PEDAGOGICAL_CRITERIA as readonly string[]).includes(value);
}

export function isLoadBearingCriterion(criterion: PedagogicalCriterion): boolean {
  return (LOAD_BEARING_CRITERIA as readonly string[]).includes(criterion);
}

export const MAX_PEDAGOGICAL_REASON_CHARS = 500;

/** A decided deterministic finding; absence means deferred to the critic. */
export interface DeterministicPedagogicalFinding {
  criterion: PedagogicalCriterion;
  status: 'pass' | 'fail';
  reason: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function fail(criterion: PedagogicalCriterion, reason: string): DeterministicPedagogicalFinding {
  return { criterion, status: 'fail', reason: clip(reason, MAX_PEDAGOGICAL_REASON_CHARS) };
}

/** Lowercase alphanumeric tokens of meaningful length. */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/** Searchable vocabulary for one canonical entity: id parts, name, aliases. */
function entityTokens(entityId: string, graph: KnowledgeGraph): string[] {
  const entity = graph.getEntity(entityId);
  if (!entity) {
    return [];
  }
  const out = new Set<string>();
  for (const part of entityId.split('.')) {
    for (const token of tokensOf(part)) {
      out.add(token);
    }
  }
  for (const token of tokensOf(entity.name)) {
    out.add(token);
  }
  for (const alias of entity.aliases ?? []) {
    for (const token of tokensOf(alias)) {
      out.add(token);
    }
  }
  return [...out];
}

function normalizeCode(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * Target-vocabulary pre-gate (`target-engagement`): fails only when NO
 * target entity contributes any recognizable token to the task text.
 * Passing establishes nothing beyond "no obvious omission" — genuine
 * requirement is the critic's job.
 */
function checkTargetVocabulary(
  spec: GenerationSpecification,
  candidate: GeneratedCandidate,
  graph: KnowledgeGraph,
): DeterministicPedagogicalFinding | null {
  const haystack = `${candidate.title}\n${candidate.taskDescription}`.toLowerCase();
  for (const entityId of spec.activityRequirements.targetEntityIds) {
    const entity = graph.getEntity(entityId);
    if (!entity) {
      return fail('target-engagement', `Specification target "${entityId}" resolves against no known entity.`);
    }
    if (entityTokens(entityId, graph).some((token) => haystack.includes(token))) {
      return null;
    }
  }
  return fail(
    'target-engagement',
    'Task text carries no recognizable vocabulary for any specification target entity.',
  );
}

/**
 * Answer-leakage scan (`evidence-observability`): fails only on verbatim
 * embedding of the reference fix inside the task text of a debugging
 * task. Coding-problem candidates carry no reference solution field, so
 * there is nothing deterministic to check for them here.
 */
function checkAnswerLeakage(
  candidate: GeneratedCandidate,
): DeterministicPedagogicalFinding | null {
  if (candidate.activityKind !== 'debugging-task' || candidate.debugging === undefined) {
    return null;
  }
  const fix = normalizeCode(candidate.debugging.referenceFix);
  if (fix.length < 24) {
    return null;
  }
  const text = normalizeCode(`${candidate.title}\n${candidate.taskDescription}`);
  if (text.includes(fix)) {
    return fail('evidence-observability', 'Task text embeds the reference fix verbatim.');
  }
  return null;
}

/**
 * Debugging payload sanity (`debugging-genuineness`): fails only when the
 * broken and fixed artifacts are textually identical — a task with no
 * fault to diagnose. Whether the fault is meaningful is the critic's job.
 */
function checkDebuggingDistinctness(
  candidate: GeneratedCandidate,
): DeterministicPedagogicalFinding | null {
  if (candidate.activityKind !== 'debugging-task' || candidate.debugging === undefined) {
    return null;
  }
  if (normalizeCode(candidate.debugging.brokenSnapshot) === normalizeCode(candidate.debugging.referenceFix)) {
    return fail('debugging-genuineness', 'Broken and fixed code are identical; there is no fault to diagnose.');
  }
  return null;
}

/**
 * Specification linkage (`internal-consistency`): the candidate must point
 * at this specification, and kind and payload presence must agree. Shape
 * validation belongs to Stage 2; this is the I-3 fail-closed recheck.
 */
function checkSpecLinkage(
  spec: GenerationSpecification,
  candidate: GeneratedCandidate,
): DeterministicPedagogicalFinding | null {
  if (candidate.specId !== spec.specId) {
    return fail('internal-consistency', 'Candidate references a different specification.');
  }
  if (candidate.activityKind === 'debugging-task' && candidate.debugging === undefined) {
    return fail('internal-consistency', 'Debugging task carries no debugging artifact.');
  }
  if (candidate.activityKind !== 'debugging-task' && candidate.debugging !== undefined) {
    return fail('internal-consistency', 'Non-debugging task carries a debugging artifact.');
  }
  return null;
}

/**
 * Runs every deterministic pedagogical predicate. Returns at most one
 * finding per decided criterion; undecided criteria are absent (the critic
 * resolves them). Pure function over validated inputs.
 */
export function runDeterministicPedagogicalChecks(
  spec: GenerationSpecification,
  candidate: GeneratedCandidate,
  graph: KnowledgeGraph,
): DeterministicPedagogicalFinding[] {
  const findings: DeterministicPedagogicalFinding[] = [];
  const vocabulary = checkTargetVocabulary(spec, candidate, graph);
  if (vocabulary) {
    findings.push(vocabulary);
  }
  const leakage = checkAnswerLeakage(candidate);
  if (leakage) {
    findings.push(leakage);
  }
  const distinctness = checkDebuggingDistinctness(candidate);
  if (distinctness) {
    findings.push(distinctness);
  }
  const linkage = checkSpecLinkage(spec, candidate);
  if (linkage) {
    findings.push(linkage);
  }
  return findings;
}

/**
 * Out-of-scope reference detection for critic findings: canonical-ID-shaped
 * tokens (`xxx.yyy`) that resolve against the graph but are NOT
 * specification targets. Deterministic and narrow by design — display-name
 * prose cannot be reliably attributed, so only explicit canonical IDs are
 * flagged. Returns the offending ids, unique and sorted.
 */
export function detectOutOfScopeReferences(
  reason: string,
  specTargetEntityIds: string[],
  graph: KnowledgeGraph,
): string[] {
  const targets = new Set(specTargetEntityIds);
  const out = new Set<string>();
  const candidates = reason.match(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/g) ?? [];
  for (const candidate of candidates) {
    if (!targets.has(candidate) && graph.hasEntity(candidate)) {
      out.add(candidate);
    }
  }
  return [...out].sort();
}
