import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import { getClassificationStatus } from '../knowledge/classification';
import type { ClassificationConfidence } from '../knowledge/ontologyTypes';

/**
 * Phase F2 activity catalog: the smallest clean abstraction over EXISTING
 * problems that lets the planner choose without generating anything.
 *
 * A catalog entry is a read-only view (problem identity + C knowledge +
 * verbatim difficulty). It carries NO learner state, NO scores, and NO
 * pedagogical claims — relevance is computed per goal at plan time by the
 * planner, never stored on the entry. Unclassified problems are excluded:
 * without C knowledge there is no honest entity anchor, and the planner
 * refuses to guess (mirroring the Phase D feed policy).
 */

export interface ActivityCatalogEntry {
  problemId: string;
  title: string | null;
  canonicalUrl: string;
  /** Verbatim problem difficulty (one opaque signal among many, never ranked by). */
  difficulty: string | null;
  /** All classified entity IDs (sorted, deduped). */
  entityIds: string[];
  frameworks: string[];
  forms: string[];
  concepts: string[];
  patterns: string[];
  classificationConfidence: ClassificationConfidence;
  classificationStatus: 'classified' | 'partial';
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))].sort();
}

function bucketIds(classification: ProblemClassification, bucket: keyof ProblemClassification): string[] {
  const refs = classification[bucket];
  if (!Array.isArray(refs)) {
    return [];
  }
  return (refs as Array<{ entityId: string }>).map((r) => r.entityId);
}

/**
 * Build one catalog entry from an existing problem + its classification.
 * Returns null when the problem is unclassified (no honest C anchor) —
 * the planner skips such problems instead of inventing knowledge.
 */
export function catalogEntryFromProblem(
  problem: Problem,
  classification: ProblemClassification | null | undefined,
): ActivityCatalogEntry | null {
  if (!classification || classification.problemId !== problem.problemId) {
    return null;
  }
  const status = getClassificationStatus(classification);
  if (status === 'unclassified') {
    return null;
  }
  const frameworks = sortedUnique(bucketIds(classification, 'frameworks'));
  const forms = sortedUnique([
    ...bucketIds(classification, 'forms'),
    ...bucketIds(classification, 'variants'),
  ]);
  const concepts = sortedUnique(bucketIds(classification, 'concepts'));
  const patterns = sortedUnique(bucketIds(classification, 'patterns'));
  const entityIds = sortedUnique([
    ...bucketIds(classification, 'topics'),
    ...concepts,
    ...frameworks,
    ...forms,
    ...patterns,
    ...bucketIds(classification, 'tactics'),
    ...bucketIds(classification, 'prerequisites'),
    ...bucketIds(classification, 'solutionFamilies'),
  ]);
  if (entityIds.length === 0) {
    return null;
  }
  return {
    problemId: problem.problemId,
    title: problem.title,
    canonicalUrl: problem.canonicalUrl,
    difficulty: problem.difficulty,
    entityIds,
    frameworks,
    forms,
    concepts,
    patterns,
    classificationConfidence: classification.confidence,
    classificationStatus: status === 'classified' ? 'classified' : 'partial',
  };
}

/**
 * Build the practice catalog from existing problems and their stored
 * classifications. Pure and deterministic (sorted by problemId). Problems
 * without a matching classification are skipped — never guessed.
 */
export function buildPracticeCatalog(
  problems: Problem[],
  classifications: Array<ProblemClassification | null | undefined>,
): ActivityCatalogEntry[] {
  const byProblem = new Map<string, ProblemClassification>();
  for (const classification of classifications) {
    if (classification && typeof classification.problemId === 'string') {
      const current = byProblem.get(classification.problemId);
      if (!current || classification.classifiedAt.localeCompare(current.classifiedAt) >= 0) {
        byProblem.set(classification.problemId, classification);
      }
    }
  }
  const out: ActivityCatalogEntry[] = [];
  for (const problem of problems) {
    const entry = catalogEntryFromProblem(problem, byProblem.get(problem.problemId) ?? null);
    if (entry) {
      out.push(entry);
    }
  }
  return out.sort((a, b) => a.problemId.localeCompare(b.problemId));
}

/** Shared goal entities between a candidate and the active goal. */
export function candidateEntityOverlap(entry: ActivityCatalogEntry, goalEntityIds: string[]): string[] {
  const wanted = new Set(goalEntityIds);
  return entry.entityIds.filter((id) => wanted.has(id)).sort();
}

/**
 * Whether the candidate isolates the target instead of mixing in many
 * unrelated skills. A simple problem that isolates the goal entity is
 * pedagogically preferable to a broad problem testing many unrelated
 * areas — isolation is a fit signal, difficulty is not. The threshold is
 * deliberately coarse (total entity count): exact per-bucket weighting
 * would be fake precision.
 */
export function candidateIsolatesTarget(entry: ActivityCatalogEntry, goalEntityIds: string[]): boolean {
  const overlap = candidateEntityOverlap(entry, goalEntityIds);
  if (overlap.length === 0) {
    return false;
  }
  return entry.entityIds.length <= 6;
}
