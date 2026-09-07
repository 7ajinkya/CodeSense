/**
 * Core event envelope for all CodeSense raw activity events.
 *
 * Phase 0 implements only RAW ACTIVITY. Events record observable facts;
 * interpretation (evidence, learner state, pedagogy) belongs to future layers.
 *
 * "SOFTWARE WATCHES ACTIVITY. AI WATCHES MEANINGFUL MOMENTS."
 */

export const SCHEMA_VERSION = 1;

/** Where an event originated inside VS Code. */
export type EventSource =
  | 'document'
  | 'editor'
  | 'terminal'
  | 'diagnostics'
  | 'testing'
  | 'session';

export type EventType =
  // Session lifecycle
  | 'session.started'
  | 'session.ended'
  // Document activity
  | 'document.opened'
  | 'document.changed'
  | 'document.saved'
  | 'document.closed'
  // Active editor / workspace
  | 'editor.activeChanged'
  // Terminal activity
  | 'terminal.commandStarted'
  | 'terminal.commandCompleted'
  // Diagnostics
  | 'diagnostics.changed'
  // Testing
  | 'test.started'
  | 'test.ended'
  // Run/debug (deferred capture; see docs — API limitations)
  | 'run.started'
  | 'run.completed'
  // Phase 1: problem / attempt lifecycle (telemetry linkage, not AI)
  | 'problem.started'
  | 'problem.ended'
  | 'attempt.started'
  | 'attempt.stateChanged'
  | 'attempt.completed'
  | 'attempt.triggerEligible'
  | 'checkpoint.created'
  // AI Layer V1: evaluation/check-in facts (metadata only, never CoT or
  // duplicated message text — the full evaluation lives in evaluations.json)
  | 'ai.evaluated';

/** Generic, versioned event envelope with an event-specific payload. */
export interface ActivityEvent<P = unknown> {
  eventId: string;
  sessionId: string;
  /**
   * Phase 1: links activity to the active attempt (Activity -> Attempt ->
   * Problem). Null/absent for session-level events and all Phase 0 history.
   */
  attemptId?: string | null;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  eventType: EventType;
  source: EventSource;
  schemaVersion: number;
  payload: P;
}

// ---------------------------------------------------------------------------
// Event-specific payloads (no giant nullable catch-all structure)
// ---------------------------------------------------------------------------

export interface DocumentRefPayload {
  /** File system path, when the document is on disk. */
  filePath?: string;
  /** URI string of the document. */
  uri: string;
  languageId: string;
  documentVersion?: number;
}

export interface DocumentOpenedPayload extends DocumentRefPayload {}

export interface DocumentSavedPayload extends DocumentRefPayload {}

export interface DocumentClosedPayload extends DocumentRefPayload {}

/** One content change within a document-changed event. */
export interface ContentChangePayload {
  /** Line/character range of the change in the pre-change document. */
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  /** Length of the replaced (deleted) text — not the text itself. */
  deletedLength: number;
  /** Length of the inserted text — not the text itself. */
  insertedLength: number;
  /** Number of lines in the inserted text, when meaningful. */
  insertedLineCount?: number;
  /**
   * Phase 1: the exact inserted text ('' for pure deletions). Present on
   * events recorded while a problem attempt is active so code evolution can
   * be reconstructed deterministically. Absent on Phase 0 history.
   */
  insertedText?: string;
}

export interface DocumentChangedPayload extends DocumentRefPayload {
  /** Document version before the changes. */
  versionBefore: number;
  /** Document version after the changes. */
  versionAfter: number;
  changes: ContentChangePayload[];
}

export interface ActiveEditorChangedPayload {
  uri?: string;
  filePath?: string;
  languageId?: string;
  workspacePath?: string;
}

export interface SessionStartedPayload {
  workspacePath?: string;
}

export interface SessionEndedPayload {
  reason: 'user' | 'window-unload';
  eventCount: number;
  durationMs: number;
}

export interface TerminalCommandStartedPayload {
  terminalName: string;
  commandLine: string;
  cwd?: string;
}

export interface TerminalCommandCompletedPayload {
  terminalName: string;
  commandLine: string;
  exitCode: number | null;
  /** Brief output metadata (e.g. first/last lines), not full output. */
  outputPreview?: string;
  durationMs?: number;
}

export interface DiagnosticItemPayload {
  severity: 'error' | 'warning' | 'information' | 'hint';
  code?: string;
  source?: string;
  message: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface DiagnosticsChangedPayload {
  uri: string;
  filePath?: string;
  languageId?: string;
  /** Full current diagnostic list for the document (observable state). */
  diagnostics: DiagnosticItemPayload[];
}

export interface TestStartedPayload {
  testId: string;
  testLabel: string;
  suite?: string;
}

export interface TestEndedPayload {
  testId: string;
  testLabel: string;
  suite?: string;
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  durationMs?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Phase 1 payloads: problem / attempt / checkpoint / trigger linkage
// ---------------------------------------------------------------------------

export interface ProblemStartedPayload {
  problemId: string;
  provider: string;
  canonicalUrl: string;
  source: string;
  title?: string;
}

export interface ProblemEndedPayload {
  problemId: string;
  attemptId: string;
  finalState: string;
}

export interface AttemptStartedPayload {
  attemptId: string;
  problemId: string;
  language?: string;
}

export interface AttemptStateChangedPayload {
  attemptId: string;
  fromState: string;
  toState: string;
  source: 'learner' | 'system';
  note?: string;
}

export interface AttemptCompletedPayload {
  attemptId: string;
  problemId: string;
  finalState: string;
  durationMs: number;
}

export interface AttemptTriggerEligiblePayload {
  attemptId: string;
  kind: 'idle' | 'hard45';
  reason: string;
}

export interface CheckpointCreatedPayload {
  checkpointId: string;
  attemptId: string;
  reason: 'start' | 'save' | 'run' | 'test' | 'idle';
  uri: string;
  snapshotChars: number;
}

export interface AiEvaluatedPayload {
  evaluationId: string;
  attemptId: string;
  triggerKind: 'idle' | 'hard45' | 'manual';
  shouldIntervene: boolean;
  interventionType: string;
}

export interface RunStartedPayload {
  kind: 'task' | 'terminal';
  label: string;
}

export interface RunCompletedPayload {
  kind: 'task' | 'terminal';
  label: string;
  exitCode: number | null;
  durationMs?: number;
}
