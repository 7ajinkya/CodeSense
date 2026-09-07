import { expect } from 'chai';
import {
  applyChangeEvent,
  createCodeEditRecord,
  editRecordsFromEvents,
  findContinuityGap,
  positionToOffset,
  reconstructSource,
  tryReconstructSource,
} from 'codesense/history/codeHistory';
import {
  MAX_IDLE_CHECKPOINTS,
  countIdleCheckpoints,
  createCheckpoint,
  enforceIdleCheckpointCap,
  latestCheckpointForUri,
} from 'codesense/history/checkpoints';
import { LocalCheckpointStore } from 'codesense/history/checkpointStore';
import { ActivityEvent } from 'codesense/events/activityEvent';
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

const STORE = tmpDir('codesense-test-checkpoints');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

describe('Diff tracking and deterministic reconstruction', () => {
  it('maps positions to offsets with clamping', () => {
    expect(positionToOffset('ab\ncd', 0, 1)).to.equal(1);
    expect(positionToOffset('ab\ncd', 1, 1)).to.equal(4);
    expect(positionToOffset('ab\ncd', 9, 99)).to.equal(5);
  });

  it('reconstructs source from an exact edit sequence', () => {
    const base = 'def solve():\n    pass\n';
    const edits = [
      createCodeEditRecord({
        timestamp: '2026-01-01T00:00:01.000Z',
        sessionId: 'ses_1',
        attemptId: 'att_1',
        uri: 'file:///a.py',
        language: 'python',
        documentVersion: 2,
        versionBefore: 1,
        versionAfter: 2,
        changes: [
          {
            range: { startLine: 1, startCharacter: 4, endLine: 1, endCharacter: 8 },
            rangeLength: 4,
            insertedText: 'return 42',
          },
        ],
      }),
      createCodeEditRecord({
        timestamp: '2026-01-01T00:00:02.000Z',
        sessionId: 'ses_1',
        attemptId: 'att_1',
        uri: 'file:///a.py',
        language: 'python',
        documentVersion: 3,
        versionBefore: 2,
        versionAfter: 3,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
            rangeLength: 0,
            insertedText: '# two sum\n',
          },
        ],
      }),
    ];
    expect(reconstructSource(base, edits)).to.equal('# two sum\ndef solve():\n    return 42\n');
  });

  it('preserves multiple changes within a single change event', () => {
    // Two non-overlapping insertions in one event (pre-change coordinates,
    // as VS Code reports them for a single version transition).
    const base = 'ab';
    const result = applyChangeEvent(base, [
      {
        range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
        rangeLength: 0,
        insertedText: 'X',
      },
      {
        range: { startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 2 },
        rangeLength: 0,
        insertedText: 'Y',
      },
    ]);
    expect(result).to.equal('XabY');
  });

  it('derives edit records from persisted document.changed events', () => {
    const event = createEvent({
      sessionId: 'ses_1',
      eventType: 'document.changed',
      source: 'document',
      payload: {
        uri: 'file:///a.py',
        languageId: 'python',
        documentVersion: 2,
        versionBefore: 1,
        versionAfter: 2,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
            deletedLength: 0,
            insertedLength: 1,
            insertedText: 'x',
          },
          {
            range: { startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 2 },
            deletedLength: 1,
            insertedLength: 1,
            insertedText: 'y',
          },
        ],
      },
    });
    event.attemptId = 'att_1';
    const records = editRecordsFromEvents([event]);
    expect(records.length).to.equal(1);
    expect(records[0].attemptId).to.equal('att_1');
    expect(records[0].changes.length).to.equal(2);
    // Pre-change base 'ab': insert 'x' at 0, replace 'b' with 'y' -> 'xay'.
    expect(reconstructSource('ab', records)).to.equal('xay');
  });

  it('skips Phase 0 length-only history instead of fabricating text', () => {
    const legacy = createEvent({
      sessionId: 'ses_1',
      eventType: 'document.changed',
      source: 'document',
      payload: {
        uri: 'file:///a.py',
        languageId: 'python',
        versionBefore: 1,
        versionAfter: 2,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
            deletedLength: 0,
            insertedLength: 5,
          },
        ],
      },
    });
    expect(editRecordsFromEvents([legacy as ActivityEvent])).to.deep.equal([]);
  });
});

describe('Reconstruction continuity (observation gaps)', () => {
  function seqEdit(versionBefore: number, versionAfter: number, text: string) {
    return createCodeEditRecord({
      timestamp: `2026-01-01T00:00:0${versionAfter}.000Z`,
      sessionId: 'ses_1',
      attemptId: 'att_1',
      uri: 'file:///a.py',
      language: 'python',
      documentVersion: versionAfter,
      versionBefore,
      versionAfter,
      changes: [
        {
          range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
          rangeLength: 0,
          insertedText: text,
        },
      ],
    });
  }

  it('reconstructs a continuous version chain', () => {
    const edits = [seqEdit(1, 2, 'x'), seqEdit(2, 3, 'y')];
    expect(findContinuityGap(edits)).to.be.null;
    const result = tryReconstructSource('ab', edits);
    expect(result.ok).to.be.true;
    expect(result.gapIndex).to.be.null;
    expect(result.text).to.equal('yxab');
  });

  it('reports a gap instead of silently wrong source when a version is missing', () => {
    const edits = [seqEdit(1, 2, 'x'), seqEdit(4, 5, 'y')]; // v3 never observed
    expect(findContinuityGap(edits)).to.equal(1);
    const result = tryReconstructSource('ab', edits);
    expect(result.ok).to.be.false;
    expect(result.text).to.be.null;
    expect(result.gapIndex).to.equal(1);
  });

  it('detects gaps left by skipped Phase-0 length-only events', () => {
    const modern = (vBefore: number, vAfter: number, text: string) =>
      createEvent({
        sessionId: 'ses_1',
        eventType: 'document.changed',
        source: 'document',
        payload: {
          uri: 'file:///a.py',
          languageId: 'python',
          documentVersion: vAfter,
          versionBefore: vBefore,
          versionAfter: vAfter,
          changes: [
            {
              range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
              deletedLength: 0,
              insertedLength: text.length,
              insertedText: text,
            },
          ],
        },
      });
    const legacy = createEvent({
      sessionId: 'ses_1',
      eventType: 'document.changed',
      source: 'document',
      payload: {
        uri: 'file:///a.py',
        languageId: 'python',
        versionBefore: 2,
        versionAfter: 4,
        changes: [
          {
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
            deletedLength: 0,
            insertedLength: 9,
          },
        ],
      },
    });
    // Legacy event is ignored (never fabricated), leaving a detectable gap.
    const records = editRecordsFromEvents([modern(1, 2, 'x'), legacy, modern(4, 5, 'y')]);
    expect(records.length).to.equal(2);
    expect(findContinuityGap(records)).to.equal(1);
    const result = tryReconstructSource('ab', records);
    expect(result.ok).to.be.false;
    expect(result.text).to.be.null;
  });
});

describe('Checkpoints: anchors with an idle cap', () => {
  it('caps idle checkpoints at 10 while keeping important ones', () => {
    const checkpoints = [];
    for (let i = 0; i < 12; i++) {
      checkpoints.push(
        createCheckpoint({
          attemptId: 'att_1',
          sessionId: 'ses_1',
          timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
          reason: 'idle',
          uri: 'file:///a.py',
          language: 'python',
          snapshot: `v${i}`,
        }),
      );
    }
    checkpoints.push(
      createCheckpoint({
        attemptId: 'att_1',
        sessionId: 'ses_1',
        timestamp: '2026-01-01T01:00:00.000Z',
        reason: 'save',
        uri: 'file:///a.py',
        language: 'python',
        snapshot: 'saved',
      }),
    );
    const { kept, removed } = enforceIdleCheckpointCap(checkpoints);
    expect(MAX_IDLE_CHECKPOINTS).to.equal(10);
    expect(countIdleCheckpoints(kept)).to.equal(10);
    expect(removed.length).to.equal(2);
    // Oldest idle evicted first; the save checkpoint is never evicted.
    expect(kept.some((c) => c.reason === 'save')).to.be.true;
    expect(kept.some((c) => c.snapshot === 'v0')).to.be.false;
    expect(kept.some((c) => c.snapshot === 'v11')).to.be.true;
  });

  it('persists checkpoints and finds the latest per file', async () => {
    const store = new LocalCheckpointStore(STORE);
    await store.saveCheckpoint(
      createCheckpoint({
        attemptId: 'att_1',
        sessionId: 'ses_1',
        timestamp: '2026-01-01T00:00:00.000Z',
        reason: 'start',
        uri: 'file:///a.py',
        language: 'python',
        snapshot: 'print(1)',
      }),
    );
    await store.saveCheckpoint(
      createCheckpoint({
        attemptId: 'att_1',
        sessionId: 'ses_1',
        timestamp: '2026-01-01T00:01:00.000Z',
        reason: 'save',
        uri: 'file:///a.py',
        language: 'python',
        snapshot: 'print(2)',
      }),
    );
    const all = await store.listCheckpointsForAttempt('att_1');
    expect(all.length).to.equal(2);
    expect(latestCheckpointForUri(all, 'file:///a.py')!.snapshot).to.equal('print(2)');
    expect(latestCheckpointForUri(all, 'file:///other.py')).to.be.null;
    await store.deleteCheckpoints([all[0].checkpointId]);
    expect((await store.listCheckpointsForAttempt('att_1')).length).to.equal(1);
  });
});
