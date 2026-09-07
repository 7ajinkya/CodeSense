import * as vscode from 'vscode';
import { ATTEMPT_STATES, AttemptState, canEndAttempt } from '../attempts/attempt';

/**
 * Phase 1.5 CodeSense sidebar (Activity Bar view).
 *
 * A single WebviewView is used because the spec needs an in-sidebar
 * state `<select>` and a disabled End Problem button — neither is
 * expressible with a TreeView. The view is deliberately dumb: it renders a
 * snapshot built from existing domain state and forwards button/select
 * actions to existing services via `SidebarActions`. No business logic,
 * no second source of truth, no AI.
 */

// ---------------------------------------------------------------------------
// Snapshot (pure view model — unit-testable, no vscode dependency)
// ---------------------------------------------------------------------------

export interface SidebarSessionInfo {
  sessionId: string;
  startedAt: string;
}

export interface SidebarProblemInfo {
  title: string;
  detail: string;
  state: AttemptState;
  /** The authoritative state list (ATTEMPT_STATES, not a copy). */
  states: AttemptState[];
  /** False exactly when state is In Progress (backend rule mirrored). */
  canEndProblem: boolean;
  /** ISO-8601 attempt start; the view derives the elapsed clock from it. */
  attemptStartedAt: string;
}

export interface SidebarAiState {
  status: 'idle' | 'evaluating' | 'unavailable' | 'error';
  /** Latest coach message for the visible attempt, if any. */
  message: string | null;
  /** True while a problem attempt is active (replies need an attempt). */
  canReply: boolean;
}

export interface SidebarSnapshot {
  session: SidebarSessionInfo | null;
  problem: SidebarProblemInfo | null;
  /** AI Layer V1 panel model; absent when no session is active. */
  ai?: SidebarAiState;
}

export interface SidebarSnapshotInput {
  session: { sessionId: string; startedAt: string } | null;
  problem: { title: string; detail: string } | null;
  attempt: { currentState: AttemptState; startedAt: string } | null;
}

/** Build the sidebar view model from existing domain state. */
export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
  if (!input.session) {
    return { session: null, problem: null };
  }
  if (!input.problem || !input.attempt) {
    return {
      session: { sessionId: input.session.sessionId, startedAt: input.session.startedAt },
      problem: null,
    };
  }
  return {
    session: { sessionId: input.session.sessionId, startedAt: input.session.startedAt },
    problem: {
      title: input.problem.title,
      detail: input.problem.detail,
      state: input.attempt.currentState,
      states: [...ATTEMPT_STATES],
      canEndProblem: canEndAttempt(input.attempt.currentState),
      attemptStartedAt: input.attempt.startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider (thin: renders snapshots, forwards actions)
// ---------------------------------------------------------------------------

/** Existing services the sidebar delegates to (implemented in extension.ts). */
export interface SidebarActions {
  startSession(): void;
  endSession(): void;
  startProblem(): void;
  endProblem(): void;
  /** Receives the raw select value; validation stays host-side. */
  setProblemState(state: string): void;
  showProblemHistory(): void;
  /** Learner reply to the coach; persistence/validation stays host-side. */
  aiReply(text: string): void;
}

const EMPTY_SNAPSHOT: SidebarSnapshot = { session: null, problem: null };

export class CodeSenseSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codesense.sidebar';

  private view: vscode.WebviewView | null = null;
  private snapshot: SidebarSnapshot = EMPTY_SNAPSHOT;

  constructor(private readonly actions: SidebarActions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml();
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        return;
      }
      const msg = message as Record<string, unknown>;
      switch (msg.command) {
        case 'ready':
          // The webview announces when its scripts are running. The
          // resolve-time post below can be dropped when the content is still
          // loading (e.g. sidebar closed then reopened), so this handshake
          // is the guaranteed delivery path for the current snapshot.
          this.postSnapshot();
          break;
        case 'startSession':
          this.actions.startSession();
          break;
        case 'endSession':
          this.actions.endSession();
          break;
        case 'startProblem':
          this.actions.startProblem();
          break;
        case 'endProblem':
          this.actions.endProblem();
          break;
        case 'setProblemState':
          if (typeof msg.state === 'string') {
            this.actions.setProblemState(msg.state);
          }
          break;
        case 'showProblemHistory':
          this.actions.showProblemHistory();
          break;
        case 'aiReply':
          if (typeof msg.text === 'string') {
            this.actions.aiReply(msg.text);
          }
          break;
        default:
          break;
      }
    });
    if (typeof webviewView.onDidDispose === 'function') {
      webviewView.onDidDispose(() => {
        this.view = null;
      });
    }
    this.postSnapshot();
  }

  /** Push fresh state; cached when the view is not visible. */
  update(snapshot: SidebarSnapshot): void {
    this.snapshot = snapshot;
    this.postSnapshot();
  }

  /** Snapshot last pushed (or cached) — for tests/smoke verification. */
  currentSnapshot(): SidebarSnapshot {
    return this.snapshot;
  }

  private postSnapshot(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ command: 'snapshot', snapshot: this.snapshot });
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeSense</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; }
  h2 { margin: 0 0 4px; }
  h3 { margin: 16px 0 6px; font-size: 0.85em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-input-border); padding-top: 12px; }
  h3:first-of-type { border-top: none; padding-top: 0; }
  .row { margin: 6px 0; }
  .title { font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); }
  button, select { width: 100%; box-sizing: border-box; padding: 6px; margin: 4px 0; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.55; }
  label { display: block; margin: 8px 0 2px; font-weight: 600; }
</style>
</head>
<body>
<h2>CodeSense</h2>
<div id="content"><p class="muted">Loading…</p></div>
<script>
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  let startedAt = null;
  let clockTimer = null;
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const mm = (h > 0 ? String(m).padStart(2, '0') : String(m));
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }
  function tickClock() {
    const el = document.getElementById('elapsed');
    if (el && startedAt) {
      el.textContent = fmtElapsed(Date.now() - Date.parse(startedAt));
    }
  }
  function aiStatusText(status) {
    if (status === 'evaluating') { return 'Checking in…'; }
    if (status === 'unavailable') { return 'AI unavailable (not configured). Telemetry continues normally.'; }
    if (status === 'error') { return 'Last check-in failed — telemetry unaffected. It will retry on the next trigger.'; }
    return '';
  }
  function aiHtml(ai) {
    if (!ai) { return ''; }
    let html = '<h3>AI Coach</h3>';
    const status = aiStatusText(ai.status);
    if (status) {
      html += '<div class="row muted">' + esc(status) + '</div>';
    }
    if (ai.message) {
      html += '<div class="row"><span class="muted">\\u{1F916} CodeSense:</span><br>' + esc(ai.message) + '</div>';
    }
    if (ai.canReply) {
      html += '<div class="row"><textarea id="aiReply" rows="2" style="width:100%;box-sizing:border-box" placeholder="Reply to your coach…"></textarea></div>' +
        '<div class="row"><button id="btnReply">Reply</button></div>';
    }
    return html;
  }
  function render(snapshot) {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    startedAt = null;
    if (!snapshot.session) {
      content.innerHTML =
        '<p>\\u25cb No active session</p>' +
        '<p class="muted">Start a coding session to begin tracking your activity.</p>' +
        '<div class="row"><button id="btn">Start Session</button></div>';
      document.getElementById('btn').addEventListener('click', () =>
        vscode.postMessage({ command: 'startSession' }));
      return;
    }
    let html = '<p>\\u25cf Session active</p>';
    if (!snapshot.problem) {
      html += '<p class="muted">No active problem</p>' +
        '<div class="row"><button id="btnStart">+ Start Problem</button></div>' +
        aiHtml(snapshot.ai) +
        '<h3>Session</h3>' +
        '<div class="row"><button id="btnEndSession">End Session</button></div>' +
        '<h3>History</h3>' +
        '<div class="row"><button id="btnHistory">View Problem History</button></div>';
      content.innerHTML = html;
      document.getElementById('btnStart').addEventListener('click', () =>
        vscode.postMessage({ command: 'startProblem' }));
      document.getElementById('btnEndSession').addEventListener('click', () =>
        vscode.postMessage({ command: 'endSession' }));
      document.getElementById('btnHistory').addEventListener('click', () =>
        vscode.postMessage({ command: 'showProblemHistory' }));
      wireReply();
      return;
    }
    const p = snapshot.problem;
    startedAt = p.attemptStartedAt;
    const options = p.states.map((s) =>
      '<option value="' + esc(s) + '"' + (s === p.state ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    html += '<h3>Current Problem</h3>' +
      '<div class="row title">' + esc(p.title) + '</div>';
    if (p.detail) {
      html += '<div class="row muted">' + esc(p.detail) + '</div>';
    }
    html += '<div class="row muted">\\u23f1 <span id="elapsed">0:00</span></div>' +
      '<label for="stateSelect">State</label>' +
      '<select id="stateSelect">' + options + '</select>' +
      '<div class="row"><button id="btnEndProblem"' + (p.canEndProblem ? '' : ' disabled') + '>End Problem</button></div>';
    if (!p.canEndProblem) {
      html += '<div class="row muted">Select a state other than In Progress before ending.</div>';
    }
    html += aiHtml(snapshot.ai) +
      '<h3>Session</h3>' +
      '<div class="row"><button id="btnEndSession">End Session</button></div>' +
      '<h3>History</h3>' +
      '<div class="row"><button id="btnHistory">View Problem History</button></div>';
    content.innerHTML = html;
    document.getElementById('stateSelect').addEventListener('change', (e) =>
      vscode.postMessage({ command: 'setProblemState', state: e.target.value }));
    document.getElementById('btnEndProblem').addEventListener('click', () =>
      vscode.postMessage({ command: 'endProblem' }));
    document.getElementById('btnEndSession').addEventListener('click', () =>
      vscode.postMessage({ command: 'endSession' }));
    document.getElementById('btnHistory').addEventListener('click', () =>
      vscode.postMessage({ command: 'showProblemHistory' }));
    wireReply();
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }
  function wireReply() {
    const box = document.getElementById('aiReply');
    const btn = document.getElementById('btnReply');
    if (!box || !btn) { return; }
    btn.addEventListener('click', () => {
      vscode.postMessage({ command: 'aiReply', text: box.value });
      box.value = '';
    });
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.command === 'snapshot') {
      render(msg.snapshot);
    }
  });
  // Announce readiness: a host postMessage sent while this content is still
  // loading is dropped, so the provider answers this with the current
  // snapshot (guaranteed delivery on open and on every recreation).
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}
