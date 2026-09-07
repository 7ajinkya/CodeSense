import { CodeCheckpoint, CheckpointReason } from './checkpoints';
import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const CHECKPOINTS_FILE = 'checkpoints.json';

/** Local-first checkpoint persistence. Snapshots stay on disk, local only. */
export interface CheckpointStore {
  saveCheckpoint(checkpoint: CodeCheckpoint): Promise<void>;
  listCheckpointsForAttempt(attemptId: string): Promise<CodeCheckpoint[]>;
  deleteCheckpoints(checkpointIds: string[]): Promise<void>;
}

const KNOWN_REASONS: CheckpointReason[] = ['start', 'save', 'run', 'test', 'idle'];

function parseCheckpoint(raw: unknown): CodeCheckpoint | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.checkpointId !== 'string' ||
    typeof raw.attemptId !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.timestamp !== 'string' ||
    typeof raw.uri !== 'string' ||
    typeof raw.language !== 'string' ||
    typeof raw.snapshot !== 'string'
  ) {
    return null;
  }
  if (typeof raw.reason !== 'string' || !(KNOWN_REASONS as string[]).includes(raw.reason)) {
    return null;
  }
  const checkpoint: CodeCheckpoint = {
    checkpointId: raw.checkpointId,
    attemptId: raw.attemptId,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    reason: raw.reason as CheckpointReason,
    uri: raw.uri,
    language: raw.language,
    documentVersion: typeof raw.documentVersion === 'number' ? raw.documentVersion : null,
    snapshot: raw.snapshot,
    // Tolerant: records written before the baseline flag existed parse as
    // non-baseline; `attemptBaseline` falls back to reason 'start' for those.
    baseline: raw.baseline === true,
  };
  return checkpoint;
}

export class LocalCheckpointStore implements CheckpointStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): CodeCheckpoint[] {
    const raw = loadJsonArray<unknown>(CHECKPOINTS_FILE, this.workspacePath);
    const out: CodeCheckpoint[] = [];
    for (const item of raw) {
      const parsed = parseCheckpoint(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async saveCheckpoint(checkpoint: CodeCheckpoint): Promise<void> {
    const rest = this.loadAll().filter((c) => c.checkpointId !== checkpoint.checkpointId);
    rest.push(checkpoint);
    saveJsonArray(CHECKPOINTS_FILE, rest, this.workspacePath);
  }

  async listCheckpointsForAttempt(attemptId: string): Promise<CodeCheckpoint[]> {
    return this.loadAll()
      .filter((c) => c.attemptId === attemptId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async deleteCheckpoints(checkpointIds: string[]): Promise<void> {
    const ids = new Set(checkpointIds);
    saveJsonArray(
      CHECKPOINTS_FILE,
      this.loadAll().filter((c) => !ids.has(c.checkpointId)),
      this.workspacePath,
    );
  }
}
