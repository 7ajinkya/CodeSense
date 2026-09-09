import { createAsyncQueue } from '../util/asyncQueue';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { ProblemClassification } from '../knowledge/classification';
import type { Attempt } from '../attempts/attempt';
import type { Problem } from '../problems/problem';
import type { EvidenceStore } from '../learner/learnerEvidenceStore';
import type { LearnerModelStore } from '../learner/learnerModelStore';
import { syncRecordsToLearnerModel } from '../learner/learnerFeeds';
import {
  LearnerReflection,
  ReflectionCategory,
  ReflectionInterpretation,
  createReflectionOffer,
  dismissReflection,
  isKnownReflectionCategory,
  markReflectionEmitted,
  respondToReflection,
} from './reflectionTypes';
import { extractReflectionEvidence } from './reflectionEvidence';
import type { ReflectionStore } from './reflectionStore';

/**
 * Phase G reflection chain (host orchestration, extracted for testability —
 * no vscode dependency).
 *
 * Mirrors the F1 `goalChain.ts` hardening:
 * - Single-flight through an internal queue so overlapping endProblem /
 *   response paths cannot interleave into duplicate rows or evidence.
 * - The queue holds no data; every task re-reads the stores.
 * - Pure orchestration over injected stores: never throws (fail-open),
 *   never surfaces UI, never triggers F1/F2/F3 — new evidence becomes
 *   available naturally to future D/F processing.
 */

export type ReflectionOfferResult =
  | { action: 'offered'; reflection: LearnerReflection }
  | { action: 'already-exists'; reflection: LearnerReflection }
  | { action: 'none'; reason: 'not-finalized' | 'error' };

export interface ReflectionOfferPorts {
  reflectionStore: ReflectionStore;
  nowIso(): string;
}

export interface ReflectionOfferInput {
  attempt: Attempt;
  problem: Problem;
  classificationStatus: 'classified' | 'partial' | 'unclassified';
  goalId?: string | null;
  planId?: string | null;
  progressSignal?: string | null;
}

export type ReflectionSubmitResult =
  | { action: 'emitted'; reflection: LearnerReflection; stored: number }
  | { action: 'validated-no-evidence'; reflection: LearnerReflection }
  | { action: 'already-emitted'; reflection: LearnerReflection }
  | { action: 'dismissed'; reflection: LearnerReflection }
  | { action: 'none'; reason: 'invalid-input' | 'error' };

export interface ReflectionSubmitPorts {
  reflectionStore: ReflectionStore;
  evidenceStore: EvidenceStore;
  modelStore: LearnerModelStore;
  graph: KnowledgeGraph;
  nowIso(): string;
}

export interface ReflectionSubmitInput {
  attempt: Attempt;
  problem: Problem;
  classification: ProblemClassification | null | undefined;
  category: ReflectionCategory;
  freeText?: string | null;
  /** Learner-confirmed refinement (G6); null on the deterministic path. */
  interpretation?: ReflectionInterpretation | null;
}

const reflectionQueue = createAsyncQueue();

/** Serialized entry point: concurrent callers queue behind each other. */
export function offerReflectionForAttemptEnd(
  ports: ReflectionOfferPorts,
  input: ReflectionOfferInput,
): Promise<ReflectionOfferResult> {
  return reflectionQueue.enqueue(() => runOfferReflection(ports, input));
}

async function runOfferReflection(
  ports: ReflectionOfferPorts,
  input: ReflectionOfferInput,
): Promise<ReflectionOfferResult> {
  try {
    // Only finalized attempts get a reflection opportunity. Provenance is
    // captured from the finalized attempt object itself — never from live
    // globals — so consecutive attempts can never cross-attribute.
    if (!input.attempt.completedAt) {
      return { action: 'none', reason: 'not-finalized' };
    }
    const existing = await ports.reflectionStore
      .getReflectionForAttempt(input.attempt.attemptId)
      .catch(() => null);
    if (existing) {
      return { action: 'already-exists', reflection: existing };
    }
    const now = ports.nowIso();
    const offer = createReflectionOffer({
      attemptId: input.attempt.attemptId,
      problemId: input.problem.problemId,
      sessionId: input.attempt.sessionId,
      problemTitle: input.problem.title,
      classificationStatus: input.classificationStatus,
      goalId: input.goalId ?? null,
      planId: input.planId ?? null,
      progressSignal: input.progressSignal ?? null,
      now,
    });
    await ports.reflectionStore.upsertReflection(offer);
    return { action: 'offered', reflection: offer };
  } catch {
    return { action: 'none', reason: 'error' };
  }
}

/** Serialized entry point for learner responses (also queued). */
export function submitReflectionResponse(
  ports: ReflectionSubmitPorts,
  input: ReflectionSubmitInput,
): Promise<ReflectionSubmitResult> {
  return reflectionQueue.enqueue(() => runSubmitReflection(ports, input));
}

async function runSubmitReflection(
  ports: ReflectionSubmitPorts,
  input: ReflectionSubmitInput,
): Promise<ReflectionSubmitResult> {
  try {
    if (!isKnownReflectionCategory(input.category)) {
      return { action: 'none', reason: 'invalid-input' };
    }
    if (!input.attempt.completedAt) {
      return { action: 'none', reason: 'invalid-input' };
    }
    const now = ports.nowIso();
    let reflection = await ports.reflectionStore
      .getReflectionForAttempt(input.attempt.attemptId)
      .catch(() => null);
    // Robustness: a response without a prior offer (e.g. crash between
    // finalize and offer) creates the offer inline from the same finalized
    // attempt object, preserving exact provenance.
    if (!reflection) {
      const offer = createReflectionOffer({
        attemptId: input.attempt.attemptId,
        problemId: input.problem.problemId,
        sessionId: input.attempt.sessionId,
        problemTitle: input.problem.title,
        classificationStatus: input.classification ? 'classified' : 'unclassified',
        now,
      });
      await ports.reflectionStore.upsertReflection(offer);
      reflection = offer;
    }
    if (reflection.status === 'dismissed') {
      return { action: 'dismissed', reflection };
    }
    if (reflection.status === 'evidence-emitted') {
      return { action: 'already-emitted', reflection };
    }
    // Guard against provenance drift: the stored row must belong to this
    // exact attempt+problem. A stale callback carrying another attempt's
    // ids can never write here because the lookup key IS the attempt id,
    // but belt-and-braces beats a cross-attribution incident.
    if (
      reflection.provenance.attemptId !== input.attempt.attemptId ||
      reflection.provenance.problemId !== input.problem.problemId
    ) {
      return { action: 'none', reason: 'invalid-input' };
    }
    let responded = reflection;
    if (responded.status === 'offered') {
      try {
        responded = respondToReflection(responded, {
          category: input.category,
          freeText: input.freeText ?? null,
          now,
        });
      } catch {
        return { action: 'none', reason: 'invalid-input' };
      }
      await ports.reflectionStore.upsertReflection(responded);
    } else if (
      responded.category !== null &&
      responded.category !== input.category &&
      responded.status === 'responded'
    ) {
      // Crash-recovery path: a previous response was persisted but emission
      // never completed. Keep the FIRST explicit response (learner's
      // original words win over a retried callback).
    }
    const effectiveCategory = responded.category ?? input.category;
    const records = extractReflectionEvidence(ports.graph, {
      reflectionId: responded.reflectionId,
      category: effectiveCategory,
      freeText: responded.freeText ?? input.freeText ?? null,
      interpretation: input.interpretation ?? responded.interpretation ?? null,
      attempt: input.attempt,
      problem: input.problem,
      classification: input.classification,
      sessionId: input.attempt.sessionId,
      timestamp: now,
    });
    if (records.length > 0) {
      const outcome = await syncRecordsToLearnerModel(
        {
          evidenceStore: ports.evidenceStore,
          modelStore: ports.modelStore,
          graph: ports.graph,
          nowIso: ports.nowIso,
        },
        records,
      ).catch(() => null);
      if (!outcome) {
        return { action: 'none', reason: 'error' };
      }
    }
    // The validated interpretation stored on the row is the confirmed one
    // (if any) — never an unconfirmed AI proposal. On the deterministic
    // path this stays null; the category + evidence ids carry the meaning.
    const storedInterpretation =
      input.interpretation && input.interpretation.learnerConfirmed
        ? input.interpretation
        : responded.interpretation;
    const emitted = markReflectionEmitted(responded, {
      evidenceIds: records.map((r) => r.evidenceId),
      interpretation: storedInterpretation,
      now: ports.nowIso(),
    });
    await ports.reflectionStore.upsertReflection(emitted);
    if (records.length === 0) {
      return { action: 'validated-no-evidence', reflection: emitted };
    }
    return { action: 'emitted', reflection: emitted, stored: records.length };
  } catch {
    return { action: 'none', reason: 'error' };
  }
}

export type ReflectionDismissResult =
  | { action: 'dismissed'; reflection: LearnerReflection }
  | { action: 'already-settled'; reflection: LearnerReflection }
  | { action: 'none'; reason: 'no-offer' | 'error' };

/** Serialized dismissal (also queued, same single-flight). */
export function dismissReflectionOffer(
  ports: ReflectionOfferPorts,
  attemptId: string,
): Promise<ReflectionDismissResult> {
  return reflectionQueue.enqueue(() => runDismissReflection(ports, attemptId));
}

async function runDismissReflection(
  ports: ReflectionOfferPorts,
  attemptId: string,
): Promise<ReflectionDismissResult> {
  try {
    const existing = await ports.reflectionStore
      .getReflectionForAttempt(attemptId)
      .catch(() => null);
    if (!existing) {
      return { action: 'none', reason: 'no-offer' };
    }
    if (existing.status !== 'offered') {
      return { action: 'already-settled', reflection: existing };
    }
    const dismissed = dismissReflection(existing, ports.nowIso());
    await ports.reflectionStore.upsertReflection(dismissed);
    return { action: 'dismissed', reflection: dismissed };
  } catch {
    return { action: 'none', reason: 'error' };
  }
}
