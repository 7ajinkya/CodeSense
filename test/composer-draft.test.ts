import { expect } from 'chai';
import * as vm from 'vm';
import { CodeSenseSidebarProvider } from 'codesense/ui/sidebarView';

/**
 * Composer draft preservation + rate-limit Send gating, exercised against
 * the SHIPPED webview script with a tiny fake DOM (no VS Code host).
 *
 * Invariant under test: any host refresh preserves the unsent draft; only
 * an accepted Send clears it. A confirmed rate limit disables Send with a
 * countdown and re-enables automatically; nothing else disables Send.
 */

interface FakeEl {
  innerHTML: string;
  textContent: string;
  value: string;
  disabled: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  addEventListener(t: string, f: (...args: unknown[]) => void): void;
  fire(t: string, event?: unknown): void;
}

function makeFakeEl(): FakeEl {
  const el: FakeEl = {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    attrs: {},
    listeners: {},
    setAttribute(k: string, v: string): void {
      el.attrs[k] = v;
    },
    getAttribute(k: string): string | undefined {
      return el.attrs[k];
    },
    addEventListener(t: string, f: (...args: unknown[]) => void): void {
      el.listeners[t] = el.listeners[t] ?? [];
      el.listeners[t].push(f);
    },
    fire(t: string, event: unknown = {}): void {
      for (const f of el.listeners[t] ?? []) {
        f(event);
      }
    },
  };
  return el;
}

interface DraftApi {
  render(snapshot: unknown): void;
  tickRateLimit(): void;
  isRateLimitedNow(): boolean;
  getDraft(): string;
}

interface DraftHarness {
  api: DraftApi;
  els: Record<string, FakeEl>;
  posted: unknown[];
  savedStates: unknown[];
  contentHtml(): string;
  /** Deliver a host snapshot through the real message-event path. */
  push(snapshot: unknown): void;
  /** Posted learner replies (excluding the load-time ready handshake). */
  replies(): Array<{ command: string; text: string }>;
}

function loadDraftHarness(storedState: unknown = null): DraftHarness {
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

  const els: Record<string, FakeEl> = {};
  const posted: unknown[] = [];
  const savedStates: unknown[] = [];
  const windowListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const fakeDocument = {
    body: makeFakeEl(),
    getElementById: (id: string): FakeEl => {
      if (!els[id]) {
        els[id] = makeFakeEl();
      }
      return els[id];
    },
  };
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      postMessage: (m: unknown) => {
        posted.push(m);
      },
      getState: () => storedState,
      setState: (s: unknown) => {
        savedStates.push(s);
      },
    }),
    document: fakeDocument,
    window: {
      addEventListener: (t: string, f: (...args: unknown[]) => void) => {
        windowListeners[t] = windowListeners[t] ?? [];
        windowListeners[t].push(f);
      },
    },
    setInterval: () => 0 as unknown,
    clearInterval: () => undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    script![1] +
      '\n;this.__draft = { render, tickRateLimit, isRateLimitedNow, ' +
      'getDraft: function () { return composerDraft; } };',
    sandbox,
  );
  const api = (sandbox as Record<string, unknown>).__draft as DraftApi;
  return {
    api,
    els,
    posted,
    savedStates,
    contentHtml: () => els.content?.innerHTML ?? '',
    push: (snapshot: unknown) => {
      for (const f of windowListeners.message ?? []) {
        f({ data: { command: 'snapshot', snapshot } });
      }
    },
    replies: () =>
      posted.filter(
        (p): p is { command: string; text: string } =>
          typeof p === 'object' && p !== null && (p as Record<string, unknown>).command === 'aiReply',
      ),
  };
}

function idleSnapshot(
  exchange: Array<{ role: 'coach' | 'learner'; text: string }>,
  ai: Record<string, unknown> = {},
): unknown {
  return {
    session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
    problem: null,
    attempt: null,
    ai: { status: 'idle', message: null, exchange, canReply: true, ...ai },
  };
}

function typeInto(harness: DraftHarness, text: string): void {
  const box = harness.els.aiReply;
  box.value = text;
  box.fire('input');
}

// ---------------------------------------------------------------------------
// Draft preservation across every refresh kind
// ---------------------------------------------------------------------------

describe('Composer draft preservation across host refreshes', () => {
  it('keeps the draft when a coach message arrives', () => {
    const h = loadDraftHarness();
    h.api.render(idleSnapshot([{ role: 'coach', text: 'hello' }]));
    typeInto(h, 'half-typed question?');
    h.api.render(
      idleSnapshot([
        { role: 'coach', text: 'hello' },
        { role: 'coach', text: 'another check-in' },
      ]),
    );
    expect(h.els.aiReply.value).to.equal('half-typed question?');
    expect(h.contentHtml()).to.contain('another check-in');
  });

  it('keeps the draft across rate-limit and generic-failure refreshes', () => {
    const h = loadDraftHarness();
    h.api.render(idleSnapshot([{ role: 'coach', text: 'hello' }]));
    typeInto(h, 'do not lose me');
    h.api.render(
      idleSnapshot([{ role: 'coach', text: 'hello' }], {
        status: 'error',
        rateLimitedUntil: Date.now() + 60000,
      }),
    );
    expect(h.els.aiReply.value).to.equal('do not lose me');
    h.api.render(
      idleSnapshot([{ role: 'coach', text: 'hello' }], { status: 'error' }),
    );
    expect(h.els.aiReply.value).to.equal('do not lose me');
  });

  it('sends exactly the preserved text and clears only on accepted send', () => {
    const h = loadDraftHarness();
    h.push(idleSnapshot([]));
    typeInto(h, 'exact text 123');
    // A proactive refresh lands before Send is pressed.
    h.push(
      idleSnapshot([
        { role: 'coach', text: 'ping' },
      ]),
    );
    h.els.btnReply.fire('click');
    expect(h.replies()).to.deep.equal([{ command: 'aiReply', text: 'exact text 123' }]);
    expect(h.els.aiReply.value).to.equal('');
    expect(h.api.getDraft()).to.equal('');
  });

  it('preserves the draft when Send is blocked by an in-flight reply', () => {
    const h = loadDraftHarness();
    h.push(idleSnapshot([]));
    typeInto(h, 'first');
    h.els.btnReply.fire('click');
    expect(h.replies().length).to.equal(1);
    // No host snapshot arrived yet, so a second press must not duplicate-send.
    typeInto(h, 'second attempt');
    h.els.btnReply.fire('click');
    expect(h.replies().length).to.equal(1);
    expect(h.els.aiReply.value).to.equal('second attempt');
    // A fresh host snapshot re-arms Send; the preserved draft sends verbatim.
    h.push(idleSnapshot([{ role: 'coach', text: 'answer' }]));
    h.els.btnReply.fire('click');
    expect(h.replies().length).to.equal(2);
    expect(h.replies()[1]).to.deep.equal({ command: 'aiReply', text: 'second attempt' });
  });

  it('preserves the draft when Send is blocked by an active rate limit', () => {
    const h = loadDraftHarness();
    h.push(idleSnapshot([]));
    typeInto(h, 'wait out the limit');
    h.push(
      idleSnapshot([], { status: 'error', rateLimitedUntil: Date.now() + 60000 }),
    );
    h.els.btnReply.fire('click');
    expect(h.replies()).to.deep.equal([]);
    expect(h.els.aiReply.value).to.equal('wait out the limit');
  });

  it('survives webview recreation via persisted UI state (merged, not clobbering)', () => {
    const first = loadDraftHarness({ fontSize: 'large' });
    first.api.render(idleSnapshot([]));
    typeInto(first, 'typed before reload');
    const saved = first.savedStates[first.savedStates.length - 1] as Record<string, unknown>;
    expect(saved.composerDraft).to.equal('typed before reload');
    expect(saved.fontSize).to.equal('large');
    const second = loadDraftHarness(saved);
    expect(second.api.getDraft()).to.equal('typed before reload');
    second.api.render(idleSnapshot([]));
    expect(second.els.aiReply.value).to.equal('typed before reload');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit Send gating in the composer
// ---------------------------------------------------------------------------

describe('Rate-limit Send gating in the composer', () => {
  it('disables Send with a live countdown only for a confirmed limit', () => {
    const h = loadDraftHarness();
    h.push(
      idleSnapshot([], { status: 'error', rateLimitedUntil: Date.now() + 42000 }),
    );
    expect(h.api.isRateLimitedNow()).to.be.true;
    expect(h.contentHtml()).to.contain('<button id="btnReply" disabled>');
    expect(h.contentHtml()).to.contain('rate-limited');
    expect(h.contentHtml()).to.contain('rateLimitCountdown');
  });

  it('leaves Send enabled for generic failures without a cooldown', () => {
    const h = loadDraftHarness();
    h.push(idleSnapshot([], { status: 'error' }));
    expect(h.api.isRateLimitedNow()).to.be.false;
    expect(h.contentHtml()).to.contain('<button id="btnReply">');
    expect(h.contentHtml()).to.not.contain('rateLimitStatus');
  });

  it('re-enables Send with an inline ready note when the cooldown lapses', async () => {
    const h = loadDraftHarness();
    h.push(
      idleSnapshot([], { status: 'error', rateLimitedUntil: Date.now() + 1200 }),
    );
    expect(h.contentHtml()).to.contain('<button id="btnReply" disabled>');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Simulate the composer as the disabled markup left it, then tick.
    h.els.btnReply.disabled = true;
    h.api.tickRateLimit();
    expect(h.els.btnReply.disabled).to.be.false;
    expect(h.els.rateLimitStatus.textContent).to.equal('AI ready');
  });

  it('treats an already-expired timestamp as no limit', () => {
    const h = loadDraftHarness();
    h.push(
      idleSnapshot([], { status: 'error', rateLimitedUntil: Date.now() - 1000 }),
    );
    expect(h.api.isRateLimitedNow()).to.be.false;
    expect(h.contentHtml()).to.contain('<button id="btnReply">');
    expect(h.contentHtml()).to.not.contain('rateLimitStatus');
  });
});
