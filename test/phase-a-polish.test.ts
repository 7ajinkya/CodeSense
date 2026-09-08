import { expect } from 'chai';
import * as vm from 'vm';
import { CodeSenseSidebarProvider } from 'codesense/ui/sidebarView';

/**
 * Post-Phase-A UI polish: real chat layout, full available conversation,
 * CodeSense-only font-size control, typography/control coherence.
 *
 * Rendering tests execute the SHIPPED webview script. Pure helpers are
 * asserted directly; page-level behavior (render/scroll/font-restore) runs
 * against a tiny fake DOM injected into the vm sandbox — no VS Code host,
 * no network, no timers (setInterval is stubbed out).
 */

interface ShippedPage {
  html: string;
  aiHtml(ai: {
    status: 'idle' | 'evaluating' | 'unavailable' | 'error';
    message: string | null;
    exchange: Array<{ role: 'coach' | 'learner'; text: string }>;
    canReply: boolean;
  }): string;
  resolveFontSize(value: unknown): string;
  getFontSize(): string;
  render(snapshot: unknown): void;
  bodyAttrs: Record<string, string>;
  posted: unknown[];
  els: Record<string, FakeEl>;
}

interface FakeEl {
  innerHTML: string;
  value: string;
  disabled: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  addEventListener(t: string, f: (...args: unknown[]) => void): void;
}

function makeFakeEl(): FakeEl {
  return {
    innerHTML: '',
    value: 'medium',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    attrs: {},
    setAttribute(k: string, v: string): void {
      this.attrs[k] = v;
    },
    getAttribute(k: string): string | undefined {
      return this.attrs[k];
    },
    addEventListener(): void {
    /* DOM events are not simulated in these tests. */
  },
  };
}

function loadShippedPage(storedState: unknown = null): ShippedPage {
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
      setState: () => undefined,
    }),
    document: fakeDocument,
    window: { addEventListener: () => undefined },
    setInterval: () => 0 as unknown,
    clearInterval: () => undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    script![1] +
      '\n;this.__cs = { aiHtml, learnerHtml, mdToHtml, resolveFontSize, render, ' +
      'getFontSize: function () { return fontSize; } };',
    sandbox,
  );
  const api = (sandbox as Record<string, unknown>).__cs as {
    aiHtml: ShippedPage['aiHtml'];
    resolveFontSize: ShippedPage['resolveFontSize'];
    render: ShippedPage['render'];
    getFontSize: () => string;
  };
  return {
    html: captured,
    aiHtml: api.aiHtml,
    resolveFontSize: api.resolveFontSize,
    getFontSize: api.getFontSize,
    render: api.render,
    bodyAttrs: fakeDocument.body.attrs,
    posted,
    els,
  };
}

// ---------------------------------------------------------------------------
// 1. Real chat UI: left/right bubbles, sender identity, safe content
// ---------------------------------------------------------------------------

describe('Polish: chat layout (coach left, learner right)', () => {
  const page = loadShippedPage();

  it('aligns coach LEFT and learner RIGHT with distinct bubbles', () => {
    const html = page.aiHtml({
      status: 'idle',
      message: null,
      exchange: [
        { role: 'coach', text: 'Try **this**.' },
        { role: 'learner', text: 'I tried that.' },
      ],
      canReply: true,
    });
    expect(html).to.contain('<div class="msg-row left">');
    expect(html).to.contain('<div class="msg-row right">');
    expect(html).to.contain('bubble coach-msg');
    expect(html).to.contain('bubble learner-msg');
    expect(html.indexOf('msg-row left')).to.be.lessThan(html.indexOf('msg-row right'));
  });

  it('keeps sender identity and safe content inside bubbles', () => {
    const html = page.aiHtml({
      status: 'idle',
      message: null,
      exchange: [
        { role: 'coach', text: 'Check `x` <b>now</b>.' },
        { role: 'learner', text: '**bold?** <img src=x>' },
      ],
      canReply: false,
    });
    expect(html).to.contain('CodeSense');
    expect(html).to.contain('>You<');
    expect(html).to.contain('<code>x</code>');
    expect(html).to.contain('&lt;b&gt;');
    expect(html).to.contain('**bold?**');
    expect(html).to.not.contain('<strong>bold?</strong>');
    expect(html).to.not.contain('<img');
  });

  it('renders the conversation in a labelled, scrollable chat region', () => {
    const html = page.aiHtml({
      status: 'idle',
      message: null,
      exchange: [{ role: 'coach', text: 'hi' }],
      canReply: false,
    });
    expect(html).to.contain('id="chat"');
    expect(html).to.contain('role="log"');
    expect(page.html).to.contain('.chat');
    expect(page.html).to.contain('overflow-y');
  });
});

// ---------------------------------------------------------------------------
// 2. Full available conversation, chronological
// ---------------------------------------------------------------------------

describe('Polish: full available conversation renders chronologically', () => {
  const page = loadShippedPage();

  it('renders a long exchange (beyond the old tail of 6) in order', () => {
    const exchange = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'coach' : 'learner') as 'coach' | 'learner',
      text: `turn-${i}`,
    }));
    const html = page.aiHtml({ status: 'idle', message: null, exchange, canReply: true });
    let prev = -1;
    for (let i = 0; i < 12; i++) {
      const at = html.indexOf(`turn-${i}`);
      expect(at, `turn-${i} present`).to.be.greaterThan(prev);
      prev = at;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. CodeSense-only font-size control
// ---------------------------------------------------------------------------

describe('Polish: CodeSense-only font-size control', () => {
  it('maps stored values with a Medium default', () => {
    const page = loadShippedPage();
    expect(page.resolveFontSize('small')).to.equal('small');
    expect(page.resolveFontSize('medium')).to.equal('medium');
    expect(page.resolveFontSize('large')).to.equal('large');
    expect(page.resolveFontSize('xlarge')).to.equal('xlarge');
    expect(page.resolveFontSize('huge')).to.equal('huge');
    expect(page.resolveFontSize('xhuge')).to.equal('xhuge');
    for (const bad of ['XXL', '', null, undefined, 42]) {
      expect(page.resolveFontSize(bad), JSON.stringify(bad)).to.equal('medium');
    }
  });

  it('offers Small/Medium/Large/Extra Large in the sidebar header', () => {
    const page = loadShippedPage();
    expect(page.html).to.contain('id="fontSizeSelect"');
    expect(page.html).to.contain('for="fontSizeSelect"');
    for (const label of ['Small', 'Medium', 'Large', 'Extra Large']) {
      expect(page.html).to.contain(`>${label}<`);
    }
  });

  it('scopes sizing to the CodeSense webview only', () => {
    const page = loadShippedPage();
    expect(page.html).to.contain('data-cs-font');
    expect(page.html).to.contain('getState');
    expect(page.html).to.contain('setState');
    // Must never reach global/editor/terminal sizing.
    expect(page.html).to.not.contain('editor.fontSize');
    expect(page.html).to.not.contain('workbench');
    expect(page.html).to.not.contain('terminal.integrated.fontSize');
  });

  it('restores the persisted size on load, defaulting to Medium', () => {
    const restored = loadShippedPage({ fontSize: 'xlarge' });
    expect(restored.getFontSize()).to.equal('xlarge');
    expect(restored.bodyAttrs['data-cs-font']).to.equal('xlarge');
    const fresh = loadShippedPage(null);
    expect(fresh.getFontSize()).to.equal('medium');
    const bogus = loadShippedPage({ fontSize: 'XXL' });
    expect(bogus.getFontSize()).to.equal('medium');
  });
});

// ---------------------------------------------------------------------------
// 4-7. Page render: timer pill, controls, scroll policy, accessibility
// ---------------------------------------------------------------------------

describe('Polish: page render (timer, controls, scroll, labels)', () => {
  it('shows the timer as a pill on the problem view', () => {
    const page = loadShippedPage();
    page.render({
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: {
        title: 'Two Sum',
        detail: 'leetcode',
        state: 'Got Stuck',
        states: ['In Progress', 'Got Stuck'],
        canEndProblem: true,
        attemptStartedAt: '2026-01-01T00:05:00.000Z',
      },
      ai: { status: 'idle', message: null, exchange: [], canReply: true },
    });
    const body = page.els.content.innerHTML;
    expect(body).to.contain('timer-pill');
    expect(body).to.contain('id="elapsed"');
    expect(body).to.contain('for="stateSelect"');
    expect(body).to.contain('for="aiReply"');
  });

  it('follows new messages only when already at the bottom', () => {
    const page = loadShippedPage();
    const snapshot = {
      session: { sessionId: 'ses_1', startedAt: '2026-01-01T00:00:00.000Z' },
      problem: null,
      attempt: null,
      ai: {
        status: 'idle',
        message: null,
        exchange: [{ role: 'coach', text: 'hello' }],
        canReply: false,
      },
    };
    // First paint: no chat element yet -> scrolls to bottom.
    page.render(snapshot);
    const chat = page.els.chat;
    expect(chat.scrollTop).to.equal(chat.scrollHeight);
    // Reader scrolled up: position preserved across re-render.
    chat.scrollHeight = 500;
    chat.clientHeight = 100;
    chat.scrollTop = 0;
    page.render(snapshot);
    expect(page.els.chat.scrollTop).to.equal(0);
    // Reader at bottom: follows to the new bottom.
    chat.scrollHeight = 600;
    chat.scrollTop = 500;
    page.render(snapshot);
    expect(page.els.chat.scrollTop).to.equal(600);
  });

  it('keeps controls labelled with visible focus states', () => {
    const page = loadShippedPage();
    expect(page.html).to.contain('for="fontSizeSelect"');
    expect(page.html).to.contain('focus-visible');
    expect(page.html).to.contain('Reply');
  });
});
