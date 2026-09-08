import { randomUUID } from 'crypto';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import type { EvidenceDimension } from '../learner/learnerTypes';
import {
  MAX_GOAL_DESCRIPTION_CHARS,
  MAX_GOAL_ENTITY_IDS,
  MAX_GOAL_EVIDENCE_IDS,
  MAX_GOAL_TEXT_CHARS,
} from './goalTypes';
import type {
  GoalEvidenceBasis,
  GoalSuccessCriteria,
  GoalWordingCandidate,
  LearningGoal,
  LearningNeed,
} from './goalTypes';
import { needTargetKey } from './needDetection';

export const GOAL_ID_PREFIX = 'goal_';

export function generateGoalId(): string {
  return `${GOAL_ID_PREFIX}${randomUUID()}`;
}

/** Canonical dedup key: sorted entity IDs joined with `+`, plus dimension. */
export function goalTargetKey(entityIds: string[], dimension: EvidenceDimension): string {
  return needTargetKey(entityIds, dimension);
}

function truncateGoalText(text: string, max: number = MAX_GOAL_TEXT_CHARS): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function entityDisplayName(graph: KnowledgeGraph, entityId: string): string {
  return graph.getEntity(entityId)?.name ?? entityId;
}

function dimensionPhrase(dimension: EvidenceDimension): string {
  switch (dimension) {
    case 'recognition':
      return 'independent recognition';
    case 'conceptual':
      return 'conceptual understanding';
    case 'implementation':
      return 'implementation';
    case 'debugging':
      return 'debugging';
    case 'transfer':
      return 'transfer to unfamiliar variants';
    case 'independence':
      return 'independent problem solving';
    case 'exposure':
      return 'exposure';
  }
}

/**
 * Qualitative success criteria per dimension: what FUTURE evidence should
 * emphasize. Descriptive guidance only — later phases evaluate progress
 * against new evidence; F1 establishes the representation, not the engine.
 */
const SUCCESS_CRITERIA_TEMPLATES: Record<EvidenceDimension, { summary: string; guidance: string }> = {
  recognition: {
    summary: 'Repeated independent identification of the relevant problem form, without coaching prompts.',
    guidance: 'Future evidence should emphasize independent identification (recognition) across more than one problem form.',
  },
  conceptual: {
    summary: 'Correct explanations and approach choices showing the underlying idea, not just working code.',
    guidance: 'Future evidence should emphasize explanations, correct approach selection, and answered Socratic questions.',
  },
  implementation: {
    summary: 'Independently implemented correct solutions using the relevant technique.',
    guidance: 'Future evidence should emphasize independently implemented correct solutions with the technique.',
  },
  debugging: {
    summary: 'Identifying and fixing relevant implementation failures with decreasing help.',
    guidance: 'Future evidence should emphasize diagnosed and fixed failures, and less help needed to do so.',
  },
  transfer: {
    summary: 'Applying the capability to unfamiliar variants and surfaces.',
    guidance: 'Future evidence should emphasize success on unfamiliar variants, not repetitions of the same form.',
  },
  independence: {
    summary: 'Success without progressively stronger intervention.',
    guidance: 'Future evidence should emphasize solved attempts needing no help or strictly lighter help.',
  },
  exposure: {
    summary: 'Encountering the area across more problems.',
    guidance: 'Future evidence should emphasize broader encounter history before any stronger claim.',
  },
};

export function successCriteriaFor(dimension: EvidenceDimension): GoalSuccessCriteria {
  const template = SUCCESS_CRITERIA_TEMPLATES[dimension];
  return { summary: template.summary, dimension, guidance: template.guidance };
}

export interface GoalExplanation {
  /** Learner-facing summary of why this goal is suggested. */
  summary: string;
  /** Grounded evidence excerpts (bounded observation text), oldest first. */
  evidencePoints: string[];
  /** Uncertainty caveat, or null when the basis is corroborated. */
  uncertainty: string | null;
}

const MAX_EXPLANATION_POINTS = 4;
const MAX_EXPLANATION_POINT_CHARS = 200;

/**
 * Deterministic, evidence-grounded explanation builder. Every claim in
 * the output traces to the need's evidence basis; uncertainty notes are
 * preserved verbatim rather than smoothed over.
 */
export function explainProposal(
  need: LearningNeed,
  evidence: LearnerEvidence[],
  graph: KnowledgeGraph,
): GoalExplanation {
  const names = need.entityIds.map((id) => entityDisplayName(graph, id)).join(', ');
  const byId = new Map(evidence.map((record) => [record.evidenceId, record] as const));
  const points: string[] = [];
  for (const evidenceId of need.evidenceBasis.evidenceIds) {
    const record = byId.get(evidenceId);
    if (!record) {
      continue;
    }
    points.push(truncateGoalText(record.observation, MAX_EXPLANATION_POINT_CHARS));
    if (points.length >= MAX_EXPLANATION_POINTS) {
      break;
    }
  }
  const summary =
    `Across ${need.evidenceBasis.evidenceIds.length} evidence-backed encounter(s), ` +
    `${describeNeedFocus(need, names)}.`;
  const uncertainty =
    need.ambiguity && need.ambiguity.length > 0 ? `Open question: ${need.ambiguity.join(' ')}` : null;
  return { summary, evidencePoints: points, uncertainty };
}

function describeNeedFocus(need: LearningNeed, names: string): string {
  const facet = dimensionPhrase(need.dimension);
  if (need.confidence === 'low') {
    return (
      `there are repeated but still uncertain signals around ${facet} on ${names} — ` +
      'worth deliberate attention, not a conclusion'
    );
  }
  return `repeated difficulty centers on ${facet} on ${names}`;
}

function cleanEntityIds(graph: KnowledgeGraph, entityIds: string[]): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of entityIds) {
    if (typeof id !== 'string') {
      return null;
    }
    const trimmed = id.trim();
    if (trimmed.length === 0 || !graph.hasEntity(trimmed)) {
      return null;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (out.length === 0 || out.length > MAX_GOAL_ENTITY_IDS) {
    return null;
  }
  return out.sort();
}

function basisFromNeed(need: LearningNeed, needId: string): GoalEvidenceBasis {
  return {
    evidenceIds: need.evidenceBasis.evidenceIds.slice(0, MAX_GOAL_EVIDENCE_IDS),
    profileUpdatedAt: need.evidenceBasis.profileUpdatedAt,
    ontologyVersion: need.evidenceBasis.ontologyVersion,
    aggregatorVersion: need.evidenceBasis.aggregatorVersion,
    needId,
  };
}

/**
 * Build an evidence-derived goal proposal from a detected need.
 * Deterministic: same need + graph yields the same proposal modulo
 * id/timestamps. Status is ALWAYS `proposed` — activation requires
 * a learner decision through the lifecycle module.
 */
export function proposeGoalFromNeed(
  need: LearningNeed,
  args: { graph: KnowledgeGraph; now: string },
): LearningGoal | null {
  const entityIds = cleanEntityIds(args.graph, need.entityIds);
  if (!entityIds) {
    return null;
  }
  const names = entityIds.map((id) => entityDisplayName(args.graph, id)).join(', ');
  const now = args.now;
  return {
    goalId: generateGoalId(),
    targetKey: goalTargetKey(entityIds, need.dimension),
    entityIds,
    dimension: need.dimension,
    description: truncateGoalText(
      `Improve ${dimensionPhrase(need.dimension)} on ${names}.`,
      MAX_GOAL_DESCRIPTION_CHARS,
    ),
    source: 'evidence-derived',
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    evidenceBasis: basisFromNeed(need, need.needId),
    successCriteria: successCriteriaFor(need.dimension),
    progressBaseline: null,
    decidedAt: null,
  };
}

export interface LearnerGoalRequest {
  /** Optional canonical entity IDs (validated; unresolved input is refused). */
  entityIds?: string[];
  /** Optional frozen dimension; broadest honest default when omitted. */
  dimension?: EvidenceDimension;
  /** Optional learner phrasing; becomes the description when usable. */
  description?: string;
  /** Verbatim learner statement (bounded, stored as provenance). */
  learnerStatement: string;
}

/**
 * Build a learner-requested goal proposal. The learner's explicit intent
 * is a legitimate source of direction on its own — no evidence required,
 * and none invented: the basis carries the statement, not a need.
 */
export function proposeGoalFromRequest(
  request: LearnerGoalRequest,
  args: { graph: KnowledgeGraph; profile: LearnerProfile | null; now: string },
): LearningGoal | null {
  if (typeof request.learnerStatement !== 'string' || request.learnerStatement.trim().length === 0) {
    return null;
  }
  let entityIds: string[] = [];
  if (request.entityIds !== undefined) {
    const cleaned = cleanEntityIds(args.graph, request.entityIds);
    if (!cleaned) {
      return null;
    }
    entityIds = cleaned;
  }
  const dimension = request.dimension ?? 'implementation';
  const statement = truncateGoalText(request.learnerStatement);
  const description =
    typeof request.description === 'string' && request.description.trim().length > 0
      ? truncateGoalText(request.description, MAX_GOAL_DESCRIPTION_CHARS)
      : entityIds.length > 0
        ? truncateGoalText(
            `Get better at ${dimensionPhrase(dimension)} on ${entityIds.map((id) => entityDisplayName(args.graph, id)).join(', ')}.`,
            MAX_GOAL_DESCRIPTION_CHARS,
          )
        : statement.slice(0, MAX_GOAL_DESCRIPTION_CHARS);
  const now = args.now;
  return {
    goalId: generateGoalId(),
    targetKey: goalTargetKey(entityIds, dimension),
    entityIds,
    dimension,
    description,
    source: 'learner-requested',
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    evidenceBasis: {
      evidenceIds: [],
      profileUpdatedAt: args.profile?.updatedAt ?? now,
      ontologyVersion: args.graph.ontologyVersion,
      aggregatorVersion: args.profile?.aggregatorVersion ?? 'unknown',
      needId: null,
      learnerStatement: statement,
    },
    successCriteria: successCriteriaFor(dimension),
    progressBaseline: null,
    decidedAt: null,
  };
}

/**
 * Strict validation for AI-produced wording candidates. Accepts ONLY
 * display text (description / success-criteria summary), each bounded and
 * non-blank, with no other keys. Anything else — statuses, sources,
 * provenance, ids — is rejected, so candidate wording can never smuggle
 * durable state.
 */
export function validateGoalCandidate(raw: unknown): GoalWordingCandidate | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'description' && key !== 'successCriteriaSummary') {
      return null;
    }
  }
  const out: GoalWordingCandidate = {};
  let claimed = false;
  if (record.description !== undefined) {
    if (typeof record.description !== 'string' || record.description.trim().length === 0) {
      return null;
    }
    out.description = truncateGoalText(record.description, MAX_GOAL_DESCRIPTION_CHARS);
    claimed = true;
  }
  if (record.successCriteriaSummary !== undefined) {
    if (typeof record.successCriteriaSummary !== 'string' || record.successCriteriaSummary.trim().length === 0) {
      return null;
    }
    out.successCriteriaSummary = truncateGoalText(record.successCriteriaSummary);
    claimed = true;
  }
  return claimed ? out : null;
}

/**
 * Apply validated candidate wording onto a proposal draft. Returns a new
 * record: description/success-criteria text may change, but id, source,
 * status, provenance, baseline, and decisions are preserved untouched.
 */
export function applyCandidateWording(proposal: LearningGoal, candidate: GoalWordingCandidate): LearningGoal {
  return {
    ...proposal,
    description: candidate.description ?? proposal.description,
    successCriteria: {
      ...proposal.successCriteria,
      summary: candidate.successCriteriaSummary ?? proposal.successCriteria.summary,
    },
    evidenceBasis: { ...proposal.evidenceBasis },
  };
}
