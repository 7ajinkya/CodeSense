import type { AIEvaluation, AIConversationMessage, InterventionType } from '../ai/aiTypes';
import type { Attempt, AttemptState } from '../attempts/attempt';
import { hashIdentity } from '../problems/problem';
import type { Problem } from '../problems/problem';
import type { ProblemClassification } from '../knowledge/classification';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceConfidence,
  EvidenceDimension,
  EvidenceType,
  HelpLevel,
} from './learnerTypes';
import {
  LearnerEvidence,
  generateEvidenceId,
  truncateEvidenceText,
  validateLearnerEvidence,
} from './learnerEvidence';
import { rebuildLearnerModel } from './learnerModelUpdater';
import type { LearnerProfile } from './learnerModel';
import type { EvidenceStore } from './learnerEvidenceStore';
import type { LearnerModelStore } from './learnerModelStore';

/**
 * Phase D evidence feeds: the ONLY sanctioned path from observations to
 * evidence. Each extractor is a pure function (inputs in, validated
 * evidence out) so interpretation rules are unit-testable without vscode,
 * stores, or network. Orchestrators (`sync*`) append + refold + persist,
 * fail-open: they return explicit outcomes and never throw.
 *
 * What each source may claim (and may NOT):
 * - Attempt outcome: EXPOSURE for every classified entity; outcome scoped
 *   to frameworks/forms/variants/patterns/concepts (topics are encounter
 *   context, not ability claims). A bare WA/TLE/CE is a LOW-confidence
 *   implementation-difficulty signal — rival causes (concept gap, edge
 *   case, parsing, pressure) are written into the interpretation.
 * - AI diagnosis: exactly one record per intervening evaluation, and ONLY
 *   when observedEvidence is non-empty; confidence capped at medium; silent
 *   (NONE) evaluations produce NOTHING (a look without action is not
 *   success evidence).
 * - Conversation: ONLY with an explicit caller-provided assessment. Live
 *   replies are never parsed or judged — Phase G reflection uses this API.
 * - Mistake reports: explicit category + entities (tests, future
 *   detectors, future reflection).
 */

/** Classification buckets that carry approach-level ability claims. */
const OUTCOME_BUCKETS = ['frameworks', 'forms', 'variants', 'patterns', 'concepts'] as const;
/** Buckets an AI diagnosis may speak to (approach selection level). */
const DIAGNOSIS_BUCKETS = ['concepts', 'frameworks', 'forms'] as const;

type OutcomeBucket = (typeof OUTCOME_BUCKETS)[number];

function classifiedEntities(
  classification: ProblemClassification | null | undefined,
  buckets: readonly OutcomeBucket[],
): string[] {
  if (!classification) {
    return [];
  }
  const out = new Set<string>();
  for (const bucket of buckets) {
    const refs = classification[bucket] ?? [];
    for (const ref of refs) {
      if (typeof ref.entityId === 'string' && ref.entityId.length > 0) {
        out.add(ref.entityId);
      }
    }
  }
  return [...out].sort();
}

function allClassifiedEntities(classification: ProblemClassification | null | undefined): string[] {
  if (!classification) {
    return [];
  }
  const out = new Set<string>();
  const buckets = [
    'topics',
    'concepts',
    'frameworks',
    'forms',
    'patterns',
    'variants',
    'tactics',
    'prerequisites',
    'solutionFamilies',
  ] as const;
  for (const bucket of buckets) {
    for (const ref of classification[bucket]) {
      out.add(ref.entityId);
    }
  }
  return [...out].sort();
}

interface EvidenceSpec {
  evidenceType: EvidenceType;
  entityIds: string[];
  observation: string;
  interpretation: string;
  confidence: EvidenceConfidence;
  helpLevel?: HelpLevel;
  mistakeCategory?: string;
  dimension?: EvidenceDimension;
}

function buildEvidence(
  graph: KnowledgeGraph,
  spec: EvidenceSpec,
  ctx: {
    timestamp: string;
    sessionId: string | null;
    attemptId: string | null;
    problemId: string | null;
    source: LearnerEvidence['source'];
    sourceId: string | null;
    evidenceId?: string;
  },
): LearnerEvidence | null {
  if (spec.entityIds.length === 0) {
    return null;
  }
  return validateLearnerEvidence(
    {
      evidenceId: ctx.evidenceId ?? generateEvidenceId(),
      schemaVersion: 1,
      timestamp: ctx.timestamp,
      sessionId: ctx.sessionId,
      attemptId: ctx.attemptId,
      problemId: ctx.problemId,
      entityIds: [...spec.entityIds].sort(),
      evidenceType: spec.evidenceType,
      source: ctx.source,
      observation: truncateEvidenceText(spec.observation),
      interpretation: truncateEvidenceText(spec.interpretation),
      confidence: spec.confidence,
      ...(spec.helpLevel !== undefined ? { helpLevel: spec.helpLevel } : {}),
      ...(spec.mistakeCategory !== undefined ? { mistakeCategory: spec.mistakeCategory } : {}),
      ...(spec.dimension !== undefined ? { dimension: spec.dimension } : {}),
      provenance: { source: ctx.source, sourceId: ctx.sourceId },
    },
    { graph },
  );
}

export function helpLevelForIntervention(type: InterventionType): HelpLevel {
  switch (type) {
    case 'SOCRATIC_QUESTION':
      return 'socratic';
    case 'HINT':
      return 'hint';
    case 'EXPLANATION':
    case 'CONCEPT_REVIEW':
    case 'DEBUGGING_HELP':
      return 'explanation';
    case 'SOLUTION_GUIDANCE':
      return 'solution';
    case 'NONE':
    case 'ACKNOWLEDGE':
    default:
      return 'none';
  }
}

const HELP_RANK: Record<HelpLevel, number> = {
  none: 0,
  socratic: 1,
  hint: 2,
  explanation: 3,
  solution: 4,
  unknown: 1,
};

/** Strongest help actually given across evaluations for one attempt. */
export function maxHelpLevel(evaluations: AIEvaluation[]): HelpLevel {
  let best: HelpLevel = 'none';
  for (const evaluation of evaluations) {
    if (!evaluation.shouldIntervene) {
      continue;
    }
    const level = helpLevelForIntervention(evaluation.interventionType);
    if (HELP_RANK[level] > HELP_RANK[best]) {
      best = level;
    }
  }
  return best;
}

const FAILURE_STATES: AttemptState[] = [
  'Got WA',
  'Got TLE',
  'Got MLE',
  'Got Error / Compilation Error',
];

/**
 * Stronger help is stronger dependence evidence: a socratic nudge barely
 * moves independence, a full solution moves it a lot. Single data points
 * stay low/medium confidence — one explanation is still one evidence point.
 */
function helpConfidence(level: HelpLevel): EvidenceConfidence {
  return level === 'explanation' || level === 'solution' ? 'medium' : 'low';
}

/**
 * Stable identity for attempt-derived evidence (duplicate-sync fix).
 *
 * The same finalized attempt synchronized twice must yield the same
 * records, so the evidence store's ID dedup collapses repeat passes
 * instead of persisting duplicate copies. Coordinates cover everything
 * that distinguishes legitimate facets of one attempt (schema, attempt,
 * problem, type, entities, help level); timestamps are deliberately
 * excluded so re-finalization clock skew can never fork identities, and
 * so the ID never depends on wall-clock time for finalized attempts.
 * Different attempts always differ by attemptId; genuinely different
 * observations (e.g. a newly observed help level) keep distinct IDs.
 */
function stableAttemptEvidenceId(args: {
  attemptId: string;
  problemId: string;
  evidenceType: EvidenceType;
  entityIds: string[];
  helpLevel?: HelpLevel;
}): string {
  const key = [
    EVIDENCE_SCHEMA_VERSION,
    args.attemptId,
    args.problemId,
    args.evidenceType,
    [...args.entityIds].sort().join(','),
    args.helpLevel ?? '',
  ].join('|');
  return `ev_${hashIdentity(key)}`;
}

/**
 * Attempt-completion feed. Emits EXPOSURE (all classified entities) plus
 * outcome evidence scoped to approach-level buckets. Returns [] when the
 * problem is unclassified — without classification there is no honest
 * entity anchor, and the feed refuses to guess.
 */
export function extractAttemptEvidence(
  graph: KnowledgeGraph,
  args: {
    attempt: Attempt;
    problem: Problem;
    classification: ProblemClassification | null | undefined;
    evaluations: AIEvaluation[];
    timestamp?: string;
  },
): LearnerEvidence[] {
  const { attempt, problem } = args;
  const at = args.timestamp ?? attempt.completedAt ?? new Date().toISOString();
  const ctx = {
    timestamp: at,
    sessionId: attempt.sessionId,
    attemptId: attempt.attemptId,
    problemId: problem.problemId,
    source: 'attempt-outcome' as const,
    sourceId: attempt.attemptId,
  };
  const out: LearnerEvidence[] = [];
  const exposed = allClassifiedEntities(args.classification);
  if (exposed.length === 0) {
    return [];
  }
  const scoped = classifiedEntities(args.classification, OUTCOME_BUCKETS);
  // Stable per-record identity: repeat synchronizations of the same
  // finalized attempt mint the same IDs, so the store collapses them.
  const stableId = (evidenceType: EvidenceType, entityIds: string[], helpLevel?: HelpLevel): string =>
    stableAttemptEvidenceId({
      attemptId: attempt.attemptId,
      problemId: problem.problemId,
      evidenceType,
      entityIds,
      helpLevel,
    });
  const exposure = buildEvidence(
    graph,
    {
      evidenceType: 'EXPOSURE',
      entityIds: exposed,
      observation: `Attempted "${problem.title ?? problem.problemId}" (ended as "${attempt.currentState}").`,
      interpretation: 'Encountered these knowledge areas. Exposure only — no ability claim follows.',
      confidence: 'high',
    },
    { ...ctx, evidenceId: stableId('EXPOSURE', exposed) },
  );
  if (exposure) {
    out.push(exposure);
  }
  if (scoped.length === 0) {
    return out;
  }
  const state = attempt.currentState;
  const maxHelp = maxHelpLevel(args.evaluations);
  if (state === 'Got AC Independently' && maxHelp === 'none') {
    const independent = buildEvidence(
      graph,
      {
        evidenceType: 'INDEPENDENT_SUCCESS',
        entityIds: scoped,
        observation: `Solved "${problem.title ?? problem.problemId}" with no recorded coach help.`,
        interpretation:
          'One independent success: weak positive implementation signal. Single encounters prove nothing durable.',
        confidence: 'medium',
        helpLevel: 'none',
      },
      { ...ctx, evidenceId: stableId('INDEPENDENT_SUCCESS', scoped, 'none') },
    );
    const implemented = buildEvidence(
      graph,
      {
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        entityIds: scoped,
        observation: `Working implementation produced for "${problem.title ?? problem.problemId}".`,
        interpretation: 'The code ran to an accepted outcome once; approach choice and edge coverage stay unknown.',
        confidence: 'low',
      },
      { ...ctx, evidenceId: stableId('IMPLEMENTATION_SUCCESS', scoped) },
    );
    if (independent) {
      out.push(independent);
    }
    if (implemented) {
      out.push(implemented);
    }
    return out;
  }
  if (state === 'Got AC Independently' || state === 'Got AC with Help') {
    const implemented = buildEvidence(
      graph,
      {
        evidenceType: 'IMPLEMENTATION_SUCCESS',
        entityIds: scoped,
        observation: `Accepted outcome on "${problem.title ?? problem.problemId}" (reported "${state}").`,
        interpretation: 'Eventual success with help in the loop; implementation credit is shared with the help received.',
        confidence: 'low',
      },
      { ...ctx, evidenceId: stableId('IMPLEMENTATION_SUCCESS', scoped) },
    );
    if (implemented) {
      out.push(implemented);
    }
  } else if ((FAILURE_STATES as string[]).includes(state)) {
    const failed = buildEvidence(
      graph,
      {
        evidenceType: 'IMPLEMENTATION_FAILURE',
        entityIds: scoped,
        observation: `Attempt on "${problem.title ?? problem.problemId}" ended as "${state}".`,
        interpretation:
          'Weak implementation-difficulty signal only. Rival explanations preserved: concept gap, edge case, ' +
          'parsing, language friction, or pressure — none established by an outcome alone.',
        confidence: 'low',
      },
      { ...ctx, evidenceId: stableId('IMPLEMENTATION_FAILURE', scoped) },
    );
    if (failed) {
      out.push(failed);
    }
  }
  if (maxHelp !== 'none') {
    const helped = buildEvidence(
      graph,
      {
        evidenceType: 'HELP_REQUIRED',
        entityIds: scoped,
        observation: `Coach help at level "${maxHelp}" was given during this attempt.`,
        interpretation: 'One data point on the help ladder; a single hint never marks a concept weak.',
        confidence: helpConfidence(maxHelp),
        helpLevel: maxHelp,
      },
      { ...ctx, evidenceId: stableId('HELP_REQUIRED', scoped, maxHelp) },
    );
    if (helped) {
      out.push(helped);
    }
  } else if (state === 'Got AC with Help') {
    // Learner-reported help with nothing observed in evaluations (help may
    // have come from outside the coach loop). Record the report honestly
    // with level `unknown` instead of inventing a level or dropping it.
    const reported = buildEvidence(
      graph,
      {
        evidenceType: 'HELP_REQUIRED',
        entityIds: scoped,
        observation: `Attempt reported as "${state}" with no coach help observed in evaluations.`,
        interpretation: 'Learner-reported help outside the observed loop; level unknown, weight minimal.',
        confidence: 'low',
        helpLevel: 'unknown',
      },
      { ...ctx, evidenceId: stableId('HELP_REQUIRED', scoped, 'unknown') },
    );
    if (reported) {
      out.push(reported);
    }
  }
  return out;
}

/**
 * AI-diagnosis feed. Exactly one record per intervening evaluation with
 * non-empty observedEvidence; NOTHING for silent (NONE) evaluations.
 * Confidence is capped at medium — a hypothesis stays a hypothesis.
 * Dimension follows the recommended interaction (debugging vs conceptual
 * help); other intervention kinds carry no localizable claim.
 */
export function extractEvaluationEvidence(
  graph: KnowledgeGraph,
  args: {
    evaluation: AIEvaluation;
    attempt: Attempt;
    classification: ProblemClassification | null | undefined;
  },
): LearnerEvidence[] {
  const { evaluation, attempt } = args;
  if (!evaluation.shouldIntervene || evaluation.diagnosis.observedEvidence.length === 0) {
    return [];
  }
  let evidenceType: EvidenceType | null = null;
  if (evaluation.diagnosis.recommendedInteraction === 'DEBUGGING_HELP') {
    evidenceType = 'DEBUGGING_FAILURE';
  } else if (
    evaluation.diagnosis.recommendedInteraction === 'CONCEPT_REVIEW' ||
    evaluation.diagnosis.recommendedInteraction === 'EXPLANATION' ||
    evaluation.diagnosis.recommendedInteraction === 'SOLUTION_GUIDANCE'
  ) {
    evidenceType = 'CONCEPTUAL_CONFUSION';
  } else {
    return [];
  }
  const scoped = classifiedEntities(args.classification, DIAGNOSIS_BUCKETS);
  if (scoped.length === 0) {
    return [];
  }
  const observed = evaluation.diagnosis.observedEvidence.slice(0, 3).join(' | ');
  const confidence: EvidenceConfidence = evaluation.diagnosis.confidence === 'low' ? 'low' : 'medium';
  const record = buildEvidence(
    graph,
    {
      evidenceType,
      entityIds: scoped,
      observation: `Coach grounded a ${evaluation.interventionType} in: ${observed}`,
      interpretation:
        `Uncertain ${evidenceType === 'DEBUGGING_FAILURE' ? 'debugging-difficulty' : 'conceptual-difficulty'} ` +
        `hypothesis (coach confidence ${evaluation.diagnosis.confidence}, capped here). Alternative explanations in unknowns.`,
      confidence,
    },
    {
      timestamp: evaluation.timestamp,
      sessionId: attempt.sessionId,
      attemptId: attempt.attemptId,
      problemId: attempt.problemId,
      source: 'ai-diagnosis',
      sourceId: evaluation.evaluationId,
    },
  );
  return record ? [record] : [];
}

export type ReplyAssessment =
  | 'demonstrates-understanding'
  | 'shows-confusion'
  | 'reports-implementation-friction'
  | 'acknowledgement'
  | 'unassessable';

/**
 * Conversation feed — explicit assessment ONLY. `acknowledgement` and
 * `unassessable` yield no evidence (a reply receipt is not knowledge).
 * `reports-implementation-friction` credits self-reported understanding
 * while making NO implementation claim: paired with outcome evidence,
 * that split IS the concept/implementation distinction.
 */
export function extractReplyEvidence(
  graph: KnowledgeGraph,
  args: {
    message: AIConversationMessage;
    attempt: Attempt;
    classification: ProblemClassification | null | undefined;
    assessment: ReplyAssessment;
  },
): LearnerEvidence[] {
  if (args.assessment === 'acknowledgement' || args.assessment === 'unassessable') {
    return [];
  }
  const scoped = classifiedEntities(args.classification, DIAGNOSIS_BUCKETS);
  if (scoped.length === 0) {
    return [];
  }
  const ctx = {
    timestamp: args.message.timestamp,
    sessionId: args.attempt.sessionId,
    attemptId: args.attempt.attemptId,
    problemId: args.attempt.problemId,
    source: 'conversation' as const,
    sourceId: args.message.messageId,
  };
  if (args.assessment === 'demonstrates-understanding') {
    const record = buildEvidence(
      graph,
      {
        evidenceType: 'CONCEPTUAL_SUCCESS',
        entityIds: scoped,
        observation: 'Learner reply demonstrates the underlying idea (explicit assessment).',
        interpretation: 'Self-explained understanding: positive but self-reported, so confidence stays medium.',
        confidence: 'medium',
      },
      ctx,
    );
    return record ? [record] : [];
  }
  if (args.assessment === 'shows-confusion') {
    const record = buildEvidence(
      graph,
      {
        evidenceType: 'CONCEPTUAL_CONFUSION',
        entityIds: scoped,
        observation: 'Learner reply shows confusion about the underlying idea (explicit assessment).',
        interpretation: 'Stated confusion is direct but narrow: one confused reply is not a verdict.',
        confidence: 'medium',
      },
      ctx,
    );
    return record ? [record] : [];
  }
  const record = buildEvidence(
    graph,
    {
      evidenceType: 'CONCEPTUAL_SUCCESS',
      entityIds: scoped,
      observation: 'Learner reports understanding the idea but hitting implementation/language friction (explicit assessment).',
      interpretation:
        'Self-reported understanding credited weakly; NO implementation claim is made here — ' +
        'the friction itself is not failure evidence.',
      confidence: 'low',
    },
    ctx,
  );
  return record ? [record] : [];
}

/**
 * Explicit mistake report (tests, future detectors, future reflection).
 * Occurrences accumulate into patterns in the updater; a single report
 * is status `single`, never a trait.
 */
export function extractMistakeEvidence(
  graph: KnowledgeGraph,
  args: {
    category: string;
    entityIds: string[];
    dimension?: EvidenceDimension;
    observation: string;
    sessionId?: string | null;
    attemptId?: string | null;
    problemId?: string | null;
    timestamp?: string;
    confidence?: EvidenceConfidence;
  },
): LearnerEvidence | null {
  return buildEvidence(
    graph,
    {
      evidenceType: 'RECURRING_MISTAKE',
      entityIds: args.entityIds,
      observation: args.observation,
      interpretation: `Sighted "${args.category}" pattern instance; recurrence is decided by count, not by this record.`,
      confidence: args.confidence ?? 'medium',
      mistakeCategory: args.category,
      dimension: args.dimension ?? 'implementation',
    },
    {
      timestamp: args.timestamp ?? new Date().toISOString(),
      sessionId: args.sessionId ?? null,
      attemptId: args.attemptId ?? null,
      problemId: args.problemId ?? null,
      source: 'mistake-report',
      sourceId: null,
    },
  );
}

export type RecognitionVerdict = 'recognized' | 'missed';

/**
 * Explicit recognition report (learner independently named the right
 * approach, or demonstrably missed it). A miss becomes CONCEPTUAL_CONFUSION
 * — choosing the wrong family is a conceptual signal, kept low-confidence.
 */
export function extractRecognitionEvidence(
  graph: KnowledgeGraph,
  args: {
    entityIds: string[];
    verdict: RecognitionVerdict;
    observation: string;
    sessionId?: string | null;
    attemptId?: string | null;
    problemId?: string | null;
    timestamp?: string;
  },
): LearnerEvidence | null {
  const type: EvidenceType = args.verdict === 'recognized' ? 'RECOGNITION' : 'CONCEPTUAL_CONFUSION';
  return buildEvidence(
    graph,
    {
      evidenceType: type,
      entityIds: args.entityIds,
      observation: args.observation,
      interpretation:
        args.verdict === 'recognized'
          ? 'Independent recognition is stronger than exposure, still single-encounter weak.'
          : 'Missed recognition is a weak conceptual signal; unfamiliar form explains it as well as a gap.',
      confidence: 'low',
    },
    {
      timestamp: args.timestamp ?? new Date().toISOString(),
      sessionId: args.sessionId ?? null,
      attemptId: args.attemptId ?? null,
      problemId: args.problemId ?? null,
      source: args.attemptId ? 'attempt-outcome' : 'human-curated',
      sourceId: args.attemptId ?? null,
    },
  );
}

export interface LearnerSyncOutcome {
  stored: number;
  pruned: number;
  totalEvidence: number;
}

async function appendAndRefold(
  evidenceStore: EvidenceStore,
  modelStore: LearnerModelStore,
  graph: KnowledgeGraph,
  records: LearnerEvidence[],
  now: string,
): Promise<LearnerSyncOutcome> {
  const { stored, pruned } = await evidenceStore.appendEvidenceBatch(records);
  const history = await evidenceStore.listEvidence();
  const previous = await modelStore.loadProfile().catch(() => null);
  const profile = rebuildLearnerModel(history, graph, { now, previous });
  await modelStore.saveProfile(profile);
  return { stored, pruned, totalEvidence: history.length };
}

/**
 * Orchestrator: attempt completion → evidence → persisted profile.
 * Fail-open by contract: returns an outcome, never throws (store
 * failures surface as `{ stored: 0, ..., error }`).
 */
export async function syncAttemptToLearnerModel(
  ports: {
    evidenceStore: EvidenceStore;
    modelStore: LearnerModelStore;
    graph: KnowledgeGraph;
    nowIso(): string;
  },
  input: {
    attempt: Attempt;
    problem: Problem;
    classification: ProblemClassification | null | undefined;
    evaluations: AIEvaluation[];
  },
): Promise<LearnerSyncOutcome & { error?: string }> {
  try {
    const records = extractAttemptEvidence(ports.graph, {
      attempt: input.attempt,
      problem: input.problem,
      classification: input.classification,
      evaluations: input.evaluations,
    });
    return await appendAndRefold(ports.evidenceStore, ports.modelStore, ports.graph, records, ports.nowIso());
  } catch (err) {
    return { stored: 0, pruned: 0, totalEvidence: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Orchestrator: one saved evaluation → evidence → persisted profile. */
export async function syncEvaluationToLearnerModel(
  ports: {
    evidenceStore: EvidenceStore;
    modelStore: LearnerModelStore;
    graph: KnowledgeGraph;
    nowIso(): string;
  },
  input: {
    evaluation: AIEvaluation;
    attempt: Attempt;
    classification: ProblemClassification | null | undefined;
  },
): Promise<LearnerSyncOutcome & { error?: string }> {
  try {
    const records = extractEvaluationEvidence(ports.graph, {
      evaluation: input.evaluation,
      attempt: input.attempt,
      classification: input.classification,
    });
    return await appendAndRefold(ports.evidenceStore, ports.modelStore, ports.graph, records, ports.nowIso());
  } catch (err) {
    return { stored: 0, pruned: 0, totalEvidence: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Orchestrator for explicit reports (mistakes, recognition, replies). */
export async function syncRecordsToLearnerModel(
  ports: {
    evidenceStore: EvidenceStore;
    modelStore: LearnerModelStore;
    graph: KnowledgeGraph;
    nowIso(): string;
  },
  records: LearnerEvidence[],
): Promise<LearnerSyncOutcome & { error?: string }> {
  try {
    return await appendAndRefold(ports.evidenceStore, ports.modelStore, ports.graph, records, ports.nowIso());
  } catch (err) {
    return { stored: 0, pruned: 0, totalEvidence: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
