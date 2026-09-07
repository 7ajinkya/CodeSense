import * as vscode from 'vscode';

/**
 * Phase 1 status bar: the learner must always see at a glance —
 * am I in a session? Am I solving a problem? Which one, in what state?
 * Clicking the item opens the CodeSense menu (`codesense.showMenu`).
 */
export class CodeSenseStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'codesense.showMenu';
    this.item.tooltip = 'CodeSense: open menu';
    this.showIdle();
    this.item.show();
  }

  showIdle(): void {
    this.item.text = '$(circle-outline) CodeSense: idle';
  }

  showSessionNoProblem(): void {
    this.item.text = '$(play) CodeSense: session — no active problem';
  }

  showActiveProblem(problemLabel: string, state: string): void {
    const short = problemLabel.length > 40 ? problemLabel.slice(0, 37) + '...' : problemLabel;
    this.item.text = `$(play) CodeSense: ${short} [${state}]`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
