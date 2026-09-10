import { hashIdentity } from '../problems/problem';
import type { Attempt } from '../attempts/attempt';
import { isRecord } from '../persistence/storeFiles';
import type {
  CandidateSelection,
  ReinforcementCandidate,
} from './reinforcementCandidate';
import type { ReinforcementDecision, ReinforcementNeed } from './reinforcementNeed';
import type { ActivityProgress, ProgressSignal } from '../progress/progressTypes';

/**
 * Phase J-3 long-term recommendation + reinforcement chain: turns a frozen
 * J-2 need/candidate result into an explainable, learner-choice-driven
 * recommendation. Pure derivation + pure lifecycle + injected persistence —
 * no UI, no AI, no clock unless `now` is omitted, no randomness.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - J-2 owns need detection and candidate selection. J-3 consumes
 *   `ReinforcementDecision` + `CandidateSelection` verbatim and abstains
 *   (null) whenever J-2 abstained. No threshold, ordering, similarity, or
 *   breadth rule is re-derived here.
 * - F2 owns activity plans and execution. Recommendations never create,
 *   transition, or link plans or attempts. A recommendation may point at a
 *   problem; it never owns what happens there.
 * - F3 owns progress interpretation. Completion and independence are read
 *   from `ActivityProgress` (strong linkage
 *   `record.linkedAttemptId === attemptId` plus `IndependenceFacet` and
 *   `ProgressSignal` vocabularies) — never recomputed from raw states.
 * - D owns evidence/model. Nothing here writes, cites-as-verdict, or
 *   re-scores anything. Skip/defer/choose-another are terminal dispositions
 *   of a suggestion, never learner failure, and produce no signal anywhere.
 * - "Structurally narrower" (J-2 post-audit terminology) is preserved
 *   end-to-end. No field, reason, or explanation claims easiness,
 *   difficulty, weakness, mastery, or forgetting.
 */

export const RECOMMENDATION_SCHEMA_VERSION = 1;
export const RECOMMENDATION_ID_PREFIX = 'rec_';
export const CHAIN_ID_PREFIX = 'chain_';

/**
 * Learner disposition + derived truth for one suggestion. `offered` is the
 * only entry state. `completed` is derived from attempt/F3 truth, never
 * declared. `skipped`/`deferred` are terminal learner choices.
 */
export type RecommendationStatus =
  | 'offered'
  | 'accepted'
  | 'skipped'
  | 'deferred'
  | 'completed'
  | 'superseded';

export const RECOMMENDATION_STATUSES: readonly RecommendationStatus[] = [
  'offered',
  'accepted',
  'skipped',
  'deferred',
  'completed',
  'superseded',
];

export function isKnownRecommendationStatus(value: unknown): value is RecommendationStatus {
  return typeof value === 'string' && (RECOMMENDATION_STATUSES as readonly string[]).includes(value);
}

export type RecommendationRole = 'reinforcement' | 'revisit';

export function isKnownRecommendationRole(value: unknown): value is RecommendationRole {
  return value === 'reinforcement' || value === 'revisit';
}

/**
 * Minimal structural facts making the recommendation reproducible without
 * copying C/D rows: shared core IDs, focus counts, and J-0-derived practice
 * counts (recomputed live elsewhere; stored here as the basis snapshot).
 */
export interface CandidateBasis {
  sharedFrameworks: string[];
  sharedForms: string[];
  sharedConcepts: string[];
  sharedTactics: string[];
  candidateAreas: number;
  sourceAreas: number;
  candidateTimesAttempted: number;
  candidateTimesSolved: number;
}

export interface LongTermRecommendation {
  /** Deterministic identity (see `recommendationIdFor`). Never random. */
  recommendationId: string;
  schemaVersion: number;
  /** Stable chain identity for one source↔reinforcement pair (see `chainIdFor`). */
  chainId: string;
  role: RecommendationRole;
  /** Canonical original problem (reused identity, never invented). */
  sourceProblemId: string;
  /** Canonical reinforcement problem, or the completed step for revisits. */
  reinforcementProblemId: string;
  /** F1 goal reference where legitimately available (copied ID, not ownership). */
  goalId: string | null;
  /** Fingerprint of the J-2 need this recommendation was built from. */
  needFingerprint: string;
  /** Sorted unique D evidence IDs cited by the J-2 need. */
  evidenceIds: string[];
  candidateBasis: CandidateBasis;
  /** Deterministic learner-readable explanation (see `buildExplanation`). */
  explanation: string;
  status: RecommendationStatus;
  /** The other half of the chain once it exists (null until linked). */
  counterpartRecommendationId: string | null;
  /** Previous recommendation this one replaces (null unless superseding). */
  supersedesRecommendationId: string | null;
  /** Successor that replaced this one (null unless superseded). */
  supersededByRecommendationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Legal lifecycle edges. Terminal states map to no outgoing edges. */
export const RECOMMENDATION_TRANSITIONS: Record<RecommendationStatus, readonly RecommendationStatus[]> = {
  offered: ['accepted', 'skipped', 'deferred', 'completed', 'superseded'],
  accepted: ['completed', 'skipped', 'deferred', 'superseded'],
  deferred: ['accepted', 'skipped', 'superseded'],
  skipped: [],
  completed: [],
  superseded: [],
};

function copyRecommendation(rec: LongTermRecommendation, status: RecommendationStatus, now: string): LongTermRecommendation {
  return {
    ...rec,
    status,
    updatedAt: now,
    evidenceIds: [...rec.evidenceIds],
    candidateBasis: {
      ...rec.candidateBasis,
      sharedFrameworks: [...rec.candidateBasis.sharedFrameworks],
      sharedForms: [...rec.candidateBasis.sharedForms],
      sharedConcepts: [...rec.candidateBasis.sharedConcepts],
      sharedTactics: [...rec.candidateBasis.sharedTactics],
    },
  };
}

function transitionRecommendation(
  rec: LongTermRecommendation,
  to: RecommendationStatus,
  now: string,
): LongTermRecommendation {
  const allowed = RECOMMENDATION_TRANSITIONS[rec.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid recommendation transition: ${rec.status} → ${to} (recommendation ${rec.recommendationId}).`,
    );
  }
  return copyRecommendation(rec, to, now);
}

/** Learner explicitly chooses this recommendation. Records disposition only — NOT completion. */
export function acceptRecommendation(rec: LongTermRecommendation, now: string): LongTermRecommendation {
  return transitionRecommendation(rec, 'accepted', now);
}

/**
 * Learner explicitly declines. Terminal for this recommendation and,
 * structurally, incapable of becoming learner evidence: this function
 * touches only the J-3 row and takes no D/F stores as input.
 */
export function skipRecommendation(rec: LongTermRecommendation, now: string): LongTermRecommendation {
  return transitionRecommendation(rec, 'skipped', now);
}

/** Learner explicitly chooses to come back later. Terminal disposition; a new rec forms only on new derivation. */
export function deferRecommendation(rec: LongTermRecommendation, now: string): LongTermRecommendation {
  return transitionRecommendation(rec, 'deferred', now);
}

/** A newer recommendation replaces this one. History is preserved, never deleted. */
export function markSuperseded(
  rec: LongTermRecommendation,
  successorId: string,
  now: string,
): LongTermRecommendation {
  const next = transitionRecommendation(rec, 'superseded', now);
  return { ...next, supersededByRecommendationId: successorId };
}

/**
 * Link the other half of a reinforcement chain (metadata only, not a status
 * change). Allowed on live chain states; terminal learner choices
 * (skipped/deferred/superseded) are never rewritten — history stays honest.
 */
export function linkCounterpartRecommendation(
  rec: LongTermRecommendation,
  counterpartId: string,
  now: string,
): LongTermRecommendation {
  if (rec.status !== 'offered' && rec.status !== 'accepted' && rec.status !== 'completed') {
    throw new Error(`Cannot link counterpart on recommendation ${rec.recommendationId} in status ${rec.status}.`);
  }
  if (typeof counterpartId !== 'string' || counterpartId.trim().length === 0) {
    throw new Error('Cannot link an empty counterpart recommendation ID.');
  }
  return { ...copyRecommendation(rec, rec.status, now), counterpartRecommendationId: counterpartId };
}

/** Fingerprint of a J-2 need: sorted targets, dimensions, and reason kinds. */
export function needFingerprintFor(need: ReinforcementNeed): string {
  const material = [
    [...need.targetEntityIds].sort().join(','),
    [...need.dimensions].sort().join(','),
    need.reasons.map((r) => r.kind).sort().join(','),
  ].join('|');
  return hashIdentity(material);
}

function evidenceFingerprintFor(evidenceIds: string[]): string {
  return hashIdentity([...evidenceIds].sort().join(','));
}

/**
 * Canonical recommendation identity material: every persisted input whose
 * change means "a materially different recommendation snapshot", and
 * nothing else.
 *
 * Included (all canonically ordered; ID lists sorted; numbers as decimal):
 * - role, sourceProblemId, reinforcementProblemId: which chain half for
 *   which canonical problems. A changed problem or role is a different
 *   recommendation by definition.
 * - goalId ('' when null): goal routing is snapshot provenance — a rec
 *   derived for a goal vs derived goal-free are different snapshots, so a
 *   re-derivation can never silently flip goal context.
 * - needFingerprint: J-2's canonical need summary (sorted targets,
 *   dimensions, reason kinds). J-2-owned; consumed, never recomputed.
 * - evidenceFingerprint: J-2's cited evidence set. New evidence means a new
 *   snapshot (old rows survive for supersession, never overwritten).
 * - shared core ID lists + area counts: the structural basis reproduced in
 *   CandidateBasis. A reclassified candidate (different shared core) or a
 *   changed breadth snapshot is materially different content.
 * - candidateTimesAttempted/candidateTimesSolved: J-0-derived practice
 *   context quoted in the explanation ("not attempted yet" vs "solved
 *   once"). Changed practice means changed snapshot.
 *
 * Deliberately excluded:
 * - timestamps/persistence metadata (createdAt/updatedAt): ordering only.
 * - explanation prose: learner-readable rendering of the material above;
 *   rewording must not fork identity.
 * - lifecycle status and linkage pointers: mutable row state, not identity.
 * - need.solvedAttemptIds and reason detail prose: these affect only the
 *   excluded explanation text. Proof: deriveRecommendation persists
 *   needFingerprint (kinds), evidenceIds, basis, and explanation — of
 *   these, solvedAttemptIds flow exclusively into reason-detail prose via
 *   J-2, which is already excluded; every semantic dimension they could
 *   carry (which entities, which evidence, which signal kinds) is covered
 *   by needFingerprint + evidenceFingerprint. Including them would fork IDs
 *   for explanation-only differences, contradicting the exclusion above.
 */
export interface RecommendationIdentityMaterial {
  role: RecommendationRole;
  sourceProblemId: string;
  reinforcementProblemId: string;
  goalId: string | null;
  needFingerprint: string;
  evidenceFingerprint: string;
  sharedFrameworks: string[];
  sharedForms: string[];
  sharedConcepts: string[];
  sharedTactics: string[];
  candidateAreas: number;
  sourceAreas: number;
  candidateTimesAttempted: number;
  candidateTimesSolved: number;
}

/** Stable serialization of the canonical identity material (no timestamps, no prose, no randomness). */
export function canonicalIdentityMaterial(material: RecommendationIdentityMaterial): string {
  const ids = (list: string[]): string => [...list].sort().join(',');
  return [
    material.role,
    material.sourceProblemId,
    material.reinforcementProblemId,
    material.goalId ?? '',
    material.needFingerprint,
    material.evidenceFingerprint,
    ids(material.sharedFrameworks),
    ids(material.sharedForms),
    ids(material.sharedConcepts),
    ids(material.sharedTactics),
    String(material.candidateAreas),
    String(material.sourceAreas),
    String(material.candidateTimesAttempted),
    String(material.candidateTimesSolved),
  ].join('|');
}

/**
 * Deterministic recommendation identity: rec_<FNV(canonical material)>.
 * Role included so reinforcement and revisit halves can never collide.
 */
export function recommendationIdFor(material: RecommendationIdentityMaterial): string {
  return `${RECOMMENDATION_ID_PREFIX}${hashIdentity(canonicalIdentityMaterial(material))}`;
}

/** Stable chain identity for one source↔reinforcement pair (both halves share it). */
export function chainIdFor(sourceProblemId: string, reinforcementProblemId: string): string {
  return `${CHAIN_ID_PREFIX}${hashIdentity(`${sourceProblemId}|${reinforcementProblemId}`)}`;
}

function basisFor(candidate: ReinforcementCandidate): CandidateBasis {
  return {
    sharedFrameworks: [...candidate.sharedFrameworks].sort(),
    sharedForms: [...candidate.sharedForms].sort(),
    sharedConcepts: [...candidate.sharedConcepts].sort(),
    sharedTactics: [...candidate.sharedTactics].sort(),
    candidateAreas: candidate.candidateAreas,
    sourceAreas: candidate.sourceAreas,
    candidateTimesAttempted: candidate.timesAttempted,
    candidateTimesSolved: candidate.timesSolved,
  };
}

/**
 * Deterministic explanation from authoritative facts only. Answerable
 * questions: WHY this recommendation (J-2 reason details), WHY this
 * candidate (shared core + focus counts + practice context), WHAT next
 * (revisit the original to check transfer). Banned by construction: the
 * builder receives no mastery/weakness/difficulty inputs, so unsupported
 * claims are unrepresentable.
 */
export function buildExplanation(args: {
  need: ReinforcementNeed;
  candidate: ReinforcementCandidate;
  sourceProblemLabel: string;
}): string {
  const { need, candidate } = args;
  const reasons = need.reasons.map((r) => r.detail).join(' ');
  const sharedCore = [...candidate.sharedFrameworks, ...candidate.sharedForms].sort();
  const practice =
    candidate.timesAttempted === 0
      ? 'You have not attempted it yet.'
      : candidate.timesSolved === 0
        ? `You have attempted it ${candidate.timesAttempted} time(s) without solving it yet.`
        : 'You have solved it once before.';
  return (
    `This is recommended because your recent work on ${args.sourceProblemLabel} provides ` +
    `${need.reasons.length} corroborating signals that focused consolidation would help: ${reasons} ` +
    `This problem shares the relevant core (${sharedCore.join(', ') || 'no core overlap'}) while covering ` +
    `${candidate.candidateAreas} knowledge areas vs ${candidate.sourceAreas} on the original, so it isolates ` +
    `the target more directly. ${practice} ` +
    `Afterward, revisiting the original problem checks whether the skill transfers.`
  );
}

export interface DeriveRecommendationInputs {
  /** Frozen J-2 decision (abstentions yield null — never worked around). */
  decision: ReinforcementDecision;
  /** Frozen J-2 selection (the candidate is picked from it, never invented). */
  selection: CandidateSelection;
  /** Which selected candidate to recommend (defaults to the best-first one). */
  candidateProblemId?: string;
  /** F1 goal reference where legitimately available (copied ID only). */
  goalId?: string | null;
  /** Human-readable source label for the explanation (title or URL). */
  sourceProblemLabel?: string;
  /** ID of a previous recommendation this one supersedes (linkage only). */
  supersedesRecommendationId?: string | null;
  now?: string;
}

/**
 * Build the reinforcement recommendation for a J-2-indicated need and an
 * eligible J-2 candidate. Returns null (abstain) on any missing or
 * contradictory input. Pure: same inputs always yield the same record.
 */
export function deriveRecommendation(inputs: DeriveRecommendationInputs): LongTermRecommendation | null {
  const { decision, selection } = inputs;
  if (decision.outcome !== 'reinforcement-indicated' || decision.need === null) {
    return null;
  }
  if (selection.outcome !== 'candidate-found' || selection.candidates.length === 0) {
    return null;
  }
  if (selection.sourceProblemId !== decision.need.sourceProblemId) {
    return null;
  }
  const candidate =
    inputs.candidateProblemId === undefined
      ? selection.candidates[0]!
      : selection.candidates.find((c) => c.problemId === inputs.candidateProblemId) ?? null;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  if (candidate.problemId === decision.need.sourceProblemId) {
    return null;
  }
  const need = decision.need;
  const needFingerprint = needFingerprintFor(need);
  const evidenceFingerprint = evidenceFingerprintFor(need.evidenceIds);
  const basis = basisFor(candidate);
  const goalId = inputs.goalId ?? null;
  const now = inputs.now ?? new Date().toISOString();
  return {
    recommendationId: recommendationIdFor({
      role: 'reinforcement',
      sourceProblemId: need.sourceProblemId,
      reinforcementProblemId: candidate.problemId,
      goalId,
      needFingerprint,
      evidenceFingerprint,
      sharedFrameworks: basis.sharedFrameworks,
      sharedForms: basis.sharedForms,
      sharedConcepts: basis.sharedConcepts,
      sharedTactics: basis.sharedTactics,
      candidateAreas: basis.candidateAreas,
      sourceAreas: basis.sourceAreas,
      candidateTimesAttempted: basis.candidateTimesAttempted,
      candidateTimesSolved: basis.candidateTimesSolved,
    }),
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    chainId: chainIdFor(need.sourceProblemId, candidate.problemId),
    role: 'reinforcement',
    sourceProblemId: need.sourceProblemId,
    reinforcementProblemId: candidate.problemId,
    goalId,
    needFingerprint,
    evidenceIds: [...need.evidenceIds].sort(),
    candidateBasis: basis,
    explanation: buildExplanation({ need, candidate, sourceProblemLabel: inputs.sourceProblemLabel ?? need.sourceProblemId }),
    status: 'offered',
    counterpartRecommendationId: null,
    supersedesRecommendationId: inputs.supersedesRecommendationId ?? null,
    supersededByRecommendationId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface CompletionAssessment {
  /** True only with a qualifying completed attempt AND linked F3 progress. */
  complete: boolean;
  /** Machine-readable ground for the verdict (never a mastery claim). */
  ground: 'attempt-and-progress' | 'missing-attempt' | 'missing-progress';
  attemptId: string | null;
  progressId: string | null;
  /** F3's signal on the linked progress (null when unproven). */
  signal: ProgressSignal | null;
  /** F3's independence reading, as-is (null when unproven). */
  independent: boolean | null;
  /** F3's help reading, as-is (null when unproven). */
  helped: boolean | null;
}

/**
 * Assess completion against authoritative truth. Target problem: the
 * reinforcement problem for reinforcement recs, the source problem for
 * revisit recs. A qualifying attempt started AFTER the offer, is completed
 * (active attempts never qualify), and has F3 progress strongly linked to
 * it. Acceptance, opening, viewing, skipping, or deferring never qualify.
 */
export function evaluateCompletion(
  rec: LongTermRecommendation,
  attempts: Attempt[],
  progress: ActivityProgress[],
): CompletionAssessment {
  const targetProblemId = rec.role === 'reinforcement' ? rec.reinforcementProblemId : rec.sourceProblemId;
  const seen = new Set<string>();
  const qualifying = attempts
    .filter((a) => {
      if (seen.has(a.attemptId)) {
        return false;
      }
      seen.add(a.attemptId);
      return (
        a.problemId === targetProblemId &&
        a.completedAt !== null &&
        a.startedAt.localeCompare(rec.createdAt) > 0
      );
    })
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId));
  if (qualifying.length === 0) {
    return { complete: false, ground: 'missing-attempt', attemptId: null, progressId: null, signal: null, independent: null, helped: null };
  }
  // Latest qualifying attempt carries the freshest interpretation.
  for (let i = qualifying.length - 1; i >= 0; i--) {
    const attempt = qualifying[i]!;
    const linked = progress
      .filter((p) => p.linkedAttemptId === attempt.attemptId)
      .slice()
      .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
    if (linked.length > 0) {
      const latest = linked[linked.length - 1]!;
      return {
        complete: true,
        ground: 'attempt-and-progress',
        attemptId: attempt.attemptId,
        progressId: latest.progressId,
        signal: latest.progressSignal,
        independent: latest.independence.independent,
        helped: latest.independence.helped,
      };
    }
  }
  const latestAttempt = qualifying[qualifying.length - 1]!;
  return {
    complete: false,
    ground: 'missing-progress',
    attemptId: latestAttempt.attemptId,
    progressId: null,
    signal: null,
    independent: null,
    helped: null,
  };
}

/**
 * Record a proven completion on the recommendation. Throws unless the
 * assessment proves completion and the status allows it (offered/accepted).
 * The assessment — not learner declaration — is the authority.
 */
export function applyCompletion(
  rec: LongTermRecommendation,
  assessment: CompletionAssessment,
  now: string,
): LongTermRecommendation {
  if (!assessment.complete) {
    throw new Error(`Cannot complete recommendation ${rec.recommendationId}: completion is unproven (${assessment.ground}).`);
  }
  return transitionRecommendation(rec, 'completed', now);
}

/** F3 signals under which a completed reinforcement step warrants a revisit. */
const REVISIT_ELIGIBLE_SIGNALS: readonly ProgressSignal[] = [
  'EVIDENCE_ADDED',
  'IMPROVING',
  'UNCERTAINTY_REDUCED',
  'SUFFICIENT_EVIDENCE_FOR_REVIEW',
];

/**
 * Derive the revisit recommendation for the ORIGINAL problem once the
 * reinforcement half is completed with a non-struggle F3 signal. Struggle,
 * mixed, regression, or evidence-free outcomes preserve the chain state and
 * yield null (abstain — later stages own retry policy). The revisit uses the
 * same canonical source problemId: no new Problem, record, plan, artifact,
 * or attempt is created here. The learner must still choose it.
 */
export function deriveRevisitRecommendation(args: {
  reinforcement: LongTermRecommendation;
  assessment: CompletionAssessment;
  now?: string;
}): LongTermRecommendation | null {
  const { reinforcement, assessment } = args;
  if (reinforcement.role !== 'reinforcement' || reinforcement.status !== 'completed') {
    return null;
  }
  if (!assessment.complete || assessment.signal === null) {
    return null;
  }
  if (!(REVISIT_ELIGIBLE_SIGNALS as readonly string[]).includes(assessment.signal)) {
    return null;
  }
  const now = args.now ?? new Date().toISOString();
  const evidenceIds = [...new Set([...reinforcement.evidenceIds, ...(assessment.progressId ? [assessment.progressId] : [])])].sort();
  const independenceNote =
    assessment.independent === true && assessment.helped === false
      ? 'The focused step was completed independently.'
      : assessment.helped === true
        ? 'The focused step involved help, so this revisit checks independent transfer.'
        : 'Independence of the focused step is unproven, so this revisit checks transfer.';
  const basis: CandidateBasis = {
    ...reinforcement.candidateBasis,
    sharedFrameworks: [...reinforcement.candidateBasis.sharedFrameworks],
    sharedForms: [...reinforcement.candidateBasis.sharedForms],
    sharedConcepts: [...reinforcement.candidateBasis.sharedConcepts],
    sharedTactics: [...reinforcement.candidateBasis.sharedTactics],
  };
  return {
    recommendationId: recommendationIdFor({
      role: 'revisit',
      sourceProblemId: reinforcement.sourceProblemId,
      reinforcementProblemId: reinforcement.reinforcementProblemId,
      goalId: reinforcement.goalId,
      needFingerprint: reinforcement.needFingerprint,
      evidenceFingerprint: evidenceFingerprintFor(evidenceIds),
      sharedFrameworks: basis.sharedFrameworks,
      sharedForms: basis.sharedForms,
      sharedConcepts: basis.sharedConcepts,
      sharedTactics: basis.sharedTactics,
      candidateAreas: basis.candidateAreas,
      sourceAreas: basis.sourceAreas,
      candidateTimesAttempted: basis.candidateTimesAttempted,
      candidateTimesSolved: basis.candidateTimesSolved,
    }),
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    chainId: reinforcement.chainId,
    role: 'revisit',
    sourceProblemId: reinforcement.sourceProblemId,
    reinforcementProblemId: reinforcement.reinforcementProblemId,
    goalId: reinforcement.goalId,
    needFingerprint: reinforcement.needFingerprint,
    evidenceIds,
    candidateBasis: basis,
    explanation:
      `Revisiting the original problem is recommended because the focused consolidation step is done. ` +
      `${independenceNote} Solving the original again shows whether the skill transfers to the fuller context.`,
    status: 'offered',
    counterpartRecommendationId: reinforcement.recommendationId,
    supersedesRecommendationId: null,
    supersededByRecommendationId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Lenient shape check for persisted rows (mirrors `parseProblemKnowledge`):
 * null for malformed data so one bad row never breaks loading. Shape-only.
 */
export function parseRecommendation(raw: unknown): LongTermRecommendation | null {
  if (!isRecord(raw)) {
    return null;
  }
  try {
    if (typeof raw.recommendationId !== 'string' || raw.recommendationId.trim().length === 0) {
      return null;
    }
    if (raw.schemaVersion !== RECOMMENDATION_SCHEMA_VERSION) {
      return null;
    }
    if (typeof raw.chainId !== 'string' || raw.chainId.trim().length === 0) {
      return null;
    }
    if (!isKnownRecommendationRole(raw.role)) {
      return null;
    }
    if (typeof raw.sourceProblemId !== 'string' || raw.sourceProblemId.trim().length === 0) {
      return null;
    }
    if (typeof raw.reinforcementProblemId !== 'string' || raw.reinforcementProblemId.trim().length === 0) {
      return null;
    }
    if (raw.goalId !== null && (typeof raw.goalId !== 'string' || raw.goalId.trim().length === 0)) {
      return null;
    }
    if (typeof raw.needFingerprint !== 'string' || raw.needFingerprint.length === 0) {
      return null;
    }
    if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.some((e: unknown) => typeof e !== 'string')) {
      return null;
    }
    const basis = isRecord(raw.candidateBasis) ? raw.candidateBasis : null;
    if (basis === null) {
      return null;
    }
    const idList = (field: string): string[] | null => {
      const value: unknown = basis[field];
      if (!Array.isArray(value) || value.some((e: unknown) => typeof e !== 'string')) {
        return null;
      }
      return [...(value as string[])].sort();
    };
    const sharedFrameworks = idList('sharedFrameworks');
    const sharedForms = idList('sharedForms');
    const sharedConcepts = idList('sharedConcepts');
    const sharedTactics = idList('sharedTactics');
    if (sharedFrameworks === null || sharedForms === null || sharedConcepts === null || sharedTactics === null) {
      return null;
    }
    for (const count of ['candidateAreas', 'sourceAreas', 'candidateTimesAttempted', 'candidateTimesSolved'] as const) {
      if (typeof basis[count] !== 'number') {
        return null;
      }
    }
    if (typeof raw.explanation !== 'string' || raw.explanation.trim().length === 0) {
      return null;
    }
    if (!isKnownRecommendationStatus(raw.status)) {
      return null;
    }
    const links: Record<'counterpartRecommendationId' | 'supersedesRecommendationId' | 'supersededByRecommendationId', string | null> = {
      counterpartRecommendationId: null,
      supersedesRecommendationId: null,
      supersededByRecommendationId: null,
    };
    for (const link of ['counterpartRecommendationId', 'supersedesRecommendationId', 'supersededByRecommendationId'] as const) {
      const value: unknown = raw[link];
      if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
        return null;
      }
      links[link] = value as string | null;
    }
    if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
      return null;
    }
    return {
      recommendationId: raw.recommendationId,
      schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
      chainId: raw.chainId,
      role: raw.role,
      sourceProblemId: raw.sourceProblemId,
      reinforcementProblemId: raw.reinforcementProblemId,
      goalId: raw.goalId,
      needFingerprint: raw.needFingerprint,
      evidenceIds: [...(raw.evidenceIds as string[])].sort(),
      candidateBasis: {
        sharedFrameworks,
        sharedForms,
        sharedConcepts,
        sharedTactics,
        candidateAreas: basis.candidateAreas as number,
        sourceAreas: basis.sourceAreas as number,
        candidateTimesAttempted: basis.candidateTimesAttempted as number,
        candidateTimesSolved: basis.candidateTimesSolved as number,
      },
      explanation: raw.explanation,
      status: raw.status,
      counterpartRecommendationId: links.counterpartRecommendationId,
      supersedesRecommendationId: links.supersedesRecommendationId,
      supersededByRecommendationId: links.supersededByRecommendationId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}
