import { randomUUID } from 'crypto';

/**
 * Phase 1 checkpoints — hybrid model (§23):
 *   continuous edits  -> diffs (see `codeHistory.ts`)
 *   important moments -> full snapshots (this module)
 *
 * Full checkpoints are created at: tracking/start, save, run, test
 * execution/result, and ~10 minutes of inactivity. Diffs give detailed
 * evolution; checkpoints are reliable anchors so no AI ever has to
 * reconstruct source from arbitrary diffs.
 */

export type CheckpointReason = 'start' | 'save' | 'run' | 'test' | 'idle';

export const IDLE_CHECKPOINT_REASON: CheckpointReason = 'idle';

/** At most this many idle checkpoints are retained per attempt (§25). */
export const MAX_IDLE_CHECKPOINTS = 10;

export function generateCheckpointId(): string {
  return 'chk_' + randomUUID();
}

export interface CodeCheckpoint {
  checkpointId: string;
  attemptId: string;
  sessionId: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  reason: CheckpointReason;
  uri: string;
  language: string;
  documentVersion: number | null;
  /** Exact full source text at checkpoint time. */
  snapshot: string;
  /**
   * True when this checkpoint is the OBSERVED STARTING STATE of its attempt
   * (e.g. reason 'start'), not learner-authored evidence. A reused file may
   * still hold a previous attempt's code here — consumers must never
   * attribute baseline content to learner activity during the attempt.
   */
  baseline: boolean;
}

export function createCheckpoint(opts: {
  checkpointId?: string;
  attemptId: string;
  sessionId: string;
  timestamp?: string;
  reason: CheckpointReason;
  uri: string;
  language: string;
  documentVersion?: number | null;
  snapshot: string;
  baseline?: boolean;
}): CodeCheckpoint {
  return {
    checkpointId: opts.checkpointId ?? generateCheckpointId(),
    attemptId: opts.attemptId,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    reason: opts.reason,
    uri: opts.uri,
    language: opts.language,
    documentVersion: opts.documentVersion ?? null,
    snapshot: opts.snapshot,
    baseline: opts.baseline ?? false,
  };
}

/**
 * Retention for one attempt's checkpoints: keep ALL non-idle checkpoints
 * (save/run/test/start are never deleted for the idle cap) and the newest
 * `maxIdle` idle checkpoints. Returns `{ kept, removed }` — oldest idle
 * checkpoints are evicted first.
 */
export function enforceIdleCheckpointCap(
  checkpoints: CodeCheckpoint[],
  maxIdle: number = MAX_IDLE_CHECKPOINTS,
): { kept: CodeCheckpoint[]; removed: CodeCheckpoint[] } {
  const idle = checkpoints
    .filter((c) => c.reason === IDLE_CHECKPOINT_REASON)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const important = checkpoints.filter((c) => c.reason !== IDLE_CHECKPOINT_REASON);
  if (idle.length <= maxIdle) {
    return { kept: [...checkpoints], removed: [] };
  }
  const evicted = idle.slice(0, idle.length - maxIdle);
  const evictedIds = new Set(evicted.map((c) => c.checkpointId));
  return {
    kept: checkpoints.filter((c) => !evictedIds.has(c.checkpointId)),
    removed: evicted,
  };
}

/** Newest checkpoint for a document URI (any reason), or null. */
export function latestCheckpointForUri(
  checkpoints: CodeCheckpoint[],
  uri: string,
): CodeCheckpoint | null {
  const matches = checkpoints.filter((c) => c.uri === uri);
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

/** Newest checkpoint of an attempt overall, or null. */
export function latestCheckpoint(checkpoints: CodeCheckpoint[]): CodeCheckpoint | null {
  if (checkpoints.length === 0) {
    return null;
  }
  return [...checkpoints].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

function byTimestampAsc(a: CodeCheckpoint, b: CodeCheckpoint): number {
  return a.timestamp.localeCompare(b.timestamp);
}

/**
 * The observed starting state of an attempt: the earliest checkpoint
 * explicitly flagged as baseline, falling back to the earliest 'start'
 * checkpoint for records written before the flag existed. Null when the
 * attempt has no baseline (e.g. no tracked document was open at start).
 * The baseline snapshot is the replay anchor for the attempt's edits —
 * it is provenance, not learner-authored evidence.
 */
export function attemptBaseline(
  checkpoints: CodeCheckpoint[],
  attemptId: string,
): CodeCheckpoint | null {
  const mine = checkpoints.filter((c) => c.attemptId === attemptId);
  const flagged = mine.filter((c) => c.baseline).sort(byTimestampAsc);
  if (flagged.length > 0) {
    return flagged[0];
  }
  const starts = mine.filter((c) => c.reason === 'start').sort(byTimestampAsc);
  return starts[0] ?? null;
}

export function countIdleCheckpoints(checkpoints: CodeCheckpoint[]): number {
  return checkpoints.filter((c) => c.reason === IDLE_CHECKPOINT_REASON).length;
}
