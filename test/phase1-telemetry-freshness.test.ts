import { expect } from 'chai';
import { createManualProblem } from 'codesense/problems/problem';
import { createAttempt } from 'codesense/attempts/attempt';
import {
  editRecordsFromEvents,
  findContinuityGap,
  selectAttemptEdits,
} from 'codesense/history/codeHistory';
import { createCheckpoint } from 'codesense/history/checkpoints';
import { LocalCheckpointStore } from 'codesense/history/checkpointStore';
import { buildAIContext } from 'codesense/context/aiContext';
import { createEvent } from 'codesense/events/eventFactory';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

const STORE = tmpDir('codesense-test-telemetry-freshness');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

const URI = 'file:///main.py';
const V1 = 'def solve():\n    pass\n';
const V2 = 'def solve():\n    return []\n';
const V3 = 'def solve():\n    result = []\n    return result\n';
const V4 = 'def solve():\n    result = []\n    result.append(1)\n    return result\n';

/** Mirrors the host document.changed payload shape (versions advance per event). */
function changeEvent(
  timestamp: string,
  versionAfter: number,
  change: { startLine: number; startCharacter: number; endLine: number; endCharacter: number; deletedLength: number; insertedText: string },
) {
  const event = createEvent({
    sessionId: 'ses_1',
    eventType: 'document.changed',
    source: 'document',
    payload: {
      filePath: '/main.py',
      uri: URI,
      languageId: 'python',
      documentVersion: versionAfter,
      versionBefore: versionAfter - 1,
      versionAfter,
      changes: [
        {
          range: {
            startLine: change.startLine,
            startCharacter: change.startCharacter,
            endLine: change.endLine,
            endCharacter: change.endCharacter,
          },
          deletedLength: change.deletedLength,
          insertedLength: change.insertedText.length,
          insertedLineCount: 0,
          insertedText: change.insertedText,
        },
      ],
    },
    timestamp,
  });
  event.attemptId = 'att_fresh_1';
  return event;
}

// Exact replay chain V1 -> V2 -> V3 -> V4 (pre-change coordinates, as VS Code reports them).
const EDIT1 = { startLine: 1, startCharacter: 4, endLine: 1, endCharacter: 8, deletedLength: 4, insertedText: 'return []' };
const EDIT2 = {
  startLine: 1, startCharacter: 4, endLine: 1, endCharacter: 13, deletedLength: 9,
  insertedText: 'result = []\n    return result',
};
const EDIT3 = {
  startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 0, deletedLength: 0,
  insertedText: '    result.append(1)\n',
};

function problemFixture() {
  return createManualProblem('https://leetcode.com/problems/two-sum/', {
    title: 'Two Sum',
    statement: 'Add two numbers.',
  });
}

describe('Attempt telemetry stays complete across edits and saves', () => {
  it('keeps every edit of a multi-edit attempt in history', () => {
    const events = [
      changeEvent('2026-09-09T10:01:00.000Z', 2, EDIT1),
      changeEvent('2026-09-09T10:03:00.000Z', 3, EDIT2),
      changeEvent('2026-09-09T10:05:00.000Z', 4, EDIT3),
    ];
    const records = selectAttemptEdits(editRecordsFromEvents(events), 'att_fresh_1');
    expect(records).to.have.lengthOf(3);
    expect(records.map((r) => r.documentVersion)).to.deep.equal([2, 3, 4]);
    expect(records.map((r) => r.changes[0]?.insertedText)).to.deep.equal([
      'return []',
      'result = []\n    return result',
      '    result.append(1)\n',
    ]);
  });

  it('preserves every change of a multi-change single event', () => {
    const event = createEvent({
      sessionId: 'ses_1',
      eventType: 'document.changed',
      source: 'document',
      payload: {
        filePath: '/main.py',
        uri: URI,
        languageId: 'python',
        documentVersion: 2,
        versionBefore: 1,
        versionAfter: 2,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
            deletedLength: 0,
            insertedLength: 1,
            insertedLineCount: 0,
            insertedText: 'X',
          },
          {
            range: { startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 2 },
            deletedLength: 0,
            insertedLength: 1,
            insertedLineCount: 0,
            insertedText: 'Y',
          },
        ],
      },
      timestamp: '2026-09-09T10:01:00.000Z',
    });
    event.attemptId = 'att_fresh_1';
    const records = editRecordsFromEvents([event]);
    expect(records).to.have.lengthOf(1);
    expect(records[0]?.changes.map((c) => c.insertedText)).to.deep.equal(['X', 'Y']);
  });

  it('chains versions across successive edits without gaps', () => {
    const events = [
      changeEvent('2026-09-09T10:01:00.000Z', 2, EDIT1),
      changeEvent('2026-09-09T10:03:00.000Z', 3, EDIT2),
      changeEvent('2026-09-09T10:05:00.000Z', 4, EDIT3),
    ];
    const records = editRecordsFromEvents(events);
    for (const record of records) {
      expect(record.versionBefore).to.be.lessThan(record.versionAfter);
    }
    for (let i = 1; i < records.length; i++) {
      expect(records[i]?.versionBefore).to.equal(records[i - 1]?.versionAfter);
    }
    expect(findContinuityGap(records)).to.be.null;
  });

  it('persists three saves as three distinct checkpoints', async () => {
    const store = new LocalCheckpointStore(STORE);
    const snaps: Array<[string, string, number]> = [
      ['2026-09-09T10:02:00.000Z', V2, 2],
      ['2026-09-09T10:04:00.000Z', V3, 3],
      ['2026-09-09T10:06:00.000Z', V4, 4],
    ];
    for (const [at, snapshot, version] of snaps) {
      await store.saveCheckpoint(
        createCheckpoint({
          attemptId: 'att_fresh_1',
          sessionId: 'ses_1',
          timestamp: at,
          reason: 'save',
          uri: URI,
          language: 'python',
          documentVersion: version,
          snapshot,
        }),
      );
    }
    const listed = await store.listCheckpointsForAttempt('att_fresh_1');
    expect(listed).to.have.lengthOf(3);
    // Later saves never overwrite earlier checkpoints.
    expect(new Set(listed.map((c) => c.checkpointId)).size).to.equal(3);
    expect(listed.map((c) => c.snapshot)).to.deep.equal([V2, V3, V4]);
    expect(listed.map((c) => c.reason)).to.deep.equal(['save', 'save', 'save']);
    expect(listed.map((c) => c.documentVersion)).to.deep.equal([2, 3, 4]);
    expect(listed.every((c) => c.baseline === false)).to.be.true;
  });
});

describe('Evaluation context freshness (rebuilt per evaluation, never reused)', () => {
  function checkpointsThrough(version: 2 | 3 | 4) {
    const all = [
      createCheckpoint({
        checkpointId: 'chk_base',
        attemptId: 'att_fresh_1',
        sessionId: 'ses_1',
        timestamp: '2026-09-09T10:00:00.000Z',
        reason: 'start',
        uri: URI,
        language: 'python',
        documentVersion: 1,
        snapshot: V1,
        baseline: true,
      }),
      createCheckpoint({
        checkpointId: 'chk_s1',
        attemptId: 'att_fresh_1',
        sessionId: 'ses_1',
        timestamp: '2026-09-09T10:02:00.000Z',
        reason: 'save',
        uri: URI,
        language: 'python',
        documentVersion: 2,
        snapshot: V2,
      }),
      createCheckpoint({
        checkpointId: 'chk_s2',
        attemptId: 'att_fresh_1',
        sessionId: 'ses_1',
        timestamp: '2026-09-09T10:04:00.000Z',
        reason: 'save',
        uri: URI,
        language: 'python',
        documentVersion: 3,
        snapshot: V3,
      }),
      createCheckpoint({
        checkpointId: 'chk_s3',
        attemptId: 'att_fresh_1',
        sessionId: 'ses_1',
        timestamp: '2026-09-09T10:06:00.000Z',
        reason: 'save',
        uri: URI,
        language: 'python',
        documentVersion: 4,
        snapshot: V4,
      }),
    ];
    return all.filter((c) => (c.documentVersion ?? 0) <= version);
  }

  function editsThrough(version: 2 | 3 | 4) {
    const edits: Record<number, { change: typeof EDIT1; at: string }> = {
      2: { change: EDIT1, at: '2026-09-09T10:01:00.000Z' },
      3: { change: EDIT2, at: '2026-09-09T10:03:00.000Z' },
      4: { change: EDIT3, at: '2026-09-09T10:05:00.000Z' },
    };
    const events = [];
    for (let v = 2; v <= version; v++) {
      const entry = edits[v] as { change: typeof EDIT1; at: string };
      events.push(changeEvent(entry.at, v, entry.change));
    }
    return selectAttemptEdits(editRecordsFromEvents(events), 'att_fresh_1');
  }

  it('a later context build reflects newer telemetry, not the first build', () => {
    const problem = problemFixture();
    const attempt = createAttempt({ attemptId: 'att_fresh_1', problemId: problem.problemId, sessionId: 'ses_1' });
    const first = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: editsThrough(2),
      checkpoints: checkpointsThrough(2),
      sessionEvents: [],
    });
    expect(first.code.currentText).to.equal(V2);
    // More edits and saves land; the next evaluation rebuilds from scratch.
    const second = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: editsThrough(4),
      checkpoints: checkpointsThrough(4),
      sessionEvents: [],
    });
    expect(second.code.currentText).to.equal(V4);
    expect(second.code.currentText).to.not.equal(first.code.currentText);
    expect(second.code.recentEdits).to.have.lengthOf(3);
    expect(second.code.reconstructionOk).to.be.true;
  });

  it('exposes the complete evolution span, not only the first saved state', () => {
    const problem = problemFixture();
    const attempt = createAttempt({ attemptId: 'att_fresh_1', problemId: problem.problemId, sessionId: 'ses_1' });
    const ctx = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: editsThrough(4),
      checkpoints: checkpointsThrough(4),
      sessionEvents: [],
    });
    // Newest checkpoint (full snapshot) is first.
    expect(ctx.code.checkpoints[0]?.reason).to.equal('save');
    expect(ctx.code.checkpoints[0]?.snapshot).to.equal(V4);
    // Evolution diffs span the whole attempt: baseline through latest save.
    expect(ctx.code.evolutionDiffs).to.have.lengthOf(3);
    expect(ctx.code.evolutionDiffs[0]?.label ?? '').to.match(/^start@/);
    expect(ctx.code.evolutionDiffs[ctx.code.evolutionDiffs.length - 1]?.label ?? '').to.match(/-> save@/);
    // The anchor is intact and the replay reaches the latest text.
    expect(ctx.code.baseline?.snapshot).to.equal(V1);
    expect(ctx.code.reconstructedSource).to.equal(V4);
  });

  it('an idle checkpoint feeds the next build as the newest state', () => {
    const problem = problemFixture();
    const attempt = createAttempt({ attemptId: 'att_fresh_1', problemId: problem.problemId, sessionId: 'ses_1' });
    const withIdle = [
      ...checkpointsThrough(4),
      createCheckpoint({
        checkpointId: 'chk_idle',
        attemptId: 'att_fresh_1',
        sessionId: 'ses_1',
        timestamp: '2026-09-09T10:16:00.000Z',
        reason: 'idle',
        uri: URI,
        language: 'python',
        documentVersion: 4,
        snapshot: V4,
      }),
    ];
    const ctx = buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: editsThrough(4),
      checkpoints: withIdle,
      sessionEvents: [],
    });
    expect(ctx.code.currentText).to.equal(V4);
    expect(ctx.code.checkpoints[0]?.reason).to.equal('idle');
    expect(ctx.code.checkpoints[0]?.snapshot).to.equal(V4);
    const last = ctx.code.evolutionDiffs[ctx.code.evolutionDiffs.length - 1];
    expect(last?.label ?? '').to.match(/-> idle@/);
  });
});
