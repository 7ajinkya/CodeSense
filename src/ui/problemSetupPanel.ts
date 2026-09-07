import * as vscode from 'vscode';

/**
 * Phase 1 problem-setup webview (manual input is the normal path).
 *
 * Flow: Problem URL + manually pasted problem statement -> Create Problem.
 * Automatic scraping is intentionally NOT part of this flow: external sites
 * may block bots, and fetching must never gate problem solving. The learner
 * copies the statement from the website; the URL is stored as the canonical
 * external reference and the pasted text becomes the authoritative content.
 *
 * The scraper (`scraper/scrape.py`, `problems/scraperClient.ts`,
 * `problems/resolver.ts`) is preserved but dormant — see its README. It can
 * be re-enabled later without redesigning Problem creation.
 *
 * The panel is deliberately dumb: all persistence decisions live in the
 * extension host via `ProblemSetupHandler` (testable, no webview).
 */

export interface StartInput {
  url: string;
  title: string;
  statement: string;
  constraints: string;
  difficulty: string;
  topics: string;
}

export interface ProblemSetupHandler {
  onStart(input: StartInput): Promise<{ ok: true } | { ok: false; error: string }>;
  onCancel(): void;
}

export function showProblemSetupPanel(handler: ProblemSetupHandler): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'codesenseProblemSetup',
    'CodeSense: Start Problem',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = renderHtml();

  // Closing the panel discards the in-progress setup. Idempotent with
  // explicit Cancel/Start.
  panel.onDidDispose(() => {
    handler.onCancel();
  });

  panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        return;
      }
      const msg = message as Record<string, unknown>;
      if (msg.command === 'start') {
        const input = toStartInput(msg);
        if (input === null) {
          void panel.webview.postMessage({
            command: 'startResult',
            ok: false,
            error: 'A problem URL and problem statement are required.',
          });
          return;
        }
        void handler.onStart(input).then((outcome) => {
          if (outcome.ok) {
            panel.dispose();
          } else {
            void panel.webview.postMessage({ command: 'startResult', ok: false, error: outcome.error });
          }
        });
      } else if (msg.command === 'cancel') {
        handler.onCancel();
        panel.dispose();
      }
    },
    undefined,
    [],
  );

  return panel;
}

function toStartInput(msg: Record<string, unknown>): StartInput | null {
  const str = (key: string): string => (typeof msg[key] === 'string' ? (msg[key] as string) : '');
  const input: StartInput = {
    url: str('url').trim(),
    title: str('title'),
    statement: str('statement'),
    constraints: str('constraints'),
    difficulty: str('difficulty'),
    topics: str('topics'),
  };
  if (input.url.length === 0 || input.statement.trim().length === 0) {
    return null;
  }
  return input;
}

function renderHtml(): string {
  // Static shell; only error text arrives via postMessage (no injection risk).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeSense: Start Problem</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; max-width: 720px; }
  h2 { margin-top: 0; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; padding: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); }
  textarea { min-height: 160px; font-family: var(--vscode-editor-font-family, monospace); }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { padding: 6px 14px; cursor: pointer; }
  #status { margin: 12px 0; padding: 8px; border: 1px solid var(--vscode-input-border); white-space: pre-wrap; }
  .warn { border-color: var(--vscode-testing-iconFailed, orange); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>
</head>
<body>
<h2>Start Problem</h2>
<p class="hint">Paste the problem URL and copy the problem statement from the
website into the box below. The URL is kept as the external reference; your
pasted statement becomes the problem content.</p>
<label for="url">Problem URL</label>
<input type="text" id="url" placeholder="https://leetcode.com/problems/two-sum/">
<div id="status">No problem started yet.</div>
<label for="title">Title (optional)</label>
<input type="text" id="title" placeholder="Two Sum">
<label for="statement">Problem statement</label>
<textarea id="statement" placeholder="Paste the problem statement here..."></textarea>
<label for="constraints">Constraints (optional)</label>
<textarea id="constraints" style="min-height:60px" placeholder="1 &lt;= n &lt;= 10^5 ..."></textarea>
<label for="difficulty">Difficulty (optional)</label>
<input type="text" id="difficulty" placeholder="Easy / Medium / Hard">
<label for="topics">Topics, comma-separated (optional)</label>
<input type="text" id="topics" placeholder="Array, Hash Table">
<div class="row">
  <button id="startBtn">Start Problem</button>
  <button id="cancelBtn">Cancel</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  $('startBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'start', url: $('url').value, title: $('title').value,
      statement: $('statement').value, constraints: $('constraints').value,
      difficulty: $('difficulty').value, topics: $('topics').value });
  });
  $('cancelBtn').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text;
    el.className = cls || '';
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'startResult' && !msg.ok) {
      setStatus('Could not start problem: ' + (msg.error || 'unknown error'), 'warn');
    }
  });
</script>
</body>
</html>`;
}
