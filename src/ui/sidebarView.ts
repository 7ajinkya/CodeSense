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
 *
 * Phase A (AI UX): coach messages render as safe Markdown (see
 * `ui/markdown.ts` for the host-side renderer and its tests). The webview
 * embeds a mirrored zero-dependency renderer — the webview cannot import
 * from `src/`, so keep the two implementations in sync. Only whitelisted
 * tags are ever emitted; all model/learner text is HTML-escaped first.
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

export interface SidebarExchangeMessage {
  role: 'coach' | 'learner';
  text: string;
}

export interface SidebarAiState {
  status: 'idle' | 'evaluating' | 'unavailable' | 'error';
  /** Latest coach message for the visible attempt, if any. */
  message: string | null;
  /**
   * Recent conversation tail for the visible attempt (oldest first),
   * including learner replies. Rendered when non-empty; the legacy
   * single `message` above is the fallback.
   */
  exchange: SidebarExchangeMessage[];
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
  .coach-msg { background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-input-border);
    border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
  .learner-msg { border-left: 3px solid var(--vscode-focusBorder); padding: 4px 0 4px 10px; margin: 8px 0; }
  .coach-name { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 4px; }
  .md p { margin: 6px 0; line-height: 1.45; }
  .md p:first-child { margin-top: 0; }
  .md p:last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 8px 0 4px; line-height: 1.3; text-transform: none;
    border: none; padding: 0; color: inherit; }
  .md h1 { font-size: 1.15em; }
  .md h2 { font-size: 1.05em; }
  .md h3, .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 6px 0; padding-left: 20px; }
  .md li { margin: 2px 0; line-height: 1.45; }
  .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 1px 4px; border-radius: 4px; }
  .md pre.codeblock { background: var(--vscode-editor-background); border: 1px solid var(--vscode-input-border);
    border-radius: 6px; padding: 0; overflow-x: auto; margin: 8px 0; }
  .md pre.codeblock code { display: block; background: none; padding: 8px 10px; white-space: pre; }
  .md .code-lang { font-size: 0.75em; color: var(--vscode-descriptionForeground); padding: 4px 10px 0; }
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
  let replySending = false;
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Phase A safe-Markdown mirror of src/ui/markdown.ts (webview cannot
  // import from src/). Escape-first, code placeholders, block state
  // machine, inline bold/italic/code. Whitelisted tags only.
  function sanitizeLang(raw) {
    var label = String(raw || '').trim().split(/\\s+/)[0] || '';
    if (!label) { return ''; }
    if (/^[A-Za-z0-9+#_.-]{1,24}$/.test(label)) { return label; }
    return 'code';
  }
  function inlineMd(rawLine) {
    // Inline code is extracted via split (no backtick literal needed in
    // this template) so markup inside code stays literal. An unmatched
    // trailing backtick stays literal text.
    var spans = [];
    var bt = String.fromCharCode(96);
    var parts = String(rawLine).split(bt);
    var text = parts[0];
    var p = 1;
    while (p < parts.length) {
      if (p < parts.length - 1) {
        if (parts[p].length > 0) {
          spans.push(parts[p]);
          text += 'CODESENSEMDINLINE' + (spans.length - 1) + 'CODESENSEMD';
        } else {
          text += bt + bt;
        }
        text += parts[p + 1];
        p += 2;
      } else {
        text += bt + parts[p];
        p += 1;
      }
    }
    var out = esc(text);
    out = out.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
    out = out.replace(/\\*([^*\\n]+?)\\*/g, '<em>$1</em>');
    out = out.replace(/(^|\\W)_([^_\\n]+?)_(?=\\W|$)/g, '$1<em>$2</em>');
    for (var k = 0; k < spans.length; k++) {
      out = out.split('CODESENSEMDINLINE' + k + 'CODESENSEMD').join('<code>' + esc(spans[k]) + '</code>');
    }
    return out;
  }
  function mdToHtml(input) {
    if (!input || !String(input).trim()) { return ''; }
    var rawLines = String(input).replace(/\\r\\n/g, '\\n').split('\\n');
    var lines = [];
    var blocks = [];
    var inCode = false;
    var lang = '';
    var code = [];
    function closeCode() {
      blocks.push({ language: lang, code: code.join('\\n') });
      lines.push({ kind: 'code', index: blocks.length - 1 });
      inCode = false; lang = ''; code = [];
    }
    for (var r = 0; r < rawLines.length; r++) {
      var line = rawLines[r];
      var trimmed = line.trim();
      if (!inCode && trimmed.indexOf('\`\`\`') === 0) {
        inCode = true; lang = sanitizeLang(trimmed.slice(3)); code = [];
        continue;
      }
      if (inCode && trimmed.indexOf('\`\`\`') === 0) { closeCode(); continue; }
      if (inCode) { code.push(line); } else { lines.push({ kind: 'text', line: line }); }
    }
    if (inCode) { closeCode(); }
    function codeHtml(block) {
      var body = esc(block.code);
      if (block.language) {
        return '<pre class="codeblock"><div class="code-lang">' + esc(block.language) + '</div><code>' + body + '</code></pre>';
      }
      return '<pre class="codeblock"><code>' + body + '</code></pre>';
    }
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var seg = lines[i];
      if (seg.kind === 'code') { html.push(codeHtml(blocks[seg.index])); i++; continue; }
      var cur = seg.line;
      if (!cur.trim()) { i++; continue; }
      var t = cur.trim();
      var hm = /^(#{1,6})\\s+(.+?)\\s*$/.exec(t);
      if (hm) { html.push('<h' + hm[1].length + '>' + inlineMd(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (/^\\s*[-*+]\\s+.+$/.test(cur)) {
        var items = [];
        while (i < lines.length && lines[i].kind === 'text' && /^\\s*[-*+]\\s+.+$/.test(lines[i].line)) {
          items.push('<li>' + inlineMd(lines[i].line.replace(/^\\s*[-*+]\\s+/, '')) + '</li>');
          i++;
        }
        html.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\\s*\\d+\\.\\s+.+$/.test(cur)) {
        var ordered = [];
        while (i < lines.length && lines[i].kind === 'text' && /^\\s*\\d+\\.\\s+.+$/.test(lines[i].line)) {
          ordered.push('<li>' + inlineMd(lines[i].line.replace(/^\\s*\\d+\\.\\s+/, '')) + '</li>');
          i++;
        }
        html.push('<ol>' + ordered.join('') + '</ol>');
        continue;
      }
      var para = [];
      while (i < lines.length) {
        var pl = lines[i];
        if (pl.kind !== 'text') { break; }
        if (!pl.line.trim()) { break; }
        var pt = pl.line.trim();
        if (/^(#{1,6})\\s+.+?\\s*$/.test(pt)) { break; }
        if (/^\\s*[-*+]\\s+.+$/.test(pl.line) || /^\\s*\\d+\\.\\s+.+$/.test(pl.line)) { break; }
        para.push(inlineMd(pl.line.trim()));
        i++;
      }
      if (para.length) { html.push('<p>' + para.join('<br>') + '</p>'); }
    }
    return html.join('');
  }
  function learnerHtml(text) {
    return '<p>' + esc(String(text).replace(/\\r\\n/g, '\\n')).split('\\n').join('<br>') + '</p>';
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
    if (ai.exchange.length > 0) {
      html += ai.exchange
        .map((turn) =>
          turn.role === 'coach'
            ? '<div class="coach-msg"><div class="coach-name">\\u{1F916} CodeSense</div><div class="md">' + mdToHtml(turn.text) + '</div></div>'
            : '<div class="learner-msg"><div class="coach-name">You</div><div class="md">' + learnerHtml(turn.text) + '</div></div>',
        )
        .join('');
    } else if (ai.message) {
      html += '<div class="coach-msg"><div class="coach-name">\\u{1F916} CodeSense</div><div class="md">' + mdToHtml(ai.message) + '</div></div>';
    }
    if (ai.canReply) {
      const replyDisabled = replySending || ai.status === 'evaluating' ? ' disabled' : '';
      html += '<div class="row"><textarea id="aiReply" rows="2" style="width:100%;box-sizing:border-box" placeholder="Reply to your coach…"></textarea></div>' +
        '<div class="row"><button id="btnReply"' + replyDisabled + '>Reply</button></div>';
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
    if (replySending) { btn.disabled = true; }
    btn.addEventListener('click', () => {
      if (replySending) { return; }
      replySending = true;
      btn.disabled = true;
      vscode.postMessage({ command: 'aiReply', text: box.value });
      box.value = '';
    });
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.command === 'snapshot') {
      // Each snapshot is fresh server state: re-arm the Reply button.
      // (Host-side evaluationInFlight remains the authoritative guard.)
      replySending = false;
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
