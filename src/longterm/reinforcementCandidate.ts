import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import { deriveProblemStatsForProblem } from './problemStats';
import type { ProblemKnowledgeRecord } from './problemKnowledge';
import type { ReinforcementNeed } from './reinforcementNeed';

/**
 * Phase J-2 similar, structurally narrower consolidation candidates: "which
 * EXISTING problem is a defensible consolidation step for this reinforcement
 * need?" Pure, read-only, deterministic — no store, no AI, no I generation,
 * no clock.
 *
 * Boundary notes:
 * - Similarity is structural over canonical C IDs only (shared
 *   frameworks/forms first, concepts/tactics as preserved context). Same
 *   title, same provider, same verbatim difficulty, or topic-only overlap
 *   never qualifies — those prove nothing about shared reasoning.
 * - "Easier" has NO universal scale in this repository: `Problem.difficulty`
 *   is verbatim opaque text the F2 planner deliberately never ranks by, so
 *   J-2 does not rank by it either. The repository-supportable relative
 *   reading is structural focus: a candidate exercising the same core
 *   (shared framework/form) across FEWER total knowledge areas is a
 *   narrower consolidation step. Verbatim difficulty is reported as opaque
 *   context only. This limitation is explicit, not hidden.
 * - Repetition reuses J-0 derived stats (no new counters): candidates
 *   solved ≥ MAX_CANDIDATE_SOLVES times are already consolidated (mirrors
 *   F3's "≥2 positive distinct plans" sufficiency invariant); unattempted
 *   candidates order before practiced ones. No candidate is ever forced:
 *   poor pools yield `no-suitable-candidate`.
 * - The original problem (by canonical `problemId`) can never select
 *   itself; canonical duplicates collapse to the same exclusion.
 */

export const MAX_CANDIDATE_SOLVES = 2;

export interface CandidateSource {
  problem: Problem;
  /** Canonical problem knowledge (null when unclassified). */
  classification: ProblemClassification | null;
  /** J-1 learner record (null when absent; supporting pointers only). */
  knowledge: ProblemKnowledgeRecord | null;
}

/** Structured C knowledge for one problem, bucketed for comparison. */
export interface ProblemKnowledgeSet {
  frameworks: string[];
  /** Classification forms + variants (form family; mirrors the F2 catalog fold) + J-1 form IDs. */
  forms: string[];
  concepts: string[];
  tactics: string[];
  /** Breadth proxy: every structured ID incl. patterns/topics (sorted unique). */
  all: string[];
}

function refsOf(classification: ProblemClassification | null, bucket: keyof ProblemClassification): string[] {
  if (!classification) {
    return [];
  }
  const refs = classification[bucket];
  if (!Array.isArray(refs)) {
    return [];
  }
  return (refs as Array<{ entityId: string }>)
    .map((r) => r.entityId)
    .filter((id) => typeof id === 'string' && id.length > 0);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build the comparable knowledge set (pure; unknown shapes yield empty sets, never throw). */
export function knowledgeSetFor(
  classification: ProblemClassification | null,
  knowledge: ProblemKnowledgeRecord | null,
): ProblemKnowledgeSet {
  const frameworks = sortedUnique([...refsOf(classification, 'frameworks'), ...(knowledge?.frameworkIds ?? [])]);
  const forms = sortedUnique([
    ...refsOf(classification, 'forms'),
    ...refsOf(classification, 'variants'),
    ...(knowledge?.formIds ?? []),
  ]);
  const concepts = sortedUnique([...refsOf(classification, 'concepts'), ...(knowledge?.conceptIds ?? [])]);
  const tactics = sortedUnique([...refsOf(classification, 'tactics'), ...(knowledge?.tacticIds ?? [])]);
  const all = sortedUnique([
    ...frameworks,
    ...forms,
    ...concepts,
    ...tactics,
    ...refsOf(classification, 'patterns'),
    ...refsOf(classification, 'topics'),
  ]);
  return { frameworks, forms, concepts, tactics, all };
}

export interface ReinforcementCandidate {
  problemId: string;
  title: string | null;
  canonicalUrl: string;
  /** Shared core: same framework(s) — the reasoning family is preserved. */
  sharedFrameworks: string[];
  /** Shared core: same form(s)/variant(s) — the surface structure is preserved. */
  sharedForms: string[];
  /** Preserved context (never sufficient alone for eligibility). */
  sharedConcepts: string[];
  /** Preserved context (never sufficient alone for eligibility). */
  sharedTactics: string[];
  /** Relative-focus basis: candidate areas vs source areas (fewer = narrower). */
  candidateAreas: number;
  sourceAreas: number;
  /** Repetition basis, derived via J-0 (never persisted). */
  timesAttempted: number;
  timesSolved: number;
  /** Verbatim opaque label from the canonical problem — context only, never ordered. */
  difficulty: string | null;
  /** Structured ordering facts (no numeric similarity score exists). */
  orderingBasis: string[];
}

export interface RejectedCandidate {
  problemId: string;
  excludedReason:
    | 'self-exclusion'
    | 'insufficient-structured-similarity'
    | 'no-shared-core-knowledge'
    | 'not-more-focused'
    | 'already-consolidated';
  detail: string;
}

export interface CandidateSelection {
  sourceProblemId: string;
  outcome: 'candidate-found' | 'no-suitable-candidate';
  /** Eligible candidates, best-first by structural ordering basis. */
  candidates: ReinforcementCandidate[];
  /** Every non-eligible pool member, sorted by problemId, with reasons. */
  rejected: RejectedCandidate[];
}

function intersect(a: string[], b: Set<string>): string[] {
  return a.filter((id) => b.has(id));
}

/**
 * Select similar, structurally narrower EXISTING problems for a reinforcement
 * need. "Narrower" is a structural claim (same core across fewer knowledge
 * areas), never a claim about actual difficulty or easiness.
 * Pure: same inputs always yield the same selection. Reads J-0 stats and
 * C/J-1 knowledge only; writes nothing, calls nothing.
 */
export function selectReinforcementCandidates(args: {
  need: ReinforcementNeed;
  source: CandidateSource;
  candidates: CandidateSource[];
  attempts: Attempt[];
}): CandidateSelection {
  const { need, source } = args;
  if (need.sourceProblemId !== source.problem.problemId) {
    throw new Error('Cannot select candidates: the need targets a different source problem.');
  }
  const sourceSet = knowledgeSetFor(source.classification, source.knowledge);
  const sourceCore = new Set([...sourceSet.frameworks, ...sourceSet.forms]);
  const seen = new Set<string>();
  const pool: CandidateSource[] = [];
  for (const entry of args.candidates.slice().sort((a, b) => a.problem.problemId.localeCompare(b.problem.problemId))) {
    if (seen.has(entry.problem.problemId)) {
      continue;
    }
    seen.add(entry.problem.problemId);
    pool.push(entry);
  }
  // Attempts deduped by ID so repeated input rows cannot inflate practice counts.
  const attemptSeen = new Set<string>();
  const attempts = args.attempts.filter((a) => {
    if (attemptSeen.has(a.attemptId)) {
      return false;
    }
    attemptSeen.add(a.attemptId);
    return true;
  });

  const candidates: Array<{ candidate: ReinforcementCandidate; rank: number[] }> = [];
  const rejected: RejectedCandidate[] = [];
  for (const entry of pool) {
    const problemId = entry.problem.problemId;
    if (problemId === source.problem.problemId) {
      rejected.push({
        problemId,
        excludedReason: 'self-exclusion',
        detail: 'The original problem can never reinforce itself (canonical identity match).',
      });
      continue;
    }
    const set = knowledgeSetFor(entry.classification, entry.knowledge);
    if (set.all.length === 0) {
      rejected.push({
        problemId,
        excludedReason: 'insufficient-structured-similarity',
        detail: 'No structured knowledge (unclassified and no knowledge record) — similarity cannot be established.',
      });
      continue;
    }
    const sharedFrameworks = intersect(set.frameworks, sourceCore).filter((id) => sourceSet.frameworks.includes(id));
    const sharedForms = intersect(set.forms, sourceCore).filter((id) => sourceSet.forms.includes(id));
    if (sharedFrameworks.length === 0 && sharedForms.length === 0) {
      const sharedOther = sortedUnique([
        ...intersect(set.concepts, new Set(sourceSet.concepts)),
        ...intersect(set.tactics, new Set(sourceSet.tactics)),
      ]);
      rejected.push({
        problemId,
        excludedReason: 'no-shared-core-knowledge',
        detail:
          sharedOther.length > 0
            ? `Shares only peripheral knowledge (${sharedOther.join(', ')}) with no shared framework/form — the core reasoning is not preserved.`
            : 'Shares no framework, form, concept, or tactic with the source — unrelated practice would teach the wrong thing.',
      });
      continue;
    }
    if (set.all.length >= sourceSet.all.length) {
      rejected.push({
        problemId,
        excludedReason: 'not-more-focused',
        detail: `Covers ${set.all.length} knowledge areas vs ${sourceSet.all.length} on the source — not a narrower consolidation step.`,
      });
      continue;
    }
    const stats = deriveProblemStatsForProblem(entry.problem, attempts);
    if (stats.timesSolved >= MAX_CANDIDATE_SOLVES) {
      rejected.push({
        problemId,
        excludedReason: 'already-consolidated',
        detail: `Already solved ${stats.timesSolved} times — consolidation value is spent (limit ${MAX_CANDIDATE_SOLVES}).`,
      });
      continue;
    }
    const sharedConcepts = intersect(set.concepts, new Set(sourceSet.concepts));
    const sharedTactics = intersect(set.tactics, new Set(sourceSet.tactics));
    const practiceClass = stats.timesAttempted === 0 ? 0 : stats.timesSolved === 0 ? 1 : 2;
    const practiceLabel =
      practiceClass === 0
        ? 'unattempted — fresh consolidation surface'
        : practiceClass === 1
          ? `attempted ${stats.timesAttempted}×, unsolved — familiar but unspent`
          : `solved once — light prior practice`;
    const sharedCoreCount = sharedFrameworks.length + sharedForms.length;
    candidates.push({
      candidate: {
        problemId,
        title: entry.problem.title,
        canonicalUrl: entry.problem.canonicalUrl,
        sharedFrameworks,
        sharedForms,
        sharedConcepts,
        sharedTactics,
        candidateAreas: set.all.length,
        sourceAreas: sourceSet.all.length,
        timesAttempted: stats.timesAttempted,
        timesSolved: stats.timesSolved,
        difficulty: entry.problem.difficulty,
        orderingBasis: [
          practiceLabel,
          `shares ${sharedCoreCount} core area(s): ${sortedUnique([...sharedFrameworks, ...sharedForms]).join(', ')}`,
          `more focused: ${set.all.length} areas vs ${sourceSet.all.length} on the source`,
        ],
      },
      rank: [practiceClass, -sharedCoreCount, set.all.length],
    });
  }
  candidates.sort(
    (a, b) =>
      a.rank[0]! - b.rank[0]! ||
      a.rank[1]! - b.rank[1]! ||
      a.rank[2]! - b.rank[2]! ||
      a.candidate.problemId.localeCompare(b.candidate.problemId),
  );
  rejected.sort((a, b) => a.problemId.localeCompare(b.problemId));
  return {
    sourceProblemId: source.problem.problemId,
    outcome: candidates.length > 0 ? 'candidate-found' : 'no-suitable-candidate',
    candidates: candidates.map((c) => c.candidate),
    rejected,
  };
}
