import { expect } from 'chai';
import {
  ATTEMPT_STATES,
  canEndAttempt,
  completeAttempt,
  createAttempt,
  deriveCurrentState,
  interruptAttempt,
  isKnownAttemptState,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import { LocalAttemptStore } from 'codesense/attempts/attemptStore';
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

const STORE = tmpDir('codesense-test-attempts');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

describe('Attempt lifecycle', () => {
  it('creates an attempt starting In Progress with an initial history entry', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    expect(attempt.attemptId).to.match(/^att_/);
    expect(attempt.currentState).to.equal('In Progress');
    expect(attempt.completedAt).to.be.null;
    expect(attempt.stateHistory.length).to.equal(1);
    expect(deriveCurrentState(attempt)).to.equal('In Progress');
  });

  it('blocks ending while In Progress and allows ending after a terminal state', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    expect(canEndAttempt(attempt.currentState)).to.be.false;
    expect(() => completeAttempt(attempt)).to.throw(/In Progress/);

    transitionAttemptState(attempt, 'Got Stuck', 'learner');
    expect(canEndAttempt(attempt.currentState)).to.be.true;
    completeAttempt(attempt);
    expect(attempt.completedAt).to.not.be.null;
  });

  it('preserves the full transition trail (append-only)', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    transitionAttemptState(attempt, 'Got WA', 'learner');
    transitionAttemptState(attempt, 'In Progress', 'learner');
    transitionAttemptState(attempt, 'Got AC Independently', 'learner');
    const trail = attempt.stateHistory.map((t) => t.toState);
    expect(trail).to.deep.equal(['In Progress', 'Got WA', 'In Progress', 'Got AC Independently']);
    expect(deriveCurrentState(attempt)).to.equal('Got AC Independently');
  });

  it('rejects unknown states', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    expect(isKnownAttemptState('Confused')).to.be.false;
    expect(() => transitionAttemptState(attempt, 'Confused' as never, 'learner')).to.throw();
  });

  it('exposes all required terminal states', () => {
    for (const state of [
      'Got Error / Compilation Error',
      'Got WA',
      'Got TLE',
      'Got MLE',
      'Got AC with Help',
      'Got AC Independently',
      'Got Stuck',
      'Abandoned / Continue Later',
    ]) {
      expect(ATTEMPT_STATES).to.include(state);
      expect(canEndAttempt(state as never)).to.be.true;
    }
  });
});

describe('Attempt interruption (session/host end with open attempt)', () => {
  it('marks an In Progress attempt Abandoned via system and completes it', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    const result = interruptAttempt(attempt, '2026-02-02T00:00:00.000Z');
    expect(result.interrupted).to.be.true;
    expect(attempt.currentState).to.equal('Abandoned / Continue Later');
    expect(attempt.completedAt).to.equal('2026-02-02T00:00:00.000Z');
    const last = attempt.stateHistory[attempt.stateHistory.length - 1];
    expect(last.fromState).to.equal('In Progress');
    expect(last.toState).to.equal('Abandoned / Continue Later');
    expect(last.source).to.equal('system');
    expect(last.note).to.match(/interrupted/);
  });

  it('preserves a terminal learner state and only completes the attempt', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    transitionAttemptState(attempt, 'Got Stuck', 'learner');
    const result = interruptAttempt(attempt);
    expect(result.interrupted).to.be.false;
    expect(attempt.currentState).to.equal('Got Stuck');
    expect(attempt.completedAt).to.not.be.null;
    expect(attempt.stateHistory.length).to.equal(2);
  });

  it('leaves already-completed attempts untouched', () => {
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_1' });
    transitionAttemptState(attempt, 'Got WA', 'learner');
    completeAttempt(attempt, '2026-03-03T00:00:00.000Z');
    const historyLength = attempt.stateHistory.length;
    const result = interruptAttempt(attempt);
    expect(result.interrupted).to.be.false;
    expect(attempt.stateHistory.length).to.equal(historyLength);
    expect(attempt.completedAt).to.equal('2026-03-03T00:00:00.000Z');
  });
});

describe('Attempt store: problems reusable across attempts', () => {
  it('supports multiple attempts for one problem and one active attempt per session', async () => {
    const store = new LocalAttemptStore(STORE);
    const first = createAttempt({ problemId: 'prob_twosum', sessionId: 'ses_1' });
    await store.saveAttempt(first);
    expect(await store.getActiveAttemptForSession('ses_1')).to.not.be.null;

    // End the first attempt, then retry the same problem: new Attempt, same Problem.
    transitionAttemptState(first, 'Got Stuck', 'learner');
    completeAttempt(first);
    await store.saveAttempt(first);
    expect(await store.getActiveAttemptForSession('ses_1')).to.be.null;

    const second = createAttempt({ problemId: 'prob_twosum', sessionId: 'ses_1' });
    await store.saveAttempt(second);
    const attempts = await store.listAttemptsForProblem('prob_twosum');
    expect(attempts.length).to.equal(2);
    expect(attempts[0].attemptId).to.not.equal(attempts[1].attemptId);
    expect(attempts[0].problemId).to.equal(attempts[1].problemId);
    expect((await store.listAttemptsForSession('ses_1')).length).to.equal(2);
  });

  it('round-trips state history through disk', async () => {
    const store = new LocalAttemptStore(STORE);
    const attempt = createAttempt({ problemId: 'prob_1', sessionId: 'ses_9' });
    transitionAttemptState(attempt, 'Got TLE', 'learner', { note: 'too slow' });
    await store.saveAttempt(attempt);
    const loaded = await store.getAttempt(attempt.attemptId);
    expect(loaded).to.not.be.null;
    expect(loaded!.stateHistory.length).to.equal(2);
    expect(loaded!.currentState).to.equal('Got TLE');
    expect(loaded!.stateHistory[1].note).to.equal('too slow');
  });
});
