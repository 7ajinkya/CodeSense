import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { ProblemClassification } from '../knowledge/classification';
import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import { hashIdentity } from '../problems/problem';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import { truncateEvidenceText, validateLearnerEvidence } from '../learner/learnerEvidence';
import type { EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import {
  ReflectionCategory,
  ReflectionInterpretation,
  truncateReflectionText,
  validateReflectionInterpretation,
} from './reflectionTypes';

/**
 * Phase G deterministic evidence mapping (no AI required).
 *
 * D remains the sole owner of evidence construction rules: every record
 * built here passes `validateLearnerEvidence({ graph })` and is persisted
 * only through `syncRecordsToLearnerModel`. This module owns ONLY the
 * reflection→evidence *mapping* (which explicit category means what),
 * never the evidence lifecycle itself.
 *
 * Mapping philosophy:
 * - Category alone determines the evidence type; free text never changes
 *   the type on the deterministic path (it is quoted in the observation).
 * - A confirmed AI interpretation may *narrow* entities or supply a
 *   specific mistake category, but it can never widen confidence or invent
 *   entities (see `validateReflectionInterpretation`).
 * - Unclassified problems yield no evidence: without a canonical anchor
 *   the mapper refuses to guess (mirrors the attempt feed).
 */

/** Approach-level buckets reflection evidence may speak to. */
const REFLECTION_ENTITY_BUCKETS = ['frameworks', 'forms', 'variants', 'patterns', 'concepts'] as const;

type ReflectionBucket = (typeof REFLECTION_ENTITY_BUCKETS)[number];

function scopedReflectionEntities(
  classification: ProblemClassification | null | undefined,
): string[] {
  if (!classification) {
    return [];
  }
  const out = new Set<string>();
  for (const bucket of REFLECTION_ENTITY_BUCKETS) {
    const refs = (classification as Record<ReflectionBucket, Array<{ entityId: string }>>)[bucket] ?? [];
    for (const ref of refs) {
      if (typeof ref.entityId === 'string' && ref.entityId.length > 0) {
        out.add(ref.entityId);
      }
    }
  }
  return [...out].sort();
}

/** Stable identity: reprocessing the same reflection mints the same ids. */
export function stableReflectionEvidenceId(args: {
  reflectionId: string;
  evidenceType: EvidenceType;
  entityIds: string[];
  category: ReflectionCategory;
  mistakeCategory?: string;
}): string {
  const key = [
    'g-reflection',
    args.reflectionId,
    args.evidenceType,
    [...args.entityIds].sort().join(','),
    args.category,
    args.mistakeCategory ?? '',
  ].join('|');
  return `ev_${hashIdentity(key)}`;
}

function categoryObservation(args: {
  category: ReflectionCategory;
  problem: Problem;
  attempt: Attempt;
  freeText: string | null;
}): string {
  const title = args.problem.title ?? args.problem.problemId;
  const base = `Learner reflection (${args.category}) after "${title}" (ended as "${args.attempt.currentState}").`;
  if (args.freeText && args.freeText.trim().length > 0) {
    return `${base} Learner wrote: "${truncateReflectionText(args.freeText)}"`;
  }
  return base;
}

interface DeterministicSpec {
  evidenceType: EvidenceType;
  dimension: EvidenceDimension;
  confidence: 'low' | 'medium';
  mistakeCategory?: string;
  interpretation: string;
}

/**
 * Deterministic category → evidence spec (no AI, no free-text parsing).
 * Returns null for `other` (nothing determinate to claim).
 */
function specForCategory(category: ReflectionCategory): DeterministicSpec | null {
  switch (category) {
    case 'knew-idea-struggled-implement':
      return {
        evidenceType: 'CONCEPTUAL_SUCCESS',
        dimension: 'conceptual',
        confidence: 'low',
        interpretation:
          'Self-reported understanding with implementation friction. NO implementation claim is made here — ' +
          'paired with outcome evidence, that split IS the concept/implementation distinction.',
      };
    case 'did-not-recognize-pattern':
      return {
        evidenceType: 'CONCEPTUAL_CONFUSION',
        dimension: 'conceptual',
        confidence: 'low',
        interpretation:
          'Self-reported missed recognition: weak conceptual signal. An unfamiliar form explains it as well as a gap.',
      };
    case 'understood-after-hint':
      return {
        evidenceType: 'CONCEPTUAL_SUCCESS',
        dimension: 'conceptual',
        confidence: 'low',
        interpretation:
          'Self-reported understanding after a hint. Help itself is recorded separately from evaluations; ' +
          'this credits only the reported understanding, weakly.',
      };
    case 'debugging-mistake':
      return {
        evidenceType: 'RECURRING_MISTAKE',
        dimension: 'debugging',
        confidence: 'medium',
        mistakeCategory: 'debugging-mistake',
        interpretation:
          'Sighted "debugging-mistake" pattern instance; recurrence is decided by count, not by this record.',
      };
    case 'unsure-why-worked':
      return {
        evidenceType: 'CONCEPTUAL_CONFUSION',
        dimension: 'conceptual',
        confidence: 'low',
        interpretation:
          'Self-reported working code without understanding: accepted outcome with explicit non-understanding. ' +
          'Telemetry alone could never establish this.',
      };
    case 'other':
    default:
      return null;
  }
}

export interface ReflectionEvidenceInput {
  reflectionId: string;
  category: ReflectionCategory;
  freeText: string | null;
  /** Validated + learner-confirmed refinement (G6); null on the deterministic path. */
  interpretation: ReflectionInterpretation | null;
  attempt: Attempt;
  problem: Problem;
  classification: ProblemClassification | null | undefined;
  sessionId: string | null;
  timestamp: string;
}

/**
 * Pure mapper: explicit reflection input → 0..2 validated D evidence
 * records. Returns [] when nothing determinate can be claimed (e.g.
 * `other` with no confirmed interpretation, or unclassified problems).
 * Never throws; invalid candidates are dropped.
 */
export function extractReflectionEvidence(
  graph: KnowledgeGraph,
  input: ReflectionEvidenceInput,
): LearnerEvidence[] {
  const scoped = scopedReflectionEntities(input.classification);
  if (scoped.length === 0) {
    return [];
  }
  // Confirmed interpretation path (G6 refinement): the learner explicitly
  // confirmed an AI-proposed narrowing. Re-validate deterministically;
  // unconfirmed or invalid proposals fall through to the category default.
  const confirmed =
    input.interpretation !== null
      ? validateReflectionInterpretation(input.interpretation, { graph })
      : null;
  if (confirmed !== null && confirmed.learnerConfirmed) {
    const record = validateLearnerEvidence(
      {
        evidenceId: stableReflectionEvidenceId({
          reflectionId: input.reflectionId,
          evidenceType: confirmed.evidenceType,
          entityIds: confirmed.entityIds,
          category: input.category,
          mistakeCategory: confirmed.mistakeCategory,
        }),
        schemaVersion: 1,
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        attemptId: input.attempt.attemptId,
        problemId: input.problem.problemId,
        entityIds: [...confirmed.entityIds].sort(),
        evidenceType: confirmed.evidenceType,
        source: 'human-curated',
        observation: truncateEvidenceText(
          categoryObservation({
            category: input.category,
            problem: input.problem,
            attempt: input.attempt,
            freeText: input.freeText,
          }),
        ),
        interpretation: truncateEvidenceText(
          `${confirmedText(confirmed)} (learner-confirmed${confirmed.aiAssisted ? ', AI-assisted' : ''}).`,
        ),
        confidence: confirmed.confidence,
        ...(confirmed.evidenceType === 'RECURRING_MISTAKE' && confirmed.mistakeCategory
          ? { mistakeCategory: confirmed.mistakeCategory }
          : {}),
        ...(confirmed.evidenceType === 'RECURRING_MISTAKE'
          ? { dimension: confirmed.dimension }
          : {}),
        provenance: { source: 'human-curated', sourceId: input.reflectionId },
      },
      { graph },
    );
    return record ? [record] : [];
  }
  // Deterministic category path (works fully without AI).
  const spec = specForCategory(input.category);
  if (!spec) {
    return [];
  }
  const record = validateLearnerEvidence(
    {
      evidenceId: stableReflectionEvidenceId({
        reflectionId: input.reflectionId,
        evidenceType: spec.evidenceType,
        entityIds: scoped,
        category: input.category,
        mistakeCategory: spec.mistakeCategory,
      }),
      schemaVersion: 1,
      timestamp: input.timestamp,
      sessionId: input.sessionId,
      attemptId: input.attempt.attemptId,
      problemId: input.problem.problemId,
      entityIds: [...scoped].sort(),
      evidenceType: spec.evidenceType,
      source: 'human-curated',
      observation: truncateEvidenceText(
        categoryObservation({
          category: input.category,
          problem: input.problem,
          attempt: input.attempt,
          freeText: input.freeText,
        }),
      ),
      interpretation: truncateEvidenceText(spec.interpretation),
      confidence: spec.confidence,
      ...(spec.evidenceType === 'RECURRING_MISTAKE' && spec.mistakeCategory
        ? { mistakeCategory: spec.mistakeCategory, dimension: spec.dimension }
        : {}),
      provenance: { source: 'human-curated', sourceId: input.reflectionId },
    },
    { graph },
  );
  return record ? [record] : [];
}

function confirmedText(interpretation: ReflectionInterpretation): string {
  switch (interpretation.evidenceType) {
    case 'RECURRING_MISTAKE':
      return (
        `Sighted "${interpretation.mistakeCategory ?? 'debugging-mistake'}" pattern instance ` +
        `(${interpretation.dimension}); recurrence is decided by count, not by this record`
      );
    case 'CONCEPTUAL_SUCCESS':
      return 'Learner-confirmed self-reported understanding; credited weakly, no implementation claim';
    case 'CONCEPTUAL_CONFUSION':
      return 'Learner-confirmed self-reported confusion; one report is not a verdict';
    case 'RECOGNITION':
      return 'Learner-confirmed independent recognition; single-encounter weak';
    default:
      return 'Learner-confirmed reflection interpretation';
  }
}
