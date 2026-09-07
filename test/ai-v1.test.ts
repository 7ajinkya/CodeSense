import { expect } from 'chai';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AIConversationMessage,
  AIEvaluation,
  EvaluationTriggerKind,
  isKnownInterventionType,
  validateAIEvaluation,
} from 'codesense/ai/aiTypes';
import {
  COACHING_PROMPT_VERSION,
  COACHING_SYSTEM_PROMPT,
  renderContextForPrompt,
} from 'codesense/ai/aiPrompt';
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, readAiConfig } from 'codesense/ai/aiConfig';
import {
  FakeReasoner,
  HttpChatReasoner,
  buildChatRequest,
  coachMessage,
  extractJsonContent,
  learnerMessage,
} from 'codesense/ai/reasoners';
import { LocalAiStore } from 'codesense/ai/aiStore';
import { EvaluationPorts, HARD45_CHECKIN_MESSAGE, runAiEvaluation } from 'codesense/ai/evaluationRunner';
import {
  AIContext,
  AI_CONTEXT_VERSION,
  buildAIContext,
} from 'codesense/context/aiContext';
import { createManualProblem } from 'codesense/problems/problem';
import { createAttempt } from 'codesense/attempts/attempt';
import { createEvent } from 'codesense/events/eventFactory';
import { createCheckpoint } from 'codesense/history/checkpoints';
import { createCodeEditRecord } from 'codesense/history/codeHistory';
import { createTriggerState, pollTriggers, recordTriggerActivity } from 'codesense/triggers/triggerEngine';

const MIN = 60 * 1000;

/** Minimal async-rejection assertion (no extra test dependencies). */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err instanceof Error ? err.message : String(err)).to.match(pattern);
    return;
  }
  expect.fail('expected promise to reject');
}

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

function scriptedEvaluation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    shouldIntervene: true,
    interventionType: 'SOCRATIC_QUESTION',
    urgency: 'low',
    message: 'What happens to your invariant on line 3 when the input is empty?',
    reasoningSignals: {
      observedApproach: 'Two-pointer scan',
      suspectedIssue: 'Empty-input edge case unhandled',
      confidence: 0.7,
      relevantEvidence: ['edit v3 changed loop bound', 'diagnostics: 0 errors'],
    },
    ...overrides,
  };
}

function fixtureContext(attemptId = 'att_ctx1'): AIContext {
  const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
    title: 'Two Sum',
    statement: 'Add two numbers.',
  });
  const attempt = createAttempt({ attemptId, problemId: problem.problemId, sessionId: 'ses_ctx' });
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

// ---------------------------------------------------------------------------
// Prompt design
// ---------------------------------------------------------------------------

describe('AI prompt (versioned coaching instruction)', () => {
  it('pins a prompt version and states the core contract', () => {
    expect(COACHING_PROMPT_VERSION).to.equal(2);
    expect(COACHING_SYSTEM_PROMPT).to.contain('Socratic');
    expect(COACHING_SYSTEM_PROMPT).to.contain('shouldIntervene');
    expect(COACHING_SYSTEM_PROMPT).to.contain('chain-of-thought');
    expect(COACHING_SYSTEM_PROMPT).to.contain('observed starting state');
    expect(COACHING_SYSTEM_PROMPT).to.contain('Do not use NONE for a mandatory');
    expect(COACHING_SYSTEM_PROMPT).to.contain('not a mandatory hint');
  });

  it('renders scoped context with baseline labeled and statement capped', () => {
    const ctx = fixtureContext();
    const text = renderContextForPrompt(ctx);
    expect(text).to.contain('Two Sum');
    expect(text).to.contain('OBSERVED STARTING STATE');
    expect(text).to.not.contain('sessions.json');
    expect(text).to.not.contain('evt_');
  });

  it('includes conversation when present', () => {
    const ctx = fixtureContext();
    const withConversation: AIContext = {
      ...ctx,
      conversation: [learnerMessage('att_ctx1', 'I tried shrinking the window')],
    };
    expect(renderContextForPrompt(withConversation)).to.contain('shrinking the window');
  });
});

// ---------------------------------------------------------------------------
// Structured output validation
// ---------------------------------------------------------------------------

describe('AIEvaluation validation (strict, never guessed)', () => {
  const opts = { attemptId: 'att_v1', triggerKind: 'idle' as EvaluationTriggerKind, timestamp: '2026-01-01T00:00:00.000Z' };

  it('accepts a complete valid evaluation', () => {
    const evaluation = validateAIEvaluation(scriptedEvaluation(), opts);
    expect(evaluation).to.not.be.null;
    expect(evaluation!.shouldIntervene).to.be.true;
    expect(evaluation!.interventionType).to.equal('SOCRATIC_QUESTION');
    expect(evaluation!.attemptId).to.equal('att_v1');
    expect(evaluation!.evaluationId).to.match(/^eval_/);
    expect(evaluation!.reasoningSignals.confidence).to.equal(0.7);
  });

  it('coerces non-intervening evaluations to the single no-action shape', () => {
    const evaluation = validateAIEvaluation(
      scriptedEvaluation({ shouldIntervene: false, interventionType: 'HINT', message: 'stale text' }),
      opts,
    );
    expect(evaluation).to.not.be.null;
    expect(evaluation!.shouldIntervene).to.be.false;
    expect(evaluation!.interventionType).to.equal('NONE');
    expect(evaluation!.message).to.equal('');
  });

  it('rejects malformed output', () => {
    const bad: unknown[] = [
      null,
      'just a string',
      42,
      {},
      scriptedEvaluation({ shouldIntervene: 'yes' }),
      scriptedEvaluation({ interventionType: 'MIND_READ' }),
      scriptedEvaluation({ urgency: 'extreme' }),
      scriptedEvaluation({ message: '   ' }),
      scriptedEvaluation({ interventionType: 'NONE' }), // NONE + shouldIntervene:true
      scriptedEvaluation({ reasoningSignals: null }),
      scriptedEvaluation({ reasoningSignals: { observedApproach: null, suspectedIssue: null, confidence: 2, relevantEvidence: [] } }),
      scriptedEvaluation({ reasoningSignals: { observedApproach: null, suspectedIssue: null, confidence: null, relevantEvidence: 'x' } }),
      scriptedEvaluation({ reasoningSignals: { observedApproach: 7, suspectedIssue: null, confidence: null, relevantEvidence: [] } }),
    ];
    for (const raw of bad) {
      expect(validateAIEvaluation(raw, opts), JSON.stringify(raw)).to.be.null;
    }
    expect(isKnownInterventionType('HINT')).to.be.true;
    expect(isKnownInterventionType('MIND_READ')).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// Configuration (env-driven, no secrets in source)
// ---------------------------------------------------------------------------

describe('AI configuration', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is disabled without key or custom base URL', () => {
    delete process.env.CODESENSE_AI_API_KEY;
    delete process.env.CODESENSE_AI_BASE_URL;
    const config = readAiConfig();
    expect(config.enabled).to.be.false;
    expect(config.baseUrl).to.equal(DEFAULT_AI_BASE_URL);
    expect(config.model).to.equal(DEFAULT_AI_MODEL);
  });

  it('enables with a key, and honors overrides', () => {
    process.env.CODESENSE_AI_API_KEY = 'sk-test';
    process.env.CODESENSE_AI_MODEL = 'test-model';
    process.env.CODESENSE_AI_TIMEOUT_MS = '5000';
    const config = readAiConfig();
    expect(config.enabled).to.be.true;
    expect(config.model).to.equal('test-model');
    expect(config.timeoutMs).to.equal(5000);
  });

  it('enables keyless local endpoints and falls back on bad timeouts', () => {
    delete process.env.CODESENSE_AI_API_KEY;
    process.env.CODESENSE_AI_BASE_URL = 'http://127.0.0.1:11434/v1/';
    process.env.CODESENSE_AI_TIMEOUT_MS = 'bogus';
    const config = readAiConfig();
    expect(config.enabled).to.be.true;
    expect(config.baseUrl).to.equal('http://127.0.0.1:11434/v1');
    expect(config.timeoutMs).to.be.greaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reasoners: fake (tests) + HTTP (real wire format, local stub server)
// ---------------------------------------------------------------------------

describe('FakeReasoner (scripted provider double)', () => {
  it('replays scripted payloads, records contexts, then defaults to NONE', async () => {
    const fake = new FakeReasoner([scriptedEvaluation(), new Error('boom')]);
    const ctx = fixtureContext();
    expect(await fake.evaluate(ctx)).to.deep.equal(scriptedEvaluation());
    expect(fake.seen.length).to.equal(1);
    await expectRejected(fake.evaluate(ctx), /boom/);
    const fallback = (await fake.evaluate(ctx)) as Record<string, unknown>;
    expect(fallback.shouldIntervene).to.be.false;
    expect(fallback.interventionType).to.equal('NONE');
  });
});

describe('HttpChatReasoner wire format (local stub server, no external calls)', () => {
  let server: http.Server;
  let baseUrl = '';
  let lastBody: unknown = null;
  let mode: 'ok' | 'http500' | 'empty' | 'nonjson' = 'ok';

  before((done) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        lastBody = JSON.parse(raw) as unknown;
        if (mode === 'http500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'busy' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (mode === 'empty') {
          res.end(JSON.stringify({ choices: [] }));
        } else if (mode === 'nonjson') {
          res.end(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scriptedEvaluation()) } }] }));
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

  beforeEach(() => {
    mode = 'ok';
    lastBody = null;
  });

  function reasoner(): HttpChatReasoner {
    return new HttpChatReasoner({ baseUrl, apiKey: 'stub-key', model: 'stub-model' });
  }

  it('posts a bounded JSON request and parses the structured reply', async () => {
    const raw = await reasoner().evaluate(fixtureContext(), {});
    expect((raw as Record<string, unknown>).interventionType).to.equal('SOCRATIC_QUESTION');
    const body = lastBody as Record<string, unknown>;
    expect(body.model).to.equal('stub-model');
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.length).to.equal(2);
    expect(messages[0].role).to.equal('system');
    expect(messages[1].role).to.equal('user');
    expect((body.response_format as Record<string, unknown>).type).to.equal('json_object');
  });

  it('surfaces HTTP, envelope, and content failures as thrown errors', async () => {
    mode = 'http500';
    await expectRejected(reasoner().evaluate(fixtureContext(), {}), /HTTP 500/);
    mode = 'empty';
    await expectRejected(reasoner().evaluate(fixtureContext(), {}), /no choices/);
    mode = 'nonjson';
    await expectRejected(reasoner().evaluate(fixtureContext(), {}), /Unexpected token/);
  });

  it('rejects unreachable hosts without hanging', async () => {
    const dead = new HttpChatReasoner({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm' });
    await expectRejected(dead.evaluate(fixtureContext(), {}), /unreachable/);
  });

  it('builds versioned requests and extracts envelopes purely', () => {
    const request = buildChatRequest('m', fixtureContext());
    expect(request.response_format).to.deep.equal({ type: 'json_object' });
    expect(() => extractJsonContent({})).to.throw();
    expect(() => extractJsonContent({ choices: [{ message: { content: '' } }] })).to.throw();
    expect(extractJsonContent({ choices: [{ message: { content: '{"a":1}' } }] })).to.deep.equal({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// AI stores (local, attempt-scoped)
// ---------------------------------------------------------------------------

describe('AI stores (local evaluations + conversation)', () => {
  const STORE = tmpDir('codesense-test-ai');

  beforeEach(() => clean(STORE));
  afterEach(() => clean(STORE));

  function evaluation(attemptId: string): AIEvaluation {
    const validated = validateAIEvaluation(scriptedEvaluation(), {
      attemptId,
      triggerKind: 'idle',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    if (!validated) {
      throw new Error('fixture evaluation must validate');
    }
    return validated;
  }

  it('persists and scopes evaluations per attempt', async () => {
    const store = new LocalAiStore(STORE);
    await store.saveEvaluation(evaluation('att_a'));
    await store.saveEvaluation(evaluation('att_b'));
    expect((await store.listEvaluationsForAttempt('att_a')).length).to.equal(1);
    expect((await store.listEvaluationsForAttempt('att_b')).length).to.equal(1);
    expect(await store.listEvaluationsForAttempt('att_missing')).to.deep.equal([]);
  });

  it('persists conversation per attempt in order', async () => {
    const store = new LocalAiStore(STORE);
    await store.appendConversation(learnerMessage('att_a', 'first', '2026-01-01T00:00:01.000Z'));
    await store.appendConversation(coachMessage('att_a', 'second', { timestamp: '2026-01-01T00:00:02.000Z' }));
    await store.appendConversation(learnerMessage('att_b', 'other'));
    const mine = await store.listConversation('att_a');
    expect(mine.map((m) => m.text)).to.deep.equal(['first', 'second']);
    expect(mine[0].role).to.equal('learner');
    expect(mine[1].role).to.equal('coach');
  });
});

// ---------------------------------------------------------------------------
// Evaluation runner (lifecycle, stale protection, graceful failure)
// ---------------------------------------------------------------------------

function fakePorts(overrides: Partial<EvaluationPorts> = {}): EvaluationPorts & {
  saved: AIEvaluation[];
  appended: AIConversationMessage[];
  stillActive: boolean;
} {
  const saved: AIEvaluation[] = [];
  const appended: AIConversationMessage[] = [];
  const state = { stillActive: true };
  const ports: EvaluationPorts & {
    saved: AIEvaluation[];
    appended: AIConversationMessage[];
    stillActive: boolean;
  } = {
    saved,
    appended,
    get stillActive(): boolean {
      return state.stillActive;
    },
    set stillActive(value: boolean) {
      state.stillActive = value;
    },
    nowIso: () => '2026-01-01T00:10:00.000Z',
    getActiveAttempt: () => ({
      attempt: createAttempt({ attemptId: 'att_run', problemId: 'prob_run', sessionId: 'ses_run' }),
      problem: createManualProblem('https://leetcode.com/problems/two-sum/', {
        title: 'Two Sum',
        statement: 'Add two numbers.',
      }),
    }),
    buildContext: async () => fixtureContext('att_run'),
    reasoner: new FakeReasoner([scriptedEvaluation()]),
    saveEvaluation: async (evaluation: AIEvaluation) => {
      saved.push(evaluation);
    },
    appendConversation: async (message: AIConversationMessage) => {
      appended.push(message);
    },
    isAttemptStillActive: (attemptId: string): boolean =>
      state.stillActive && attemptId === 'att_run',
    timeoutMs: 1000,
    ...overrides,
  };
  return ports;
}

describe('Evaluation runner', () => {
  it('persists and displays a valid intervention', async () => {
    const ports = fakePorts();
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle for 10m',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.true;
    expect(ports.saved.length).to.equal(1);
    expect(ports.saved[0].triggerKind).to.equal('idle');
    expect(ports.appended.length).to.equal(1);
    expect(ports.appended[0].role).to.equal('coach');
    expect(ports.appended[0].evaluationId).to.equal(ports.saved[0].evaluationId);
  });

  it('persists an idle no-intervention evaluation without displaying anything', async () => {
    const ports = fakePorts({ reasoner: new FakeReasoner() });
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle for 10m',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.false;
    expect(outcome.evaluation.shouldIntervene).to.be.false;
    expect(outcome.evaluation.interventionType).to.equal('NONE');
    expect(ports.saved.length).to.equal(1);
    expect(ports.appended).to.deep.equal([]);
  });

  it('skips when the attempt is gone before starting', async () => {
    const ports = fakePorts({ getActiveAttempt: () => null });
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle',
    });
    expect(outcome).to.deep.equal({ status: 'skipped', reason: 'no-active-attempt' });
    expect(ports.saved).to.deep.equal([]);
  });

  it('fails gracefully on provider errors, malformed output, and timeouts', async () => {
    const failing = await runAiEvaluation(fakePorts({ reasoner: new FakeReasoner([new Error('down')]) }), {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle',
    });
    expect(failing.status).to.equal('failed');
    if (failing.status === 'failed') {
      expect(failing.reason).to.equal('provider-error');
    }

    const malformed = await runAiEvaluation(fakePorts({ reasoner: new FakeReasoner(['nope']) }), {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle',
    });
    expect(malformed.status).to.equal('failed');
    if (malformed.status === 'failed') {
      expect(malformed.reason).to.equal('malformed-response');
    }

    const hanging = new FakeReasoner();
    hanging.evaluate = () => new Promise(() => undefined) as Promise<unknown>;
    const timedOut = await runAiEvaluation(fakePorts({ reasoner: hanging, timeoutMs: 20 }), {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle',
    });
    expect(timedOut.status).to.equal('failed');
    if (timedOut.status === 'failed') {
      expect(timedOut.reason).to.equal('timeout');
    }
  });

  it('persists but never displays a stale evaluation (A ends, B starts, A responds)', async () => {
    let resolveResponse!: (value: unknown) => void;
    const gated = new FakeReasoner();
    gated.evaluate = () =>
      new Promise<unknown>((resolve) => {
        resolveResponse = resolve;
      });
    const ports = fakePorts({ reasoner: gated });
    const pending = runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle',
    });
    // Let the runner reach the reasoner call, then simulate the learner
    // ending Attempt A and starting B while the model is still thinking.
    await new Promise((resolve) => setImmediate(resolve));
    ports.stillActive = false;
    resolveResponse(scriptedEvaluation());
    const outcome = await pending;
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.false;
    // History for A is still preserved.
    expect(ports.saved.length).to.equal(1);
    expect(ports.saved[0].attemptId).to.equal('att_run');
    expect(ports.appended.length).to.equal(1);
  });
});

// ---------------------------------------------------------------------------
// hard45 mandatory check-in (evaluation mandatory AND check-in mandatory)
// ---------------------------------------------------------------------------

describe('hard45 mandatory check-in', () => {
  function acknowledgeModel(): FakeReasoner {
    return new FakeReasoner([
      scriptedEvaluation({
        interventionType: 'ACKNOWLEDGE',
        urgency: 'low',
        message: 'Your loop bound fix looks right — keep pushing.',
      }),
    ]);
  }

  it('displays a model ACKNOWLEDGE with conversation persisted', async () => {
    const ports = fakePorts({ reasoner: acknowledgeModel() });
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'hard45',
      reason: '45-minute hard boundary reached',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.true;
    expect(outcome.evaluation.shouldIntervene).to.be.true;
    expect(outcome.evaluation.interventionType).to.equal('ACKNOWLEDGE');
    expect(outcome.evaluation.message.length).to.be.greaterThan(0);
    expect(ports.saved.length).to.equal(1);
    expect(ports.appended.length).to.equal(1);
    expect(ports.appended[0].role).to.equal('coach');
    expect(ports.appended[0].evaluationId).to.equal(ports.saved[0].evaluationId);
  });

  it('normalizes a model NONE into a deterministic ACKNOWLEDGE check-in', async () => {
    const ports = fakePorts({ reasoner: new FakeReasoner() }); // FakeReasoner defaults to NONE
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'hard45',
      reason: '45-minute hard boundary reached',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.true;
    expect(outcome.evaluation.shouldIntervene).to.be.true;
    expect(outcome.evaluation.interventionType).to.equal('ACKNOWLEDGE');
    expect(outcome.evaluation.urgency).to.equal('low');
    expect(outcome.evaluation.message).to.equal(HARD45_CHECKIN_MESSAGE);
    expect(outcome.evaluation.message.length).to.be.greaterThan(0);
    expect(ports.saved.length).to.equal(1);
    expect(ports.saved[0].interventionType).to.equal('ACKNOWLEDGE');
    expect(ports.appended.length).to.equal(1);
    expect(ports.appended[0].role).to.equal('coach');
  });

  it('still evaluates while the learner is actively coding in In Progress', async () => {
    const ports = fakePorts();
    const active = ports.getActiveAttempt();
    expect(active).to.not.be.null;
    expect(active!.attempt.currentState).to.equal('In Progress');
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'hard45',
      reason: '45-minute hard boundary reached',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    // Active coding / In Progress never suppresses the hard45 evaluation,
    // and the scripted HINT intervention is displayed, not downgraded.
    expect(outcome.displayed).to.be.true;
    expect(outcome.evaluation.interventionType).to.equal('SOCRATIC_QUESTION');
  });

  it('keeps stale hard45 results out of the new attempt but preserves history', async () => {
    let resolveResponse!: (value: unknown) => void;
    const gated = new FakeReasoner();
    gated.evaluate = () =>
      new Promise<unknown>((resolve) => {
        resolveResponse = resolve;
      });
    const ports = fakePorts({ reasoner: gated });
    const pending = runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'hard45',
      reason: '45-minute hard boundary reached',
    });
    await new Promise((resolve) => setImmediate(resolve));
    ports.stillActive = false;
    resolveResponse(scriptedEvaluation({ shouldIntervene: false, interventionType: 'NONE', message: '' }));
    const outcome = await pending;
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.false;
    // Persisted for history as the mandatory ACKNOWLEDGE check-in.
    expect(ports.saved.length).to.equal(1);
    expect(ports.saved[0].triggerKind).to.equal('hard45');
    expect(ports.saved[0].interventionType).to.equal('ACKNOWLEDGE');
    expect(ports.appended.length).to.equal(1);
  });

  it('leaves the general NONE contract untouched (validator unchanged)', async () => {
    // Idle NONE stays silent; only the hard45 path normalizes.
    const ports = fakePorts({ reasoner: new FakeReasoner() });
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_run',
      triggerKind: 'idle',
      reason: 'idle for 10m',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.false;
    expect(outcome.evaluation.interventionType).to.equal('NONE');
    expect(ports.appended).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// AI context: scoping, baseline provenance, reconstruction, conversation
// ---------------------------------------------------------------------------

describe('AI context V1 (scoped assembly for the reasoner)', () => {
  it('exposes version 2 with empty conversation and learner placeholder by default', () => {
    const ctx = fixtureContext();
    expect(ctx.version).to.equal(AI_CONTEXT_VERSION);
    expect(ctx.conversation).to.deep.equal([]);
    expect(ctx.learnerContext).to.deep.equal({ notes: [] });
  });

  it('keeps only the current attempt edits and flags the baseline', () => {
    const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Add two numbers.',
    });
    const current = createAttempt({ attemptId: 'att_now', problemId: problem.problemId, sessionId: 'ses_1' });
    const uri = 'file:///main.py';
    const baseline = createCheckpoint({
      attemptId: 'att_now',
      sessionId: 'ses_1',
      timestamp: '2026-01-01T00:00:00.000Z',
      reason: 'start',
      uri,
      language: 'python',
      documentVersion: 1,
      snapshot: 'x = 0\n',
      baseline: true,
    });
    const ownEdit = createCodeEditRecord({
      sessionId: 'ses_1',
      attemptId: 'att_now',
      uri,
      language: 'python',
      documentVersion: 2,
      versionBefore: 1,
      versionAfter: 2,
      changes: [
        {
          range: { startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 5 },
          rangeLength: 1,
          insertedText: '1',
        },
      ],
    });
    const foreignEdit = createCodeEditRecord({
      sessionId: 'ses_1',
      attemptId: 'att_other',
      uri,
      language: 'python',
      documentVersion: 9,
      versionBefore: 8,
      versionAfter: 9,
      changes: [
        {
          range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
          rangeLength: 0,
          insertedText: 'FOREIGN',
        },
      ],
    });
    const save = createCheckpoint({
      attemptId: 'att_now',
      sessionId: 'ses_1',
      timestamp: '2026-01-01T00:01:00.000Z',
      reason: 'save',
      uri,
      language: 'python',
      documentVersion: 2,
      snapshot: 'x = 1\n',
    });
    const ctx = buildAIContext({
      problem,
      attempt: current,
      previousAttempts: [],
      edits: [foreignEdit, ownEdit],
      checkpoints: [baseline, save],
      sessionEvents: [],
      conversation: [learnerMessage('att_now', 'stuck on the loop')],
      now: '2026-01-01T00:02:00.000Z',
    });
    // Only this attempt's edits survive scoping.
    expect(ctx.code.recentEdits.length).to.equal(1);
    expect(ctx.code.recentEdits[0].attemptId).to.equal('att_now');
    // Baseline is flagged and replay anchors the exact current source.
    expect(ctx.code.baseline).to.not.be.null;
    expect(ctx.code.baseline!.snapshot).to.equal('x = 0\n');
    expect(ctx.code.reconstructionOk).to.be.true;
    expect(ctx.code.reconstructedSource).to.equal('x = 1\n');
    expect(ctx.code.currentText).to.equal('x = 1\n');
    // Checkpoint summaries carry the provenance flag.
    const summaries = new Map(ctx.code.checkpoints.map((c) => [c.reason, c.baseline]));
    expect(summaries.get('start')).to.be.true;
    expect(summaries.get('save')).to.be.false;
    // Conversation becomes future context.
    expect(ctx.conversation.length).to.equal(1);
    expect(ctx.conversation[0].text).to.contain('stuck on the loop');
  });

  it('marks reconstruction failed when the chain cannot anchor', () => {
    const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Add two numbers.',
    });
    const current = createAttempt({ attemptId: 'att_gap', problemId: problem.problemId, sessionId: 'ses_1' });
    const orphan = createCodeEditRecord({
      sessionId: 'ses_1',
      attemptId: 'att_gap',
      uri: 'file:///main.py',
      language: 'python',
      documentVersion: 7,
      versionBefore: 6,
      versionAfter: 7,
      changes: [
        {
          range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
          rangeLength: 0,
          insertedText: 'y',
        },
      ],
    });
    const ctx = buildAIContext({
      problem,
      attempt: current,
      previousAttempts: [],
      edits: [orphan],
      checkpoints: [],
      sessionEvents: [],
      now: '2026-01-01T00:02:00.000Z',
    });
    expect(ctx.code.baseline).to.be.null;
    expect(ctx.code.reconstructionOk).to.be.false;
    expect(ctx.code.reconstructedSource).to.be.null;
  });

  it('excludes unrelated session activity from execution evidence', () => {
    const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Add two numbers.',
    });
    const current = createAttempt({ attemptId: 'att_e', problemId: problem.problemId, sessionId: 'ses_1' });
    // extractExecutionEvidence itself is event-type scoped; attempt scoping
    // happens at assembly time in the extension (see buildEvaluationContext).
    const terminalDone = createEvent({
      sessionId: 'ses_1',
      eventType: 'terminal.commandCompleted',
      source: 'terminal',
      payload: { terminalName: 't', commandLine: 'python main.py', exitCode: 0 },
    });
    const ctx = buildAIContext({
      problem,
      attempt: current,
      previousAttempts: [],
      edits: [],
      checkpoints: [],
      sessionEvents: [terminalDone],
      now: '2026-01-01T00:02:00.000Z',
    });
    expect(ctx.executions.length).to.equal(1);
    expect(ctx.executions[0].kind).to.equal('terminal');
  });
});

// ---------------------------------------------------------------------------
// Trigger -> AI contract (engine semantics reused, never reimplemented)
// ---------------------------------------------------------------------------

describe('Trigger to AI handoff (mandatory boundary without cooldown)', () => {
  it('44:59 no evaluation yet, 45:00 mandatory, 45:01 no refire', () => {
    const t0 = 9_000_000;
    const state = createTriggerState(t0, t0);
    for (let m = 5; m < 45; m += 5) {
      pollTriggers(state, t0 + m * MIN);
    }
    expect(pollTriggers(state, t0 + 44 * MIN + 59_000).eligible).to.be.false;
    const at45 = pollTriggers(state, t0 + 45 * MIN);
    expect(at45.eligible).to.be.true;
    expect(at45.kind).to.equal('hard45');
    // Same boundary one second later: consumed, silent — no cooldown needed.
    expect(pollTriggers(state, t0 + 45 * MIN + 1000).eligible).to.be.false;
  });

  it('idle eligibility is activity-gated while the hard boundary is absolute', () => {
    const t0 = 10_000_000;
    const idle = createTriggerState(t0, t0);
    expect(pollTriggers(idle, t0 + 10 * MIN).kind).to.equal('idle');
    const busy = createTriggerState(t0, t0);
    for (let m = 1; m <= 45; m++) {
      recordTriggerActivity(busy, t0 + m * MIN);
      const evaluation = pollTriggers(busy, t0 + m * MIN);
      if (m < 45) {
        expect(evaluation.kind).to.not.equal('hard45');
        expect(evaluation.kind).to.not.equal('idle');
      }
    }
    // Continuous activity suppressed idle the whole time but never the
    // hard boundary, which fired exactly at 45 minutes.
    expect(busy.hard45Consumed).to.be.true;
  });
});
