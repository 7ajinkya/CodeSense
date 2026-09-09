import { expect } from 'chai';
import {
  nextCheckinStatus,
  resetCheckinStatusOnAttemptBoundary,
} from 'codesense/ai/evaluationGuard';
import type { CheckinCompletionKind } from 'codesense/ai/evaluationGuard';

/**
 * Check-in panel status transitions (stale-completion protection).
 *
 * Regression coverage for the stuck-banner defect: async evaluation
 * completions used to stamp the sidebar status unconditionally, so a slow
 * failure landing after the learner moved on — or after a newer success —
 * resurrected/planted a "Last check-in failed" banner for the wrong
 * context. Only the currently visible attempt may now move the status;
 * every completion stays in logs + persisted history regardless.
 */
describe('Check-in panel status (recency-gated transitions)', () => {
  it('a visible failure sets the error banner', () => {
    expect(nextCheckinStatus('idle', 'failed', true)).to.equal('error');
    expect(nextCheckinStatus('evaluating', 'failed', true)).to.equal('error');
    expect(nextCheckinStatus('error', 'failed', true)).to.equal('error');
  });

  it('a stale failure never plants or resurrects the banner', () => {
    expect(nextCheckinStatus('idle', 'failed', false)).to.equal('idle');
    expect(nextCheckinStatus('error', 'failed', false)).to.equal('error');
    expect(nextCheckinStatus('evaluating', 'failed', false)).to.equal('evaluating');
  });

  it('a later visible success clears a displayed failure', () => {
    // Required scenario: failure status displayed, then a later check-in
    // succeeds for the visible attempt — the banner must go away.
    expect(nextCheckinStatus('error', 'evaluated-displayed', true)).to.equal('idle');
    expect(nextCheckinStatus('evaluating', 'evaluated-displayed', true)).to.equal('idle');
    expect(nextCheckinStatus('idle', 'evaluated-displayed', true)).to.equal('idle');
  });

  it('a stale success never clears a fresher banner', () => {
    expect(nextCheckinStatus('error', 'evaluated-displayed', false)).to.equal('error');
    expect(nextCheckinStatus('error', 'evaluated-silent', false)).to.equal('error');
    expect(nextCheckinStatus('idle', 'evaluated-displayed', false)).to.equal('idle');
  });

  it('a visible silent check-in returns the panel to neutral', () => {
    // Normal idle-NONE path: nothing to show, no banner either.
    expect(nextCheckinStatus('evaluating', 'evaluated-silent', true)).to.equal('idle');
    expect(nextCheckinStatus('error', 'evaluated-silent', true)).to.equal('idle');
  });

  it('folds a full failure-then-success sequence to idle', () => {
    let status = nextCheckinStatus('idle', 'failed', true);
    expect(status).to.equal('error');
    status = nextCheckinStatus(status, 'evaluated-displayed', true);
    expect(status).to.equal('idle');
  });

  it('folds a success-then-stale-failure sequence without re-arming', () => {
    let status = nextCheckinStatus('idle', 'evaluated-displayed', true);
    expect(status).to.equal('idle');
    // A slow earlier evaluation failing afterwards must not resurrect it.
    status = nextCheckinStatus(status, 'failed', false);
    expect(status).to.equal('idle');
  });

  it('accepts every documented completion kind', () => {
    const kinds: CheckinCompletionKind[] = ['evaluated-displayed', 'evaluated-silent', 'failed'];
    for (const kind of kinds) {
      expect(nextCheckinStatus('idle', kind, true)).to.be.a('string');
      expect(nextCheckinStatus('idle', kind, false)).to.equal('idle');
    }
  });
});

describe('Check-in status on attempt boundaries', () => {
  it('retires transient status when attempts turn over', () => {
    expect(resetCheckinStatusOnAttemptBoundary('evaluating')).to.equal('idle');
    expect(resetCheckinStatusOnAttemptBoundary('error')).to.equal('idle');
  });

  it('leaves steady states untouched', () => {
    expect(resetCheckinStatusOnAttemptBoundary('idle')).to.equal('idle');
    expect(resetCheckinStatusOnAttemptBoundary('unavailable')).to.equal('unavailable');
  });
});
