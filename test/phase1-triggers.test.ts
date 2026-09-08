import { expect } from 'chai';
import {
  HARD_LIMIT_MS,
  IDLE_THRESHOLD_ENV_VAR,
  IDLE_THRESHOLD_MS,
  consumeTrigger,
  createTriggerState,
  evaluateTriggers,
  pollTriggers,
  recordTriggerActivity,
  resolveIdleThresholdMs,
} from 'codesense/triggers/triggerEngine';

const MIN = 60 * 1000;

describe('Trigger engine: idle detection', () => {
  it('fires after 10 minutes of inactivity', () => {
    expect(IDLE_THRESHOLD_MS).to.equal(10 * MIN);
    const t0 = 1_000_000;
    const state = createTriggerState(t0, t0);
    expect(evaluateTriggers(state, t0 + 9 * MIN).eligible).to.be.false;
    const at10 = evaluateTriggers(state, t0 + 10 * MIN);
    expect(at10.eligible).to.be.true;
    expect(at10.kind).to.equal('idle');
  });

  it('any qualifying activity resets the idle watermark', () => {
    const t0 = 1_000_000;
    const state = createTriggerState(t0, t0);
    recordTriggerActivity(state, t0 + 9 * MIN);
    // 9 more minutes of quiet after fresh activity: not yet eligible.
    expect(evaluateTriggers(state, t0 + 18 * MIN).eligible).to.be.false;
    expect(evaluateTriggers(state, t0 + 19 * MIN).eligible).to.be.true;
  });
});

describe('Trigger engine: strict 45-minute hard boundary', () => {
  it('fires at 45 minutes since attempt start', () => {
    expect(HARD_LIMIT_MS).to.equal(45 * MIN);
    const t0 = 2_000_000;
    const state = createTriggerState(t0, t0);
    // Learner checks in every 5 minutes (idle never reaches 10 minutes).
    for (let m = 5; m < 45; m += 5) {
      recordTriggerActivity(state, t0 + m * MIN);
    }
    expect(evaluateTriggers(state, t0 + 44 * MIN + 59_000).eligible).to.be.false;
    const at45 = evaluateTriggers(state, t0 + 45 * MIN);
    expect(at45.eligible).to.be.true;
    expect(at45.kind).to.equal('hard45');
  });

  it('continuous coding activity does NOT suppress the hard limit', () => {
    const t0 = 3_000_000;
    const state = createTriggerState(t0, t0);
    // Learner types every minute for 45 minutes straight (never idle).
    for (let m = 1; m <= 45; m++) {
      recordTriggerActivity(state, t0 + m * MIN);
      const early = evaluateTriggers(state, t0 + m * MIN);
      if (m < 45) {
        expect(early.kind).to.not.equal('hard45');
      }
    }
    const at45 = evaluateTriggers(state, t0 + 45 * MIN);
    expect(at45.eligible).to.be.true;
    expect(at45.kind).to.equal('hard45');
  });

  it('prefers the hard boundary when both conditions hold', () => {
    const t0 = 4_000_000;
    const state = createTriggerState(t0, t0);
    const both = evaluateTriggers(state, t0 + 60 * MIN);
    expect(both.eligible).to.be.true;
    expect(both.kind).to.equal('hard45');
  });
});

describe('Trigger engine: consumption without cooldown', () => {
  it('fires the 45-minute boundary exactly once (no per-second retrigger)', () => {
    const t0 = 5_000_000;
    const state = createTriggerState(t0, t0);
    // Keep the idle condition at bay so this test isolates hard45 consumption.
    for (let m = 5; m <= 45; m += 5) {
      recordTriggerActivity(state, t0 + m * MIN);
    }
    expect(pollTriggers(state, t0 + 45 * MIN).eligible).to.be.true;
    // Same condition one second / one minute later: consumed, silent.
    // (Fresh activity keeps idle below threshold, so nothing else fires.)
    recordTriggerActivity(state, t0 + 45 * MIN + 1000);
    expect(pollTriggers(state, t0 + 45 * MIN + 1000).eligible).to.be.false;
    recordTriggerActivity(state, t0 + 46 * MIN);
    expect(pollTriggers(state, t0 + 46 * MIN).eligible).to.be.false;
  });

  it('fires an idle epoch exactly once, then allows a NEW epoch after fresh activity', () => {
    const t0 = 6_000_000;
    const state = createTriggerState(t0, t0);
    expect(pollTriggers(state, t0 + 10 * MIN).eligible).to.be.true;
    // Same quiet period keeps polling: no repeat (this is consumption,
    // not a cooldown — no timer suppresses anything).
    expect(pollTriggers(state, t0 + 10 * MIN + 1000).eligible).to.be.false;
    expect(pollTriggers(state, t0 + 20 * MIN).eligible).to.be.false;
    // Fresh activity starts a new epoch, which may become eligible again.
    recordTriggerActivity(state, t0 + 21 * MIN);
    expect(pollTriggers(state, t0 + 31 * MIN).eligible).to.be.true;
    expect(pollTriggers(state, t0 + 31 * MIN + 5000).eligible).to.be.false;
  });

  it('supports explicit consume + evaluate sequencing', () => {
    const t0 = 7_000_000;
    const state = createTriggerState(t0, t0);
    const first = evaluateTriggers(state, t0 + 10 * MIN);
    expect(first.eligible).to.be.true;
    if (first.kind) {
      consumeTrigger(state, first.kind);
    }
    expect(evaluateTriggers(state, t0 + 11 * MIN).eligible).to.be.false;
  });
});

describe('Trigger engine: configurable idle threshold (dogfooding override)', () => {
  it('defaults to 10 minutes when the variable is absent', () => {
    expect(IDLE_THRESHOLD_MS).to.equal(600_000);
    expect(resolveIdleThresholdMs({})).to.equal(600_000);
    expect(resolveIdleThresholdMs({ [IDLE_THRESHOLD_ENV_VAR]: undefined })).to.equal(600_000);
  });

  it('respects a custom 60-second value', () => {
    expect(resolveIdleThresholdMs({ [IDLE_THRESHOLD_ENV_VAR]: '60000' })).to.equal(60_000);
  });

  it('falls back safely on invalid or non-positive values', () => {
    for (const bad of ['', '   ', 'bogus', 'NaN', 'Infinity', '-5', '0', '-0.5']) {
      expect(resolveIdleThresholdMs({ [IDLE_THRESHOLD_ENV_VAR]: bad }), JSON.stringify(bad)).to.equal(
        600_000,
      );
    }
  });

  it('fires idle at the custom threshold without touching the hard boundary', () => {
    const t0 = 9_000_000;
    const custom = 60_000;
    const state = createTriggerState(t0, t0);
    expect(pollTriggers(state, t0 + 59_999, custom).eligible).to.be.false;
    const at60 = pollTriggers(state, t0 + 60_000, custom);
    expect(at60.eligible).to.be.true;
    expect(at60.kind).to.equal('idle');
    // Same quiet period: consumed, silent.
    expect(pollTriggers(state, t0 + 61_000, custom).eligible).to.be.false;
    expect(HARD_LIMIT_MS).to.equal(45 * MIN);
  });

  it('hard45 still fires at exactly 45 minutes under a custom idle threshold', () => {
    const t0 = 10_000_000;
    const custom = 60_000;
    const state = createTriggerState(t0, t0);
    // Activity every 30s keeps the 60s idle condition at bay.
    for (let s = 30; s < 45 * 60; s += 30) {
      recordTriggerActivity(state, t0 + s * 1000);
      expect(pollTriggers(state, t0 + s * 1000, custom).eligible).to.be.false;
    }
    const at45 = pollTriggers(state, t0 + 45 * MIN, custom);
    expect(at45.eligible).to.be.true;
    expect(at45.kind).to.equal('hard45');
  });
});

describe('Trigger engine: per-attempt lifecycle reset', () => {
  it('a new attempt starts with a fresh lifecycle (no leaked consumption)', () => {
    const attemptAStart = 8_000_000;
    const stateA = createTriggerState(attemptAStart, attemptAStart);
    for (let m = 5; m <= 45; m += 5) {
      recordTriggerActivity(stateA, attemptAStart + m * MIN);
    }
    // Problem A consumes its 45-minute boundary.
    expect(pollTriggers(stateA, attemptAStart + 45 * MIN).eligible).to.be.true;
    recordTriggerActivity(stateA, attemptAStart + 46 * MIN);
    expect(pollTriggers(stateA, attemptAStart + 46 * MIN).eligible).to.be.false;

    // Problem B starts later: its boundary counts from ITS start.
    const attemptBStart = attemptAStart + 60 * MIN;
    const stateB = createTriggerState(attemptBStart, attemptBStart);
    recordTriggerActivity(stateB, attemptBStart + 40 * MIN);
    expect(evaluateTriggers(stateB, attemptBStart + 44 * MIN).eligible).to.be.false;
    const b45 = evaluateTriggers(stateB, attemptBStart + 45 * MIN);
    expect(b45.eligible).to.be.true;
    expect(b45.kind).to.equal('hard45');
  });
});
