/**
 * Phase 1 code-evolution tracking.
 *
 * Continuous edits are stored as EXACT change events (range + inserted text),
 * not per-keystroke snapshots. The history is deterministic enough to
 * reconstruct any checkpointed source exactly (§22, §35).
 *
 * A single VS Code `onDidChangeTextDocument` event may carry MULTIPLE content
 * changes; all of them are preserved in order.
 */

import { CodeCheckpoint, attemptBaseline } from './checkpoints';

export interface TextRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface CodeChange {
  /** Range in the pre-change document. */
  range: TextRange;
  /** Length of the replaced (deleted) text. */
  rangeLength: number;
  /** The exact inserted text (may be '' for pure deletions). */
  insertedText: string;
}

export interface CodeEditRecord {
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  sessionId: string;
  attemptId: string | null;
  uri: string;
  language: string;
  documentVersion: number;
  versionBefore: number;
  versionAfter: number;
  changes: CodeChange[];
}

export function createCodeEditRecord(opts: {
  timestamp?: string;
  sessionId: string;
  attemptId: string | null;
  uri: string;
  language: string;
  documentVersion: number;
  versionBefore: number;
  versionAfter: number;
  changes: CodeChange[];
}): CodeEditRecord {
  return {
    timestamp: opts.timestamp ?? new Date().toISOString(),
    sessionId: opts.sessionId,
    attemptId: opts.attemptId,
    uri: opts.uri,
    language: opts.language,
    documentVersion: opts.documentVersion,
    versionBefore: opts.versionBefore,
    versionAfter: opts.versionAfter,
    changes: opts.changes.map((c) => ({ ...c, range: { ...c.range } })),
  };
}

// ---------------------------------------------------------------------------
// Deterministic reconstruction
// ---------------------------------------------------------------------------

/**
 * Convert a (line, character) position to a string offset. Lines beyond the
 * text clamp to the end; characters beyond the line clamp to the line end.
 * Pure UTF-16 code-unit arithmetic (matches VS Code positions).
 */
export function positionToOffset(text: string, line: number, character: number): number {
  const lines = text.split('\n');
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < clampedLine; i++) {
    offset += lines[i].length + 1; // +1 for '\n'
  }
  const lineText = lines[clampedLine] ?? '';
  return offset + Math.max(0, Math.min(character, lineText.length));
}

/**
 * Apply the changes of ONE document-change event to `baseText`.
 *
 * All changes in a single `onDidChangeTextDocument` event belong to ONE
 * document version transition: their ranges/`rangeOffset`s refer to the
 * pre-change document and are non-overlapping. Changes are therefore applied
 * in descending start-offset order against the original text (e.g. two
 * multi-cursor insertions at 0 and 2 in "ab" yield "XabY", not "XaYb").
 */
export function applyChangeEvent(baseText: string, changes: CodeChange[]): string {
  const withOffsets = changes.map((c) => ({
    start: positionToOffset(baseText, c.range.startLine, c.range.startCharacter),
    end: positionToOffset(baseText, c.range.endLine, c.range.endCharacter),
    insertedText: c.insertedText,
  }));
  withOffsets.sort((a, b) => b.start - a.start);
  let text = baseText;
  for (const change of withOffsets) {
    text = text.slice(0, change.start) + change.insertedText + text.slice(change.end);
  }
  return text;
}

/** Replay an ordered sequence of edit records to reconstruct source.
 * Assumes a continuous chain (see `findContinuityGap`); use
 * `tryReconstructSource` when continuity is not established. */
export function reconstructSource(baseText: string, edits: CodeEditRecord[]): string {
  let text = baseText;
  for (const edit of edits) {
    text = applyChangeEvent(text, edit.changes);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Continuity: detecting observation gaps before trusting reconstruction
// ---------------------------------------------------------------------------

/**
 * Index of the first edit that breaks the version chain, or null when the
 * chain is continuous. Consecutive edits must satisfy
 * `edits[i].versionBefore === edits[i-1].versionAfter`; the base text is
 * assumed to correspond to the first edit's `versionBefore` (it carries no
 * version of its own). Gaps arise from unobserved edits (background
 * documents, untracked periods) — replaying across them would silently
 * produce wrong source, so callers must check first.
 */
export function findContinuityGap(edits: CodeEditRecord[]): number | null {
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].versionBefore !== edits[i - 1].versionAfter) {
      return i;
    }
  }
  return null;
}

export interface ReconstructionResult {
  ok: boolean;
  /** Exact source when `ok`; null on gap (never guessed). */
  text: string | null;
  /** Index of the first discontinuous edit; null when continuous. */
  gapIndex: number | null;
}

/**
 * Reconstruct source only when the edit chain is continuous. Returns an
 * explicit gap failure instead of silently wrong text.
 */
export function tryReconstructSource(baseText: string, edits: CodeEditRecord[]): ReconstructionResult {
  const gapIndex = findContinuityGap(edits);
  if (gapIndex !== null) {
    return { ok: false, text: null, gapIndex };
  }
  return { ok: true, text: reconstructSource(baseText, edits), gapIndex: null };
}

// ---------------------------------------------------------------------------
// Attempt-scoped history: baseline vs learner-authored edits
// ---------------------------------------------------------------------------

/**
 * Exactly the learner-authored edits of one attempt: records linked to its
 * attemptId, in chronological order. Pre-attempt edits (other/null
 * attemptId, e.g. a previous attempt's code in a reused file) are excluded,
 * so this history can never attribute earlier code to the attempt's learner.
 * Callers replaying for one document should additionally filter by URI.
 */
export function selectAttemptEdits(records: CodeEditRecord[], attemptId: string): CodeEditRecord[] {
  return records.filter((r) => r.attemptId === attemptId);
}

export interface AnchoredAttemptHistory {
  /** Observed starting state (provenance, not evidence); null if none. */
  baseline: CodeCheckpoint | null;
  /** Learner-authored edits of the attempt, chronological. */
  edits: CodeEditRecord[];
}

/**
 * The complete deterministic recipe for one attempt's code history:
 * baseline snapshot + that attempt's edits. Replay via
 * `tryReconstructSource(history.baseline.snapshot, history.edits)` and
 * compare against a later checkpoint to verify exactness.
 */
export function anchoredAttemptHistory(
  checkpoints: CodeCheckpoint[],
  records: CodeEditRecord[],
  attemptId: string,
): AnchoredAttemptHistory {
  return {
    baseline: attemptBaseline(checkpoints, attemptId),
    edits: selectAttemptEdits(records, attemptId),
  };
}

// ---------------------------------------------------------------------------
// Bridge: persisted session events -> edit records (single source of truth)
// ---------------------------------------------------------------------------

interface RawRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

function isRawRange(value: unknown): value is RawRange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.startLine === 'number' &&
    typeof r.startCharacter === 'number' &&
    typeof r.endLine === 'number' &&
    typeof r.endCharacter === 'number'
  );
}

/**
 * Derive edit records from persisted `document.changed` events. Only changes
 * carrying `insertedText` (Phase 1 recording) become records — Phase 0
 * length-only history is skipped (documented degradation, never fabricated).
 */
export function editRecordsFromEvents(
  events: import('../events/activityEvent').ActivityEvent[],
): CodeEditRecord[] {
  const out: CodeEditRecord[] = [];
  for (const event of events) {
    if (event.eventType !== 'document.changed') {
      continue;
    }
    const payload: unknown = event.payload;
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.uri !== 'string' || typeof p.languageId !== 'string') {
      continue;
    }
    const rawChanges: unknown = p.changes;
    if (!Array.isArray(rawChanges)) {
      continue;
    }
    const changes: CodeChange[] = [];
    for (const raw of rawChanges) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const c = raw as Record<string, unknown>;
      // Pre-Phase-1 events have no inserted text: skip, don't fabricate.
      if (typeof c.insertedText !== 'string') {
        continue;
      }
      if (!isRawRange(c.range)) {
        continue;
      }
      // Persisted payloads store the deleted length as `deletedLength`
      // (Phase 0 naming); accept `rangeLength` as a fallback alias.
      const deletedRaw: unknown = c.deletedLength ?? c.rangeLength;
      if (typeof deletedRaw !== 'number') {
        continue;
      }
      changes.push({
        range: {
          startLine: c.range.startLine,
          startCharacter: c.range.startCharacter,
          endLine: c.range.endLine,
          endCharacter: c.range.endCharacter,
        },
        rangeLength: deletedRaw,
        insertedText: c.insertedText,
      });
    }
    if (changes.length === 0) {
      continue;
    }
    const versionAfter = typeof p.versionAfter === 'number' ? p.versionAfter : 0;
    const versionBefore = typeof p.versionBefore === 'number' ? p.versionBefore : versionAfter;
    const version =
      typeof p.documentVersion === 'number' ? p.documentVersion : versionAfter;
    const attemptRaw: unknown = event.attemptId;
    out.push(
      createCodeEditRecord({
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        attemptId: typeof attemptRaw === 'string' ? attemptRaw : null,
        uri: p.uri,
        language: p.languageId,
        documentVersion: version,
        versionBefore,
        versionAfter,
        changes,
      }),
    );
  }
  return out;
}
