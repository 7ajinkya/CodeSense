import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { dimensionStateOf } from '../learner/learnerModel';
import type { LearnerProfile } from '../learner/learnerModel';
import type { EvidenceDimension } from '../learner/learnerTypes';
import type { LearningNeed } from './goalTypes';

/**
 * Phase F1 learning-need detection: pure derivation of actionable needs
 * from frozen Phase D output. Reads D state, never writes it; produces
 * no verdicts, only needs grounded in corroborated evidence.
 *
 * Corroboration rules (no fake precision, no single-event goals):
 * - Rule A (corroborated difficulty): entity status `struggling` or
 *   `mixed` — which Phase D only assigns on repeated, majority-negative
 *   evidence — yields one need per negative-majority dimension.
 * - Rule B (ambiguous repetition): repeated evidence (count floor) with
 *   low status confidence yields at most one need on the top-negative
 *   dimension, carrying explicit rival interpretations.
 * - Anything weaker (single events, exposure-only, confident positives)
 *   yields nothing. Uncertainty is preserved, never laundered.
 */

export const MAX_DETECTED_NEEDS = 10;
export const MIN_EVIDENCE_FOR_AMBIGUOUS_NEED = 3;
export const MAX_NEED_EVIDENCE_IDS = 12;

/** Non-exposure dimensions in stable evaluation order. */
const SCORABLE_DIMENSIONS: readonly EvidenceDimension[] = [
  'recognition',
  'conceptual',
  'implementation',
  'debugging',
  'transfer',
  'independence',
];

/** Deterministic FNV-1a hex (matches repo hashing style, dependency-free). */
function stableKeyHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function needTargetKey(entityIds: string[], dimension: EvidenceDimension): string {
  return `${[...entityIds].sort().join('+')}|${dimension}`;
}

export function needIdFor(entityIds: string[], dimension: EvidenceDimension): string {
  return `need_${stableKeyHash(needTargetKey(entityIds, dimension))}`;
}

function basisEvidenceIds(profile: LearnerProfile, entityId: string): string[] {
  const state = profile.knowledgeStates.find((s) => s.entityId === entityId);
  if (!state) {
    return [];
  }
  const ids = [...state.supportingEvidenceIds, ...state.contradictingEvidenceIds];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered.slice(0, MAX_NEED_EVIDENCE_IDS);
}

function describeDimension(dimension: EvidenceDimension): string {
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

function negativeMajorityDimensions(
  profile: LearnerProfile,
  entityId: string,
): Array<{ dimension: EvidenceDimension; negativeWeight: number }> {
  const state = profile.knowledgeStates.find((s) => s.entityId === entityId);
  if (!state) {
    return [];
  }
  const out: Array<{ dimension: EvidenceDimension; negativeWeight: number }> = [];
  for (const dimension of SCORABLE_DIMENSIONS) {
    const dim = dimensionStateOf(state, dimension);
    if (dim.negativeWeight > 0 && dim.negativeWeight > dim.positiveWeight) {
      out.push({ dimension, negativeWeight: dim.negativeWeight });
    }
  }
  out.sort((a, b) => b.negativeWeight - a.negativeWeight || a.dimension.localeCompare(b.dimension));
  return out;
}

/**
 * Derive candidate learning needs from a learner profile.
 * Pure and deterministic: same inputs always yield the same needs in the
 * same order (severity rank, then entity, then dimension), capped.
 */
export function detectLearningNeeds(args: {
  profile: LearnerProfile;
  graph: KnowledgeGraph;
  now: string;
  limit?: number;
}): LearningNeed[] {
  const { profile, graph, now } = args;
  const limit = args.limit ?? MAX_DETECTED_NEEDS;
  const out: LearningNeed[] = [];
  const seenKeys = new Set<string>();

  const pushNeed = (need: LearningNeed): void => {
    const key = needTargetKey(need.entityIds, need.dimension);
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    out.push(need);
  };

  const ordered = [...profile.knowledgeStates].sort((a, b) => {
    const rank = (status: string): number => (status === 'struggling' ? 0 : status === 'mixed' ? 1 : 2);
    return rank(a.status) - rank(b.status) || a.entityId.localeCompare(b.entityId);
  });

  for (const state of ordered) {
    if (!graph.hasEntity(state.entityId)) {
      continue;
    }
    const basis = {
      evidenceIds: basisEvidenceIds(profile, state.entityId),
      profileUpdatedAt: profile.updatedAt,
      ontologyVersion: profile.ontologyVersion,
      aggregatorVersion: profile.aggregatorVersion,
    };
    // Rule A: corroborated difficulty → one need per negative-majority facet.
    if (state.status === 'struggling' || state.status === 'mixed') {
      const negatives = negativeMajorityDimensions(profile, state.entityId);
      for (const { dimension } of negatives) {
        const entityIds = [state.entityId];
        pushNeed({
          needId: needIdFor(entityIds, dimension),
          entityIds,
          dimension,
          description: `Improve ${describeDimension(dimension)} on ${state.entityId}`,
          rationale:
            `Repeated difficulty evidence on ${state.entityId} ` +
            `(${dimension} facet, status ${state.status}, confidence ${state.statusConfidence}).`,
          confidence: state.status === 'mixed' ? 'medium' : state.statusConfidence,
          evidenceBasis: basis,
          observedAt: now,
        });
      }
      continue;
    }
    // Rule B: ambiguous repetition → at most one explicitly-hedged need.
    if (state.statusConfidence === 'low' && state.evidenceCount >= MIN_EVIDENCE_FOR_AMBIGUOUS_NEED) {
      const negatives = negativeMajorityDimensions(profile, state.entityId);
      if (negatives.length === 0) {
        continue;
      }
      const top = negatives[0];
      if (!top) {
        continue;
      }
      const ambiguity: string[] = [];
      if (negatives.length > 1) {
        const second = negatives[1];
        if (second && second.negativeWeight * 2 > top.negativeWeight) {
          ambiguity.push(
            `Evidence also shows difficulty in ${describeDimension(second.dimension)}; ` +
              'insufficient basis to single out one facet.',
          );
        }
      }
      ambiguity.push('Temporary difficulty or unfamiliar problem variant cannot be ruled out.');
      const entityIds = [state.entityId];
      pushNeed({
        needId: needIdFor(entityIds, top.dimension),
        entityIds,
        dimension: top.dimension,
        description: `Improve ${describeDimension(top.dimension)} on ${state.entityId}`,
        rationale:
          `Repeated but low-confidence evidence on ${state.entityId}; ` +
          'treated as a candidate, not a conclusion.',
        ambiguity,
        confidence: 'low',
        evidenceBasis: basis,
        observedAt: now,
      });
    }
  }
  return out.slice(0, Math.max(0, limit));
}
