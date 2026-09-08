import * as vscode from 'vscode';
import { renderStartProblemHtml } from './startProblemHtml';

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
 * extension host via `ProblemSetupHandler` (testable, no webview). Page
 * markup lives in `startProblemHtml.ts` (pure, unit-testable); the shared
 * CodeSense text size arrives baked from the host preference plus live
 * `fontSize` messages both ways.
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
  /** Shared CodeSense UI font size changed in this panel (host persists + broadcasts). */
  onFontSizeChange?(size: string): void;
}

export function showProblemSetupPanel(
  handler: ProblemSetupHandler,
  initialFontSize: string = 'medium',
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'codesenseProblemSetup',
    'CodeSense: Start Problem',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = renderStartProblemHtml(initialFontSize);

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
      } else if (msg.command === 'fontSize') {
        if (typeof msg.size === 'string') {
          handler.onFontSizeChange?.(msg.size);
        }
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
