import type { Attempt } from '../attempts/attempt';
import { isSolvedAttempt } from './problemStats';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import { dimensionStateOf } from '../learner/learnerModel';
import { getLearnerKnowledge, getWeakOrUncertainEntities } from '../learner/learnerQueries';
import type { EvidenceDimension } from '../learner/learnerTypes';
import type { ActivityProgress, ProgressSignal } from '../progress/progressTypes';
import type { ProblemKnowledgeRecord } from './problemKnowledge';

/**
 * Phase J-2 reinforcement detection: "does this solved problem warrant
 * consolidation?" Pure, read-only, deterministic — no store, no AI, no
 * clock, no randomness.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - D owns evidence and capability. J-2 READS D records/profile through
 *   D's own semantics (`isSolvedAttempt`, `getWeakOrUncertainEntities`,
 *   `statusConfidence`, evidence `confidence`) and computes NO mastery,
 *   weakness, or confidence of its own. The output is a transient derived
 *   decision (`reinforcement-indicated`), never a persisted second model.
 * - F3 owns progress/reassessment. J-2 reads `ActivityProgress` signals
 *   (struggle vs consolidation vocabularies) without re-deriving them.
 * - C owns knowledge. Target entities are ID references into C buckets
 *   (classification) plus J-1 record buckets; J-1 notes are supporting
 *   pointers only, never evidence.
 * - Corroboration rule: a single weak/noisy event never triggers. At least
 *   MIN_CORROBORATING_SIGNALS distinct signal kinds are required, mirroring
 *   D's conservatism (single encounters prove nothing durable) and F3's
 *   "≥2 positive distinct plans" sufficiency invariant.
 * - EXPOSURE evidence never counts as a signal (it records encounter, not
 *   capability). Skipped F2 plans are invisible here by construction: J-2
 *   takes no plans as input, so non-compliance can never become a signal.
 */

export const MIN_CORROBORATING_SIGNALS = 2;
/** Per-reason cited-evidence cap (mirrors `MAX_PLAN_EVIDENCE_IDS`). */
export const MAX_REASON_EVIDENCE_IDS = 12;

/** F3 signals read as ongoing struggle (F3's own vocabulary, not re-derived). */
const STRUGGLE_SIGNALS: readonly ProgressSignal[] = ['STILL_STRUGGLING', 'MIXED_SIGNAL', 'REGRESSION_SIGNAL'];
/** F3 signals read as consolidation (F3's own vocabulary, not re-derived). */
const CONSOLIDATION_SIGNALS: readonly ProgressSignal[] = [
  'IMPROVING',
  'UNCERTAINTY_REDUCED',
  'SUFFICIENT_EVIDENCE_FOR_REVIEW',
];

export type ReinforcementOutcome = 'no-reinforcement-needed' | 'insufficient-evidence' | 'reinforcement-indicated';

export type ReinforcementReasonKind =
  | 'no-solved-attempt'
  | 'no-structured-knowledge'
  | 'consolidated-strength'
  | 'solved-with-help'
  | 'uncertain-knowledge-state'
  | 'low-confidence-evidence'
  | 'f3-struggle-signal'
  | 'recurring-mistake';

export interface ReinforcementReason {
  kind: ReinforcementReasonKind;
  /** Learner-readable structured fact (cites attempt/progress IDs textually). */
  detail: string;
  /** D `LearnerEvidence` IDs behind this reason only (sorted, capped). */
  evidenceIds: string[];
}

export interface ReinforcementNeed {
  sourceProblemId: string;
  /** Sorted canonical C entity IDs consolidation should preserve. */
  targetEntityIds: string[];
  /** Sorted D dimensions with low/medium confidence on target entities. */
  dimensions: EvidenceDimension[];
  /** Sorted solved attempt IDs on the source problem. */
  solvedAttemptIds: string[];
  /** Sorted unique D evidence IDs cited across reasons. */
  evidenceIds: string[];
  /** The corroborating reasons (≥ MIN_CORROBORATING_SIGNALS). */
  reasons: ReinforcementReason[];
}

export interface ReinforcementDecision {
  outcome: ReinforcementOutcome;
  /** Non-null exactly when outcome is `reinforcement-indicated`. */
  need: ReinforcementNeed | null;
  /** Explains the outcome (mirrors need.reasons when indicated). */
  reasons: ReinforcementReason[];
}

export interface ReinforcementDetectionInputs {
  problem: Problem;
  /** Full attempt history (filtered to the problem inside; never mutated). */
  attempts: Attempt[];
  /** Full D evidence history (selected, never mutated). */
  evidence: LearnerEvidence[];
  /** Current D profile (null when unavailable — detection degrades honestly). */
  profile: LearnerProfile | null;
  /** F3 progress records (read-only signals). */
  progress: ActivityProgress[];
  /** Canonical problem knowledge (null when unclassified). */
  classification: ProblemClassification | null;
  /** J-1 learner knowledge record (null when absent; supporting only). */
  knowledge: ProblemKnowledgeRecord | null;
}

function uniqueAttempts(attempts: Attempt[]): Attempt[] {
  const seen = new Set<string>();
  const out: Attempt[] = [];
  for (const attempt of attempts) {
    if (!seen.has(attempt.attemptId)) {
      seen.add(attempt.attemptId);
      out.push(attempt);
    }
  }
  return out;
}

function bucketIds(classification: ProblemClassification | null, bucket: keyof ProblemClassification): string[] {
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

/**
 * Target entities for consolidation: the problem's structured knowledge
 * (C classification core buckets plus J-1 record buckets). Topics are
 * excluded as too coarse to preserve anything specific. Sorted unique.
 */
export function targetEntitiesFor(
  classification: ProblemClassification | null,
  knowledge: ProblemKnowledgeRecord | null,
): string[] {
  const ids = new Set<string>();
  for (const bucket of ['frameworks', 'forms', 'variants', 'concepts', 'patterns', 'tactics'] as const) {
    for (const id of bucketIds(classification, bucket)) {
      ids.add(id);
    }
  }
  if (knowledge) {
    for (const id of [...knowledge.conceptIds, ...knowledge.formIds, ...knowledge.frameworkIds, ...knowledge.tacticIds]) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

function capIds(ids: string[]): string[] {
  return ids.slice(0, MAX_REASON_EVIDENCE_IDS);
}

/**
 * Decide whether a solved problem warrants reinforcement. Pure: same inputs
 * always yield the same decision. Never writes evidence, goals, plans,
 * progress, reflections, or knowledge records.
 */
export function detectReinforcementNeed(inputs: ReinforcementDetectionInputs): ReinforcementDecision {
  const { problem, profile, classification, knowledge } = inputs;
  const mine = uniqueAttempts(inputs.attempts)
    .filter((a) => a.problemId === problem.problemId)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId));
  const mineIds = new Set(mine.map((a) => a.attemptId));
  const solved = mine.filter(isSolvedAttempt);
  if (solved.length === 0) {
    return {
      outcome: 'no-reinforcement-needed',
      need: null,
      reasons: [
        {
          kind: 'no-solved-attempt',
          detail: `Problem ${problem.problemId} has no solved attempt — reinforcement follows consolidation, not initial learning.`,
          evidenceIds: [],
        },
      ],
    };
  }
  const targets = targetEntitiesFor(classification, knowledge);
  if (targets.length === 0) {
    return {
      outcome: 'insufficient-evidence',
      need: null,
      reasons: [
        {
          kind: 'no-structured-knowledge',
          detail:
            `Problem ${problem.problemId} has no structured knowledge (unclassified and no knowledge record) — ` +
            'similarity cannot be established, so reinforcement abstains.',
          evidenceIds: [],
        },
      ],
    };
  }
  const targetSet = new Set(targets);
  const solvedAttemptIds = solved.map((a) => a.attemptId).sort();
  const latestSolved = solved
    .slice()
    .sort(
      (a, b) =>
        (a.completedAt ?? a.startedAt).localeCompare(b.completedAt ?? b.startedAt) ||
        a.attemptId.localeCompare(b.attemptId),
    )[solved.length - 1]!;
  const evidenceLinked = inputs.evidence.filter(
    (r) =>
      (r.attemptId !== null && mineIds.has(r.attemptId)) ||
      (r.attemptId === null && r.problemId === problem.problemId),
  );
  const progressLinked = inputs.progress.filter(
    (p) => p.activity.problemId === problem.problemId || (p.linkedAttemptId !== null && mineIds.has(p.linkedAttemptId)),
  );

  // Consolidation veto: every target entity demonstrates strength with high
  // confidence, the latest solve was independent, and no struggle signals.
  if (profile !== null) {
    const states = targets.map((id) => getLearnerKnowledge(profile, id));
    const fullyConsolidated =
      states.length > 0 &&
      states.every(
        (s) => s !== null && (s.status === 'demonstrated' || s.status === 'strong') && s.statusConfidence === 'high',
      );
    const hasStruggle = progressLinked.some((p) => (STRUGGLE_SIGNALS as readonly string[]).includes(p.progressSignal));
    const hasRecurring = profile.recurringMistakes.some(
      (m) => m.status === 'recurring' && m.relatedEntityIds.some((id) => targetSet.has(id)),
    );
    if (fullyConsolidated && latestSolved.currentState === 'Got AC Independently' && !hasStruggle && !hasRecurring) {
      return {
        outcome: 'no-reinforcement-needed',
        need: null,
        reasons: [
          {
            kind: 'consolidated-strength',
            detail:
              `All ${targets.length} target entities show demonstrated/strong knowledge with high confidence, ` +
              `the latest solve (${latestSolved.attemptId}) was independent, and no struggle signals touch problem ${problem.problemId}.`,
            evidenceIds: [],
          },
        ],
      };
    }
  }

  const signals: ReinforcementReason[] = [];

  const helpedSolves = solved.filter((a) => a.currentState === 'Got AC with Help');
  const helpEvidence = evidenceLinked.filter((r) => r.evidenceType === 'HELP_REQUIRED');
  if (helpedSolves.length > 0 || helpEvidence.length > 0) {
    signals.push({
      kind: 'solved-with-help',
      detail:
        helpedSolves.length > 0
          ? `${helpedSolves.length} solve(s) reported with help (${helpedSolves.map((a) => a.attemptId).sort().join(', ')}) — independence not yet demonstrated.`
          : `${helpEvidence.length} help-required evidence record(s) touch this problem's attempts — independence not yet demonstrated.`,
      evidenceIds: capIds(
        helpEvidence
          .slice()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId))
          .map((r) => r.evidenceId),
      ),
    });
  }

  if (profile !== null) {
    const uncertain = getWeakOrUncertainEntities(profile).filter((s) => targetSet.has(s.entityId));
    if (uncertain.length > 0) {
      const cited = uncertain.flatMap((s) => [...s.supportingEvidenceIds, ...s.contradictingEvidenceIds]);
      signals.push({
        kind: 'uncertain-knowledge-state',
        detail: `${uncertain.length} target entit${uncertain.length === 1 ? 'y shows' : 'ies show'} weak/uncertain D state (${uncertain.map((s) => `${s.entityId}:${s.status}/${s.statusConfidence}`).sort().join(', ')}).`,
        evidenceIds: capIds([...new Set(cited)].sort()),
      });
    }
  }

  const lowMed = evidenceLinked
    .filter((r) => r.evidenceType !== 'EXPOSURE' && (r.confidence === 'low' || r.confidence === 'medium'))
    .filter((r) => r.entityIds.some((id) => targetSet.has(id)))
    .slice()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId));
  if (lowMed.length > 0) {
    signals.push({
      kind: 'low-confidence-evidence',
      detail: `${lowMed.length} low/medium-confidence D record(s) on target entities (${lowMed.map((r) => r.evidenceType).filter((v, i, arr) => arr.indexOf(v) === i).sort().join(', ')}).`,
      evidenceIds: capIds(lowMed.map((r) => r.evidenceId)),
    });
  }

  const struggles = progressLinked
    .filter((p) => (STRUGGLE_SIGNALS as readonly string[]).includes(p.progressSignal))
    .slice()
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.progressId.localeCompare(b.progressId));
  if (struggles.length > 0) {
    signals.push({
      kind: 'f3-struggle-signal',
      detail: `${struggles.length} F3 struggle signal(s) touch this problem (${struggles.map((p) => `${p.progressId}:${p.progressSignal}`).join(', ')}).`,
      evidenceIds: [],
    });
  }

  if (profile !== null) {
    const recurring = profile.recurringMistakes
      .filter((m) => m.status === 'recurring' && m.relatedEntityIds.some((id) => targetSet.has(id)))
      .slice()
      .sort((a, b) => a.mistakeId.localeCompare(b.mistakeId));
    if (recurring.length > 0) {
      signals.push({
        kind: 'recurring-mistake',
        detail: `${recurring.length} recurring mistake pattern(s) touch target entities (${recurring.map((m) => `"${m.category}"`).join(', ')}).`,
        evidenceIds: capIds([...new Set(recurring.flatMap((m) => m.evidenceIds))].sort()),
      });
    }
  }

  if (signals.length < MIN_CORROBORATING_SIGNALS) {
    return { outcome: 'insufficient-evidence', need: null, reasons: signals };
  }

  const dimensions = new Set<EvidenceDimension>();
  if (profile !== null) {
    const dims: EvidenceDimension[] = [
      'recognition',
      'conceptual',
      'implementation',
      'debugging',
      'transfer',
      'independence',
    ];
    for (const id of targets) {
      const state = getLearnerKnowledge(profile, id);
      if (!state) {
        continue;
      }
      for (const dim of dims) {
        const ds = dimensionStateOf(state, dim);
        if (ds.confidence === 'low' || ds.confidence === 'medium') {
          dimensions.add(dim);
        }
      }
    }
  }
  const evidenceIds = [...new Set(signals.flatMap((s) => s.evidenceIds))].sort();
  return {
    outcome: 'reinforcement-indicated',
    need: {
      sourceProblemId: problem.problemId,
      targetEntityIds: targets,
      dimensions: [...dimensions].sort(),
      solvedAttemptIds,
      evidenceIds,
      reasons: signals,
    },
    reasons: signals,
  };
}

/** Whether an F3 signal reads as consolidation (exported for tests/stages). */
export function isConsolidationSignal(signal: ProgressSignal): boolean {
  return (CONSOLIDATION_SIGNALS as readonly string[]).includes(signal);
}
