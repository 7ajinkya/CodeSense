import { expect } from 'chai';
import { ATTEMPT_STATES } from 'codesense/attempts/attempt';
import { buildSidebarSnapshot } from 'codesense/ui/sidebarView';

describe('Sidebar snapshot (view model over existing state)', () => {
  it('shows no session when idle', () => {
    expect(buildSidebarSnapshot({ session: null, problem: null, attempt: null })).to.deep.equal({
      session: null,
      problem: null,
    });
  });

  it('shows an active session with no problem', () => {
    const snapshot = buildSidebarSnapshot({
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: null,
      attempt: null,
    });
    expect(snapshot.session).to.deep.equal({
      sessionId: 'ses_1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(snapshot.problem).to.be.null;
  });

  it('shows the active problem with authoritative state, blocking End while In Progress', () => {
    const snapshot = buildSidebarSnapshot({
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: { title: 'Two Sum', detail: 'leetcode two-sum' },
      attempt: { currentState: 'In Progress', startedAt: '2026-01-01T00:05:00.000Z' },
    });
    expect(snapshot.problem).to.not.be.null;
    expect(snapshot.problem!.title).to.equal('Two Sum');
    expect(snapshot.problem!.detail).to.equal('leetcode two-sum');
    expect(snapshot.problem!.state).to.equal('In Progress');
    expect(snapshot.problem!.states).to.deep.equal([...ATTEMPT_STATES]);
    expect(snapshot.problem!.canEndProblem).to.be.false;
    expect(snapshot.problem!.attemptStartedAt).to.equal('2026-01-01T00:05:00.000Z');
  });

  it('enables ending after a terminal state', () => {
    const snapshot = buildSidebarSnapshot({
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: { title: 'Two Sum', detail: 'leetcode' },
      attempt: { currentState: 'Got Stuck', startedAt: '2026-01-01T00:05:00.000Z' },
    });
    expect(snapshot.problem!.state).to.equal('Got Stuck');
    expect(snapshot.problem!.canEndProblem).to.be.true;
  });

  it('shows no problem when the attempt is gone (ended/interrupted)', () => {
    const snapshot = buildSidebarSnapshot({
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: null,
      attempt: null,
    });
    expect(snapshot.session).to.not.be.null;
    expect(snapshot.problem).to.be.null;
  });
});
