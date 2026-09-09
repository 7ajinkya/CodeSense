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
  resolveIdleThresholdMs,
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
  SidebarExchangeMessage,
  buildSidebarSnapshot,
  withBadgeMetadata,
} from './ui/sidebarView';
import {
  StartInput,
  showProblemSetupPanel,
} from './ui/problemSetupPanel';
// AI Layer V1 imports (reasoning only — telemetry/lifecycle untouched).
import { AIEvaluation, EvaluationTriggerKind, generateConversationMessageId } from './ai/aiTypes';import { HttpChatReasoner } from './ai/reasoners';
import { LocalAiStore } from './ai/aiStore';
import { loadEnvFile, readAiConfig } from './ai/aiConfig';
import { EvaluationOutcome, runAiEvaluation, shouldNotifyProactiveIntervention } from './ai/evaluationRunner';
import { resolveUIFontSize } from './ui/fontSize';
import { isAwaitingLearnerResponse } from './ai/conversationStatus';
import { nextCheckinStatus, releaseEvaluation, resetCheckinStatusOnAttemptBoundary, tryReserveEvaluation } from './ai/evaluationGuard';
import { resolveRateLimitCooldownMs } from './ai/rateLimit';
import { buildAIContext } from './context/aiContext';
import { editRecordsFromEvents, selectAttemptEdits } from './history/codeHistory';
// Phase C imports (knowledge graph + automatic problem classification:
// local-first supporting infrastructure — never blocks solving, never
// mutates the Problem record, never models the learner).
import { LocalClassificationStore } from './knowledge/classificationStore';
import { getClassificationStatus } from './knowledge/classification';
import { getDefaultKnowledgeGraph } from './knowledge/ontologyStore';
import { HttpProblemClassificationReasoner, runProblemClassification } from './knowledge/classifier';
// Phase D imports (learner model: evidence-driven beliefs with provenance.
// Local-first supporting infrastructure — feeds are fire-and-forget and
// fail-open; they never block solving, coaching, or lifecycle transitions).
import { LocalLearnerEvidenceStore } from './learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from './learner/learnerModelStore';
import { isKnownEvidenceDimension } from './learner/learnerTypes';
import { buildLearnerNotesForPrompt } from './learner/learnerQueries';
import {
  syncAttemptToLearnerModel,
  syncEvaluationToLearnerModel,
} from './learner/learnerFeeds';
// Phase E imports (personalized coach: deterministic learner-aware context,
// decision briefing, outcome derivation, finalization packaging, and a
// secret-free AI I/O trace. Advisory to the model and fail-open throughout;
// the frozen validator/runner/trigger contracts are untouched).
import { LocalAiTraceStore } from './ai/aiTrace';
import { buildCoachContext, summarizeCoachingTurn } from './coach/coachContext';
import type { CoachContext } from './coach/coachTypes';
// Phase F1 imports (learning needs + learner-owned goals: deterministic
// derivation from the frozen learner model, durable lifecycle-managed
// goals, fail-open background surfacing; never a second mastery model,
// never automatic activation without a learner decision).
import { LocalGoalStore } from './goals/goalStore';
import { detectLearningNeeds } from './goals/needDetection';
import { explainProposal, proposeGoalFromRequest } from './goals/goalProposal';
import { acceptGoal, modifyGoal, rejectGoal, resumeGoal, pauseGoal, completeGoal, abandonGoal } from './goals/goalLifecycle';
import {
  findConflictingGoal,
  getActiveGoals,
  getProposals,
  summarizeGoalsForPrompt,
} from './goals/goalQueries';
import type { LearningGoal } from './goals/goalTypes';
// F1 proposal-lifecycle hardening: freshness/provenance predicates and the
// serialized post-problem proposal chain (stale pendings neither suppress
// nor block; surfacing is display-time validated with provenance).
import { formatProvenanceLine, isProposalFresh, resolveProposalProvenance } from './goals/goalFreshness';
import { proposeGoalForAttemptEnd } from './goals/goalChain';
// Phase F2 imports (targeted practice planning: deterministic selection of
// an existing problem serving an active goal, durable plan lifecycle,
// fail-open learner-facing surfacing; never generates problems, never
// models the learner, never writes D evidence or F1 goal state).
import { LocalActivityPlanStore } from './practice/activityStore';
import { buildPracticeCatalog, type ActivityCatalogEntry } from './practice/activityCatalog';
import { planNextActivity } from './practice/activityPlanner';
import { linkAttemptToPlan, offerPlan, startPlan } from './practice/activityLifecycle';
import { getActivePlansForGoal, summarizePlanForLearner } from './practice/activityQueries';
// Phase F3 imports (practice evidence feedback: goal-relative progress
// over finalized D evidence, durable per-activity records, fail-open
// background evaluation; never writes D evidence, never transitions
// goals or plans, never plans the next activity).
import { LocalProgressStore } from './progress/progressStore';
import { evaluateActivityProgress } from './progress/progressEvaluation';
import { summarizeProgressForLearner } from './progress/progressQueries';

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
 * - Phase A (AI UX, presentation only): the sidebar renders coach messages
 *   as safe Markdown and learner messages as plain text; a non-modal info
 *   nudge fires only for displayed idle/hard45 interventions; an idle
 *   evaluation is suppressed while a coach question awaits the learner's
 *   reply (hard45 never suppressed). Triggers, AI contract, and persistence
 *   semantics are unchanged.
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
// Phase C state: structured problem knowledge, keyed by problemId in its
// own local file (the Problem record itself is never rewritten for this).
let classificationStore: LocalClassificationStore | null = null;
// Phase D state: append-only learner evidence + the derived learner
// profile. Both local files; the profile rebuilds from evidence, so the
// evidence file is the source of truth, never this cache.
let learnerEvidenceStore: LocalLearnerEvidenceStore | null = null;
let learnerModelStore: LocalLearnerModelStore | null = null;
// Phase F1 state: durable learner-owned goals (proposals + active goals).
// Same local-first store pattern; goals survive restart/session/problem.
let goalStore: LocalGoalStore | null = null;
// Phase F2 state: durable targeted-practice plans (one plan per suggested
// activity, linked to its active goal). Same local-first store pattern;
// plans survive restart/session/problem boundaries.
let activityPlanStore: LocalActivityPlanStore | null = null;
// Phase F3 state: durable goal-relative progress records (one per
// evaluated activity, chronological per goal). Same local-first store
// pattern; progress survives restart/session/problem boundaries.
let progressStore: LocalProgressStore | null = null;
// Phase E state: secret-free AI interaction trace ring (debug aid only,
// never learner evidence, never uploaded anywhere).
let aiTraceStore: LocalAiTraceStore | null = null;
const evaluationInFlight = new Set<string>();
let aiUnavailableNoticed = false;
// Local UI/request state for provider rate limiting (epoch ms until Send
// comes back). Never persisted, never learner state: it only tells the
// sidebar to show a countdown and disable Send, and expires on its own.
let rateLimitedUntilMs: number | null = null;
interface AiPanelState {
  status: 'idle' | 'evaluating' | 'unavailable' | 'error';
  lastMessage: string | null;
  lastAttemptId: string | null;
  /** Full available conversation for lastAttemptId (oldest first). */
  exchange: SidebarExchangeMessage[];
}
let aiPanel: AiPanelState = { status: 'idle', lastMessage: null, lastAttemptId: null, exchange: [] };

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

function activeClassificationStore(): LocalClassificationStore {
  if (!classificationStore) {
    classificationStore = new LocalClassificationStore(workspaceFsPath());
  }
  return classificationStore;
}

function activeLearnerEvidenceStore(): LocalLearnerEvidenceStore {
  if (!learnerEvidenceStore) {
    learnerEvidenceStore = new LocalLearnerEvidenceStore(workspaceFsPath());
  }
  return learnerEvidenceStore;
}

function activeLearnerModelStore(): LocalLearnerModelStore {
  if (!learnerModelStore) {
    learnerModelStore = new LocalLearnerModelStore(workspaceFsPath());
  }
  return learnerModelStore;
}

function activeAiTraceStore(): LocalAiTraceStore {
  if (!aiTraceStore) {
    aiTraceStore = new LocalAiTraceStore(workspaceFsPath());
  }
  return aiTraceStore;
}

function activeGoalStore(): LocalGoalStore {
  if (!goalStore) {
    goalStore = new LocalGoalStore(workspaceFsPath());
  }
  return goalStore;
}

function activeActivityPlanStore(): LocalActivityPlanStore {
  if (!activityPlanStore) {
    activityPlanStore = new LocalActivityPlanStore(workspaceFsPath());
  }
  return activityPlanStore;
}

function activeProgressStore(): LocalProgressStore {
  if (!progressStore) {
    progressStore = new LocalProgressStore(workspaceFsPath());
  }
  return progressStore;
}

function rebindStores(): void {
  const wsPath = workspaceFsPath();
  store = new LocalSessionStore(wsPath);
  problemStore = new LocalProblemStore(wsPath);
  attemptStore = new LocalAttemptStore(wsPath);
  checkpointStore = new LocalCheckpointStore(wsPath);
  aiStore = new LocalAiStore(wsPath);
  classificationStore = new LocalClassificationStore(wsPath);
  learnerEvidenceStore = new LocalLearnerEvidenceStore(wsPath);
  learnerModelStore = new LocalLearnerModelStore(wsPath);
  aiTraceStore = new LocalAiTraceStore(wsPath);
  goalStore = new LocalGoalStore(wsPath);
  activityPlanStore = new LocalActivityPlanStore(wsPath);
  progressStore = new LocalProgressStore(wsPath);
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

/** Extension-global state key for the shared CodeSense UI font size. */
const UI_FONT_SIZE_STATE_KEY = 'codesense.uiFontSize';

/**
 * Shared CodeSense UI font-size preference (presentation only, never
 * learner/telemetry state). Owned by the host, persisted in extension
 * global state so it survives reloads, and broadcast to every open
 * CodeSense webview. Webviews additionally keep their own last-applied
 * value for instant first paint; the host value wins on (re)connect.
 */
let uiFontSize = 'medium';
const openProblemPanels = new Set<vscode.WebviewPanel>();
let extensionContext: vscode.ExtensionContext | null = null;

function getUiFontSize(): string {
  return uiFontSize;
}

function setUiFontSize(raw: string, origin: 'sidebar' | 'panel'): void {
  const size = resolveUIFontSize(raw);
  if (size === uiFontSize) {
    return;
  }
  uiFontSize = size;
  try {
    void extensionContext?.globalState.update(UI_FONT_SIZE_STATE_KEY, size);
  } catch {
    // Persistence best-effort; the live value still broadcasts below.
  }
  for (const panel of openProblemPanels) {
    void panel.webview.postMessage({ command: 'fontSize', size });
  }
  if (origin === 'panel') {
    sidebarProvider?.pushFontSize(size);
  }
}

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
    const forVisibleAttempt =
      aiPanel.lastAttemptId !== null && aiPanel.lastAttemptId === visibleAttemptId;
    // A confirmed provider rate limit travels to the sidebar as UI state
    // only (epoch ms, never persisted). Expired values are dropped here so
    // Send re-enables even without another evaluation running.
    const rateLimitedUntil =
      rateLimitedUntilMs !== null && rateLimitedUntilMs > Date.now() ? rateLimitedUntilMs : null;
    if (rateLimitedUntil === null) {
      rateLimitedUntilMs = null;
    }
    snapshot.ai = {
      status: aiPanel.status,
      message: forVisibleAttempt ? aiPanel.lastMessage : null,
      exchange: forVisibleAttempt ? aiPanel.exchange : [],
      canReply: hasActiveProblem,
      ...(rateLimitedUntil !== null ? { rateLimitedUntil } : {}),
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
  // Phase F2 seam: link the new attempt to any offered plan for this
  // problem (background, fail-open — the attempt lifecycle above is
  // already safe and stays authoritative).
  void maybeLinkAttemptToPlan(attempt, problem);
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
  // A new attempt starts with neutral transient check-in status: a leftover
  // evaluating/error state from a previous attempt must not leak into this
  // panel (message history stays gated by attempt as before).
  aiPanel = { ...aiPanel, status: resetCheckinStatusOnAttemptBoundary(aiPanel.status) };
  refreshStatusBar();
  updateSidebar();
  void vscode.window.showInformationMessage(
    `CodeSense: problem "${problemLabel(problem)}" started. State: In Progress.`,
  );
  // Phase C: classify the problem's knowledge requirements in the
  // background. Fire-and-forget by design — classification never blocks
  // solving, never rewrites the Problem record, and stays silent on every
  // outcome (the problem is fully usable classified or not).
  void maybeClassifyProblem(problem);
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
  const panel = showProblemSetupPanel(
    {
      onStart: (input: StartInput) => handleProblemStart(input),
      onCancel: () => {
        // Nothing pending in the manual-only flow; the hook exists so a
        // future re-enabled fetch step can reset its state here.
      },
      onFontSizeChange: (size: string) => {
        setUiFontSize(size, 'panel');
      },
    },
    uiFontSize,
  );
  openProblemPanels.add(panel);
  panel.onDidDispose(() => {
    openProblemPanels.delete(panel);
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
  // Phase D+F1+F3, one authoritative sync: the F1 chain below awaits the
  // attempt→D synchronization before detection (attempt-evidence IDs are
  // stable per attempt, so even overlapping passes cannot duplicate), and
  // F3 follows it — one finalized attempt, one evidence synchronization.
  // Phase F1: derive candidate needs from the fresh model and surface at
  // most one proposal. Background and silent on every failure path; the
  // learner activates nothing implicitly (see maybeProposeGoalAfterProblemEnd).
  // Phase F3 chains after it (which awaits a D sync first), so progress
  // evaluation reads finalized evidence without adding new D writes.
  void maybeProposeGoalAfterProblemEnd(attempt, problem)
    .then(
      () => maybeEvaluateProgressAfterProblemEnd(attempt),
      (err: unknown) => {
        console.error('CodeSense: background goal chain failed', err);
      },
    );
  // Ending a problem resets the trigger lifecycle (§32): drop per-attempt state.
  activeAttempt = null;
  activeProblem = null;
  activeTrigger = null;
  // Retire transient check-in status with the attempt: a leftover
  // evaluating/error state belongs to the ended attempt, not to the empty
  // panel (message history stays gated by attempt as before).
  aiPanel = { ...aiPanel, status: resetCheckinStatusOnAttemptBoundary(aiPanel.status) };
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
    // Phase C: one-line knowledge status (fail-open; history never depends on it).
    try {
      const classification = await activeClassificationStore().getClassification(problem.problemId);
      channel.appendLine(
        classification
          ? `  knowledge: ${getClassificationStatus(classification)} (confidence: ${classification.confidence}, ontology ${classification.ontologyVersion})`
          : '  knowledge: unclassified',
      );
    } catch {
      channel.appendLine('  knowledge: unclassified');
    }
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
  choices.push({ label: '$(target) Review Learning Goals', action: 'goals' });
  choices.push({ label: '$(zap) Suggest Next Practice Activity', action: 'practice' });
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
    case 'goals':
      void reviewLearningGoals();
      break;
    case 'practice':
      void suggestNextActivityFlow();
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
  const evaluation = pollTriggers(trigger, Date.now(), resolveIdleThresholdMs());
  if (!evaluation.eligible || evaluation.kind === null) {
    return;
  }
  if (evaluation.kind === 'idle') {
    // Phase A idle suppression: when the latest CodeSense intervention is a
    // question still awaiting the learner's reply, do not stack another idle
    // evaluation on top of it. The trigger epoch stays consumed (no refire);
    // the learner's reply drives the next turn. Fail-open: store errors must
    // never block evaluations. hard45 is NEVER suppressed (else branch).
    if (await hasUnresolvedCoachQuestion(attempt.attemptId)) {
      console.log('CodeSense: idle evaluation suppressed — awaiting learner reply to the coach.');
      return;
    }
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
  preReserved = false,
): Promise<void> {
  const config = readAiConfig();
  if (!config.enabled) {
    aiPanel = { status: 'unavailable', lastMessage: null, lastAttemptId: null, exchange: [] };
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
  // With preReserved, the caller already holds this attempt's reservation
  // (added synchronously to close the back-to-back race); skipping the
  // duplicate check here is what lets the reserved evaluation proceed.
  if (!preReserved) {
    if (!tryReserveEvaluation(evaluationInFlight, attempt.attemptId)) {
      return;
    }
  }
  try {
    aiPanel = {
      status: 'evaluating',
      lastMessage: aiPanel.lastAttemptId === attempt.attemptId ? aiPanel.lastMessage : null,
      lastAttemptId: attempt.attemptId,
      // Mirror the message rule: a new attempt starts with no visible
      // exchange until its own conversation is (re)loaded below.
      exchange: aiPanel.lastAttemptId === attempt.attemptId ? aiPanel.exchange : [],
    };
    updateSidebar();
    const outcome: EvaluationOutcome = await runAiEvaluation(
      {
        nowIso: () => new Date().toISOString(),
        getActiveAttempt: () =>
          activeAttempt && activeProblem
            ? { attempt: activeAttempt, problem: activeProblem }
            : null,
        buildContext: async (target, targetProblem) => buildEvaluationContext(target, targetProblem, kind),
        reasoner: new HttpChatReasoner({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }),
        saveEvaluation: (evaluation) => activeAiStore().saveEvaluation(evaluation),
        appendConversation: (message) => activeAiStore().appendConversation(message),
        isAttemptStillActive: (attemptId) => activeAttempt?.attemptId === attemptId,
        timeoutMs: config.timeoutMs,
        // Phase E developer trace: secret-free stage events into the local
        // capped ring. Fail-open — a trace failure never affects coaching.
        onTrace: (event) => {
          void (async () => {
            try {
              await activeAiTraceStore().appendTrace({
                traceId: event.traceId,
                at: new Date().toISOString(),
                stage: event.stage,
                attemptId: event.attemptId,
                evaluationId: event.evaluationId,
                triggerKind: event.triggerKind,
                summary: event.summary.slice(0, 300),
                ...(event.preview !== undefined ? { preview: event.preview.slice(0, 500) } : {}),
              });
            } catch (err) {
              console.error('CodeSense: failed to persist AI trace event', err);
            }
          })();
        },
      },
      { attemptId: attempt.attemptId, triggerKind: kind, reason },
    );
    // Recency gate for panel STATUS (message content already has the
    // `displayed` guard below): only the currently visible attempt may
    // move the check-in status, so a slow completion landing after the
    // learner moved on can never plant or clear a banner for another
    // context. Every completion stays in logs + persisted history.
    const completionVisible = (activeAttempt?.attemptId ?? null) === attempt.attemptId;
    if (outcome.status === 'evaluated') {
      const evaluation = outcome.evaluation;
      // A completed evaluation proves the provider is answering again, so a
      // stale rate-limit countdown is lifted for the current attempt instead
      // of lingering until expiry.
      if (evaluation.attemptId === activeAttempt?.attemptId) {
        rateLimitedUntilMs = null;
      }
      recordEvent(session, 'ai.evaluated', 'session', {
        evaluationId: evaluation.evaluationId,
        attemptId: evaluation.attemptId,
        triggerKind: evaluation.triggerKind,
        shouldIntervene: evaluation.shouldIntervene,
        interventionType: evaluation.interventionType,
      });
      // Phase D: feed grounded diagnoses to the learner model in the
      // background. Silent evaluations produce no evidence by design.
      if (problem) {
        void maybeSyncEvaluationToLearnerModel(evaluation, problem);
      }
      // Phase E: deterministic turn summary (diagnosis + recommendation)
      // into the debug trace. Pure derivation, fail-open, coaching
      // behavior unchanged — this only records WHY the turn looked the
      // way it did for future debugging.
      void (async () => {
        try {
          if (!problem) {
            return;
          }
          const turned =
            (await activeAttemptStore().getAttempt(evaluation.attemptId).catch(() => null)) ??
            (live.attemptId === evaluation.attemptId ? live : null);
          if (!turned) {
            return;
          }
          const briefing = await loadCoachContext(turned, problem, kind);
          if (!briefing) {
            return;
          }
          const { diagnosis, decision } = summarizeCoachingTurn({
            evaluation,
            coachContext: briefing,
            attemptState: turned.currentState,
          });
          await activeAiTraceStore().appendTrace({
            traceId: `trace_${evaluation.attemptId}_${Date.now()}_turn`,
            at: new Date().toISOString(),
            stage: 'completed',
            attemptId: evaluation.attemptId,
            evaluationId: evaluation.evaluationId,
            triggerKind: kind,
            summary:
              `Turn summary: ${diagnosis.difficultyType}/${diagnosis.confidence} ` +
              `objective=${diagnosis.pedagogicalObjective} proposed=${decision.proposed}`,
          });
        } catch (err) {
          console.error('CodeSense: failed to trace coaching turn summary', err);
        }
      })();
      if (outcome.displayed) {
        aiPanel = { status: nextCheckinStatus(aiPanel.status, 'evaluated-displayed', completionVisible), lastMessage: evaluation.message, lastAttemptId: evaluation.attemptId, exchange: aiPanel.exchange };
      } else {
        // Evaluated fine, but the learner moved on: persist (done above),
        // never display inside the new attempt. Panel keeps prior state.
        aiPanel = { status: nextCheckinStatus(aiPanel.status, 'evaluated-silent', completionVisible), lastMessage: aiPanel.lastMessage, lastAttemptId: aiPanel.lastAttemptId, exchange: aiPanel.exchange };
      }
      // Phase A proactive notification: a subtle native nudge ONLY when a
      // trigger-driven (idle/hard45) evaluation produced a learner-facing
      // intervention on the still-current attempt. Reply turns, manual
      // check-ins, NONE/silent outcomes, failures, and stale results stay
      // silent (see shouldNotifyProactiveIntervention).
      if (shouldNotifyProactiveIntervention(kind, outcome)) {
        void vscode.window.showInformationMessage(
          'CodeSense: your coach left a new message — see the AI Coach panel in the sidebar.',
        );
      }
    } else if (outcome.status === 'failed') {
      console.error(`CodeSense: AI evaluation failed (${outcome.reason}): ${outcome.detail}`);
      aiPanel = { status: nextCheckinStatus(aiPanel.status, 'failed', completionVisible), lastMessage: aiPanel.lastMessage, lastAttemptId: aiPanel.lastAttemptId, exchange: aiPanel.exchange };
      if (outcome.reason === 'rate-limited') {
        // Confirmed provider rate limit (HTTP 429): enter the local UI
        // cooldown — sidebar shows a countdown and disables Send until it
        // lifts. No popup: the inline countdown is the specific message.
        // Telemetry and the failure panel state behave exactly as before.
        rateLimitedUntilMs = Date.now() + resolveRateLimitCooldownMs(outcome.retryAfterMs);
      } else if (kind === 'manual' || kind === 'reply') {
        // User-initiated requests get a visible failure notice (triggered
        // evaluations stay panel-only to avoid nagging); the learner's
        // already-submitted reply is untouched in the store.
        void vscode.window.showWarningMessage(
          `CodeSense AI check-in failed (${outcome.reason}). Telemetry is unaffected; retry any time.`,
        );
      }
    }
    // Re-render the exchange so an assistant response appears as soon as it
    // is persisted (no-op when nothing new was appended).
    await refreshAiExchange(attempt.attemptId);
  } finally {
    releaseEvaluation(evaluationInFlight, attempt.attemptId);
    updateSidebar();
  }
}

/**
 * Phase C background classification for one problem.
 * Never throws: every failure mode degrades to "problem stays
 * unclassified" plus a console log. Never touches the Problem record,
 * never notifies the learner, never models learner ability.
 */
async function maybeClassifyProblem(problem: Problem): Promise<void> {
  try {
    const config = readAiConfig();
    if (!config.enabled) {
      // No AI configured: the problem simply stays unclassified (usable).
      // Deliberately silent — classification is infrastructure, not a nag.
      return;
    }
    await runProblemClassification(
      {
        reasoner: new HttpProblemClassificationReasoner({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
        }),
        store: activeClassificationStore(),
        graph: getDefaultKnowledgeGraph(),
        model: config.model,
        nowIso: () => new Date().toISOString(),
        timeoutMs: config.timeoutMs,
      },
      problem,
    );
  } catch (err) {
    console.error('CodeSense: background problem classification failed', err);
  }
}

/**
 * Phase D background learner-model feeds. Each helper gathers its inputs
 * best-effort, syncs evidence + derived profile, and NEVER throws: a
 * learner-model failure degrades to "no model update" plus a console log.
 * Never awaited by lifecycle code (always `void`), so solving, coaching,
 * and transitions proceed identically with or without a learner model.
 */
async function maybeSyncAttemptToLearnerModel(attempt: Attempt, problem: Problem): Promise<void> {
  try {
    const [classification, evaluations] = await Promise.all([
      (async () => problem.classification ?? (await activeClassificationStore().getClassification(problem.problemId).catch(() => null)))(),
      activeAiStore().listEvaluationsForAttempt(attempt.attemptId).catch(() => []),
    ]);
    await syncAttemptToLearnerModel(
      {
        evidenceStore: activeLearnerEvidenceStore(),
        modelStore: activeLearnerModelStore(),
        graph: getDefaultKnowledgeGraph(),
        nowIso: () => new Date().toISOString(),
      },
      { attempt, problem, classification, evaluations },
    );
  } catch (err) {
    console.error('CodeSense: background learner-model attempt sync failed', err);
  }
}

async function maybeSyncEvaluationToLearnerModel(
  evaluation: AIEvaluation,
  problem: Problem,
): Promise<void> {
  try {
    // Anchor to the evaluation's OWN attempt (stale-safe: the learner may
    // have moved on while the model was thinking).
    const attempt = await activeAttemptStore().getAttempt(evaluation.attemptId).catch(() => null);
    if (!attempt) {
      return;
    }
    const classification = await activeClassificationStore()
      .getClassification(problem.problemId)
      .catch(() => null);
    await syncEvaluationToLearnerModel(
      {
        evidenceStore: activeLearnerEvidenceStore(),
        modelStore: activeLearnerModelStore(),
        graph: getDefaultKnowledgeGraph(),
        nowIso: () => new Date().toISOString(),
      },
      { evaluation, attempt, classification: problem.classification ?? classification },
    );
  } catch (err) {
    console.error('CodeSense: background learner-model evaluation sync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Phase F1: learning needs + learner-owned goals (background, fail-open)
// ---------------------------------------------------------------------------

/**
 * Runs the End Problem goal chain in the background: await the attempt
 * sync so detection reads the fresh profile, then run the serialized
 * proposal chain (single-flight across overlapping problem ends, stale
 * pendings neither suppress nor block), and surface at most one fresh
 * proposal. Never throws; every failure degrades to silence.
 */
async function maybeProposeGoalAfterProblemEnd(attempt: Attempt, problem: Problem): Promise<void> {
  try {
    await maybeSyncAttemptToLearnerModel(attempt, problem);
    const result = await proposeGoalForAttemptEnd({
      goalStore: activeGoalStore(),
      modelStore: activeLearnerModelStore(),
      graph: getDefaultKnowledgeGraph(),
      nowIso: () => new Date().toISOString(),
    });
    if (result.action === 'proposed') {
      void surfaceGoalProposal(result.proposal.goalId);
    } else if (result.action === 'none' && result.reason === 'error') {
      console.error('CodeSense: background goal proposal failed');
    }
    // suppressed-pending: the fresh pending proposal stays discoverable via
    // review; no second popup (anti-nag).
  } catch (err) {
    console.error('CodeSense: background goal proposal failed', err);
  }
}

/** Present one pending proposal with Accept / Modify / Not-now actions. */
async function surfaceGoalProposal(goalId: string): Promise<void> {
  try {
    const store = activeGoalStore();
    const proposal = await store.getGoal(goalId).catch(() => null);
    if (!proposal || proposal.status !== 'proposed') {
      return;
    }
    const graph = getDefaultKnowledgeGraph();
    const [profile, evidence, problems] = await Promise.all([
      activeLearnerModelStore().loadProfile().catch(() => null),
      activeLearnerEvidenceStore().listEvidence().catch(() => []),
      activeProblemStore().listProblems().catch(() => []),
    ]);
    const needs =
      profile !== null
        ? detectLearningNeeds({ profile, graph, now: new Date().toISOString(), limit: 10 })
        : [];
    // Display-time validation: never present a stale suggestion as current
    // advice. Learner-owned requests (no need) are always presentable.
    if (!isProposalFresh(proposal, needs)) {
      console.log(
        `CodeSense: skipping stale goal suggestion ${proposal.goalId} (its need no longer detects).`,
      );
      return;
    }
    let detail = proposal.description;
    const need = needs.find((candidate) => candidate.needId === proposal.evidenceBasis.needId) ?? null;
    if (profile && need) {
      const explanation = explainProposal(need, evidence, graph);
      detail = `${proposal.description}\n${explanation.summary}`;
      if (explanation.uncertainty) {
        detail += `\n${explanation.uncertainty}`;
      }
    }
    // Provenance: every surfaced suggestion says what it is based on, so a
    // previous attempt's suggestion can never read as the current one.
    const provenance = resolveProposalProvenance(proposal, evidence);
    const titles = new Map(problems.map((problem) => [problem.problemId, problem.title] as const));
    const provenanceLine = formatProvenanceLine(proposal, provenance, (problemId) => {
      const title = titles.get(problemId) ?? null;
      return typeof title === 'string' ? title : null;
    });
    if (provenanceLine !== null) {
      detail += `\n${provenanceLine}`;
    }
    const pick = await vscode.window.showInformationMessage(
      `CodeSense learning goal suggestion:\n${detail}`,
      'Start goal',
      'Modify…',
      'Not now',
    );
    if (pick === 'Start goal') {
      await decideGoal(proposal.goalId, 'accept');
    } else if (pick === 'Modify…') {
      const text = await vscode.window.showInputBox({
        prompt: 'Adjust the goal description (evidence basis is kept)',
        value: proposal.description,
        validateInput: (value) =>
          value.trim().length > 0 ? null : 'Describe the goal in a few words.',
      });
      if (text !== undefined) {
        await decideGoal(proposal.goalId, 'modify', text);
      }
    } else if (pick === 'Not now') {
      await decideGoal(proposal.goalId, 'reject');
    }
  } catch (err) {
    console.error('CodeSense: failed to surface goal proposal', err);
  }
}

/** Apply one learner decision to a proposed goal (accept/modify/reject). */
async function decideGoal(goalId: string, decision: 'accept' | 'modify' | 'reject', text?: string): Promise<void> {
  try {
    const store = activeGoalStore();
    const proposal = await store.getGoal(goalId).catch(() => null);
    if (!proposal || proposal.status !== 'proposed') {
      return;
    }
    const now = new Date().toISOString();
    if (decision === 'accept') {
      const profile = await activeLearnerModelStore().loadProfile().catch(() => null);
      if (!profile) {
        return;
      }
      await store.upsertGoal(acceptGoal(proposal, { profile, now }));
      void vscode.window.showInformationMessage(`CodeSense: goal active — "${proposal.description}"`);
    } else if (decision === 'modify') {
      const profile = await activeLearnerModelStore().loadProfile().catch(() => null);
      if (!profile || text === undefined) {
        return;
      }
      await store.upsertGoal(
        modifyGoal(proposal, { description: text, learnerStatement: text }, { profile, now }),
      );
      void vscode.window.showInformationMessage(`CodeSense: goal active — "${text.trim()}"`);
    } else {
      const profile = await activeLearnerModelStore().loadProfile().catch(() => null);
      await store.upsertGoal(
        rejectGoal(proposal, { profileUpdatedAt: profile?.updatedAt ?? now, now }),
      );
    }
  } catch (err) {
    console.error('CodeSense: failed to record goal decision', err);
  }
}

/** Review surface: active goals + pending proposals + learner-created goals. */
async function reviewLearningGoals(): Promise<void> {
  try {
    const store = activeGoalStore();
    const goals = await store.listGoals().catch(() => []);
    interface GoalChoice extends vscode.QuickPickItem {
      action: string;
      goalId?: string;
    }
    // Provenance for pending proposals (best-effort; review stays usable
    // without it). Stale pendings are annotated, never hidden — the
    // learner still owns the decision.
    const [reviewProfile, reviewEvidence, reviewProblems] = await Promise.all([
      activeLearnerModelStore().loadProfile().catch(() => null),
      activeLearnerEvidenceStore().listEvidence().catch(() => []),
      activeProblemStore().listProblems().catch(() => []),
    ]);
    const reviewNeeds =
      reviewProfile !== null
        ? detectLearningNeeds({
            profile: reviewProfile,
            graph: getDefaultKnowledgeGraph(),
            now: new Date().toISOString(),
            limit: 10,
          })
        : [];
    const reviewTitles = new Map(
      reviewProblems.map((problem) => [problem.problemId, problem.title] as const),
    );
    const proposalSuffix = (goal: LearningGoal): string => {
      if (!isProposalFresh(goal, reviewNeeds)) {
        return 'awaiting your decision · based on earlier evidence';
      }
      const line = formatProvenanceLine(
        goal,
        resolveProposalProvenance(goal, reviewEvidence),
        (problemId) => reviewTitles.get(problemId) ?? null,
      );
      return line !== null ? `awaiting your decision · ${line}` : 'awaiting your decision';
    };
    const choices: GoalChoice[] = [];
    for (const goal of goals.filter((g) => g.status === 'active' || g.status === 'paused')) {
      choices.push({
        label: `$(${goal.status === 'active' ? 'target' : 'debug-pause'}) ${goal.description}`,
        description: `${goal.dimension} · ${goal.source === 'learner-requested' ? 'my goal' : 'from evidence'}`,
        action: 'inspect',
        goalId: goal.goalId,
      });
    }
    for (const goal of goals.filter((g) => g.status === 'proposed')) {
      choices.push({
        label: `$(question) Proposed: ${goal.description}`,
        description: proposalSuffix(goal),
        action: 'decide',
        goalId: goal.goalId,
      });
    }
    choices.push({ label: '$(plus) Set a new goal…', action: 'create' });
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'CodeSense learning goals' });
    if (!picked) {
      return;
    }
    if (picked.action === 'create') {
      void createLearnerGoalFlow();
      return;
    }
    if (!picked.goalId) {
      return;
    }
    const goal = await store.getGoal(picked.goalId).catch(() => null);
    if (!goal) {
      return;
    }
    if (picked.action === 'decide') {
      void surfaceGoalProposal(goal.goalId);
      return;
    }
    await inspectGoal(goal);
  } catch (err) {
    console.error('CodeSense: failed to review learning goals', err);
  }
}

async function inspectGoal(goal: LearningGoal): Promise<void> {
  interface GoalActionChoice extends vscode.QuickPickItem {
    action: string;
  }
  const choices: GoalActionChoice[] = [];
  if (goal.status === 'active') {
    choices.push({ label: 'Suggest next activity', action: 'practice' });
    choices.push({ label: 'Pause goal', action: 'pause' });
    choices.push({ label: 'Mark achieved', action: 'achieve' });
    choices.push({ label: 'Abandon goal', action: 'abandon' });
  } else if (goal.status === 'paused') {
    choices.push({ label: 'Resume goal', action: 'resume' });
    choices.push({ label: 'Abandon goal', action: 'abandon' });
  } else {
    return;
  }
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: goal.description });
  if (!picked) {
    return;
  }
  if (picked.action === 'practice') {
    void suggestNextActivityFlow(goal.goalId);
    return;
  }
  try {
    const store = activeGoalStore();
    const now = new Date().toISOString();
    const current = await store.getGoal(goal.goalId).catch(() => null);
    if (!current || (current.status !== 'active' && current.status !== 'paused')) {
      return;
    }
    if (picked.action === 'pause') {
      await store.upsertGoal(pauseGoal(current, now));
    } else if (picked.action === 'resume') {
      await store.upsertGoal(resumeGoal(current, now));
    } else if (picked.action === 'achieve') {
      await store.upsertGoal(completeGoal(current, now));
    } else if (picked.action === 'abandon') {
      await store.upsertGoal(abandonGoal(current, now));
    }
    void vscode.window.showInformationMessage(`CodeSense: goal updated (${picked.action}).`);
  } catch (err) {
    console.error('CodeSense: failed to update learning goal', err);
  }
}

/** Guided creation of a learner-requested goal (explicit intent, no evidence needed). */
async function createLearnerGoalFlow(): Promise<void> {
  try {
    const description = await vscode.window.showInputBox({
      prompt: 'What do you want to get better at? (e.g. "DP on grids")',
      validateInput: (value) => (value.trim().length > 0 ? null : 'Describe the goal in a few words.'),
    });
    if (description === undefined || description.trim().length === 0) {
      return;
    }
    const dimensions = [
      'recognition',
      'conceptual',
      'implementation',
      'debugging',
      'transfer',
      'independence',
    ] as const;
    const pickedDimension = await vscode.window.showQuickPick([...dimensions], {
      placeHolder: 'Which kind of capability is this about?',
    });
    if (pickedDimension === undefined || !isKnownEvidenceDimension(pickedDimension)) {
      return;
    }
    const entityInput = await vscode.window.showInputBox({
      prompt: 'Related topic, concept, or technique (optional — e.g. "dynamic programming")',
    });
    const graph = getDefaultKnowledgeGraph();
    let entityIds: string[] = [];
    if (entityInput !== undefined && entityInput.trim().length > 0) {
      const resolved = graph.findByAlias(entityInput.trim()) ?? graph.findByName(entityInput.trim());
      if (resolved) {
        entityIds = [resolved.id];
      }
    }
    const profile = await activeLearnerModelStore().loadProfile().catch(() => null);
    const now = new Date().toISOString();
    const draft = proposeGoalFromRequest(
      { entityIds, dimension: pickedDimension, learnerStatement: description.trim() },
      { graph, profile, now },
    );
    if (!draft) {
      return;
    }
    if (findConflictingGoal(await activeGoalStore().listGoals().catch(() => []), draft.targetKey)) {
      void vscode.window.showInformationMessage('CodeSense: you already have a goal covering that target.');
      return;
    }
    // Explicit creation IS the learner decision: activate immediately with
    // a baseline, preserving the request as provenance.
    const store = activeGoalStore();
    await store.upsertGoal(draft);
    const saved = await store.getGoal(draft.goalId).catch(() => null);
    if (saved && profile) {
      await store.upsertGoal(acceptGoal(saved, { profile, now, note: 'created directly by learner' }));
    }
    void vscode.window.showInformationMessage(`CodeSense: goal active — "${draft.description}"`);
  } catch (err) {
    console.error('CodeSense: failed to create learning goal', err);
  }
}

// ---------------------------------------------------------------------------
// Phase F2: targeted practice suggestions (background, fail-open)
// ---------------------------------------------------------------------------

/** Build the F2 catalog from stored problems + their classifications. */
async function loadPracticeCatalog(): Promise<ActivityCatalogEntry[]> {
  try {
    const problems = await activeProblemStore().listProblems().catch(() => []);
    const resolved = await Promise.all(
      problems.map(async (problem) => {
        const stored = await activeClassificationStore()
          .getClassification(problem.problemId)
          .catch(() => null);
        return { problem, classification: problem.classification ?? stored };
      }),
    );
    return buildPracticeCatalog(
      resolved.map((entry) => entry.problem),
      resolved.map((entry) => entry.classification),
    );
  } catch (err) {
    console.error('CodeSense: failed to load practice catalog', err);
    return [];
  }
}

/** All attempts across known problems (bounded by problem count). */
async function loadAllAttempts(): Promise<Attempt[]> {
  try {
    const problems = await activeProblemStore().listProblems().catch(() => []);
    const perProblem = await Promise.all(
      problems.map((problem) =>
        activeAttemptStore().listAttemptsForProblem(problem.problemId).catch(() => []),
      ),
    );
    return perProblem.flat();
  } catch (err) {
    console.error('CodeSense: failed to load attempts for practice planning', err);
    return [];
  }
}

/**
 * Suggest the next targeted practice activity for one active goal.
 * Deterministic selection over EXISTING problems; the plan is persisted
 * and surfaced (offered) — never auto-started, never generated content.
 * Never throws; every failure degrades to an honest message.
 */
async function suggestNextActivityFlow(goalId?: string): Promise<void> {
  try {
    const goals = await activeGoalStore().listGoals().catch(() => []);
    const active = getActiveGoals(goals);
    if (active.length === 0) {
      void vscode.window.showInformationMessage(
        'CodeSense: no active learning goal yet. Review or set a goal first, then ask for practice.',
      );
      return;
    }
    let goal = goalId !== undefined ? (active.find((candidate) => candidate.goalId === goalId) ?? null) : null;
    if (goal === null && goalId === undefined && active.length === 1 && active[0] !== undefined) {
      goal = active[0];
    }
    if (goal === null && goalId === undefined) {
      interface GoalPick extends vscode.QuickPickItem {
        goalId: string;
      }
      const picked = await vscode.window.showQuickPick(
        active.map(
          (candidate): GoalPick => ({
            label: candidate.description,
            description: `${candidate.dimension} · ${candidate.source === 'learner-requested' ? 'my goal' : 'from evidence'}`,
            goalId: candidate.goalId,
          }),
        ),
        { placeHolder: 'Which goal should the practice serve?' },
      );
      if (!picked) {
        return;
      }
      goal = active.find((candidate) => candidate.goalId === picked.goalId) ?? null;
    }
    if (goal === null) {
      return;
    }
    const [catalog, profile, evidence, attempts, priorPlans] = await Promise.all([
      loadPracticeCatalog(),
      activeLearnerModelStore().loadProfile().catch(() => null),
      activeLearnerEvidenceStore().listEvidence().catch(() => []),
      loadAllAttempts(),
      activeActivityPlanStore().listPlans().catch(() => []),
    ]);
    const inFlight = getActivePlansForGoal(priorPlans, goal.goalId);
    if (inFlight.length > 0 && inFlight[0] !== undefined) {
      const current = inFlight[0];
      const summary = summarizePlanForLearner(current, {
        goalDescription: goal.description,
        siblingPlans: priorPlans,
      });
      const reopen = await vscode.window.showInformationMessage(
        `CodeSense practice (already suggested):\n${summary.title}\n${summary.purposeLabel}\n${summary.why}`,
        'Open problem',
        'Later',
      );
      if (reopen === 'Open problem') {
        const problem = await activeProblemStore().getProblem(current.problemId).catch(() => null);
        if (problem) {
          void vscode.env.openExternal(vscode.Uri.parse(problem.canonicalUrl));
        }
      }
      return;
    }
    const outcome = planNextActivity({
      goal,
      graph: getDefaultKnowledgeGraph(),
      profile,
      evidence,
      catalog,
      attempts,
      priorPlans,
      now: new Date().toISOString(),
    });
    if (outcome.status === 'no-plan') {
      void vscode.window.showInformationMessage(
        `CodeSense practice: no suggestion right now (${outcome.reason}).`,
      );
      return;
    }
    const selected = outcome.plans[0];
    if (selected === undefined) {
      return;
    }
    const planStore = activeActivityPlanStore();
    await planStore
      .upsertPlan(selected)
      .catch((err: unknown) => {
        console.error('CodeSense: failed to persist activity plan', err);
      });
    const offered = offerPlan(selected, new Date().toISOString());
    await planStore
      .upsertPlan(offered)
      .catch((err: unknown) => {
        console.error('CodeSense: failed to persist offered plan', err);
      });
    const shown = summarizePlanForLearner(offered, {
      goalDescription: goal.description,
      siblingPlans: [offered],
    });
    const pick = await vscode.window.showInformationMessage(
      `CodeSense practice suggestion:\n${shown.title}\n${shown.purposeLabel}\n${shown.why}\nSupports: ${shown.goalDescription ?? goal.description}`,
      'Open problem',
      'Mark started',
      'Later',
    );
    if (pick === 'Open problem') {
      const problem = await activeProblemStore().getProblem(offered.problemId).catch(() => null);
      if (problem) {
        void vscode.env.openExternal(vscode.Uri.parse(problem.canonicalUrl));
      }
    } else if (pick === 'Mark started') {
      try {
        await planStore.upsertPlan(startPlan(offered, new Date().toISOString()));
        void vscode.window.showInformationMessage(
          'CodeSense: practice marked as started. Your attempt stays linked to the goal.',
        );
      } catch (err) {
        console.error('CodeSense: failed to mark plan started', err);
      }
    }
  } catch (err) {
    console.error('CodeSense: failed to suggest practice activity', err);
  }
}

/**
 * Evidence-feedback seam: when an attempt starts on a problem with an
 * offered/started plan for an active goal, record the association. The
 * attempt lifecycle is untouched — only the plan gains a linkedAttemptId,
 * so later evidence stays attributable to activity → goal.
 */
async function maybeLinkAttemptToPlan(attempt: Attempt, problem: Problem): Promise<void> {
  try {
    const [goals, plans] = await Promise.all([
      activeGoalStore().listGoals().catch(() => []),
      activeActivityPlanStore().listPlans().catch(() => []),
    ]);
    const activeIds = new Set(getActiveGoals(goals).map((candidate) => candidate.goalId));
    const candidate = plans.find(
      (plan) =>
        plan.problemId === problem.problemId &&
        activeIds.has(plan.goalId) &&
        (plan.status === 'offered' || plan.status === 'started') &&
        plan.linkedAttemptId === null,
    );
    if (!candidate) {
      return;
    }
    await activeActivityPlanStore().upsertPlan(
      linkAttemptToPlan(candidate, attempt, new Date().toISOString()),
    );
  } catch (err) {
    console.error('CodeSense: failed to link attempt to practice plan', err);
  }
}

// ---------------------------------------------------------------------------
// Phase F3: practice evidence feedback & goal reassessment (background, fail-open)
// ---------------------------------------------------------------------------

/**
 * Evaluates goal-relative progress for activity plans linked to a
 * finalized attempt. Reads finalized stores only — adds no D evidence,
 * transitions no goals or plans, selects no next activity. Persists
 * evaluated records; surfaces only review-grade signals (the learner
 * decides what happens to their goals). Never throws.
 */
async function maybeEvaluateProgressAfterProblemEnd(attempt: Attempt): Promise<void> {
  try {
    const [goals, plans, evidence, profile, priorProgress] = await Promise.all([
      activeGoalStore().listGoals().catch(() => []),
      activeActivityPlanStore().listPlans().catch(() => []),
      activeLearnerEvidenceStore().listEvidence().catch(() => []),
      activeLearnerModelStore().loadProfile().catch(() => null),
      activeProgressStore().listProgress().catch(() => []),
    ]);
    const linked = plans.filter(
      (plan) =>
        plan.linkedAttemptId === attempt.attemptId &&
        (plan.status === 'offered' || plan.status === 'started' || plan.status === 'completed'),
    );
    if (linked.length === 0) {
      return;
    }
    const goalById = new Map(goals.map((goal) => [goal.goalId, goal] as const));
    const store = activeProgressStore();
    let progressed = [...priorProgress];
    for (const plan of linked) {
      const goal = goalById.get(plan.goalId) ?? null;
      if (!goal) {
        continue;
      }
      const outcome = evaluateActivityProgress({
        goal,
        plan,
        attempt,
        evidence,
        profile,
        graph: getDefaultKnowledgeGraph(),
        priorProgress: progressed,
        now: new Date().toISOString(),
      });
      if (outcome.status !== 'evaluated' || !outcome.updated) {
        continue;
      }
      await store.upsertProgress(outcome.progress).catch((err: unknown) => {
        console.error('CodeSense: failed to persist activity progress', err);
      });
      progressed = [
        ...progressed.filter((entry) => entry.progressId !== outcome.progress.progressId),
        outcome.progress,
      ];
      if (
        outcome.progress.reassessment === 'sufficient-evidence-for-review' ||
        outcome.progress.reassessment === 'review-goal'
      ) {
        const summary = summarizeProgressForLearner(outcome.progress, {
          goalDescription: goal.description,
        });
        const pick = await vscode.window.showInformationMessage(
          `CodeSense goal update:\n${summary.summary}\n${summary.nextStep}`,
          'Review goal',
          'Later',
        );
        if (pick === 'Review goal') {
          void reviewLearningGoals();
        }
      }
    }
  } catch (err) {
    console.error('CodeSense: failed to evaluate activity progress', err);
  }
}

/** Phase D: bounded learner-model digest for the coach context (fail-open). */
async function loadLearnerNotes(): Promise<string[]> {
  try {
    const profile = await activeLearnerModelStore().loadProfile();
    if (!profile) {
      return [];
    }
    const notes = buildLearnerNotesForPrompt(profile);
    // Phase F1: append the bounded active-goal digest (same channel, same
    // caps philosophy). Zero changes to Phase E files were needed.
    try {
      const goals = await activeGoalStore().listGoals().catch(() => []);
      return [...notes, ...summarizeGoalsForPrompt(goals)];
    } catch {
      return notes;
    }
  } catch (err) {
    console.error('CodeSense: failed to load learner model for AI context; continuing without it', err);
    return [];
  }
}

/**
 * Phase E: deterministic coach context for one attempt (fail-open, null on
 * any failure). Shared by context assembly and post-evaluation tracing so
 * both see the same briefing inputs.
 */
async function loadCoachContext(
  target: Attempt,
  targetProblem: Problem,
  triggerKind: string,
): Promise<CoachContext | null> {
  try {
    const attemptStore = activeAttemptStore();
    const problemAttempts = await attemptStore.listAttemptsForProblem(targetProblem.problemId);
    const previousAttempts = problemAttempts.filter(
      (a) => a.attemptId !== target.attemptId && a.completedAt !== null,
    );
    const [storedClassification, evaluations, profile, evidence, conversation] = await Promise.all([
      activeClassificationStore().getClassification(targetProblem.problemId).catch(() => null),
      activeAiStore().listEvaluationsForAttempt(target.attemptId).catch(() => []),
      activeLearnerModelStore().loadProfile().catch(() => null),
      activeLearnerEvidenceStore().listEvidence().catch(() => []),
      activeAiStore().listConversation(target.attemptId).catch(() => []),
    ]);
    // Prefer the problem-attached classification (same precedence as the
    // Phase D feeds) so briefing and evidence agree on problem knowledge.
    const classification = targetProblem.classification ?? storedClassification;
    return buildCoachContext({
      attempt: target,
      problem: targetProblem,
      classification: targetProblem.classification ?? classification,
      profile,
      evidence,
      evaluations,
      conversation,
      previousAttempts,
      triggerKind,
    });
  } catch (err) {
    console.error('CodeSense: failed to build coach context; continuing without it', err);
    return null;
  }
}

/**
 * Assemble the scoped evaluation context from existing stores. Deterministic
 * reconstruction owns the source — the model only ever receives it.
 */
async function buildEvaluationContext(
  target: Attempt,
  targetProblem: Problem,
  triggerKind?: string,
) {
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
  // Phase C: attach the problem's structured knowledge when classified.
  // Fail-open — an unreadable store means "coach from the statement alone",
  // exactly the pre-Phase-C behavior; never learner state, never mastery.
  let classification = null;
  try {
    classification = await activeClassificationStore().getClassification(targetProblem.problemId);
  } catch (err) {
    console.error('CodeSense: failed to load problem classification; continuing without it', err);
  }
  // Phase D: bounded learner-model digest for the coach (Learner Model →
  // AI context → Coach). Fail-open to no notes — identical to pre-Phase-D.
  const learnerNotes = await loadLearnerNotes();
  // Phase E: deterministic learner-aware coaching briefing (bounded slice
  // of learner state + previous-intervention situation). Fail-open to no
  // briefing — identical to pre-Phase-E.
  const coachBriefing = await loadCoachContext(target, targetProblem, triggerKind ?? 'manual');
  return buildAIContext({
    problem: targetProblem,
    attempt: target,
    previousAttempts,
    edits,
    checkpoints,
    sessionEvents,
    conversation,
    ...(classification ? { classification } : {}),
    ...(learnerNotes.length > 0 ? { learnerContext: { notes: learnerNotes } } : {}),
    ...(coachBriefing ? { coachBriefing } : {}),
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

/**
 * Phase A idle suppression probe: true when the attempt's latest CodeSense
 * intervention is a question still awaiting the learner's reply (existing
 * conversation + evaluation state only). Fail-open — store errors allow the
 * evaluation so suppression can never silence the coach by accident.
 */
async function hasUnresolvedCoachQuestion(attemptId: string): Promise<boolean> {
  try {
    const [conversation, evaluations] = await Promise.all([
      activeAiStore().listConversation(attemptId),
      activeAiStore().listEvaluationsForAttempt(attemptId),
    ]);
    return isAwaitingLearnerResponse(conversation, evaluations);
  } catch (err) {
    console.error('CodeSense: failed to check conversation state; allowing idle evaluation', err);
    return false;
  }
}

/**
 * Reload the sidebar conversation tail for one attempt and re-render.
 * Skipped silently when the attempt is no longer active (endProblem and
 * deactivate already refresh the sidebar for their own transitions).
 */
async function refreshAiExchange(attemptId: string): Promise<void> {
  if (activeAttempt?.attemptId !== attemptId) {
    return;
  }
  try {
    const [all, evaluations] = await Promise.all([
      activeAiStore().listConversation(attemptId),
      activeAiStore().listEvaluationsForAttempt(attemptId),
    ]);
    aiPanel.lastAttemptId = attemptId;
    // Post-polish chat UI shows the entire available conversation (oldest
    // first) in a scrollable area. The store cap bounds how much exists;
    // nothing is truncated here and the schema is unchanged. Badge metadata
    // comes from the already-persisted linked evaluations (view-model only).
    aiPanel.exchange = withBadgeMetadata(all, evaluations);
  } catch (err) {
    console.error('CodeSense: failed to refresh AI conversation', err);
    return;
  }
  updateSidebar();
}

/** Learner reply from the sidebar: persist, render immediately, then run one
 * conversational evaluation turn (kind 'reply' — never a fake trigger).
 * A reply that arrives while a response is already in flight is still
 * persisted and rendered, but starts no duplicate evaluation. */
async function handleAiReply(rawText: string): Promise<void> {
  const text = rawText.trim();
  if (text.length === 0) {
    return;
  }
  const attempt = activeAttempt;
  if (!currentSession || !attempt) {
    void vscode.window.showInformationMessage('CodeSense: no active problem to reply about.');
    return;
  }
  // Synchronous reservation: back-to-back Replies persist every message but
  // start exactly one conversational evaluation (released by the runner).
  const alreadyRunning = !tryReserveEvaluation(evaluationInFlight, attempt.attemptId);
  try {
    await activeAiStore().appendConversation({
      messageId: generateConversationMessageId(),
      attemptId: attempt.attemptId,
      timestamp: new Date().toISOString(),
      role: 'learner',
      text: text.length > 2000 ? text.slice(0, 2000) : text,
    });
  } catch (err) {
    console.error('CodeSense: failed to persist learner reply', err);
    if (!alreadyRunning) {
      releaseEvaluation(evaluationInFlight, attempt.attemptId);
    }
    return;
  }
  // Render the learner message immediately, before the model responds.
  await refreshAiExchange(attempt.attemptId);
  if (!alreadyRunning) {
    try {
      await maybeRunAiEvaluation(attempt, 'reply', 'learner reply in sidebar conversation', true);
    } finally {
      // Release our reservation even on paths where the runner returns
      // before its own try/finally (unconfigured AI, ended attempt).
      // Delete is idempotent with the runner's own release.
      releaseEvaluation(evaluationInFlight, attempt.attemptId);
    }
  }
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
  // AI configuration travels with the extension, not the learner workspace:
  // `<extension-path>/.env` is loaded into process.env before anything
  // reads it, so CodeSense works from arbitrary workspace folders. Missing
  // path or missing .env is a silent no-op; explicit environment variables
  // keep working as before. Session data still lives in the workspace.
  loadEnvFile(context.extensionPath);
  extensionContext = context;
  try {
    uiFontSize = resolveUIFontSize(context.globalState.get(UI_FONT_SIZE_STATE_KEY));
  } catch {
    // Unavailable storage must never block activation; Medium default stands.
  }
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
      void handleAiReply(text);
    },
    getFontSize: () => getUiFontSize(),
    setFontSize: (size: string) => {
      setUiFontSize(size, 'sidebar');
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
  const reviewGoalsDisposable = vscode.commands.registerCommand('codesense.reviewLearningGoals', () => {
    void reviewLearningGoals();
  });
  const suggestPracticeDisposable = vscode.commands.registerCommand('codesense.suggestNextActivity', () => {
    void suggestNextActivityFlow();
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
    reviewGoalsDisposable,
    suggestPracticeDisposable,
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
    // Phase E finalization (§16–18): route the interrupted attempt through
    // the SAME existing evidence machinery as End Problem (best-effort on
    // shutdown; the sync helpers never throw). No duplicate system is
    // created; session finalization below adds no learner evidence.
    if (problem) {
      void maybeSyncAttemptToLearnerModel(pending, problem);
    }
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
