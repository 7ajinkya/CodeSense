import * as vscode from 'vscode';
import { ATTEMPT_STATES, AttemptState, canEndAttempt } from '../attempts/attempt';
import { fontSizeSelectOptionsHtml } from './fontSize';

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
  /**
   * Post-polish badge metadata, copied from the linked persisted evaluation
   * (view-model only — never persisted). Present only on coach messages
   * whose evaluation record exists; the webview omits unavailable badges.
   */
  triggerKind?: string;
  interventionType?: string;
}

export interface SidebarAiState {
  status: 'idle' | 'evaluating' | 'unavailable' | 'error';
  /** Latest coach message for the visible attempt, if any. */
  message: string | null;
  /**
   * Epoch ms until a confirmed provider rate limit lifts. Present only
   * while a cooldown is active; the webview disables Send and shows a
   * countdown from it, then re-enables automatically. UI/request state —
   * never persisted. Absent for every other failure kind.
   */
  rateLimitedUntil?: number;
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

/**
 * Post-polish badge metadata attach (pure, unit-testable).
 *
 * Copies the already-persisted `triggerKind` / `interventionType` from each
 * coach message's linked evaluation into the snapshot exchange item, so the
 * webview can render "why is CodeSense talking" + "what kind of coaching"
 * badges. Learner messages never carry badges; coach messages with a
 * missing/unlinked evaluation keep text only. No stores, no schema changes.
 */
export function withBadgeMetadata(
  messages: Array<{ role: 'coach' | 'learner'; text: string; evaluationId?: string }>,
  evaluations: Array<{ evaluationId: string; triggerKind: string; interventionType: string }>,
): SidebarExchangeMessage[] {
  const byId = new Map<string, { triggerKind: string; interventionType: string }>();
  for (const evaluation of evaluations) {
    byId.set(evaluation.evaluationId, evaluation);
  }
  return messages.map((message) => {
    if (message.role !== 'coach' || !message.evaluationId) {
      return { role: message.role, text: message.text };
    }
    const evaluation = byId.get(message.evaluationId);
    if (!evaluation) {
      return { role: message.role, text: message.text };
    }
    return {
      role: message.role,
      text: message.text,
      triggerKind: evaluation.triggerKind,
      interventionType: evaluation.interventionType,
    };
  });
}

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
  /** Shared CodeSense UI font size owned by the host (optional seams). */
  getFontSize?(): string;
  setFontSize?(size: string): void;
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
          // Adopt the host-owned shared font size (covers sidebar recreates
          // after the preference changed elsewhere).
          this.pushFontSize(this.actions.getFontSize?.() ?? 'medium');
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
        case 'setFontSize':
          if (typeof msg.size === 'string') {
            this.actions.setFontSize?.(msg.size);
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

  /** Push the shared UI font size (host -> webview adoption channel). */
  pushFontSize(size: string): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ command: 'fontSize', size });
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
  /* CodeSense typography system: every size below is em-relative, so the
     webview-only Text size setting scales the whole panel coherently.
     Nothing here touches global VS Code, editor, or terminal sizing. */
  body { font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; padding: 12px;
    --cs-font-xs: 0.78em; --cs-font-sm: 0.86em; --cs-lh: 1.45; --cs-radius: 8px; }
  body[data-cs-font="small"] { font-size: 12px; }
  body[data-cs-font="medium"] { font-size: 13px; }
  body[data-cs-font="large"] { font-size: 15px; }
  body[data-cs-font="xlarge"] { font-size: 17px; }
  body[data-cs-font="huge"] { font-size: 20px; }
  body[data-cs-font="xhuge"] { font-size: 23px; }
  h2 { margin: 0 0 4px; font-size: 1.2em; line-height: 1.3; }
  h3 { margin: 16px 0 6px; font-size: 0.85em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-input-border); padding-top: 12px; }
  h3:first-of-type { border-top: none; padding-top: 0; }
  .row { margin: 6px 0; }
  .title { font-weight: 600; font-size: 1.05em; line-height: 1.35; }
  .muted { color: var(--vscode-descriptionForeground); font-size: var(--cs-font-sm); }
  .hint { color: var(--vscode-descriptionForeground); font-size: var(--cs-font-sm); }
  label { display: block; margin: 8px 0 2px; font-weight: 600; font-size: var(--cs-font-sm); }
  button, select, textarea { font-family: inherit; font-size: 1em; box-sizing: border-box; }
  button, select { width: 100%; padding: 0.45em 0.6em; margin: 4px 0; border-radius: 6px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit); }
  button { cursor: pointer; }
  button:hover:not(:disabled), select:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
  button:disabled { cursor: default; opacity: 0.55; }
  button:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  textarea { border: 1px solid var(--vscode-input-border); border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .font-ctl { display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; }
  .font-ctl label { margin: 0; white-space: nowrap; }
  .font-ctl select { width: auto; flex: 1 1 auto; margin: 0; }
  .timer-pill { display: inline-block; font-size: var(--cs-font-sm); font-variant-numeric: tabular-nums;
    border: 1px solid var(--vscode-input-border); border-radius: 999px; padding: 2px 10px; }
  .rate-limit { font-size: var(--cs-font-sm); color: var(--vscode-descriptionForeground); }
  .chat { display: flex; flex-direction: column; gap: 8px; margin: 8px 0;
    max-height: 46vh; overflow-y: auto; padding: 2px; }
  .msg-row { display: flex; flex-direction: column; max-width: 92%; }
  .msg-row.left { align-self: flex-start; align-items: flex-start; }
  .msg-row.right { align-self: flex-end; align-items: flex-end; }
  .sender { font-size: var(--cs-font-xs); color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  /* Semantic badges: small metadata pills above the coach message body.
     Meaning always comes from the text, never color alone. Trigger pills
     are subdued outlines; coaching-action pills carry a soft fill. */
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 4px; }
  .badge { font-size: var(--cs-font-xs); line-height: 1.4; letter-spacing: 0.02em;
    text-transform: uppercase; white-space: nowrap; padding: 1px 7px;
    border-radius: 999px; border: 1px solid currentColor; }
  .badge.trig { background: transparent; font-weight: 400; }
  .badge.act { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); font-weight: 600; }
  .badge.trig-idle { color: var(--vscode-textLink-foreground, inherit); }
  .badge.trig-hard45 { color: var(--vscode-terminal-ansiMagenta, var(--vscode-textLink-foreground, inherit)); }
  .badge.trig-reply { color: var(--vscode-testing-iconPassed, inherit); }
  .badge.trig-manual { color: var(--vscode-descriptionForeground, inherit); }
  .badge.act-question { color: var(--vscode-editorWarning-foreground, inherit); }
  .badge.act-hint { color: var(--vscode-charts-orange, var(--vscode-editorWarning-foreground, inherit)); }
  .badge.act-explanation { color: var(--vscode-terminal-ansiCyan, var(--vscode-textLink-foreground, inherit)); }
  .badge.act-acknowledge { color: var(--vscode-testing-iconPassed, inherit); }
  .badge.act-debugging { color: var(--vscode-terminal-ansiRed, var(--vscode-testing-iconFailed, inherit)); }
  .badge.act-concept { color: var(--vscode-charts-purple, var(--vscode-textLink-foreground, inherit)); }
  .badge.act-solution { color: var(--vscode-errorForeground, inherit); }
  .bubble { border-radius: var(--cs-radius); padding: 8px 10px; }
  .bubble.coach-msg { background: var(--vscode-editorWidget-background, transparent);
    border: 1px solid var(--vscode-input-border); border-bottom-left-radius: 2px; }
  .bubble.learner-msg { background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.12));
    border: 1px solid var(--vscode-input-border); border-bottom-right-radius: 2px; }
  .md p { margin: 6px 0; line-height: var(--cs-lh); }
  .md p:first-child { margin-top: 0; }
  .md p:last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 8px 0 4px; line-height: 1.3; text-transform: none;
    border: none; padding: 0; color: inherit; }
  .md h1 { font-size: 1.15em; }
  .md h2 { font-size: 1.05em; }
  .md h3, .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 6px 0; padding-left: 20px; }
  .md li { margin: 2px 0; line-height: var(--cs-lh); }
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
<div class="font-ctl"><label for="fontSizeSelect">Text size</label><select id="fontSizeSelect">${fontSizeSelectOptionsHtml('medium')}</select></div>
<div id="content"><p class="muted">Loading…</p></div>
<script>
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  // Post-polish Text size: webview-only, persisted via the webview state
  // API (survives reloads). Applies a data attribute on this webview's
  // body only — global VS Code / editor / terminal sizing is untouched.
  function resolveFontSize(value) {
    if (value === 'small' || value === 'medium' || value === 'large' ||
        value === 'xlarge' || value === 'huge' || value === 'xhuge') {
      return value;
    }
    return 'medium';
  }
  // Webview-local UI state (font size + unsent composer draft). Merged on
  // every write so unrelated keys survive; restored on load so a disposed
  // and recreated webview keeps both. Never touches the AI conversation
  // store — the draft is not a learner message until Send is pressed.
  function readUiState() {
    try {
      var state = vscode.getState();
      if (state && typeof state === 'object') {
        return state;
      }
    } catch (e) { /* private-mode webviews: fall through to defaults */ }
    return {};
  }
  function writeUiState(patch) {
    try {
      var state = readUiState();
      var next = {};
      for (var k in state) {
        if (Object.prototype.hasOwnProperty.call(state, k)) {
          next[k] = state[k];
        }
      }
      for (var p in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, p)) {
          next[p] = patch[p];
        }
      }
      vscode.setState(next);
    } catch (e) { /* persistence best-effort only */ }
  }
  function storedFontSize() {
    var state = readUiState();
    if (typeof state.fontSize === 'string') {
      return state.fontSize;
    }
    return 'medium';
  }
  var fontSize = resolveFontSize(storedFontSize());
  function saveFontSize() {
    writeUiState({ fontSize: fontSize });
  }
  function applyFontSize() {
    if (document && document.body && document.body.setAttribute) {
      document.body.setAttribute('data-cs-font', fontSize);
    }
    var sel = document.getElementById('fontSizeSelect');
    if (sel) {
      sel.value = fontSize;
    }
  }
  function wireFontSize() {
    var sel = document.getElementById('fontSizeSelect');
    if (!sel || sel.getAttribute('data-cs-wired')) {
      return;
    }
    sel.setAttribute('data-cs-wired', '1');
    sel.value = fontSize;
    sel.addEventListener('change', function (e) {
      fontSize = resolveFontSize(e.target.value);
      saveFontSize();
      applyFontSize();
      // Share with every CodeSense webview via the host (Start Problem
      // adopts it on next render/refresh; persistence stays host-side).
      vscode.postMessage({ command: 'setFontSize', size: fontSize });
    });
  }
  let startedAt = null;
  let clockTimer = null;
  let replySending = false;
  // Unsent composer draft (webview-local). Every host refresh rebuilds the
  // textarea element, so the draft is captured on input AND before each
  // render, then restored after render. Cleared only when a send is
  // actually submitted; a blocked send keeps the draft for retry.
  var composerDraft = '';
  (function () {
    var state = readUiState();
    if (typeof state.composerDraft === 'string') {
      composerDraft = state.composerDraft;
    }
  })();
  function saveComposerDraft() {
    writeUiState({ composerDraft: composerDraft });
  }
  function captureComposerDraft() {
    var box = document.getElementById('aiReply');
    // Only a non-empty box can carry an unseen edit: the input listener
    // syncs every keystroke (including select-all-delete), so an empty box
    // beside a pending draft is a freshly rebuilt element that wireReply is
    // about to refill — adopting the emptiness would erase a restored draft.
    if (box && typeof box.value === 'string' && box.value !== '' && box.value !== composerDraft) {
      composerDraft = box.value;
      saveComposerDraft();
    }
  }
  // Confirmed provider rate-limit cooldown (epoch ms, from the host
  // snapshot). Only this condition disables Send; every other failure
  // leaves the composer usable.
  var rateLimitedUntil = null;
  var rateLimitTimer = null;
  function isRateLimitedNow() {
    return rateLimitedUntil !== null && Date.now() < rateLimitedUntil;
  }
  function stopRateLimitTimer() {
    if (rateLimitTimer) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
    }
  }
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
  // Post-polish semantic badges, derived from the persisted evaluation
  // metadata the host attaches (triggerKind/interventionType). Unknown or
  // missing metadata renders no badge — the message itself always renders.
  function triggerBadge(kind) {
    if (kind === 'idle') { return '<span class="badge trig trig-idle">10 MIN CHECK-IN</span>'; }
    if (kind === 'hard45') { return '<span class="badge trig trig-hard45">45 MIN CHECK-IN</span>'; }
    if (kind === 'reply') { return '<span class="badge trig trig-reply">YOU REPLIED</span>'; }
    if (kind === 'manual') { return '<span class="badge trig trig-manual">MANUAL CHECK-IN</span>'; }
    return '';
  }
  function actionBadge(type) {
    if (type === 'SOCRATIC_QUESTION') { return '<span class="badge act act-question">QUESTION</span>'; }
    if (type === 'HINT') { return '<span class="badge act act-hint">HINT</span>'; }
    if (type === 'EXPLANATION') { return '<span class="badge act act-explanation">EXPLANATION</span>'; }
    if (type === 'ACKNOWLEDGE') { return '<span class="badge act act-acknowledge">ACKNOWLEDGEMENT</span>'; }
    if (type === 'DEBUGGING_HELP') { return '<span class="badge act act-debugging">DEBUGGING HELP</span>'; }
    if (type === 'CONCEPT_REVIEW') { return '<span class="badge act act-concept">CONCEPT REVIEW</span>'; }
    if (type === 'SOLUTION_GUIDANCE') { return '<span class="badge act act-solution">SOLUTION GUIDANCE</span>'; }
    return '';
  }
  function badgesHtml(turn) {
    var badges = triggerBadge(turn.triggerKind) + actionBadge(turn.interventionType);
    if (!badges) {
      return '';
    }
    return '<div class="badges">' + badges + '</div>';
  }
  function coachRow(turn) {
    return '<div class="msg-row left"><div class="sender">\\u{1F916} CodeSense</div>' + badgesHtml(turn) +
      '<div class="bubble coach-msg"><div class="md">' + mdToHtml(turn.text) + '</div></div></div>';
  }
  function learnerRow(text) {
    return '<div class="msg-row right"><div class="sender">You</div>' +
      '<div class="bubble learner-msg"><div class="md">' + learnerHtml(text) + '</div></div></div>';
  }
  // Rate-limit status: a clear non-alarming countdown while a confirmed
  // provider cooldown is active, replacing the generic error line (the
  // failure itself is still reflected in panel state). Also arms the
  // module-level cooldown the Send button and its guard consult.
  function aiRateLimitHtml(ai) {
    if (ai && typeof ai.rateLimitedUntil === 'number' && ai.rateLimitedUntil > Date.now()) {
      rateLimitedUntil = ai.rateLimitedUntil;
      var secs = Math.max(1, Math.ceil((ai.rateLimitedUntil - Date.now()) / 1000));
      return '<div class="row rate-limit" id="rateLimitStatus">AI temporarily rate-limited — try again in ' +
        '<span id="rateLimitCountdown">' + secs + 's</span></div>';
    }
    rateLimitedUntil = null;
    return '';
  }
  function aiHtml(ai) {
    if (!ai) { return ''; }
    let html = '<h3>AI Coach</h3>';
    const rateLimited = aiRateLimitHtml(ai);
    if (rateLimited) {
      html += rateLimited;
    } else {
      const status = aiStatusText(ai.status);
      if (status) {
        html += '<div class="row muted">' + esc(status) + '</div>';
      }
    }
    if (ai.exchange.length > 0) {
      html += '<div class="chat" id="chat" role="log" aria-label="Conversation with your coach">' +
        ai.exchange
          .map((turn) => (turn.role === 'coach' ? coachRow(turn) : learnerRow(turn.text)))
          .join('') +
        '</div>';
    } else if (ai.message) {
      html += '<div class="chat" id="chat" role="log" aria-label="Conversation with your coach">' +
        coachRow({ role: 'coach', text: ai.message }) + '</div>';
    }
    if (ai.canReply) {
      const replyDisabled =
        replySending || ai.status === 'evaluating' || isRateLimitedNow() ? ' disabled' : '';
      html += '<div class="row"><label for="aiReply">Reply to your coach</label>' +
        '<textarea id="aiReply" rows="2" style="width:100%;box-sizing:border-box" placeholder="Reply to your coach…"></textarea></div>' +
        '<div class="row"><button id="btnReply"' + replyDisabled + '>Reply</button></div>';
    }
    return html;
  }
  // Scroll policy: follow new messages only when the learner was already
  // viewing the newest ones. Readers scrolled up through history keep
  // their position; first paint scrolls to the bottom.
  function chatWasAtBottom() {
    var chat = document.getElementById('chat');
    if (!chat) {
      return true;
    }
    return (chat.scrollHeight - chat.scrollTop - chat.clientHeight) < 48;
  }
  function scrollChatToBottomIfNeeded(wasAtBottom) {
    var chat = document.getElementById('chat');
    if (chat && wasAtBottom) {
      chat.scrollTop = chat.scrollHeight;
    }
  }
  // Ticks the visible countdown once per second without any host
  // roundtrip or popup. At expiry it announces readiness inline and
  // re-enables Send; a missing status node simply stops the timer.
  function tickRateLimit() {
    var wrap = document.getElementById('rateLimitStatus');
    var btn = document.getElementById('btnReply');
    if (!wrap || !isRateLimitedNow()) {
      if (wrap && !isRateLimitedNow()) {
        wrap.textContent = 'AI ready';
        if (btn) {
          btn.disabled = false;
        }
      }
      stopRateLimitTimer();
      return;
    }
    var cd = document.getElementById('rateLimitCountdown');
    if (cd) {
      cd.textContent = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1000)) + 's';
    }
  }
  function afterRender(wasAtBottom) {
    applyFontSize();
    wireFontSize();
    scrollChatToBottomIfNeeded(wasAtBottom);
    stopRateLimitTimer();
    if (isRateLimitedNow() && document.getElementById('rateLimitStatus')) {
      rateLimitTimer = setInterval(tickRateLimit, 1000);
    }
  }
  function render(snapshot) {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    stopRateLimitTimer();
    startedAt = null;
    // Preserve the unsent draft BEFORE innerHTML rebuilds destroy it.
    captureComposerDraft();
    const wasAtBottom = chatWasAtBottom();
    if (!snapshot.session) {
      content.innerHTML =
        '<p>\\u25cb No active session</p>' +
        '<p class="muted">Start a coding session to begin tracking your activity.</p>' +
        '<div class="row"><button id="btn">Start Session</button></div>';
      document.getElementById('btn').addEventListener('click', () =>
        vscode.postMessage({ command: 'startSession' }));
      afterRender(wasAtBottom);
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
      afterRender(wasAtBottom);
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
    html += '<div class="row"><span class="timer-pill">\\u23f1 <span id="elapsed">0:00</span></span></div>' +
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
    afterRender(wasAtBottom);
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }
  function wireReply() {
    const box = document.getElementById('aiReply');
    const btn = document.getElementById('btnReply');
    if (!box || !btn) { return; }
    // Restore the draft the last render destroyed (or an older surviving
    // one); the box always shows exactly the pending unsent text.
    box.value = composerDraft;
    if (replySending) { btn.disabled = true; }
    box.addEventListener('input', () => {
      composerDraft = box.value;
      saveComposerDraft();
    });
    btn.addEventListener('click', () => {
      if (replySending) { return; }
      if (isRateLimitedNow()) { return; }
      const text = box.value;
      // Submit accepted: clear the draft and the box together, then post.
      // A blocked click above returns early, preserving both for retry.
      composerDraft = '';
      saveComposerDraft();
      box.value = '';
      replySending = true;
      btn.disabled = true;
      vscode.postMessage({ command: 'aiReply', text: text });
    });
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.command === 'snapshot') {
      // Each snapshot is fresh server state: re-arm the Reply button.
      // (Host-side evaluationInFlight remains the authoritative guard.)
      replySending = false;
      render(msg.snapshot);
    } else if (msg && msg.command === 'fontSize' && typeof msg.size === 'string') {
      // Shared preference changed in another CodeSense webview: adopt the
      // host value (host already validated + persisted it).
      fontSize = resolveFontSize(msg.size);
      saveFontSize();
      applyFontSize();
    }
  });
  // Announce readiness: a host postMessage sent while this content is still
  // loading is dropped, so the provider answers this with the current
  // snapshot (guaranteed delivery on open and on every recreation).
  // Apply the persisted Text size before first paint (static header select
  // is wired once here; per-snapshot renders re-apply via afterRender).
  applyFontSize();
  wireFontSize();
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}
