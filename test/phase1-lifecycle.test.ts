import { expect } from 'chai';
import { createManualProblem } from 'codesense/problems/problem';
import { LocalProblemStore } from 'codesense/problems/problemStore';
import { createAttempt, transitionAttemptState, completeAttempt } from 'codesense/attempts/attempt';
import { LocalAttemptStore } from 'codesense/attempts/attemptStore';
import { editRecordsFromEvents } from 'codesense/history/codeHistory';
import { createCheckpoint } from 'codesense/history/checkpoints';
import { buildAIContext } from 'codesense/context/aiContext';
import { createEvent } from 'codesense/events/eventFactory';
import { PythonScraperClient, detectPython } from 'codesense/problems/scraperClient';
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

const STORE = tmpDir('codesense-test-lifecycle');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

function changeEvent(sessionId: string, attemptId: string | null, uri: string, text: string) {
  const event = createEvent({
    sessionId,
    eventType: 'document.changed',
    source: 'document',
    payload: {
      uri,
      languageId: 'python',
      documentVersion: 2,
      versionBefore: 1,
      versionAfter: 2,
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
  event.attemptId = attemptId;
  return event;
}

describe('Problem lifecycle: session -> problem -> attempt -> end', () => {
  it('links activity to the active attempt, not to the file', async () => {
    const problems = new LocalProblemStore(STORE);
    const attempts = new LocalAttemptStore(STORE);

    // Same URL retried => same Problem, two Attempts.
    const url = 'https://leetcode.com/problems/two-sum/';
    const problem = createManualProblem(url, { title: 'Two Sum', statement: 'Add two numbers.' });
    await problems.upsertProblem(problem);

    const attemptA = createAttempt({ problemId: problem.problemId, sessionId: 'ses_1' });
    await attempts.saveAttempt(attemptA);
    // Learner codes main.py for Attempt A.
    const eventsA = [changeEvent('ses_1', attemptA.attemptId, 'file:///main.py', 'print("a")')];
    transitionAttemptState(attemptA, 'Got Stuck', 'learner');
    completeAttempt(attemptA);
    await attempts.saveAttempt(attemptA);

    // Same file reused for a DIFFERENT problem: no permanent binding.
    const other = createManualProblem('https://codeforces.com/problemset/problem/4/A', {
      title: 'Watermelon',
      statement: 'Split it.',
    });
    await problems.upsertProblem(other);
    expect(other.problemId).to.not.equal(problem.problemId);
    const attemptB = createAttempt({ problemId: other.problemId, sessionId: 'ses_1' });
    await attempts.saveAttempt(attemptB);
    const eventsB = [changeEvent('ses_1', attemptB.attemptId, 'file:///main.py', 'print("b")')];

    const recordsA = editRecordsFromEvents(eventsA);
    const recordsB = editRecordsFromEvents(eventsB);
    expect(recordsA[0].attemptId).to.equal(attemptA.attemptId);
    expect(recordsB[0].attemptId).to.equal(attemptB.attemptId);
    expect(recordsA[0].uri).to.equal(recordsB[0].uri); // same file, different attempts
    expect((await attempts.listAttemptsForProblem(problem.problemId)).length).to.equal(1);
    expect((await problems.listProblems()).length).to.equal(2);
  });
});

describe('AI context preparation (deterministic, scoped)', () => {
  it('assembles problem-ready-before-coding context for the active attempt only', async () => {
    const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Add two numbers.',
      difficulty: 'Easy',
      topics: ['Array'],
    });
    const previous = createAttempt({ problemId: problem.problemId, sessionId: 'ses_1' });
    transitionAttemptState(previous, 'Got Stuck', 'learner');
    completeAttempt(previous);

    const current = createAttempt({ problemId: problem.problemId, sessionId: 'ses_1' });
    const edits = editRecordsFromEvents([
      changeEvent('ses_1', current.attemptId, 'file:///main.py', 'x = 1'),
    ]);
    const checkpoints = [
      createCheckpoint({
        attemptId: current.attemptId,
        sessionId: 'ses_1',
        reason: 'save',
        uri: 'file:///main.py',
        language: 'python',
        snapshot: 'x = 1',
      }),
    ];
    const terminalDone = createEvent({
      sessionId: 'ses_1',
      eventType: 'terminal.commandCompleted',
      source: 'terminal',
      payload: { terminalName: 't', commandLine: 'python main.py', exitCode: 0 },
    });

    const ctx = buildAIContext({
      problem,
      attempt: current,
      previousAttempts: [previous],
      edits,
      checkpoints,
      sessionEvents: [terminalDone],
    });

    // Problem metadata resolved at Start Problem is present up front.
    expect(ctx.problem.title).to.equal('Two Sum');
    expect(ctx.problem.source).to.equal('manual');
    expect(ctx.attempt.currentState).to.equal('In Progress');
    expect(ctx.previousAttempts.length).to.equal(1);
    expect(ctx.previousAttempts[0].finalState).to.equal('Got Stuck');
    expect(ctx.code.currentText).to.equal('x = 1');
    expect(ctx.code.recentEdits.length).to.equal(1);
    // Local exit code observed as-is (never equated with a judge verdict).
    expect(ctx.executions.length).to.equal(1);
    expect(ctx.executions[0].exitCode).to.equal(0);
    // Scoped assembly, not a raw session dump.
    expect(Object.keys(ctx).sort()).to.deep.equal([
      'attempt',
      'builtAt',
      'code',
      'conversation',
      'executions',
      'learnerContext',
      'previousAttempts',
      'problem',
      'version',
    ]);
    expect(ctx.version).to.equal(2);
    expect(ctx.conversation).to.deep.equal([]);
    expect(ctx.learnerContext).to.deep.equal({ notes: [] });
  });
});

describe('Python scraper boundary (degrades gracefully)', () => {
  it('reports failure instead of throwing when the script is missing', async function () {
    if (detectPython() === '') {
      this.skip();
    }
    const client = new PythonScraperClient({
      pythonPath: detectPython(),
      scriptPath: path.join(STORE, 'does-not-exist.py'),
      timeoutMs: 15000,
    });
    const result = await client.scrape('https://example.com/q/1');
    expect(result.ok).to.be.false;
    if (!result.ok) {
      expect(result.error.length).to.be.greaterThan(0);
      expect(result.partial).to.be.null;
    }
  });
});
