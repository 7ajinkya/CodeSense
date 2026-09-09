import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearningGoal, LearningNeed } from './goalTypes';

/**
 * Proposal freshness + provenance (pure, no stores, no vscode).
 *
 * A pending proposal is fresh exactly when its learning need still
 * detects in the current learner state. Learner-owned requests (no need)
 * are fresh by ownership until the learner decides — they never go stale
 * on evidence grounds. Anything else pending (dismissed/active/achieved
 * states, or a need that no longer detects) is not fresh.
 *
 * Provenance resolves a proposal's evidence basis to the attempts,
 * problems, and timestamps behind it, using only the IDs the frozen F1
 * record already carries — no record shape changes required.
 */

export function isProposalFresh(proposal: LearningGoal, needs: LearningNeed[]): boolean {
  if (proposal.status !== 'proposed') {
    return false;
  }
  if (proposal.evidenceBasis.needId === null) {
    return true;
  }
  return needs.some((need) => need.needId === proposal.evidenceBasis.needId);
}

export interface PendingFreshness {
  fresh: LearningGoal[];
  stale: LearningGoal[];
}

/** Split pending (`proposed`) goals into still-current vs outdated suggestions. */
export function partitionPendingByFreshness(goals: LearningGoal[], needs: LearningNeed[]): PendingFreshness {
  const fresh: LearningGoal[] = [];
  const stale: LearningGoal[] = [];
  for (const goal of goals) {
    if (goal.status !== 'proposed') {
      continue;
    }
    if (isProposalFresh(goal, needs)) {
      fresh.push(goal);
    } else {
      stale.push(goal);
    }
  }
  const byAge = (a: LearningGoal, b: LearningGoal): number =>
    a.createdAt.localeCompare(b.createdAt) || a.goalId.localeCompare(b.goalId);
  fresh.sort(byAge);
  stale.sort(byAge);
  return { fresh, stale };
}

/** Max characters for one provenance line (learner-facing, bounded). */
export const MAX_PROVENANCE_LINE_CHARS = 200;

function clipLine(text: string, max: number = MAX_PROVENANCE_LINE_CHARS): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export interface ProposalProvenance {
  /** Evidence IDs cited by the proposal basis (as stored, oldest first). */
  evidenceIds: string[];
  /** Distinct attempt IDs behind the cited evidence that could be resolved (sorted). */
  attemptIds: string[];
  /** Distinct problem IDs behind the cited evidence that could be resolved (sorted). */
  problemIds: string[];
  /** Latest timestamp among the resolved records, or null when none resolved. */
  latestTimestamp: string | null;
  /** How many basis IDs resolved to real records (honesty marker, never guessed). */
  resolvedCount: number;
}

/**
 * Attribute a proposal to the attempts/problems/evidence behind it.
 * Unresolvable IDs (pruned history, hand-edited stores) are reported via
 * `resolvedCount`, never invented — callers must render the fallback, not
 * a fabricated source.
 */
export function resolveProposalProvenance(
  proposal: LearningGoal,
  evidence: LearnerEvidence[],
): ProposalProvenance {
  const byId = new Map(evidence.map((record) => [record.evidenceId, record] as const));
  const attemptIds = new Set<string>();
  const problemIds = new Set<string>();
  let latestTimestamp: string | null = null;
  let resolvedCount = 0;
  for (const evidenceId of proposal.evidenceBasis.evidenceIds) {
    const record = byId.get(evidenceId);
    if (!record) {
      continue;
    }
    resolvedCount += 1;
    if (record.attemptId !== null) {
      attemptIds.add(record.attemptId);
    }
    if (record.problemId !== null) {
      problemIds.add(record.problemId);
    }
    if (latestTimestamp === null || record.timestamp.localeCompare(latestTimestamp) > 0) {
      latestTimestamp = record.timestamp;
    }
  }
  return {
    evidenceIds: [...proposal.evidenceBasis.evidenceIds],
    attemptIds: [...attemptIds].sort(),
    problemIds: [...problemIds].sort(),
    latestTimestamp,
    resolvedCount,
  };
}

/**
 * One learner-facing provenance line answering "this suggestion is based
 * on what?". Evidence-derived proposals cite resolved problem titles (at
 * most two, then a count), the encounter count, and the latest evidence
 * date; unresolvable history falls back to the count alone — never a
 * fabricated source. Learner-owned requests cite the request itself.
 * Returns null only when there is genuinely nothing to say.
 */
export function formatProvenanceLine(
  proposal: LearningGoal,
  provenance: ProposalProvenance,
  resolveTitle: (problemId: string) => string | null,
): string | null {
  if (proposal.evidenceBasis.needId === null) {
    const statement = proposal.evidenceBasis.learnerStatement;
    if (typeof statement === 'string' && statement.trim().length > 0) {
      return clipLine(`Based on your request: "${statement.trim()}"`);
    }
    return 'Based on your request.';
  }
  const count = provenance.evidenceIds.length;
  const titles: string[] = [];
  for (const problemId of provenance.problemIds) {
    const title = resolveTitle(problemId);
    if (title !== null && title.trim().length > 0) {
      titles.push(title.trim());
    }
    if (titles.length >= 2) {
      break;
    }
  }
  const date =
    provenance.latestTimestamp !== null ? provenance.latestTimestamp.slice(0, 10) : null;
  if (titles.length > 0 && date !== null) {
    const more =
      provenance.problemIds.length > titles.length
        ? ` and ${provenance.problemIds.length - titles.length} other problem(s)`
        : '';
    return clipLine(
      `Based on ${titles.join(', ')}${more}: ${count} encounter(s), latest ${date}.`,
    );
  }
  if (date !== null) {
    return clipLine(`Based on ${count} past encounter(s), latest ${date}.`);
  }
  if (count > 0) {
    return clipLine(`Based on ${count} past encounter(s).`);
  }
  return null;
}
