import { fontSizeSelectOptionsHtml, resolveUIFontSize } from './fontSize';

/**
 * Start Problem page renderer (pure HTML, unit-testable, no vscode
 * dependency beyond types — the `vscode` API calls live in
 * `problemSetupPanel.ts`, which wires this output into a WebviewPanel).
 *
 * The initial font size is baked in from the host-owned shared preference;
 * live changes arrive via the `fontSize` postMessage handled below.
 * Typography follows the sidebar philosophy: one base size per level (see
 * `ui/fontSize.ts`), everything else em-relative, so Huge/Extra Huge scale
 * the whole page coherently while the main-area layout (fluid max width,
 * wrapping rows, native scroll) keeps working.
 */
export function renderStartProblemHtml(initialFontSize: string): string {
  const size = resolveUIFontSize(initialFontSize);
  const options = fontSizeSelectOptionsHtml(size);
  // Static shell; only error text arrives via postMessage (no injection risk).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeSense: Start Problem</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45;
    padding: 1.2em; max-width: 60em; }
  body[data-cs-font="small"] { font-size: 12px; }
  body[data-cs-font="medium"] { font-size: 13px; }
  body[data-cs-font="large"] { font-size: 15px; }
  body[data-cs-font="xlarge"] { font-size: 17px; }
  body[data-cs-font="huge"] { font-size: 20px; }
  body[data-cs-font="xhuge"] { font-size: 23px; }
  h2 { margin-top: 0; font-size: 1.2em; line-height: 1.3; }
  label { display: block; margin: 0.9em 0 0.3em; font-weight: 600; font-size: 0.86em; }
  input[type=text], textarea, select { font-family: inherit; font-size: 1em; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; padding: 0.45em 0.6em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 6px; }
  textarea { min-height: 12em; font-family: var(--vscode-editor-font-family, monospace); }
  textarea.tall { min-height: 4em; }
  select { padding: 0.45em 0.6em; border-radius: 6px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit); }
  button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .font-ctl { display: flex; align-items: center; gap: 0.6em; margin: 0 0 0.5em; max-width: 22em; }
  .font-ctl label { margin: 0; white-space: nowrap; }
  .font-ctl select { width: auto; flex: 1 1 auto; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button { padding: 0.45em 1em; cursor: pointer; font-size: 1em; border-radius: 6px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit); }
  button:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
  #status { margin: 12px 0; padding: 8px; border: 1px solid var(--vscode-input-border);
    white-space: pre-wrap; font-size: 1em; }
  .warn { border-color: var(--vscode-testing-iconFailed, orange); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.86em; }
</style>
</head>
<body data-cs-font="${size}">
<h2>Start Problem</h2>
<div class="font-ctl"><label for="fontSize">Text size</label><select id="fontSize">${options}</select></div>
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
<textarea id="constraints" class="tall" placeholder="1 &lt;= n &lt;= 10^5 ..."></textarea>
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
  // Shared CodeSense text size (mirror of the sidebar resolver; the host
  // owns the canonical value and pushes live changes).
  function resolveFontSize(value) {
    if (value === 'small' || value === 'medium' || value === 'large' ||
        value === 'xlarge' || value === 'huge' || value === 'xhuge') {
      return value;
    }
    return 'medium';
  }
  var fontSize = resolveFontSize(document.body ? document.body.getAttribute('data-cs-font') : null);
  function applyFontSize() {
    if (document.body && document.body.setAttribute) {
      document.body.setAttribute('data-cs-font', fontSize);
    }
    var sel = $('fontSize');
    if (sel) {
      sel.value = fontSize;
    }
  }
  applyFontSize();
  var fontSel = $('fontSize');
  if (fontSel) {
    fontSel.addEventListener('change', function (e) {
      fontSize = resolveFontSize(e.target.value);
      applyFontSize();
      vscode.postMessage({ command: 'fontSize', size: fontSize });
    });
  }
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
    } else if (msg.command === 'fontSize' && typeof msg.size === 'string') {
      fontSize = resolveFontSize(msg.size);
      applyFontSize();
    }
  });
</script>
</body>
</html>`;
}
