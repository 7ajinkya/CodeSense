import { isSupportedLanguage } from '../util/languages';

/**
 * Phase 0 observation policy: during an active coding session, document-level
 * activity is captured only for the currently active editor, and only when
 * that document's VS Code `languageId` is a supported language
 * (python, java).
 *
 * Deliberately pure (no `vscode` dependency) so the policy is unit-testable.
 * The extension resolves "currently active" via
 * `vscode.window.activeTextEditor` and feeds the result in; no workspace
 * scanning is performed anywhere.
 */

export interface ObserveDocumentArgs {
  /** False when no coding session is running. */
  sessionActive: boolean;
  /** VS Code `TextDocument.languageId` — never a filename extension. */
  languageId: string;
  /** True only when the document backs the currently active editor. */
  isActiveDocument: boolean;
}

/** Single decision point for document.{opened,changed,saved} observation. */
export function shouldObserveDocument(args: ObserveDocumentArgs): boolean {
  if (!args.sessionActive) {
    return false;
  }
  if (!args.isActiveDocument) {
    return false;
  }
  return isSupportedLanguage(args.languageId);
}

export interface TrackedDocument {
  uri: string;
  languageId: string;
}

/**
 * Remembers which document (if any) is currently under document-level
 * observation. The coding session itself is unaffected: switching to an
 * unsupported document only clears tracking, and switching back to a
 * supported document resumes it.
 */
export class ActiveDocumentTracker {
  private trackedUri: string | null = null;
  private trackedLanguageId: string | null = null;

  /**
   * Call when the active editor changes (or when a session starts, to pick
   * up the already-active editor). Returns true when document observation
   * is active afterwards. `uri`/`languageId` are undefined when there is
   * no active editor.
   */
  updateActiveDocument(
    uri: string | undefined,
    languageId: string | undefined,
    sessionActive: boolean,
  ): boolean {
    if (
      uri === undefined ||
      languageId === undefined ||
      !shouldObserveDocument({ sessionActive, languageId, isActiveDocument: true })
    ) {
      this.trackedUri = null;
      this.trackedLanguageId = null;
      return false;
    }
    this.trackedUri = uri;
    this.trackedLanguageId = languageId;
    return true;
  }

  /** True when `uri` is the document currently under observation. */
  isTracked(uri: string): boolean {
    return this.trackedUri === uri;
  }

  /**
   * Call on document close. Returns true exactly when the closed document
   * was the tracked one (so the caller should record `document.closed`),
   * and clears tracking for it.
   */
  consumeIfTracked(uri: string): boolean {
    if (this.trackedUri === uri) {
      this.trackedUri = null;
      this.trackedLanguageId = null;
      return true;
    }
    return false;
  }

  /** Call when the session ends; the session object itself is untouched. */
  reset(): void {
    this.trackedUri = null;
    this.trackedLanguageId = null;
  }

  get tracked(): TrackedDocument | null {
    if (this.trackedUri === null || this.trackedLanguageId === null) {
      return null;
    }
    return { uri: this.trackedUri, languageId: this.trackedLanguageId };
  }
}
