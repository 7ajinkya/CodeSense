import { ContentChangePayload } from '../events/activityEvent';
import { TextRange } from '../history/codeHistory';

/**
 * Privacy-boundary payload builder for `document.changed` events.
 *
 * Exact `insertedText` is captured ONLY while a problem attempt is active.
 * Without an active attempt the structural event (ranges, lengths, versions)
 * is still recorded for observed documents, but exact text is omitted.
 * The active-document + Python/Java tracking policy itself is unchanged
 * (see `capture/trackingPolicy.ts`); this module only shapes the payload.
 *
 * Pure (no `vscode` dependency) so the boundary is unit-testable.
 */

/** One observed content change, in VS Code API terms. */
export interface ObservedContentChange {
  range: TextRange;
  rangeLength: number;
  text: string;
}

export function countInsertedLines(text: string): number | undefined {
  if (text.length === 0) {
    return 0;
  }
  return text.split('\n').length - 1;
}

export function buildContentChanges(
  changes: ObservedContentChange[],
  includeInsertedText: boolean,
): ContentChangePayload[] {
  return changes.map((change) => ({
    range: {
      startLine: change.range.startLine,
      startCharacter: change.range.startCharacter,
      endLine: change.range.endLine,
      endCharacter: change.range.endCharacter,
    },
    deletedLength: change.rangeLength,
    insertedLength: change.text.length,
    insertedLineCount: countInsertedLines(change.text),
    ...(includeInsertedText ? { insertedText: change.text } : {}),
  }));
}
