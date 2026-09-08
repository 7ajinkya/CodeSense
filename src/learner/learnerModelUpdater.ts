import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { hashIdentity } from '../problems/problem';
import type { LearnerEvidence } from './learnerEvidence';
import type {
  DimensionLevel,
  EvidenceConfidence,
  EvidenceDimension,
  EvidenceType,
} from './learnerTypes';
import {
  LearnerKnowledgeState,
  LearnerMistakePattern,
  LearnerProfile,
  MAX_STATE_EVIDENCE_REFS,
  MAX_TRAJECTORY_ENTRIES,
  MistakeOccurrence,
  TrajectoryEntry,
  dimensionStateOf,
  emptyKnowledgeState,
  emptyLearnerProfile,
} from './learnerModel';
import type { DimensionState } from './learnerModel';

/**
 * Phase D deterministic aggregation: Evidence[] → LearnerProfile.
 *
 * This is a pure fold over evidence sorted by (timestamp, evidenceId):
 * `rebuildLearnerModel` replays the WHOLE history every time, so
 * "incremental update" and "rebuild from scratch" are the same code path
 * by construction — the headline determinism property tests pin down.
 *
 * Scoring rules (transparent, conservative, no ML):
 * - Each scored evidence contributes a signed weight by its confidence:
 *   low=1, medium=2, high=3. Neutral EXPOSURE scores nothing but lifts
 *   the dimension floor from UNKNOWN to EXPOSED.
 * - Levels from net score: ≥6 STRONG, ≥3 DEMONSTRATED, ≥1 EMERGING,
 *   ≤0 EXPOSED (difficulty stays visible in negativeEvidenceIds).
 *   A lone record caps at EMERGING whatever its confidence.
 *   One success → EMERGING at most. One failure → EXPOSED, never a
 *   verdict. No negative rung exists on purpose.
 * - Confidence from agreement: single → low; agreeing pair → medium;
 *   3+ unanimous → high; any contradiction caps at medium, and a
 *   near-even split drops to low.
 * - Entity status `struggling`/`mixed` requires ≥3 negative weight AND a
 *   negative majority in some dimension — one failure can never flag it.
 * - NO time decay: old evidence is outweighed by new evidence through
 *   counts, never deleted or discounted. Recency is exposed through
 *   trajectory entries and recent-evidence queries instead.
 * - Transfer: a scored success/failure on entity X also scores the
 *   `transfer` dimension when prior scored evidence exists on a DIFFERENT
 *   entity in X's framework family from a DIFFERENT problem.
 * - Mistakes group by category + entity set: 1 sighting → single,
 *   2+ → recurring; ≥2 later positives in the area with no reoccurrence
 *   → resolved (reopenable, history preserved).
 */

export const CONFIDENCE_WEIGHT: Record<EvidenceConfidence, number> = { low: 1, medium: 2, high: 3 };

const STRONG_NET = 6;
const DEMONSTRATED_NET = 3;
const EMERGING_NET = 1;

/** Negative weight (with negative majority) needed to flag `struggling`. */
const STRUGGLING_NEGATIVE_WEIGHT = 3;
/** Later positives in the area needed to resolve a recurring pattern. */
const RESOLUTION_POSITIVES = 2;

type Polarity = 1 | -1 | 0;

const EVIDENCE_POLARITY: Record<EvidenceType, Polarity> = {
  EXPOSURE: 0,
  RECOGNITION: 1,
  CONCEPTUAL_SUCCESS: 1,
  CONCEPTUAL_CONFUSION: -1,
  IMPLEMENTATION_SUCCESS: 1,
  IMPLEMENTATION_FAILURE: -1,
  DEBUGGING_SUCCESS: 1,
  DEBUGGING_FAILURE: -1,
  TRANSFER_SUCCESS: 1,
  TRANSFER_FAILURE: -1,
  RECURRING_MISTAKE: -1,
  HELP_REQUIRED: -1,
  INDEPENDENT_SUCCESS: 1,
};

const EVIDENCE_DIMENSION: Record<EvidenceType, EvidenceDimension> = {
  EXPOSURE: 'exposure',
  RECOGNITION: 'recognition',
  CONCEPTUAL_SUCCESS: 'conceptual',
  CONCEPTUAL_CONFUSION: 'conceptual',
  IMPLEMENTATION_SUCCESS: 'implementation',
  IMPLEMENTATION_FAILURE: 'implementation',
  DEBUGGING_SUCCESS: 'debugging',
  DEBUGGING_FAILURE: 'debugging',
  TRANSFER_SUCCESS: 'transfer',
  TRANSFER_FAILURE: 'transfer',
  RECURRING_MISTAKE: 'implementation',
  HELP_REQUIRED: 'independence',
  INDEPENDENT_SUCCESS: 'independence',
};

const LEVEL_RANK: Record<DimensionLevel, number> = {
  UNKNOWN: 0,
  EXPOSED: 1,
  EMERGING: 2,
  DEMONSTRATED: 3,
  STRONG: 4,
};

export function levelRank(level: DimensionLevel): number {
  return LEVEL_RANK[level];
}

function levelForNet(net: number, scoredCount: number, exposureSeen: boolean): DimensionLevel {
  if (scoredCount === 0) {
    return exposureSeen ? 'EXPOSED' : 'UNKNOWN';
  }
  // Invariant: a SINGLE evidence item can never establish DEMONSTRATED or
  // STRONG, regardless of its confidence. One encounter is one data point —
  // corroboration across encounters is what moves levels up. Without this
  // cap, a lone high-confidence record (weight 3) would hit the
  // DEMONSTRATED threshold on its own.
  if (scoredCount <= 1) {
    return net >= EMERGING_NET ? 'EMERGING' : 'EXPOSED';
  }
  if (net >= STRONG_NET) {
    return 'STRONG';
  }
  if (net >= DEMONSTRATED_NET) {
    return 'DEMONSTRATED';
  }
  if (net >= EMERGING_NET) {
    return 'EMERGING';
  }
  return 'EXPOSED';
}

function confidenceForSplit(positiveCount: number, negativeCount: number): EvidenceConfidence {
  const total = positiveCount + negativeCount;
  if (total <= 1) {
    return 'low';
  }
  if (positiveCount === 0 || negativeCount === 0) {
    return total >= 3 ? 'high' : 'medium';
  }
  const majority = Math.max(positiveCount, negativeCount) / total;
  return majority >= 2 / 3 ? 'medium' : 'low';
}

function pushTrajectory(state: LearnerKnowledgeState, entry: TrajectoryEntry): void {
  state.trajectory.push(entry);
  if (state.trajectory.length > MAX_TRAJECTORY_ENTRIES) {
    state.trajectory.splice(0, state.trajectory.length - MAX_TRAJECTORY_ENTRIES);
  }
}

function pushRefNewestFirst(list: string[], id: string): void {
  list.unshift(id);
  if (list.length > MAX_STATE_EVIDENCE_REFS) {
    list.length = MAX_STATE_EVIDENCE_REFS;
  }
}

interface DimensionApplication {
  dimension: EvidenceDimension;
  polarity: Polarity;
  weight: number;
  evidenceId: string;
  at: string;
}

function applyToDimension(
  state: LearnerKnowledgeState,
  dimension: EvidenceDimension,
  app: DimensionApplication,
  exposureSeen: boolean,
): boolean {
  const dim: DimensionState = dimensionStateOf(state, dimension);
  let nextExposureSeen = exposureSeen;
  if (app.polarity === 0) {
    nextExposureSeen = true;
    if (dim.level === 'UNKNOWN') {
      pushTrajectory(state, { at: app.at, dimension, from: dim.level, to: 'EXPOSED', evidenceIds: [app.evidenceId] });
      dim.level = 'EXPOSED';
    }
    dim.lastUpdatedAt = app.at;
    return nextExposureSeen;
  }
  if (app.polarity === 1) {
    dim.positiveWeight += app.weight;
    if (!dim.positiveEvidenceIds.includes(app.evidenceId)) {
      dim.positiveEvidenceIds.push(app.evidenceId);
    }
  } else {
    dim.negativeWeight += app.weight;
    if (!dim.negativeEvidenceIds.includes(app.evidenceId)) {
      dim.negativeEvidenceIds.push(app.evidenceId);
    }
  }
  dim.lastUpdatedAt = app.at;
  const net = dim.positiveWeight - dim.negativeWeight;
  const scored = dim.positiveEvidenceIds.length + dim.negativeEvidenceIds.length;
  const next = levelForNet(net, scored, nextExposureSeen);
  if (next !== dim.level) {
    pushTrajectory(state, { at: app.at, dimension, from: dim.level, to: next, evidenceIds: [app.evidenceId] });
    dim.level = next;
  }
  dim.confidence = confidenceForSplit(dim.positiveEvidenceIds.length, dim.negativeEvidenceIds.length);
  return nextExposureSeen;
}

const STATUS_DIMS: EvidenceDimension[] = [
  'recognition',
  'conceptual',
  'implementation',
  'debugging',
  'transfer',
  'independence',
];

function rollupStatus(state: LearnerKnowledgeState): { status: LearnerKnowledgeState['status']; confidence: EvidenceConfidence } {
  const dims = STATUS_DIMS.map((d) => dimensionStateOf(state, d));
  const hasScored = dims.some((d) => d.positiveEvidenceIds.length + d.negativeEvidenceIds.length > 0);
  if (!hasScored) {
    return { status: 'exposed', confidence: 'low' };
  }
  let struggling = false;
  for (const d of dims) {
    if (d.negativeWeight >= STRUGGLING_NEGATIVE_WEIGHT && d.negativeWeight > d.positiveWeight) {
      struggling = true;
      break;
    }
  }
  const strongCount = dims.filter((d) => d.level === 'STRONG').length;
  const demonstratedCount = dims.filter((d) => d.level === 'DEMONSTRATED' || d.level === 'STRONG').length;
  const contradicting = dims.some((d) => d.positiveEvidenceIds.length > 0 && d.negativeEvidenceIds.length > 0);
  let confidence: EvidenceConfidence = 'high';
  for (const d of dims) {
    if (d.positiveEvidenceIds.length + d.negativeEvidenceIds.length === 0) {
      continue;
    }
    if (d.confidence === 'low') {
      confidence = 'low';
      break;
    }
    if (d.confidence === 'medium') {
      confidence = 'medium';
    }
  }
  if (contradicting && confidence === 'high') {
    confidence = 'medium';
  }
  if (struggling && demonstratedCount > 0) {
    return { status: 'mixed', confidence };
  }
  if (struggling) {
    return { status: 'struggling', confidence };
  }
  if (strongCount > 0 || demonstratedCount >= 2) {
    return { status: 'strong', confidence };
  }
  if (demonstratedCount > 0) {
    return { status: 'demonstrated', confidence };
  }
  return { status: 'developing', confidence };
}

/**
 * Framework family used for transfer detection: the entity itself plus
 * its framework relatives (forms/variants of the same framework, or the
 * framework behind a form/variant). Only framework/form/variant entities
 * participate — topics and concepts are too coarse for transfer claims.
 */
export function frameworkFamily(graph: KnowledgeGraph, entityId: string): string[] {
  const entity = graph.getEntity(entityId);
  if (!entity) {
    return [entityId];
  }
  const family = new Set<string>([entityId]);
  if (entity.type === 'framework') {
    for (const member of graph.getFormsAndVariants(entityId)) {
      family.add(member.id);
    }
    return [...family].sort();
  }
  if (entity.type === 'form' || entity.type === 'variant') {
    for (const rel of graph.getRelatedEntities(entityId, ['form_of', 'variant_of'])) {
      if (!rel.outgoing) {
        continue;
      }
      family.add(rel.entity.id);
      if (rel.entity.type === 'framework') {
        for (const sibling of graph.getFormsAndVariants(rel.entity.id)) {
          family.add(sibling.id);
        }
      }
    }
    return [...family].sort();
  }
  return [entityId];
}

function mistakeKey(category: string, entityIds: string[]): string {
  return `${category}|${[...entityIds].sort().join(',')}`;
}

export function mistakeIdFor(category: string, entityIds: string[]): string {
  return 'mist_' + hashIdentity(mistakeKey(category, entityIds));
}

interface OccurrenceSeed {
  evidenceId: string;
  attemptId: string | null;
  timestamp: string;
  category: string;
  entityIds: string[];
}

interface LaterPositive {
  at: string;
  entityIds: string[];
}

/**
 * Pure deterministic fold. Sorts a COPY of the evidence (never mutates
 * input), replays every record in (timestamp, evidenceId) order, and
 * returns a fresh profile. `previous` supplies identity/timestamps only —
 * no belief is carried over except through replayed evidence.
 */
export function rebuildLearnerModel(
  evidence: LearnerEvidence[],
  graph: KnowledgeGraph,
  opts: { now?: string; previous?: LearnerProfile | null } = {},
): LearnerProfile {
  const now = opts.now ?? new Date().toISOString();
  const ordered = [...evidence].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId),
  );
  const states = new Map<string, LearnerKnowledgeState>();
  const exposureSeen = new Map<string, boolean>();
  // entityId -> problemIds with scored POSITIVE evidence (transfer index).
  const positiveProblems = new Map<string, Set<string>>();
  // mistakeKey -> occurrence seeds, in fold order.
  const mistakeSeeds = new Map<string, OccurrenceSeed[]>();
  // Scored positives on implementation/debugging (mistake resolution).
  const laterPositives: LaterPositive[] = [];

  const getState = (entityId: string, at: string): LearnerKnowledgeState => {
    let state = states.get(entityId);
    if (!state) {
      state = emptyKnowledgeState(entityId, at);
      states.set(entityId, state);
    }
    if (at.localeCompare(state.firstObservedAt) < 0) {
      state.firstObservedAt = at;
    }
    if (at.localeCompare(state.lastObservedAt) > 0) {
      state.lastObservedAt = at;
    }
    state.evidenceCount += 1;
    if (at.localeCompare(state.updatedAt) > 0) {
      state.updatedAt = at;
    }
    return state;
  };

  for (const record of ordered) {
    const polarity = EVIDENCE_POLARITY[record.evidenceType];
    const weight = CONFIDENCE_WEIGHT[record.confidence];
    const dimension =
      record.evidenceType === 'RECURRING_MISTAKE'
        ? (record.dimension ?? EVIDENCE_DIMENSION[record.evidenceType])
        : EVIDENCE_DIMENSION[record.evidenceType];

    // Primary application: one per listed entity.
    for (const entityId of record.entityIds) {
      const state = getState(entityId, record.timestamp);
      const seen = exposureSeen.get(entityId) ?? false;
      const app: DimensionApplication = {
        dimension,
        polarity,
        weight,
        evidenceId: record.evidenceId,
        at: record.timestamp,
      };
      exposureSeen.set(entityId, applyToDimension(state, dimension, app, seen));
      const rolled = rollupStatus(state);
      if (rolled.status !== state.status) {
        pushTrajectory(state, {
          at: record.timestamp,
          dimension: 'status',
          from: state.status,
          to: rolled.status,
          evidenceIds: [record.evidenceId],
        });
        state.status = rolled.status;
      }
      state.statusConfidence = rolled.confidence;
    }

    // Transfer: scored evidence on X also scores `transfer` when a
    // DIFFERENT family member already has scored positive evidence from a
    // DIFFERENT problem. Cites the triggering record — no synthetic
    // records are ever created.
    if (polarity !== 0 && record.problemId !== null) {
      for (const entityId of record.entityIds) {
        const family = frameworkFamily(graph, entityId);
        if (family.length <= 1) {
          continue;
        }
        let transferred = false;
        for (const relativeId of family) {
          if (relativeId === entityId || record.entityIds.includes(relativeId)) {
            continue;
          }
          const problems = positiveProblems.get(relativeId);
          if (!problems) {
            continue;
          }
          for (const priorProblem of problems) {
            if (priorProblem !== record.problemId) {
              transferred = true;
              break;
            }
          }
          if (transferred) {
            break;
          }
        }
        if (!transferred) {
          continue;
        }
        const state = states.get(entityId);
        if (!state) {
          continue;
        }
        const seen = exposureSeen.get(entityId) ?? false;
        exposureSeen.set(
          entityId,
          applyToDimension(
            state,
            'transfer',
            { dimension: 'transfer', polarity, weight, evidenceId: record.evidenceId, at: record.timestamp },
            seen,
          ),
        );
        const rolled = rollupStatus(state);
        if (rolled.status !== state.status) {
          pushTrajectory(state, {
            at: record.timestamp,
            dimension: 'status',
            from: state.status,
            to: rolled.status,
            evidenceIds: [record.evidenceId],
          });
          state.status = rolled.status;
        }
        state.statusConfidence = rolled.confidence;
      }
    }

    // Index scored positives for future transfer checks.
    if (polarity === 1 && record.problemId !== null) {
      for (const entityId of record.entityIds) {
        let set = positiveProblems.get(entityId);
        if (!set) {
          set = new Set<string>();
          positiveProblems.set(entityId, set);
        }
        set.add(record.problemId);
      }
      if (dimension === 'implementation' || dimension === 'debugging') {
        laterPositives.push({ at: record.timestamp, entityIds: [...record.entityIds] });
      }
    }

    // Collect mistake occurrences (explicit reports + categorized failures).
    const category: string | undefined = record.mistakeCategory;
    if (
      category !== undefined &&
      (record.evidenceType === 'RECURRING_MISTAKE' ||
        record.evidenceType === 'IMPLEMENTATION_FAILURE' ||
        record.evidenceType === 'DEBUGGING_FAILURE')
    ) {
      const key = mistakeKey(category, record.entityIds);
      let seeds = mistakeSeeds.get(key);
      if (!seeds) {
        seeds = [];
        mistakeSeeds.set(key, seeds);
      }
      seeds.push({
        evidenceId: record.evidenceId,
        attemptId: record.attemptId,
        timestamp: record.timestamp,
        category,
        entityIds: [...record.entityIds].sort(),
      });
    }
  }

  // Finalize per-entity supporting/contradicting lists (newest-first).
  const byId = new Map(ordered.map((e) => [e.evidenceId, e] as const));
  for (const state of states.values()) {
    const supporting: string[] = [];
    const contradicting: string[] = [];
    for (const dimName of ['recognition', 'conceptual', 'implementation', 'debugging', 'transfer', 'independence'] as const) {
      const dim = state[dimName];
      for (const id of dim.positiveEvidenceIds) {
        if (!supporting.includes(id)) {
          supporting.push(id);
        }
      }
      for (const id of dim.negativeEvidenceIds) {
        if (!contradicting.includes(id)) {
          contradicting.push(id);
        }
      }
    }
    const byTime = (a: string, b: string): number => {
      const ea = byId.get(a);
      const eb = byId.get(b);
      const ta = ea ? ea.timestamp : '';
      const tb = eb ? eb.timestamp : '';
      return tb.localeCompare(ta) || a.localeCompare(b);
    };
    supporting.sort(byTime);
    contradicting.sort(byTime);
    state.supportingEvidenceIds = supporting.slice(0, MAX_STATE_EVIDENCE_REFS);
    state.contradictingEvidenceIds = contradicting.slice(0, MAX_STATE_EVIDENCE_REFS);
  }

  // Group mistake patterns with resolution.
  const patterns: LearnerMistakePattern[] = [];
  for (const seeds of mistakeSeeds.values()) {
    const first = seeds[0];
    const occurrences: MistakeOccurrence[] = seeds.map((s) => ({
      evidenceId: s.evidenceId,
      attemptId: s.attemptId,
      timestamp: s.timestamp,
    }));
    const lastAt = seeds[seeds.length - 1].timestamp;
    const related = [...first.entityIds];
    let cleanStreak = 0;
    for (const positive of laterPositives) {
      if (positive.at.localeCompare(lastAt) <= 0) {
        continue;
      }
      if (positive.entityIds.some((id) => related.includes(id))) {
        cleanStreak += 1;
      }
    }
    const resolved = cleanStreak >= RESOLUTION_POSITIVES;
    const evidenceIds = seeds.map((s) => s.evidenceId);
    patterns.push({
      mistakeId: mistakeIdFor(first.category, related),
      category: first.category,
      relatedEntityIds: related,
      occurrences,
      firstObservedAt: seeds[0].timestamp,
      lastObservedAt: lastAt,
      status: resolved ? 'resolved' : seeds.length >= 2 ? 'recurring' : 'single',
      resolvedAt: resolved ? laterPositives.filter((p) => p.at.localeCompare(lastAt) > 0).map((p) => p.at).sort()[RESOLUTION_POSITIVES - 1] ?? lastAt : null,
      confidence: seeds.length >= 3 ? 'high' : seeds.length === 2 ? 'medium' : 'low',
      evidenceIds,
    });
  }
  patterns.sort((a, b) => a.mistakeId.localeCompare(b.mistakeId));

  const profile = emptyLearnerProfile(now, graph);
  if (opts.previous) {
    profile.createdAt = opts.previous.createdAt;
  }
  profile.knowledgeStates = [...states.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
  profile.recurringMistakes = patterns;
  profile.totalEvidenceCount = ordered.length;
  return profile;
}
