/**
 * Human-readable line diffs, DERIVED from exact reconstructed states.
 *
 * Direction of the architecture (strict):
 *   structured VS Code edits (canonical)
 *     -> deterministic reconstruction (codeHistory.ts)
 *     -> full checkpoint states
 *     -> this line diff (display only)
 * Never the reverse: textual diffs are not stored and must never be used
 * to reconstruct source.
 */

export type TextDiffKind = 'context' | 'add' | 'remove';

export interface TextDiffLine {
  kind: TextDiffKind;
  text: string;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split('\n');
}

/**
 * Line diff via common prefix/suffix trimming plus LCS dynamic programming
 * on the remaining middle slice. Trimming keeps the typical small-edit case
 * cheap; the DP is O(n*m) on the trimmed region only, which is appropriate
 * for human-readable display of learner-sized files — never for storage.
 */
export function computeLineDiff(oldText: string, newText: string): TextDiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: TextDiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ kind: 'context', text: oldLines[i] });
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  // LCS table over the middle slices.
  const rows = oldMid.length + 1;
  const cols = newMid.length + 1;
  const table: number[][] = [];
  for (let i = 0; i < rows; i++) {
    table.push(new Array<number>(cols).fill(0));
  }
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = cols - 2; j >= 0; j--) {
      if (oldMid[i] === newMid[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  // Walk the table emitting removes before adds (Git-style).
  let i = 0;
  let j = 0;
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      out.push({ kind: 'context', text: oldMid[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: oldMid[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: newMid[j] });
      j++;
    }
  }
  while (i < oldMid.length) {
    out.push({ kind: 'remove', text: oldMid[i] });
    i++;
  }
  while (j < newMid.length) {
    out.push({ kind: 'add', text: newMid[j] });
    j++;
  }
  for (let k = oldLines.length - suffix; k < oldLines.length; k++) {
    out.push({ kind: 'context', text: oldLines[k] });
  }
  return out;
}

/** Render a Git-style unified-ish text block (`  `/`- `/`+ ` per line). */
export function formatTextDiff(diff: TextDiffLine[]): string {
  return diff
    .map((line) => {
      if (line.kind === 'add') {
        return `+ ${line.text}`;
      }
      if (line.kind === 'remove') {
        return `- ${line.text}`;
      }
      return `  ${line.text}`;
    })
    .join('\n');
}
