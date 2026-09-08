import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { CodeSenseSidebarProvider } from 'codesense/ui/sidebarView';
import { LocalAiStore } from 'codesense/ai/aiStore';
import { tryReserveEvaluation, releaseEvaluation } from 'codesense/ai/evaluationGuard';
import { isAwaitingLearnerResponse } from 'codesense/ai/conversationStatus';
import {
  EvaluationOutcome,
  shouldNotifyProactiveIntervention,
} from 'codesense/ai/evaluationRunner';
import {
  AIConversationMessage,
  AIEvaluation,
  EvaluationTriggerKind,
  validateAIEvaluation,
} from 'codesense/ai/aiTypes';
import { coachMessage, learnerMessage } from 'codesense/ai/reasoners';

/**
 * Phase A (A2 conversation UI, A3 proactive notification, idle suppression).
 *
 * Rendering tests execute the SHIPPED webview script (same vm-harness
 * technique as the A1 parity test) so coach-vs-learner presentation,
 * ordering, and safety are verified on the artifact the learner sees.
 * Notification/suppression/reservation decisions are pure helpers over
 * existing evaluation/trigger metadata — tested directly.
 */

interface WebviewConversation {
  aiHtml(ai: {
    status: 'idle' | 'evaluating' | 'unavailable' | 'error';
    message: string | null;
    exchange: Array<{ role: 'coach' | 'learner'; text: string }>;
    canReply: boolean;
  }): string;
  learnerHtml(text: string): string;
}

function loadWebviewConversation(): WebviewConversation {
  const noop = (): void => undefined;
  const provider = new CodeSenseSidebarProvider({
    startSession: noop,
    endSession: noop,
    startProblem: noop,
    endProblem: noop,
    setProblemState: () => undefined,
    showProblemHistory: noop,
    aiReply: () => undefined,
  });
  let captured = '';
  const fakeView = {
    webview: {
      options: {},
      set html(h: string) {
        captured = h;
      },
      get html(): string {
        return captured;
      },
      onDidReceiveMessage: () => undefined,
      postMessage: () => undefined,
    },
    onDidDispose: () => undefined,
  };
  provider.resolveWebviewView(
    fakeView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
  );
  const script = captured.match(/<script>([\s\S]*?)<\/script>/);
  expect(script, 'webview script must be present').to.not.be.null;
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: { getElementById: () => null },
    window: { addEventListener: () => undefined },
  };
  vm.createContext(sandbox);
  vm.runInContext(script![1] + '\n;this.__ai = { aiHtml, learnerHtml };', sandbox);
  return (sandbox as Record<string, unknown>).__ai as WebviewConversation;
}

function scriptedEvaluation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    shouldIntervene: true,
    interventionType: 'SOCRATIC_QUESTION',
    urgency: 'low',
    message: 'What happens to your invariant when the input is empty?',
    reasoningSignals: {
      observedApproach: 'Two-pointer scan',
      suspectedIssue: 'Empty-input edge case unhandled',
      confidence: 0.7,
      relevantEvidence: ['edit v3 changed loop bound'],
    },
    diagnosis: {
      observedEvidence: ['loop bound changed without an empty-input guard'],
      hypothesis: 'The learner may not have considered the empty-input edge case.',
      confidence: 'medium',
      unknowns: ['Whether the learner knows the empty-input behavior is required'],
      recommendedInteraction: 'SOCRATIC_QUESTION',
    },
    requiresLearnerResponse: true,
    ...overrides,
  };
}

function validatedEvaluation(
  attemptId: string,
  triggerKind: EvaluationTriggerKind,
  overrides: Partial<Record<string, unknown>> = {},
): AIEvaluation {
  const evaluation = validateAIEvaluation(scriptedEvaluation(overrides), {
    attemptId,
    triggerKind,
    timestamp: '2026-01-01T00:10:00.000Z',
  });
  if (!evaluation) {
    throw new Error('fixture evaluation must validate');
  }
  return evaluation;
}

// ---------------------------------------------------------------------------
// A2: conversation rendering (shipped webview script)
// ---------------------------------------------------------------------------

describe('Phase A conversation UI (coach vs learner rendering)', () => {
  const webview = loadWebviewConversation();

  it('renders coach messages as Markdown and learner messages as plain text', () => {
    const html = webview.aiHtml({
      status: 'idle',
      message: null,
      exchange: [
        { role: 'coach', text: 'Try checking **visited** again.' },
        { role: 'learner', text: 'I tried **that** <b>already</b>' },
      ],
      canReply: true,
    });
    expect(html).to.contain('coach-msg');
    expect(html).to.contain('<strong>visited</strong>');
    expect(html).to.contain('learner-msg');
    // Learner Markdown/HTML is never interpreted.
    expect(html).to.contain('**that**');
    expect(html).to.not.contain('<strong>that</strong>');
    expect(html).to.contain('&lt;b&gt;already&lt;/b&gt;');
  });

  it('renders the legacy single-message fallback as coach Markdown', () => {
    const html = webview.aiHtml({
      status: 'idle',
      message: 'Check `visited[nr][nc]` next.',
      exchange: [],
      canReply: false,
    });
    expect(html).to.contain('coach-msg');
    expect(html).to.contain('<code>visited[nr][nc]</code>');
    expect(html).to.not.contain('<textarea');
  });

  it('keeps chronological order (oldest first)', () => {
    const html = webview.aiHtml({
      status: 'idle',
      message: null,
      exchange: [
        { role: 'coach', text: 'first-question' },
        { role: 'learner', text: 'second-reply' },
        { role: 'coach', text: 'third-followup' },
      ],
      canReply: true,
    });
    const first = html.indexOf('first-question');
    const second = html.indexOf('second-reply');
    const third = html.indexOf('third-followup');
    expect(first).to.be.greaterThan(-1);
    expect(second).to.be.greaterThan(first);
    expect(third).to.be.greaterThan(second);
  });

  it('shows the reply box when allowed and disables it while evaluating', () => {
    const idle = webview.aiHtml({ status: 'idle', message: null, exchange: [], canReply: true });
    expect(idle).to.contain('aiReply');
    expect(idle).to.contain('btnReply');
    expect(idle).to.not.contain('disabled');
    const evaluating = webview.aiHtml({
      status: 'evaluating',
      message: null,
      exchange: [],
      canReply: true,
    });
    expect(evaluating).to.contain('disabled');
  });

  it('keeps panel content XSS-safe for both roles', () => {
    const html = webview.aiHtml({
      status: 'idle',
      message: null,
      exchange: [
        { role: 'coach', text: '<script>alert(1)</script>' },
        { role: 'learner', text: '<img src=x onerror=alert(2)>' },
      ],
      canReply: false,
    });
    expect(html).to.not.contain('<script>');
    expect(html).to.contain('&lt;script&gt;');
    expect(html).to.contain('&lt;img');
  });
});

// ---------------------------------------------------------------------------
// A2: persistence (existing store reused, bounded history preserved)
// ---------------------------------------------------------------------------

describe('Phase A conversation persistence (existing store, bounded)', () => {
  const STORE = path.join(os.tmpdir(), 'codesense-test-phase-a-ux');

  beforeEach(() => {
    if (fs.existsSync(STORE)) {
      fs.rmSync(STORE, { recursive: true });
    }
  });
  afterEach(() => {
    if (fs.existsSync(STORE)) {
      fs.rmSync(STORE, { recursive: true });
    }
  });

  it('caps stored conversation per attempt without reordering', async () => {
    const store = new LocalAiStore(STORE);
    for (let i = 0; i < 205; i++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString();
      await store.appendConversation(learnerMessage('att_cap', `msg-${i}`, timestamp));
    }
    const mine = await store.listConversation('att_cap');
    expect(mine.length).to.equal(200);
    expect(mine[0].text).to.equal('msg-5');
    expect(mine[mine.length - 1].text).to.equal('msg-204');
  });
});

// ---------------------------------------------------------------------------
// A2: duplicate-submit protection (reservation protocol)
// ---------------------------------------------------------------------------

describe('Phase A duplicate-submit protection (single evaluation per burst)', () => {
  it('reserves once, refuses duplicates, releases, and isolates attempts', () => {
    const inFlight = new Set<string>();
    expect(tryReserveEvaluation(inFlight, 'att_1')).to.be.true;
    // Back-to-back reply while one is in flight: no second reservation.
    expect(tryReserveEvaluation(inFlight, 'att_1')).to.be.false;
    // A different attempt is unaffected.
    expect(tryReserveEvaluation(inFlight, 'att_2')).to.be.true;
    releaseEvaluation(inFlight, 'att_1');
    expect(tryReserveEvaluation(inFlight, 'att_1')).to.be.true;
    // Releasing an absent id is a safe no-op.
    releaseEvaluation(inFlight, 'att_missing');
    expect(inFlight.has('att_missing')).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// A3: proactive notification decision (existing metadata only)
// ---------------------------------------------------------------------------

describe('Phase A proactive notification (idle/hard45 interventions only)', () => {
  function evaluated(displayed: boolean, triggerKind: EvaluationTriggerKind): EvaluationOutcome {
    return {
      status: 'evaluated',
      evaluation: validatedEvaluation('att_n', triggerKind),
      displayed,
    };
  }

  it('notifies for displayed idle and hard45 interventions', () => {
    expect(shouldNotifyProactiveIntervention('idle', evaluated(true, 'idle'))).to.be.true;
    expect(shouldNotifyProactiveIntervention('hard45', evaluated(true, 'hard45'))).to.be.true;
  });

  it('stays silent for NONE/silent outcomes', () => {
    expect(shouldNotifyProactiveIntervention('idle', evaluated(false, 'idle'))).to.be.false;
    expect(shouldNotifyProactiveIntervention('hard45', evaluated(false, 'hard45'))).to.be.false;
  });

  it('stays silent for reply and manual turns, even when displayed', () => {
    expect(shouldNotifyProactiveIntervention('reply', evaluated(true, 'reply'))).to.be.false;
    expect(shouldNotifyProactiveIntervention('manual', evaluated(true, 'manual'))).to.be.false;
  });

  it('stays silent for failures, skips, and stale attempts', () => {
    const failed: EvaluationOutcome = { status: 'failed', reason: 'timeout', detail: 'slow' };
    const skipped: EvaluationOutcome = { status: 'skipped', reason: 'no-active-attempt' };
    expect(shouldNotifyProactiveIntervention('idle', failed)).to.be.false;
    expect(shouldNotifyProactiveIntervention('hard45', failed)).to.be.false;
    expect(shouldNotifyProactiveIntervention('idle', skipped)).to.be.false;
    // Evaluated but the learner moved on (stale): persisted, never nudged.
    expect(shouldNotifyProactiveIntervention('idle', evaluated(false, 'idle'))).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// Idle suppression (unresolved coach question defers idle evaluation)
// ---------------------------------------------------------------------------

describe('Phase A idle suppression (unresolved question defers idle only)', () => {
  it('suppresses only when the latest coach intervention asks a question', () => {
    const question = validatedEvaluation('att_s', 'idle', {
      interventionType: 'SOCRATIC_QUESTION',
      requiresLearnerResponse: true,
    });
    const hint = validatedEvaluation('att_s', 'idle', {
      interventionType: 'HINT',
      message: 'Try a hash map.',
      requiresLearnerResponse: false,
    });
    const conversation: AIConversationMessage[] = [
      coachMessage('att_s', 'What happens on empty input?', {
        timestamp: '2026-01-01T00:01:00.000Z',
        evaluationId: question.evaluationId,
      }),
    ];
    expect(isAwaitingLearnerResponse(conversation, [question])).to.be.true;
    // Informational interventions never suppress, even when newest.
    const infoOnly: AIConversationMessage[] = [
      coachMessage('att_s', 'Try a hash map.', {
        timestamp: '2026-01-01T00:02:00.000Z',
        evaluationId: hint.evaluationId,
      }),
    ];
    expect(isAwaitingLearnerResponse(infoOnly, [hint])).to.be.false;
  });

  it('clears when the learner replies', () => {
    const question = validatedEvaluation('att_s', 'idle', { interventionType: 'SOCRATIC_QUESTION' });
    const conversation: AIConversationMessage[] = [
      coachMessage('att_s', 'What happens on empty input?', {
        timestamp: '2026-01-01T00:01:00.000Z',
        evaluationId: question.evaluationId,
      }),
      learnerMessage('att_s', 'It throws — I see it now.', '2026-01-01T00:02:00.000Z'),
    ];
    expect(isAwaitingLearnerResponse(conversation, [question])).to.be.false;
  });

  it('never suppresses on empty history, learner-only tails, or unlinkable coach messages', () => {
    const question = validatedEvaluation('att_s', 'idle', { interventionType: 'SOCRATIC_QUESTION' });
    expect(isAwaitingLearnerResponse([], [question])).to.be.false;
    expect(
      isAwaitingLearnerResponse([learnerMessage('att_s', 'hello')], [question]),
    ).to.be.false;
    expect(isAwaitingLearnerResponse([coachMessage('att_s', 'hi')], [question])).to.be.false;
  });

  it('resolves the latest message by timestamp, not array order', () => {
    const question = validatedEvaluation('att_s', 'idle', { interventionType: 'SOCRATIC_QUESTION' });
    const conversation: AIConversationMessage[] = [
      learnerMessage('att_s', 'newer reply', '2026-01-01T00:03:00.000Z'),
      coachMessage('att_s', 'older question?', {
        timestamp: '2026-01-01T00:01:00.000Z',
        evaluationId: question.evaluationId,
      }),
    ];
    expect(isAwaitingLearnerResponse(conversation, [question])).to.be.false;
  });
});
