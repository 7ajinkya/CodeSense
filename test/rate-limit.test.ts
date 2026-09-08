import { expect } from 'chai';
import * as http from 'http';
import {
  RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  parseRetryAfterDelayMs,
  resolveRateLimitCooldownMs,
} from 'codesense/ai/rateLimit';
import { HttpChatReasoner, HttpProviderError } from 'codesense/ai/reasoners';
import { EvaluationPorts, runAiEvaluation } from 'codesense/ai/evaluationRunner';
import { AIConversationMessage, AIEvaluation } from 'codesense/ai/aiTypes';
import { createManualProblem } from 'codesense/problems/problem';
import { createAttempt } from 'codesense/attempts/attempt';
import { AIContext, buildAIContext } from 'codesense/context/aiContext';
import { FakeReasoner } from 'codesense/ai/reasoners';

/**
 * Rate-limit handling: HTTP 429 is classified distinctly from every other
 * failure, Retry-After is honored when usable, and a single conservative
 * fallback covers the rest. Timeouts, malformed output, network failures,
 * and generic provider errors must NEVER classify as rate-limited.
 */

function fixtureContext(attemptId = 'att_rl'): AIContext {
  const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
    title: 'Two Sum',
    statement: 'Add two numbers.',
  });
  const attempt = createAttempt({ attemptId, problemId: problem.problemId, sessionId: 'ses_rl' });
  return buildAIContext({
    problem,
    attempt,
    previousAttempts: [],
    edits: [],
    checkpoints: [],
    sessionEvents: [],
    now: '2026-01-01T00:00:00.000Z',
  });
}

function fakePorts(reasoner: FakeReasoner): EvaluationPorts & {
  saved: AIEvaluation[];
  appended: AIConversationMessage[];
} {
  const saved: AIEvaluation[] = [];
  const appended: AIConversationMessage[] = [];
  return {
    saved,
    appended,
    nowIso: () => '2026-01-01T00:10:00.000Z',
    getActiveAttempt: () => ({
      attempt: createAttempt({ attemptId: 'att_rl', problemId: 'prob_rl', sessionId: 'ses_rl' }),
      problem: createManualProblem('https://leetcode.com/problems/two-sum/', {
        title: 'Two Sum',
        statement: 'Add two numbers.',
      }),
    }),
    buildContext: async () => fixtureContext('att_rl'),
    reasoner,
    saveEvaluation: async (evaluation: AIEvaluation) => {
      saved.push(evaluation);
    },
    appendConversation: async (message: AIConversationMessage) => {
      appended.push(message);
    },
    isAttemptStillActive: (attemptId: string) => attemptId === 'att_rl',
    timeoutMs: 1000,
  };
}

// ---------------------------------------------------------------------------
// Retry-After parsing + fallback (pure)
// ---------------------------------------------------------------------------

describe('Retry-After parsing and fallback cooldown', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterDelayMs('42')).to.equal(42000);
    expect(parseRetryAfterDelayMs('  7  ')).to.equal(7000);
    expect(parseRetryAfterDelayMs('0')).to.equal(0);
  });

  it('parses HTTP-dates relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const future = new Date(now + 30000).toUTCString();
    expect(parseRetryAfterDelayMs(future, now)).to.equal(30000);
    // A past date means "already retryable": zero delay, never negative.
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterDelayMs(past, now)).to.equal(0);
  });

  it('returns null for missing, blank, or malformed values', () => {
    expect(parseRetryAfterDelayMs(null)).to.be.null;
    expect(parseRetryAfterDelayMs(undefined)).to.be.null;
    expect(parseRetryAfterDelayMs('')).to.be.null;
    expect(parseRetryAfterDelayMs('   ')).to.be.null;
    expect(parseRetryAfterDelayMs('soon')).to.be.null;
    expect(parseRetryAfterDelayMs('-5')).to.be.null;
    expect(parseRetryAfterDelayMs('4.5')).to.be.null;
  });

  it('resolves the cooldown: provider value wins, otherwise one fallback', () => {
    expect(RATE_LIMIT_FALLBACK_COOLDOWN_MS).to.be.greaterThan(0);
    expect(resolveRateLimitCooldownMs(42000)).to.equal(42000);
    expect(resolveRateLimitCooldownMs(null)).to.equal(RATE_LIMIT_FALLBACK_COOLDOWN_MS);
    expect(resolveRateLimitCooldownMs(undefined)).to.equal(RATE_LIMIT_FALLBACK_COOLDOWN_MS);
    expect(resolveRateLimitCooldownMs(0)).to.equal(RATE_LIMIT_FALLBACK_COOLDOWN_MS);
    expect(resolveRateLimitCooldownMs(-100)).to.equal(RATE_LIMIT_FALLBACK_COOLDOWN_MS);
    expect(resolveRateLimitCooldownMs(Number.NaN)).to.equal(RATE_LIMIT_FALLBACK_COOLDOWN_MS);
  });
});

// ---------------------------------------------------------------------------
// HTTP boundary: 429 captured distinctly, other statuses preserved
// ---------------------------------------------------------------------------

describe('HttpChatReasoner rate-limit capture (local stub server)', () => {
  let server: http.Server;
  let baseUrl = '';
  let mode: 'rateWithHeader' | 'rateBare' | 'http500' = 'rateWithHeader';

  before((done) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        JSON.parse(raw);
        if (mode === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'busy' }));
        } else if (mode === 'rateBare') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } }));
        } else {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '42' });
          res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}/v1`;
      done();
    });
  });

  after((done) => {
    server.close(() => done());
  });

  function reasoner(): HttpChatReasoner {
    return new HttpChatReasoner({ baseUrl, apiKey: 'stub-key', model: 'stub-model' });
  }

  async function captureError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    expect.fail('expected the request to throw');
  }

  it('throws a typed error preserving status, message, and Retry-After', async () => {
    mode = 'rateWithHeader';
    const err = (await captureError(reasoner().evaluate(fixtureContext(), {}))) as unknown;
    expect(err).to.be.instanceOf(HttpProviderError);
    const typed = err as HttpProviderError;
    expect(typed.status).to.equal(429);
    expect(typed.retryAfter).to.equal('42');
    expect(typed.message).to.match(/HTTP 429/);
  });

  it('captures a missing Retry-After as null instead of guessing', async () => {
    mode = 'rateBare';
    const err = (await captureError(reasoner().evaluate(fixtureContext(), {}))) as HttpProviderError;
    expect(err).to.be.instanceOf(HttpProviderError);
    expect(err.status).to.equal(429);
    expect(err.retryAfter).to.be.null;
  });

  it('keeps generic HTTP failures typed but non-429', async () => {
    mode = 'http500';
    const err = (await captureError(reasoner().evaluate(fixtureContext(), {}))) as HttpProviderError;
    expect(err).to.be.instanceOf(HttpProviderError);
    expect(err.status).to.equal(500);
    expect(err.message).to.match(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// Runner classification: only 429 becomes rate-limited
// ---------------------------------------------------------------------------

describe('Evaluation runner rate-limit classification', () => {
  const request = { attemptId: 'att_rl', triggerKind: 'idle' as const, reason: 'idle' };

  it('classifies 429 with Retry-After as rate-limited with the delay', async () => {
    const ports = fakePorts(
      new FakeReasoner([new HttpProviderError(429, 'AI provider HTTP 429', '30')]),
    );
    const outcome = await runAiEvaluation(ports, request);
    expect(outcome.status).to.equal('failed');
    if (outcome.status !== 'failed') {
      return;
    }
    expect(outcome.reason).to.equal('rate-limited');
    expect(outcome.retryAfterMs).to.equal(30000);
    expect(ports.saved).to.deep.equal([]);
    expect(ports.appended).to.deep.equal([]);
  });

  it('classifies bare 429 as rate-limited without a delay', async () => {
    const ports = fakePorts(new FakeReasoner([new HttpProviderError(429, 'AI provider HTTP 429', null)]));
    const outcome = await runAiEvaluation(ports, request);
    expect(outcome.status).to.equal('failed');
    if (outcome.status !== 'failed') {
      return;
    }
    expect(outcome.reason).to.equal('rate-limited');
    expect(outcome.retryAfterMs).to.be.undefined;
  });

  it('never classifies 500, timeouts, or malformed output as rate-limited', async () => {
    const failing = await runAiEvaluation(
      fakePorts(new FakeReasoner([new HttpProviderError(500, 'AI provider HTTP 500', '30')])),
      request,
    );
    expect(failing.status).to.equal('failed');
    if (failing.status === 'failed') {
      expect(failing.reason).to.equal('provider-error');
    }
    const hanging = new FakeReasoner();
    hanging.evaluate = () => new Promise(() => undefined) as Promise<unknown>;
    const timedOut = await runAiEvaluation(fakePorts(hanging), request);
    expect(timedOut.status).to.equal('failed');
    if (timedOut.status === 'failed') {
      expect(timedOut.reason).to.equal('timeout');
    }
    const malformed = await runAiEvaluation(fakePorts(new FakeReasoner(['nope'])), request);
    expect(malformed.status).to.equal('failed');
    if (malformed.status === 'failed') {
      expect(malformed.reason).to.equal('malformed-response');
    }
  });
});
