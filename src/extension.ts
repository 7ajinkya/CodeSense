import * as vscode from 'vscode';
import {
  ActivityEvent,
  DiagnosticItemPayload,
  EventSource,
  EventType,
} from './events/activityEvent';
import { createEvent } from './events/eventFactory';
import {
  CodingSession,
  appendEvent,
  createCodingSession,
  finalizeSession,
} from './session/codingSession';
import { LocalSessionStore, getStoragePath } from './persistence/localStore';
import { generateSessionId, generateWorkspaceId } from './util/ids';
import { ActiveDocumentTracker, shouldObserveDocument } from './capture/trackingPolicy';
import { buildContentChanges } from './capture/documentChanges';
// Phase 1 imports (problem/attempt/trigger/history/context/UI).
import {
  Problem,
  isUsableProblem,
  isValidProblemUrl,
  problemLabel,
} from './problems/problem';
import { LocalProblemStore } from './problems/problemStore';
import { PythonScraperClient } from './problems/scraperClient';
import { ProblemResolver } from './problems/resolver';
import {
  ATTEMPT_STATES,
  Attempt,
  AttemptState,
  canEndAttempt,
  completeAttempt,
  createAttempt,
  interruptAttempt,
  isKnownAttemptState,
  transitionAttemptState,
} from './attempts/attempt';
import { LocalAttemptStore } from './attempts/attemptStore';
import {
  AttemptTriggerState,
  createTriggerState,
  pollTriggers,
  recordTriggerActivity,
} from './triggers/triggerEngine';
import {
  CheckpointReason,
  CodeCheckpoint,
  createCheckpoint,
  enforceIdleCheckpointCap,
} from './history/checkpoints';
import { LocalCheckpointStore } from './history/checkpointStore';
import { CodeSenseStatusBar } from './ui/statusBar';
import {
  CodeSenseSidebarProvider,
  buildSidebarSnapshot,
} from './ui/sidebarView';
import {
  StartInput,
  showProblemSetupPanel,
} from './ui/problemSetupPanel';
// AI Layer V1 imports (reasoning only — telemetry/lifecycle untouched).
import { EvaluationTriggerKind, generateConversationMessageId } from './ai/aiTypes';
import { HttpChatReasoner } from './ai/reasoners';
import { LocalAiStore } from './ai/aiStore';
import { loadWorkspaceEnvFile, readAiConfig } from './ai/aiConfig';
import { EvaluationOutcome, runAiEvaluation } from './ai/evaluationRunner';
import { buildAIContext } from './context/aiContext';
import { editRecordsFromEvents, selectAttemptEdits } from './history/codeHistory';

/**
 * Phase 0 activity capture: observe document / editor / diagnostics /
 * terminal-shell activity inside VS Code and persist it locally as a
 * chronological CodingSession timeline.
 *
 * Observation policy (see `capture/trackingPolicy.ts`): while a session is
 * active, document-level activity is captured only for the currently active
 * editor and only when its VS Code `languageId` is python or java.
 * Switching to any other document pauses document observation; the session
 * itself stays active and observation resumes on switching back. No
 * workspace scanning is performed.
 *
 * API notes (verified against the installed @types/vscode):
 * - Document, editor, diagnostics, terminal shell-execution and task
 *   execution events use real, supported VS Code APIs.
 * - The VS Code Testing API (`vscode.tests`) only exposes
 *   `createTestController` — there is NO supported event for observing test
 *   execution from this extension, so test capture is deferred (see
 *   LIMITATIONS below) rather than fabricated.
 * - Terminal shell-integration events are guarded at runtime so the
 *   extension degrades gracefully on hosts without shell integration.
 *
 * Phase 1 additions (problem-solving environment):
 * - Start Problem creates a Problem from the learner-pasted URL + statement
 *   (manual input is the normal path; automatic scraping is dormant),
 *   persists it, and creates an Attempt. Activity links to the active
 *   attempt (Activity -> Attempt -> Problem); files are never bound to
 *   problems, so the same file can serve many attempts.
 * - document.changed carries exact inserted text — but ONLY while a problem
 *   attempt is active (privacy boundary); without an attempt the structural
 *   event is still recorded, without exact text. Local-only either way.
 * - Full checkpoints anchor history at start/save/run/idle (idle capped
 *   at 10 per attempt); diffs carry the detail in between.
 * - A trigger engine watches 10-minute idle and the strict 45-minute hard
 *   boundary per attempt (consumed, no cooldown, reset on End Problem).
 * - AI Layer V1: trigger eligibility additionally requests one scoped LLM
 *   evaluation per trigger instance (evaluation ≠ intervention; the model
 *   may legitimately decide no action is needed). Unconfigured or failing
 *   AI never affects telemetry, lifecycle, or the sidebar.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSession: CodingSession | null = null;
let store: LocalSessionStore | null = null;
// Which document (if any) is currently under document-level observation.
// The session outlives tracking: unsupported editors only pause observation.
const documentTracker = new ActiveDocumentTracker();

// Phase 1 state: at most ONE active attempt (active-intervention context).
let problemStore: LocalProblemStore | null = null;
let attemptStore: LocalAttemptStore | null = null;
let checkpointStore: LocalCheckpointStore | null = null;
let activeProblem: Problem | null = null;
let activeAttempt: Attempt | null = null;
let activeTrigger: AttemptTriggerState | null = null;
let statusBar: CodeSenseStatusBar | null = null;
let historyChannel: vscode.OutputChannel | null = null;
let triggerTimer: ReturnType<typeof setInterval> | null = null;
// Task start timestamps (task name -> epoch ms) for run durations, plus
// completion markers so `run.completed` is recorded exactly once per task
// regardless of event order (process end normally precedes task end).
const taskStartTimes = new Map<string, number>();
const taskCompletionSeen = new Set<string>();

// AI Layer V1 state: evaluations in flight (per attempt, stale-guarded),
// one-time unconfigured notice, and the sidebar AI panel model.
let aiStore: LocalAiStore | null = null;
const evaluationInFlight = new Set<string>();
let aiUnavailableNoticed = false;
interface AiPanelState {
  status: 'idle' | 'evaluating' | 'unavailable' | 'error';
  lastMessage: string | null;
  lastAttemptId: string | null;
}
let aiPanel: AiPanelState = { status: 'idle', lastMessage: null, lastAttemptId: null };

const TRIGGER_POLL_MS = 30 * 1000;

function workspaceFsPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function activeStore(): LocalSessionStore {
  if (!store) {
    store = new LocalSessionStore(workspaceFsPath());
  }
  return store;
}

function activeProblemStore(): LocalProblemStore {
  if (!problemStore) {
    problemStore = new LocalProblemStore(workspaceFsPath());
  }
  return problemStore;
}

function activeAttemptStore(): LocalAttemptStore {
  if (!attemptStore) {
    attemptStore = new LocalAttemptStore(workspaceFsPath());
  }
  return attemptStore;
}

function activeCheckpointStore(): LocalCheckpointStore {
  if (!checkpointStore) {
    checkpointStore = new LocalCheckpointStore(workspaceFsPath());
  }
  return checkpointStore;
}

function activeAiStore(): LocalAiStore {
  if (!aiStore) {
    aiStore = new LocalAiStore(workspaceFsPath());
  }
  return aiStore;
}

function rebindStores(): void {
  const wsPath = workspaceFsPath();
  store = new LocalSessionStore(wsPath);
  problemStore = new LocalProblemStore(wsPath);
  attemptStore = new LocalAttemptStore(wsPath);
  checkpointStore = new LocalCheckpointStore(wsPath);
  aiStore = new LocalAiStore(wsPath);
}

function getHistoryChannel(): vscode.OutputChannel {
  if (!historyChannel) {
    historyChannel = vscode.window.createOutputChannel('CodeSense Problem History');
  }
  return historyChannel;
}

function refreshStatusBar(): void {
  if (!statusBar) {
    return;
  }
  if (!currentSession) {
    statusBar.showIdle();
  } else if (activeProblem && activeAttempt) {
    statusBar.showActiveProblem(problemLabel(activeProblem), activeAttempt.currentState);
  } else {
    statusBar.showSessionNoProblem();
  }
}

let sidebarProvider: CodeSenseSidebarProvider | null = null;

/** Push current domain state to the sidebar (cached until the view resolves). */
function updateSidebar(): void {
  if (!sidebarProvider) {
    return;
  }
  const hasActiveProblem = activeProblem !== null && activeAttempt !== null;
  const snapshot = buildSidebarSnapshot({
    session: currentSession
      ? { sessionId: currentSession.sessionId, startedAt: currentSession.startedAt }
      : null,
    problem:
      hasActiveProblem && activeProblem
        ? {
            title: problemLabel(activeProblem),
            detail: activeProblem.providerId
              ? `${activeProblem.provider} ${activeProblem.providerId}`
              : activeProblem.provider,
          }
        : null,
    attempt:
      hasActiveProblem && activeAttempt
        ? { currentState: activeAttempt.currentState, startedAt: activeAttempt.startedAt }
        : null,
  });
  if (currentSession) {
    // Never show another attempt's message here: the panel model is keyed
    // to the visible attempt (stale-evaluation protection, UI side).
    const visibleAttemptId = hasActiveProblem && activeAttempt ? activeAttempt.attemptId : null;
    snapshot.ai = {
      status: aiPanel.status,
      message:
        aiPanel.lastAttemptId !== null && aiPanel.lastAttemptId === visibleAttemptId
          ? aiPanel.lastMessage
          : null,
      canReply: hasActiveProblem,
    };
  }
  sidebarProvider.update(snapshot);
}

// ---------------------------------------------------------------------------
// Recording helper — single choke point for all captured events
// ---------------------------------------------------------------------------

function recordEvent(
  session: CodingSession,
  eventType: EventType,
  source: EventSource,
  payload: Record<string, unknown>,
): ActivityEvent {
  const activity = createEvent({
    sessionId: session.sessionId,
    eventType,
    source,
    payload,
  });
  // Phase 1: link activity to the active attempt (null for session-level
  // events and all Phase 0 history — the field is optional/additive).
  activity.attemptId = activeAttempt ? activeAttempt.attemptId : null;
  appendEvent(session, activity);
  // Best-effort mirror to disk; capture must never break the editor.
  activeStore()
    .appendEvent(session.sessionId, activity)
    .then(undefined, (err: unknown) => {
      console.error(`CodeSense: failed to persist event ${activity.eventId}`, err);
    });
  return activity;
}

/** Qualifying learner activity: advances the attempt's idle watermark. */
function touchActivity(nowMs?: number): void {
  if (activeTrigger) {
    recordTriggerActivity(activeTrigger, nowMs ?? Date.now());
  }
}

// ---------------------------------------------------------------------------
// Tracking-policy helpers — every document.* / diagnostics decision flows
// through these, so unsupported or inactive documents are never observed.
// ---------------------------------------------------------------------------

/** True when `doc` backs the currently active editor. */
function isActiveDocument(doc: vscode.TextDocument): boolean {
  const active = vscode.window.activeTextEditor?.document;
  return active !== undefined && active.uri.toString() === doc.uri.toString();
}

/** Document.{opened,changed,saved} gate: active session + active + python/java. */
function isObservedDocument(doc: vscode.TextDocument): boolean {
  if (!currentSession) {
    return false;
  }
  return shouldObserveDocument({
    sessionActive: true,
    languageId: doc.languageId,
    isActiveDocument: isActiveDocument(doc),
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle commands (Phase 0 behavior preserved)
// ---------------------------------------------------------------------------

function startSession(): CodingSession {
  if (currentSession) {
    void vscode.window.showInformationMessage(
      `CodeSense: session ${currentSession.sessionId} is already active.`,
    );
    return currentSession;
  }
  const wsPath = workspaceFsPath();
  const workspaceId = wsPath ? generateWorkspaceId(wsPath) : 'ws_unknown';
  const session = createCodingSession({
    sessionId: generateSessionId(),
    workspaceId,
    workspacePath: wsPath,
  });
  currentSession = session;
  // Rebind the stores to the current workspace before persisting.
  rebindStores();
  // Pick up the already-active editor, if it is a trackable document.
  const initiallyActive = vscode.window.activeTextEditor?.document;
  documentTracker.updateActiveDocument(
    initiallyActive?.uri.toString(),
    initiallyActive?.languageId,
    true,
  );
  // Persist the session BEFORE mirroring `session.started`: the recordEvent
  // mirror uses appendEvent, which requires the session to exist on disk.
  // (Previously the mirror raced creation and logged a spurious "Session not
  // found" error on every start; no data was lost, but the error was noise.)
  void activeStore()
    .createSession(session)
    .then(
      () => {
        recordEvent(session, 'session.started', 'session', { workspacePath: wsPath });
      },
      (err: unknown) => {
        console.error('CodeSense: failed to persist new session', err);
      },
    );
  void vscode.window.showInformationMessage(
    `CodeSense: session ${session.sessionId} started.`,
  );
  refreshStatusBar();
  updateSidebar();
  return session;
}

function endSession(): CodingSession | null {
  const session = currentSession;
  if (!session) {
    void vscode.window.showInformationMessage('CodeSense: no active session.');
    return null;
  }
  // Phase 1: an active attempt owns timers/trigger state — end the problem
  // first so its outcome and trigger reset stay unambiguous.
  if (activeAttempt) {
    void vscode.window.showWarningMessage(
      'CodeSense: end the current problem first (select its outcome), then end the session.',
    );
    return null;
  }
  const startedMs = Date.parse(session.startedAt);
  const nowMs = Date.now();
  recordEvent(session, 'session.ended', 'session', {
    reason: 'user',
    eventCount: session.events.length,
    durationMs: Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs),
  });
  finalizeSession(session);
  const finished = session;
  currentSession = null;
  documentTracker.reset();
  void activeStore()
    .finalizeSession(finished)
    .then(undefined, (err: unknown) => {
      console.error('CodeSense: failed to finalize session on disk', err);
    });
  void vscode.window.showInformationMessage(
    `CodeSense: session ${finished.sessionId} ended. ${finished.events.length} events recorded.`,
  );
  refreshStatusBar();
  updateSidebar();
  return finished;
}

// ---------------------------------------------------------------------------
// Phase 1: problem / attempt lifecycle
// ---------------------------------------------------------------------------

// Problem creation boundary. Only the manual path (`buildFromManual`) is
// used in the Phase 1 UI flow; the automatic scrape path (`resolve`) and the
// Python scraper behind it are dormant but preserved for a future phase
// (see scraper/README.md). Re-enabling = calling `resolve` from the setup
// flow again — no Problem/Attempt redesign needed.
const resolver = new ProblemResolver(new PythonScraperClient());

function parseTopicsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function handleProblemStart(input: StartInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = currentSession;
  if (!session) {
    return { ok: false, error: 'Start a CodeSense session first.' };
  }
  if (activeAttempt) {
    return { ok: false, error: 'A problem is already active. End it first.' };
  }
  const url = input.url.trim();
  if (!isValidProblemUrl(url)) {
    return { ok: false, error: 'Please enter a valid http(s) problem URL.' };
  }
  const manualFields = {
    title: input.title.trim().length > 0 ? input.title.trim() : undefined,
    statement: input.statement,
    constraints: input.constraints.trim().length > 0 ? input.constraints : undefined,
    difficulty: input.difficulty.trim().length > 0 ? input.difficulty.trim() : undefined,
    topics: parseTopicsInput(input.topics),
  };
  // Manual input is the normal Phase 1 path: the learner pastes the URL
  // and the statement; automatic scraping is dormant (see scraper/README).
  // The pasted statement becomes the authoritative content; unprovided
  // metadata stays null/empty — nothing is inferred.
  const problem: Problem = resolver.buildFromManual(url, manualFields);
  if (!isUsableProblem(problem)) {
    return { ok: false, error: 'A problem statement is required to start.' };
  }
  try {
    await activeProblemStore().upsertProblem(problem);
  } catch (err) {
    return { ok: false, error: `Could not persist the problem (${String(err)}).` };
  }
  const activeDoc = vscode.window.activeTextEditor?.document;
  const language =
    activeDoc && documentTracker.isTracked(activeDoc.uri.toString()) ? activeDoc.languageId : undefined;
  const attempt = createAttempt({
    problemId: problem.problemId,
    sessionId: session.sessionId,
    language,
  });
  try {
    await activeAttemptStore().saveAttempt(attempt);
  } catch (err) {
    return { ok: false, error: `Could not persist the attempt (${String(err)}).` };
  }
  activeProblem = problem;
  activeAttempt = attempt;
  activeTrigger = createTriggerState(Date.parse(attempt.startedAt), Date.now());
  recordEvent(session, 'problem.started', 'session', {
    problemId: problem.problemId,
    provider: problem.provider,
    canonicalUrl: problem.canonicalUrl,
    source: problem.provenance.source,
    title: problem.title ?? undefined,
  });
  recordEvent(session, 'attempt.started', 'session', {
    attemptId: attempt.attemptId,
    problemId: problem.problemId,
    language,
  });
  touchActivity();
  await createSnapshotCheckpoint('start');
  refreshStatusBar();
  updateSidebar();
  void vscode.window.showInformationMessage(
    `CodeSense: problem "${problemLabel(problem)}" started. State: In Progress.`,
  );
  return { ok: true };
}

function startProblemFlow(): void {
  if (!currentSession) {
    void vscode.window.showWarningMessage('CodeSense: start a session first.');
    return;
  }
  if (activeAttempt) {
    void vscode.window.showInformationMessage(
      `CodeSense: "${activeProblem ? problemLabel(activeProblem) : 'a problem'}" is already active. End it first.`,
    );
    return;
  }
  showProblemSetupPanel({
    onStart: (input: StartInput) => handleProblemStart(input),
    onCancel: () => {
      // Nothing pending in the manual-only flow; the hook exists so a
      // future re-enabled fetch step can reset its state here.
    },
  });
}

async function setProblemState(): Promise<void> {
  const session = currentSession;
  if (!session || !activeAttempt || !activeProblem) {
    void vscode.window.showInformationMessage('CodeSense: no active problem.');
    return;
  }
  const picked = await vscode.window.showQuickPick([...ATTEMPT_STATES], {
    placeHolder: `Current: ${activeAttempt.currentState} — select problem state`,
  });
  if (!picked || !isKnownAttemptState(picked)) {
    return;
  }
  await applyProblemState(picked);
}

/**
 * Shared state-change core used by the Command Palette flow and the
 * sidebar select. Validation/persistence/events live here — never in UI.
 */
async function applyProblemState(next: AttemptState): Promise<boolean> {
  const session = currentSession;
  if (!session || !activeAttempt || !activeProblem) {
    void vscode.window.showInformationMessage('CodeSense: no active problem.');
    return false;
  }
  if (next === activeAttempt.currentState) {
    return false;
  }
  const transition = transitionAttemptState(activeAttempt, next, 'learner');
  try {
    await activeAttemptStore().saveAttempt(activeAttempt);
  } catch (err) {
    console.error('CodeSense: failed to persist state change', err);
  }
  recordEvent(session, 'attempt.stateChanged', 'session', {
    attemptId: transition.attemptId,
    fromState: transition.fromState,
    toState: transition.toState,
    source: transition.source,
  });
  touchActivity();
  refreshStatusBar();
  updateSidebar();
  void vscode.window.showInformationMessage(`CodeSense: problem state → ${next}.`);
  return true;
}

async function endProblem(): Promise<Attempt | null> {
  const session = currentSession;
  if (!session || !activeAttempt || !activeProblem) {
    void vscode.window.showInformationMessage('CodeSense: no active problem.');
    return null;
  }
  // §19: a problem must not end while still In Progress.
  if (!canEndAttempt(activeAttempt.currentState)) {
    const pick = await vscode.window.showWarningMessage(
      'You cannot end the problem while it is still marked "In Progress". Please select the current outcome/state first.',
      'Select Outcome',
      'Cancel',
    );
    if (pick === 'Select Outcome') {
      await setProblemState();
    }
    return null;
  }
  const attempt = activeAttempt;
  const problem = activeProblem;
  try {
    completeAttempt(attempt);
  } catch (err) {
    void vscode.window.showWarningMessage(`CodeSense: ${String(err)}`);
    return null;
  }
  try {
    await activeAttemptStore().saveAttempt(attempt);
  } catch (err) {
    console.error('CodeSense: failed to persist completed attempt', err);
  }
  const durationMs = Math.max(0, Date.now() - Date.parse(attempt.startedAt));
  recordEvent(session, 'attempt.completed', 'session', {
    attemptId: attempt.attemptId,
    problemId: attempt.problemId,
    finalState: attempt.currentState,
    durationMs,
  });
  recordEvent(session, 'problem.ended', 'session', {
    problemId: problem.problemId,
    attemptId: attempt.attemptId,
    finalState: attempt.currentState,
  });
  // Ending a problem resets the trigger lifecycle (§32): drop per-attempt state.
  activeAttempt = null;
  activeProblem = null;
  activeTrigger = null;
  refreshStatusBar();
  updateSidebar();
  void vscode.window.showInformationMessage(
    `CodeSense: problem "${problemLabel(problem)}" ended as "${attempt.currentState}". History preserved.`,
  );
  return attempt;
}

async function showProblemHistory(): Promise<void> {
  const channel = getHistoryChannel();
  channel.clear();
  let problems: Problem[];
  try {
    problems = await activeProblemStore().listProblems();
  } catch (err) {
    void vscode.window.showWarningMessage(`CodeSense: could not load problem history (${String(err)}).`);
    return;
  }
  if (problems.length === 0) {
    channel.appendLine('No problems recorded yet. Use "CodeSense: Start Problem" during a session.');
    channel.show();
    return;
  }
  for (const problem of problems) {
    channel.appendLine(`Problem: ${problemLabel(problem)}`);
    channel.appendLine(`  provider: ${problem.provider} | id: ${problem.providerId ?? 'n/a'}`);
    channel.appendLine(`  url: ${problem.canonicalUrl} | source: ${problem.provenance.source}`);
    let attempts: Attempt[] = [];
    try {
      attempts = await activeAttemptStore().listAttemptsForProblem(problem.problemId);
    } catch (err) {
      channel.appendLine(`  (could not load attempts: ${String(err)})`);
    }
    if (attempts.length === 0) {
      channel.appendLine('  attempts: none');
    }
    for (const attempt of attempts) {
      const status = attempt.completedAt ? `ended: ${attempt.completedAt}` : 'active';
      const trail = attempt.stateHistory.map((t) => t.toState).join(' → ');
      channel.appendLine(
        `  attempt ${attempt.attemptId} (started: ${attempt.startedAt}, ${status}) [${attempt.currentState}]`,
      );
      channel.appendLine(`    states: ${trail}`);
    }
    channel.appendLine('');
  }
  channel.show();
}

async function showMenu(): Promise<void> {
  interface MenuChoice extends vscode.QuickPickItem {
    action: string;
  }
  const choices: MenuChoice[] = [];
  if (!currentSession) {
    choices.push({ label: '$(play) Start Session', action: 'startSession' });
  } else {
    choices.push({ label: '$(play) Session active — End Session', action: 'endSession' });
    if (!activeAttempt) {
      choices.push({ label: '$(plus) Start Problem', action: 'startProblem' });
    } else {
      choices.push({
        label: `$(check) Set Problem State (now: ${activeAttempt.currentState})`,
        action: 'setState',
      });
      choices.push({ label: '$(stop) End Problem', action: 'endProblem' });
    }
  }
  choices.push({ label: '$(history) Show Problem History', action: 'history' });
  choices.push({ label: '$(list-unordered) Show Session Timeline', action: 'timeline' });
  choices.push({ label: '$(file) Show Session Data Location', action: 'location' });
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'CodeSense' });
  if (!picked) {
    return;
  }
  switch (picked.action) {
    case 'startSession':
      startSession();
      break;
    case 'endSession':
      endSession();
      break;
    case 'startProblem':
      startProblemFlow();
      break;
    case 'endProblem':
      void endProblem();
      break;
    case 'setState':
      void setProblemState();
      break;
    case 'history':
      void showProblemHistory();
      break;
    case 'timeline':
      void showTimeline();
      break;
    case 'location':
      showSessionDataLocation();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: checkpoints (full snapshots anchoring the diff history)
// ---------------------------------------------------------------------------

async function createSnapshotCheckpoint(reason: CheckpointReason): Promise<CodeCheckpoint | null> {
  const session = currentSession;
  const attempt = activeAttempt;
  if (!session || !attempt) {
    return null;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !documentTracker.isTracked(doc.uri.toString())) {
    return null;
  }
  let snapshot: string;
  try {
    snapshot = doc.getText();
  } catch {
    return null;
  }
  const checkpoint = createCheckpoint({
    attemptId: attempt.attemptId,
    sessionId: session.sessionId,
    reason,
    uri: doc.uri.toString(),
    language: doc.languageId,
    documentVersion: doc.version,
    snapshot,
    // Provenance: an attempt-start snapshot is the OBSERVED starting state
    // (a reused file may still hold a previous attempt's code) — never
    // learner-authored evidence. All other reasons are authored states.
    baseline: reason === 'start',
  });
  try {
    await activeCheckpointStore().saveCheckpoint(checkpoint);
  } catch (err) {
    console.error('CodeSense: failed to persist checkpoint', err);
    return null;
  }
  recordEvent(session, 'checkpoint.created', 'document', {
    checkpointId: checkpoint.checkpointId,
    attemptId: checkpoint.attemptId,
    reason: checkpoint.reason,
    uri: checkpoint.uri,
    snapshotChars: snapshot.length,
  });
  // Idle checkpoints are capped at 10 per attempt (§25); important
  // save/run/test/start checkpoints are never evicted for the idle cap.
  if (reason === 'idle') {
    try {
      const all = await activeCheckpointStore().listCheckpointsForAttempt(attempt.attemptId);
      const { removed } = enforceIdleCheckpointCap(all);
      if (removed.length > 0) {
        await activeCheckpointStore().deleteCheckpoints(removed.map((c) => c.checkpointId));
      }
    } catch (err) {
      console.error('CodeSense: failed to enforce idle checkpoint cap', err);
    }
  }
  return checkpoint;
}

// ---------------------------------------------------------------------------
// Phase 1: trigger polling (10-min idle + strict 45-min boundary)
// ---------------------------------------------------------------------------

async function checkTriggers(): Promise<void> {
  const session = currentSession;
  const attempt = activeAttempt;
  const trigger = activeTrigger;
  if (!session || !attempt || !trigger) {
    return;
  }
  const evaluation = pollTriggers(trigger, Date.now());
  if (!evaluation.eligible || evaluation.kind === null) {
    return;
  }
  if (evaluation.kind === 'idle') {
    await createSnapshotCheckpoint('idle');
    recordEvent(session, 'attempt.triggerEligible', 'session', {
      attemptId: attempt.attemptId,
      kind: 'idle',
      reason: evaluation.reason,
    });
    void vscode.window.showInformationMessage(
      'CodeSense: 10 minutes of inactivity — checkpoint saved (AI evaluation requested; see the sidebar AI Coach panel).',
    );
  } else {
    recordEvent(session, 'attempt.triggerEligible', 'session', {
      attemptId: attempt.attemptId,
      kind: 'hard45',
      reason: evaluation.reason,
    });
    void vscode.window.showInformationMessage(
      'CodeSense: 45 minutes since this attempt started (mandatory AI check-in requested; see the sidebar AI Coach panel).',
    );
  }
  // AI Layer V1: the trigger engine has decided an evaluation is due; the AI
  // layer now decides what (if anything) it means. Fire-and-forget by
  // design — telemetry must never wait on the model.
  void maybeRunAiEvaluation(attempt, evaluation.kind, evaluation.reason);
}

// ---------------------------------------------------------------------------
// AI Layer V1: evaluation orchestration (reasoning only — no telemetry,
// lifecycle, or persistence-semantics changes here)
// ---------------------------------------------------------------------------

/**
 * Run one AI evaluation for the attempt that triggered, if possible.
 * Never throws: every failure mode degrades to panel state + console log.
 * Never blocks: callers must not await this.
 */
async function maybeRunAiEvaluation(
  attempt: Attempt,
  kind: EvaluationTriggerKind,
  reason: string,
): Promise<void> {
  const config = readAiConfig();
  if (!config.enabled) {
    aiPanel = { status: 'unavailable', lastMessage: null, lastAttemptId: null };
    updateSidebar();
    if (!aiUnavailableNoticed) {
      aiUnavailableNoticed = true;
      void vscode.window.showInformationMessage(
        'CodeSense AI is not configured (set CODESENSE_AI_API_KEY). ' +
          'Telemetry, problems, and the sidebar keep working normally.',
      );
    }
    return;
  }
  const session = currentSession;
  const problem = activeProblem;
  const live = activeAttempt;
  if (!session || !problem || !live || live.attemptId !== attempt.attemptId) {
    return;
  }
  if (evaluationInFlight.has(attempt.attemptId)) {
    return;
  }
  evaluationInFlight.add(attempt.attemptId);
  try {
    aiPanel = {
      status: 'evaluating',
      lastMessage: aiPanel.lastAttemptId === attempt.attemptId ? aiPanel.lastMessage : null,
      lastAttemptId: attempt.attemptId,
    };
    updateSidebar();
    const outcome: EvaluationOutcome = await runAiEvaluation(
      {
        nowIso: () => new Date().toISOString(),
        getActiveAttempt: () =>
          activeAttempt && activeProblem
            ? { attempt: activeAttempt, problem: activeProblem }
            : null,
        buildContext: async (target, targetProblem) => buildEvaluationContext(target, targetProblem),
        reasoner: new HttpChatReasoner({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }),
        saveEvaluation: (evaluation) => activeAiStore().saveEvaluation(evaluation),
        appendConversation: (message) => activeAiStore().appendConversation(message),
        isAttemptStillActive: (attemptId) => activeAttempt?.attemptId === attemptId,
        timeoutMs: config.timeoutMs,
      },
      { attemptId: attempt.attemptId, triggerKind: kind, reason },
    );
    if (outcome.status === 'evaluated') {
      const evaluation = outcome.evaluation;
      recordEvent(session, 'ai.evaluated', 'session', {
        evaluationId: evaluation.evaluationId,
        attemptId: evaluation.attemptId,
        triggerKind: evaluation.triggerKind,
        shouldIntervene: evaluation.shouldIntervene,
        interventionType: evaluation.interventionType,
      });
      if (outcome.displayed) {
        aiPanel = { status: 'idle', lastMessage: evaluation.message, lastAttemptId: evaluation.attemptId };
      } else {
        // Evaluated fine, but the learner moved on: persist (done above),
        // never display inside the new attempt. Panel keeps prior state.
        aiPanel = { status: 'idle', lastMessage: aiPanel.lastMessage, lastAttemptId: aiPanel.lastAttemptId };
      }
    } else if (outcome.status === 'failed') {
      console.error(`CodeSense: AI evaluation failed (${outcome.reason}): ${outcome.detail}`);
      aiPanel = { status: 'error', lastMessage: aiPanel.lastMessage, lastAttemptId: aiPanel.lastAttemptId };
      if (kind === 'manual') {
        void vscode.window.showWarningMessage(
          `CodeSense AI check-in failed (${outcome.reason}). Telemetry is unaffected; retry any time.`,
        );
      }
    }
  } finally {
    evaluationInFlight.delete(attempt.attemptId);
    updateSidebar();
  }
}

/**
 * Assemble the scoped evaluation context from existing stores. Deterministic
 * reconstruction owns the source — the model only ever receives it.
 */
async function buildEvaluationContext(target: Attempt, targetProblem: Problem) {
  const session = currentSession;
  const attemptStore = activeAttemptStore();
  const problemAttempts = await attemptStore.listAttemptsForProblem(targetProblem.problemId);
  const previousAttempts = problemAttempts.filter(
    (a) => a.attemptId !== target.attemptId && a.completedAt !== null,
  );
  const checkpoints = await activeCheckpointStore().listCheckpointsForAttempt(target.attemptId);
  const sessionEvents = session
    ? session.events.filter((e) => e.attemptId == null || e.attemptId === target.attemptId)
    : [];
  const edits = selectAttemptEdits(editRecordsFromEvents(sessionEvents), target.attemptId);
  const conversation = await activeAiStore().listConversation(target.attemptId);
  return buildAIContext({
    problem: targetProblem,
    attempt: target,
    previousAttempts,
    edits,
    checkpoints,
    sessionEvents,
    conversation,
  });
}

/** Manual check-in: same pipeline and guards as trigger-driven evaluation. */
function requestManualEvaluation(): void {
  const attempt = activeAttempt;
  if (!currentSession || !attempt) {
    void vscode.window.showInformationMessage('CodeSense: start a session and a problem first.');
    return;
  }
  void maybeRunAiEvaluation(attempt, 'manual', 'manual check-in requested from the command palette');
}

/** Learner reply from the sidebar: persisted conversation, no auto-evaluation. */
function handleAiReply(rawText: string): void {
  const text = rawText.trim();
  if (text.length === 0) {
    return;
  }
  const attempt = activeAttempt;
  if (!currentSession || !attempt) {
    void vscode.window.showInformationMessage('CodeSense: no active problem to reply about.');
    return;
  }
  const capped = text.length > 2000 ? text.slice(0, 2000) : text;
  void activeAiStore()
    .appendConversation({
      messageId: generateConversationMessageId(),
      attemptId: attempt.attemptId,
      timestamp: new Date().toISOString(),
      role: 'learner',
      text: capped,
    })
    .then(
      () => updateSidebar(),
      (err: unknown) => {
        console.error('CodeSense: failed to persist learner reply', err);
      },
    );
}

// ---------------------------------------------------------------------------
// Capture helpers (Phase 0 logic preserved)
// ---------------------------------------------------------------------------

function toSeverityLabel(severity: vscode.DiagnosticSeverity): DiagnosticItemPayload['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    case vscode.DiagnosticSeverity.Information:
    default:
      return 'information';
  }
}

function diagnosticCodeToString(code: vscode.Diagnostic['code']): string | undefined {
  if (code === undefined) {
    return undefined;
  }
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return String(code.value);
}

function taskLabel(execution: vscode.TaskExecution): string {
  try {
    return execution.task.name;
  } catch {
    return '(task)';
  }
}

// ---------------------------------------------------------------------------
// Timeline / data-location commands (Phase 0 behavior preserved)
// ---------------------------------------------------------------------------

async function showTimeline(): Promise<void> {
  const sessionStore = activeStore();
  let ids: string[];
  try {
    ids = await sessionStore.listSessionIds();
  } catch (err) {
    void vscode.window.showWarningMessage(`CodeSense: could not list sessions (${String(err)}).`);
    return;
  }
  if (ids.length === 0) {
    void vscode.window.showInformationMessage('CodeSense: no sessions recorded yet.');
    return;
  }
  const lines: string[] = [];
  for (const id of ids) {
    const session = await sessionStore.getSession(id);
    if (!session) {
      continue;
    }
    const status = session.endedAt ? `, ended: ${session.endedAt}` : ' — active';
    lines.push(
      `Session ${session.sessionId} (started: ${session.startedAt}${status} | lang: ${session.primaryLanguage ?? 'unknown'})`,
    );
    const ordered = [...session.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const activity of ordered) {
      const label = activity.eventType.replace(/\./g, ' ');
      const payload = activity.payload as Record<string, unknown> | null;
      const lang =
        payload && typeof payload.languageId === 'string'
          ? ` (${String(payload.languageId)})`
          : '';
      lines.push(`  ${activity.timestamp} — ${label}${lang}`);
    }
    lines.push('');
  }
  void vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

function showSessionDataLocation(): void {
  const file = getStoragePath(workspaceFsPath());
  void vscode.window.showInformationMessage(`CodeSense data stored at: ${file}`);
  // `revealFileInOS` is a built-in VS Code command (no invented API).
  void vscode.commands
    .executeCommand('revealFileInOS', vscode.Uri.file(file))
    .then(undefined, () => {
      // Revealing is best-effort (e.g. file may not exist yet); the
      // information message above already told the user where data lives.
    });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  console.log('CodeSense extension activated');
  // Project-local AI configuration: <workspace-root>/.env is loaded into
  // process.env before anything reads it. No workspace or no .env is a
  // silent no-op; explicit environment variables keep working as before.
  loadWorkspaceEnvFile(workspaceFsPath());
  rebindStores();
  statusBar = new CodeSenseStatusBar();
  refreshStatusBar();
  // Sidebar (Activity Bar): thin view over existing state/services. All
  // actions delegate to the same functions the commands use, so behavior
  // and validation stay in one place.
  sidebarProvider = new CodeSenseSidebarProvider({
    startSession: () => {
      startSession();
    },
    endSession: () => {
      endSession();
    },
    startProblem: () => {
      startProblemFlow();
    },
    endProblem: () => {
      void endProblem();
    },
    setProblemState: (state: string) => {
      if (!isKnownAttemptState(state)) {
        return;
      }
      void applyProblemState(state);
    },
    showProblemHistory: () => {
      void showProblemHistory();
    },
    aiReply: (text: string) => {
      handleAiReply(text);
    },
  });
  const sidebarDisposable = vscode.window.registerWebviewViewProvider(
    CodeSenseSidebarProvider.viewId,
    sidebarProvider,
  );
  updateSidebar();
  triggerTimer = setInterval(() => {
    void checkTriggers().then(undefined, (err: unknown) => {
      console.error('CodeSense: trigger check failed', err);
    });
  }, TRIGGER_POLL_MS);

  const startDisposable = vscode.commands.registerCommand('codesense.startSession', () => {
    startSession();
  });
  const endDisposable = vscode.commands.registerCommand('codesense.endSession', () => {
    endSession();
  });
  const startProblemDisposable = vscode.commands.registerCommand('codesense.startProblem', () => {
    startProblemFlow();
  });
  const endProblemDisposable = vscode.commands.registerCommand('codesense.endProblem', () => {
    void endProblem();
  });
  const setStateDisposable = vscode.commands.registerCommand('codesense.setProblemState', () => {
    void setProblemState();
  });
  const historyDisposable = vscode.commands.registerCommand('codesense.showProblemHistory', () => {
    void showProblemHistory();
  });
  const evaluateNowDisposable = vscode.commands.registerCommand('codesense.evaluateNow', () => {
    requestManualEvaluation();
  });
  const menuDisposable = vscode.commands.registerCommand('codesense.showMenu', () => {
    void showMenu();
  });
  const timelineDisposable = vscode.commands.registerCommand('codesense.showTimeline', () => {
    void showTimeline();
  });
  const locationDisposable = vscode.commands.registerCommand(
    'codesense.showSessionDataLocation',
    () => {
      showSessionDataLocation();
    },
  );

  const documentOpened = vscode.workspace.onDidOpenTextDocument((doc) => {
    const session = currentSession;
    if (!session || !isObservedDocument(doc)) {
      return;
    }
    recordEvent(session, 'document.opened', 'document', {
      filePath: doc.fileName,
      uri: doc.uri.toString(),
      languageId: doc.languageId,
      documentVersion: doc.version,
    });
    touchActivity();
  });

  const documentChanged = vscode.workspace.onDidChangeTextDocument((change) => {
    const session = currentSession;
    const doc = change.document;
    if (!session || !isObservedDocument(doc)) {
      return;
    }
    const versionAfter = doc.version;
    const changes = buildContentChanges(
      change.contentChanges.map((contentChange) => ({
        range: {
          startLine: contentChange.range.start.line,
          startCharacter: contentChange.range.start.character,
          endLine: contentChange.range.end.line,
          endCharacter: contentChange.range.end.character,
        },
        rangeLength: contentChange.rangeLength,
        text: contentChange.text,
      })),
      // Privacy boundary: exact inserted text is captured ONLY while a
      // problem attempt is active. Without an attempt the structural event
      // (ranges, lengths, versions) is still recorded for observed documents.
      activeAttempt !== null,
    );
    recordEvent(session, 'document.changed', 'document', {
      filePath: doc.fileName,
      uri: doc.uri.toString(),
      languageId: doc.languageId,
      documentVersion: versionAfter,
      versionBefore: versionAfter - 1,
      versionAfter,
      changes,
    });
    // Keep the attempt's language hint fresh (informational only).
    if (activeAttempt) {
      activeAttempt.language = doc.languageId;
      void activeAttemptStore()
        .saveAttempt(activeAttempt)
        .then(undefined, (err: unknown) => {
          console.error('CodeSense: failed to persist attempt language', err);
        });
    }
    touchActivity();
  });

  const documentSaved = vscode.workspace.onDidSaveTextDocument((doc) => {
    const session = currentSession;
    if (!session || !isObservedDocument(doc)) {
      return;
    }
    recordEvent(session, 'document.saved', 'document', {
      filePath: doc.fileName,
      uri: doc.uri.toString(),
      languageId: doc.languageId,
      documentVersion: doc.version,
    });
    touchActivity();
    // Save checkpoints anchor the diff history (§23).
    void createSnapshotCheckpoint('save').then(undefined, (err: unknown) => {
      console.error('CodeSense: save checkpoint failed', err);
    });
  });

  const documentClosed = vscode.workspace.onDidCloseTextDocument((doc) => {
    const session = currentSession;
    if (!session) {
      return;
    }
    // A closed document is no longer the active editor, so the close event
    // is recorded only when it was the tracked (active, supported) document.
    if (!documentTracker.consumeIfTracked(doc.uri.toString())) {
      return;
    }
    recordEvent(session, 'document.closed', 'document', {
      filePath: doc.fileName,
      uri: doc.uri.toString(),
      languageId: doc.languageId,
    });
  });

  const activeEditorChanged = vscode.window.onDidChangeActiveTextEditor((editor) => {
    const session = currentSession;
    if (!session || !editor) {
      return;
    }
    // Update tracking first: the session stays alive on unsupported editors,
    // only document observation pauses. The switch event itself carries
    // document identity, so it is recorded only for supported documents.
    const tracking = documentTracker.updateActiveDocument(
      editor.document.uri.toString(),
      editor.document.languageId,
      true,
    );
    if (!tracking) {
      return;
    }
    recordEvent(session, 'editor.activeChanged', 'editor', {
      uri: editor.document.uri.toString(),
      filePath: editor.document.fileName,
      languageId: editor.document.languageId,
      workspacePath: workspaceFsPath(),
    });
    touchActivity();
  });

  const diagnosticsChanged = vscode.languages.onDidChangeDiagnostics((diagEvent) => {
    const session = currentSession;
    if (!session) {
      return;
    }
    // Diagnostics are observed only for the tracked (active, supported)
    // document — never for background or unsupported files.
    const tracked = documentTracker.tracked;
    if (!tracked) {
      return;
    }
    for (const uri of diagEvent.uris) {
      if (uri.toString() !== tracked.uri) {
        continue;
      }
      const live = vscode.languages.getDiagnostics(uri);
      const doc = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri.toString(),
      );
      recordEvent(session, 'diagnostics.changed', 'diagnostics', {
        uri: uri.toString(),
        filePath: uri.fsPath,
        languageId: doc?.languageId,
        diagnostics: live.map(
          (diagnostic): DiagnosticItemPayload => ({
            severity: toSeverityLabel(diagnostic.severity),
            code: diagnosticCodeToString(diagnostic.code),
            source: diagnostic.source,
            message: diagnostic.message,
            startLine: diagnostic.range.start.line,
            startCharacter: diagnostic.range.start.character,
            endLine: diagnostic.range.end.line,
            endCharacter: diagnostic.range.end.character,
          }),
        ),
      });
      // Deliberately NOT touchActivity(): diagnostics can arrive with no
      // learner action, so they must not reset the idle watermark.
    }
  });

  // Terminal / execution capture via the supported shell-integration API.
  // Guarded so the extension loads on hosts without shell integration.
  const terminalDisposables: vscode.Disposable[] = [];
  const windowWithShellEvents = vscode.window as typeof vscode.window & {
    onDidStartTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
    onDidEndTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
  };
  if (
    typeof windowWithShellEvents.onDidStartTerminalShellExecution === 'function' &&
    typeof windowWithShellEvents.onDidEndTerminalShellExecution === 'function'
  ) {
    terminalDisposables.push(
      windowWithShellEvents.onDidStartTerminalShellExecution((start) => {
        const session = currentSession;
        if (!session) {
          return;
        }
        recordEvent(session, 'terminal.commandStarted', 'terminal', {
          terminalName: start.terminal.name,
          commandLine: start.execution.commandLine.value,
          cwd: start.execution.cwd?.fsPath,
        });
        touchActivity();
      }),
      windowWithShellEvents.onDidEndTerminalShellExecution((end) => {
        const session = currentSession;
        if (!session) {
          return;
        }
        recordEvent(session, 'terminal.commandCompleted', 'terminal', {
          terminalName: end.terminal.name,
          commandLine: end.execution.commandLine.value,
          exitCode: end.exitCode ?? null,
        });
        touchActivity();
        // A finished local run anchors the diff history (§23, §27: local
        // exit codes are observed as-is, never equated with judge verdicts).
        void createSnapshotCheckpoint('run').then(undefined, (err: unknown) => {
          console.error('CodeSense: run checkpoint failed', err);
        });
      }),
    );
  } else {
    console.log('CodeSense: terminal shell-integration events unavailable; terminal capture disabled.');
  }

  // Task execution capture via the supported tasks API (run.started /
  // run.completed). Local exit codes only — never judge verdicts.
  const taskStarted = vscode.tasks.onDidStartTask((start) => {
    const session = currentSession;
    if (!session) {
      return;
    }
    const label = taskLabel(start.execution);
    taskStartTimes.set(label, Date.now());
    recordEvent(session, 'run.started', 'terminal', {
      kind: 'task',
      label,
    });
    touchActivity();
  });
  const taskProcessEnded = vscode.tasks.onDidEndTaskProcess((end) => {
    const session = currentSession;
    const label = taskLabel(end.execution);
    if (taskCompletionSeen.delete(label)) {
      // Already completed via task end (unexpected event order); avoid a
      // duplicate `run.completed`.
      taskStartTimes.delete(label);
      return;
    }
    if (!session) {
      return;
    }
    const startedAt = taskStartTimes.get(label);
    if (startedAt !== undefined) {
      taskStartTimes.delete(label);
    }
    recordEvent(session, 'run.completed', 'terminal', {
      kind: 'task',
      label,
      exitCode: end.exitCode ?? null,
      durationMs: startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined,
    });
    taskCompletionSeen.add(label);
    touchActivity();
    void createSnapshotCheckpoint('run').then(undefined, (err: unknown) => {
      console.error('CodeSense: run checkpoint failed', err);
    });
  });
  // Fallback for tasks without an underlying process (e.g. CustomExecution),
  // which never emit a process end. Every task emits a task end, so this
  // also guarantees no stale `taskStartTimes` entries.
  const taskEnded = vscode.tasks.onDidEndTask((end) => {
    const label = taskLabel(end.execution);
    const startedAt = taskStartTimes.get(label);
    taskStartTimes.delete(label);
    if (taskCompletionSeen.delete(label)) {
      return; // Normal path: already completed via the process end.
    }
    const session = currentSession;
    if (!session || startedAt === undefined) {
      return; // Task started before/without a session: nothing to link.
    }
    recordEvent(session, 'run.completed', 'terminal', {
      kind: 'task',
      label,
      exitCode: null, // Non-process tasks report no exit code.
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    touchActivity();
    void createSnapshotCheckpoint('run').then(undefined, (err: unknown) => {
      console.error('CodeSense: run checkpoint failed', err);
    });
  });

  // NOTE (deferred, not fabricated): the installed VS Code Testing API
  // exposes only `tests.createTestController`. There is no supported event
  // for passively observing test runs from this extension, so `test.started`
  // / `test.ended` events are defined in the model but not captured in
  // Phase 1 either. See LIMITATIONS below.

  context.subscriptions.push(
    startDisposable,
    endDisposable,
    startProblemDisposable,
    endProblemDisposable,
    setStateDisposable,
    historyDisposable,
    evaluateNowDisposable,
    menuDisposable,
    timelineDisposable,
    locationDisposable,
    sidebarDisposable,
    documentOpened,
    documentChanged,
    documentSaved,
    documentClosed,
    activeEditorChanged,
    diagnosticsChanged,
    taskStarted,
    taskProcessEnded,
    taskEnded,
    ...terminalDisposables,
  );
  if (statusBar) {
    context.subscriptions.push(statusBar);
  }
}

export function deactivate(): void {
  if (triggerTimer) {
    clearInterval(triggerTimer);
    triggerTimer = null;
  }
  // An attempt left open at shutdown must not look currently active after
  // reload: interrupt it (existing terminal state, system source) and
  // complete it so history stays unambiguous. Clean exits already nulled
  // the active attempt via End Problem, so this only fires for genuinely
  // open attempts.
  if (activeAttempt && attemptStore) {
    const pending = activeAttempt;
    const problem = activeProblem;
    const { interrupted } = interruptAttempt(pending);
    const session = currentSession;
    if (session) {
      if (interrupted) {
        const transition = pending.stateHistory[pending.stateHistory.length - 1];
        recordEvent(session, 'attempt.stateChanged', 'session', {
          attemptId: pending.attemptId,
          fromState: transition.fromState,
          toState: transition.toState,
          source: 'system',
          note: transition.note,
        });
      }
      const startedMs = Date.parse(pending.startedAt);
      recordEvent(session, 'attempt.completed', 'session', {
        attemptId: pending.attemptId,
        problemId: pending.problemId,
        finalState: pending.currentState,
        durationMs: Number.isNaN(startedMs) ? 0 : Math.max(0, Date.now() - startedMs),
      });
      if (problem) {
        recordEvent(session, 'problem.ended', 'session', {
          problemId: problem.problemId,
          attemptId: pending.attemptId,
          finalState: pending.currentState,
        });
      }
    }
    const storeRef = attemptStore;
    void storeRef.saveAttempt(pending).then(undefined, (err: unknown) => {
      console.error('CodeSense: failed to persist attempt on deactivate', err);
    });
    activeAttempt = null;
    activeProblem = null;
    activeTrigger = null;
  }
  // Synchronous shutdown: finalize in memory and mirror best-effort to disk.
  if (currentSession && store) {
    finalizeSession(currentSession);
    const finished = currentSession;
    currentSession = null;
    documentTracker.reset();
    void store.finalizeSession(finished).then(undefined, (err: unknown) => {
      console.error('CodeSense: failed to finalize session on deactivate', err);
    });
  }
}

/**
 * LIMITATIONS (Phase 1, verified against installed @types/vscode):
 * - Document observation is restricted to the active editor when its
 *   `languageId` is python or java; other files are never tracked and the
 *   workspace is never scanned.
 * - Test execution is NOT observed: `vscode.tests` offers no subscriber
 *   event for test runs; inventing `onDidRunTests`/`onDidEndTests` was
 *   avoided. The `test.started`/`test.ended` event types remain reserved.
 * - Terminal command capture requires shell integration; without it only
 *   document/editor/diagnostics/task capture is active.
 * - `document.changed` events carry exact inserted text (local-only) ONLY
 *   while a problem attempt is active; otherwise the structural event is
 *   recorded without exact text. Phase 0 length-only history cannot be
 *   reconstructed and is skipped by the edit-record bridge.
 * - Scoring/mastery/learner-model inference is NOT implemented; no MCP,
 *   curriculum, analytics, or cloud upload exists. LLM calls happen only
 *   when configured, with attempt-scoped context, via the provider
 *   abstraction in src/ai (graceful degradation otherwise).
 */
