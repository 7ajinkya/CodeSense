import { expect } from 'chai';
import {
  anchoredAttemptHistory,
  createCodeEditRecord,
  selectAttemptEdits,
  tryReconstructSource,
  CodeEditRecord,
} from 'codesense/history/codeHistory';
import {
  attemptBaseline,
  createCheckpoint,
  CodeCheckpoint,
} from 'codesense/history/checkpoints';
import { LocalCheckpointStore } from 'codesense/history/checkpointStore';
import { computeLineDiff, formatTextDiff } from 'codesense/history/textDiff';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const URI = 'file:///main.py';

function edit(
  attemptId: string | null,
  versionBefore: number,
  versionAfter: number,
  changes: CodeEditRecord['changes'],
): CodeEditRecord {
  return createCodeEditRecord({
    timestamp: `2026-01-01T00:00:${String(versionAfter).padStart(2, '0')}.000Z`,
    sessionId: 'ses_1',
    attemptId,
    uri: URI,
    language: 'python',
    documentVersion: versionAfter,
    versionBefore,
    versionAfter,
    changes,
  });
}

function replace(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  insertedText: string,
) {
  return {
    range: { startLine, startCharacter, endLine, endCharacter },
    rangeLength: 0,
    insertedText,
  };
}

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

const STORE = tmpDir('codesense-test-provenance');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

describe('Fresh attempt: baseline -> edits -> checkpoint match', () => {
  it('reconstructs the save checkpoint exactly across replacement and deletion', () => {
    // Doc version 10 at attempt start; baseline observes (not authors) it.
    const baseline = createCheckpoint({
      attemptId: 'att_1',
      sessionId: 'ses_1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reason: 'start',
      uri: URI,
      language: 'python',
      documentVersion: 10,
      snapshot: 'line1\nline2\nline3\n',
      baseline: true,
    });
    expect(baseline.baseline).to.be.true;
    // Cross-line replacement: "line2\n" -> "a\nb\n".
    const e1 = edit('att_1', 10, 11, [replace(1, 0, 2, 0, 'a\nb\n')]);
    // Pure deletion: remove "b\n".
    const e2 = edit('att_1', 11, 12, [replace(2, 0, 3, 0, '')]);
    const save = createCheckpoint({
      attemptId: 'att_1',
      sessionId: 'ses_1',
      timestamp: '2026-01-01T00:01:00.000Z',
      reason: 'save',
      uri: URI,
      language: 'python',
      documentVersion: 12,
      snapshot: 'line1\na\nline3\n',
    });
    expect(save.baseline).to.be.false;

    const history = anchoredAttemptHistory([baseline, save], [e1, e2], 'att_1');
    expect(history.baseline).to.not.be.null;
    expect(history.baseline!.snapshot).to.equal('line1\nline2\nline3\n');
    const result = tryReconstructSource(history.baseline!.snapshot, history.edits);
    expect(result.ok).to.be.true;
    expect(result.text).to.equal(save.snapshot);
  });
});

describe('Reused file: baseline is observed, learner history is post-attempt only', () => {
  const solutionA = 'def solve():\n    return "A"\n';

  function buildScenario(): { checkpoints: CodeCheckpoint[]; records: CodeEditRecord[] } {
    // Attempt A authors solution A from an empty file (versions 1->2).
    const aBaseline = createCheckpoint({
      attemptId: 'att_A', sessionId: 'ses_1', timestamp: '2026-01-01T00:00:00.000Z',
      reason: 'start', uri: URI, language: 'python', documentVersion: 1, snapshot: '',
      baseline: true,
    });
    const aEdit = edit('att_A', 1, 2, [replace(0, 0, 0, 0, solutionA)]);
    const aSave = createCheckpoint({
      attemptId: 'att_A', sessionId: 'ses_1', timestamp: '2026-01-01T00:01:00.000Z',
      reason: 'save', uri: URI, language: 'python', documentVersion: 2, snapshot: solutionA,
    });
    // Attempt B starts with main.py still holding solution A (doc version 2).
    const bBaseline = createCheckpoint({
      attemptId: 'att_B', sessionId: 'ses_1', timestamp: '2026-01-01T00:02:00.000Z',
      reason: 'start', uri: URI, language: 'python', documentVersion: 2, snapshot: solutionA,
      baseline: true,
    });
    // Learner rewrites A->B in ONE change event with TWO changes
    // (pre-change coordinates of solution A).
    const bEdit = edit('att_B', 2, 3, [
      replace(1, 11, 1, 14, '"B"'),
      replace(2, 0, 2, 0, '# done\n'),
    ]);
    const bSave = createCheckpoint({
      attemptId: 'att_B', sessionId: 'ses_1', timestamp: '2026-01-01T00:03:00.000Z',
      reason: 'save', uri: URI, language: 'python', documentVersion: 3,
      snapshot: 'def solve():\n    return "B"\n# done\n',
    });
    return { checkpoints: [aBaseline, aSave, bBaseline, bSave], records: [aEdit, bEdit] };
  }

  it('flags the reused-file baseline as observed starting state', () => {
    const { checkpoints } = buildScenario();
    const baseline = attemptBaseline(checkpoints, 'att_B');
    expect(baseline).to.not.be.null;
    expect(baseline!.baseline).to.be.true;
    expect(baseline!.snapshot).to.equal(solutionA); // observed, NOT authored in B
    expect(baseline!.reason).to.equal('start');
  });

  it('keeps learner-authored history strictly post-attempt', () => {
    const { checkpoints, records } = buildScenario();
    const history = anchoredAttemptHistory(checkpoints, records, 'att_B');
    expect(history.edits.length).to.equal(1);
    expect(history.edits.every((e) => e.attemptId === 'att_B')).to.be.true;
    // No B edit predates B's baseline document version.
    expect(history.edits.every((e) => e.versionBefore >= (history.baseline!.documentVersion ?? 0))).to.be.true;
    // Attempt A's history is independent and intact.
    const historyA = anchoredAttemptHistory(checkpoints, records, 'att_A');
    expect(tryReconstructSource(historyA.baseline!.snapshot, historyA.edits).text).to.equal(solutionA);
  });

  it('reconstructs the B checkpoint from B baseline + B edits only', () => {
    const { checkpoints, records } = buildScenario();
    const history = anchoredAttemptHistory(checkpoints, records, 'att_B');
    const result = tryReconstructSource(history.baseline!.snapshot, history.edits);
    expect(result.ok).to.be.true;
    const bSave = checkpoints.find((c) => c.attemptId === 'att_B' && c.reason === 'save')!;
    expect(result.text).to.equal(bSave.snapshot);
  });

  it('fails explicitly when the chain has a gap, even with a baseline', () => {
    const { checkpoints, records } = buildScenario();
    const history = anchoredAttemptHistory(checkpoints, records, 'att_B');
    const gapped = [history.edits[0], edit('att_B', 9, 10, [replace(0, 0, 0, 0, 'z')])];
    const result = tryReconstructSource(history.baseline!.snapshot, gapped);
    expect(result.ok).to.be.false;
    expect(result.text).to.be.null;
    expect(result.gapIndex).to.equal(1);
  });

  it('selectAttemptEdits never mixes attempts', () => {
    const { records } = buildScenario();
    expect(selectAttemptEdits(records, 'att_A').length).to.equal(1);
    expect(selectAttemptEdits(records, 'att_B').length).to.equal(1);
    expect(selectAttemptEdits(records, 'att_missing')).to.deep.equal([]);
  });
});

describe('Baseline flag persistence and backward compatibility', () => {
  it('round-trips the baseline flag through the store', async () => {
    const store = new LocalCheckpointStore(STORE);
    await store.saveCheckpoint(
      createCheckpoint({
        attemptId: 'att_1', sessionId: 'ses_1', timestamp: '2026-01-01T00:00:00.000Z',
        reason: 'start', uri: URI, language: 'python', snapshot: 'x', baseline: true,
      }),
    );
    await store.saveCheckpoint(
      createCheckpoint({
        attemptId: 'att_1', sessionId: 'ses_1', timestamp: '2026-01-01T00:01:00.000Z',
        reason: 'save', uri: URI, language: 'python', snapshot: 'xy',
      }),
    );
    const all = await store.listCheckpointsForAttempt('att_1');
    const start = all.find((c) => c.reason === 'start')!;
    const save = all.find((c) => c.reason === 'save')!;
    expect(start.baseline).to.be.true;
    expect(save.baseline).to.be.false;
    expect(attemptBaseline(all, 'att_1')!.checkpointId).to.equal(start.checkpointId);
  });

  it('falls back to reason start for pre-flag records', () => {
    const legacy = createCheckpoint({
      attemptId: 'att_9', sessionId: 'ses_1', timestamp: '2026-01-01T00:00:00.000Z',
      reason: 'start', uri: URI, language: 'python', snapshot: 'old',
    });
    expect(legacy.baseline).to.be.false; // default, not flagged
    expect(attemptBaseline([legacy], 'att_9')).to.not.be.null;
    expect(attemptBaseline([], 'att_9')).to.be.null;
  });
});

describe('Git-style line diffs derived from exact states', () => {
  it('emits context-only diffs for identical states', () => {
    // 'a\nb\n' splits to ['a', 'b', ''] — the trailing element encodes the
    // final newline, so identical states diff to pure context.
    const diff = computeLineDiff('a\nb\n', 'a\nb\n');
    expect(diff.length).to.equal(3);
    expect(diff.every((l) => l.kind === 'context')).to.be.true;
  });

  it('derives adds, removes, and replacements', () => {
    const diff = computeLineDiff('line1\nline2\nline3\n', 'line1\na\nline3\nnewline\n');
    expect(diff.filter((l) => l.kind === 'remove').map((l) => l.text)).to.deep.equal(['line2']);
    expect(diff.filter((l) => l.kind === 'add').map((l) => l.text)).to.deep.equal(['a', 'newline']);
    // Round-trip invariants: diff is a faithful view of both states
    // (join without extra newline — trailing '' elements encode it).
    const oldView = diff.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n');
    const newView = diff.filter((l) => l.kind !== 'remove').map((l) => l.text).join('\n');
    expect(oldView).to.equal('line1\nline2\nline3\n');
    expect(newView).to.equal('line1\na\nline3\nnewline\n');
  });

  it('handles empty states', () => {
    expect(computeLineDiff('', '')).to.deep.equal([]);
    const added = computeLineDiff('', 'x\n');
    expect(added.every((l) => l.kind === 'add')).to.be.true;
    const removed = computeLineDiff('x\n', '');
    expect(removed.every((l) => l.kind === 'remove')).to.be.true;
  });

  it('formats Git-style hunks', () => {
    const text = formatTextDiff(computeLineDiff('a\nb\n', 'a\nc\n'));
    expect(text).to.equal('  a\n- b\n+ c\n  ');
  });
});
