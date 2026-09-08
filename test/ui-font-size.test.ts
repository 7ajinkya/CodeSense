import { expect } from 'chai';
import * as vm from 'vm';
import {
  DEFAULT_UI_FONT_SIZE_ID,
  UI_FONT_SIZES,
  resolveUIFontSize,
  uiFontSizePx,
} from 'codesense/ui/fontSize';
import { renderStartProblemHtml } from 'codesense/ui/startProblemHtml';
import { CodeSenseSidebarProvider } from 'codesense/ui/sidebarView';

/**
 * Shared CodeSense UI font size: one canonical preference consumed by both
 * the AI sidebar and the Start Problem panel. Webview scripts mirror only
 * the tiny resolver + data-cs-font rules; these tests pin every surface to
 * the canonical list so the mirrors cannot drift.
 */

const EXPECTED_OPTIONS: Array<[string, string, number]> = [
  ['small', 'Small', 12],
  ['medium', 'Medium', 13],
  ['large', 'Large', 15],
  ['xlarge', 'Extra Large', 17],
  ['huge', 'Huge', 20],
  ['xhuge', 'Extra Huge', 23],
];

function optionValues(html: string, selectId: string | null = null): string[] {
  let scope = html;
  if (selectId !== null) {
    const select = html.match(new RegExp(`<select id="${selectId}">([\\s\\S]*?)</select>`));
    expect(select, `select #${selectId} must be present`).to.not.be.null;
    scope = select![1];
  }
  const values: string[] = [];
  const re = /<option value="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scope)) !== null) {
    values.push(match[1]);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Canonical representation (host + tests)
// ---------------------------------------------------------------------------

describe('Shared font size: canonical list', () => {
  it('defines all six levels with labels and a materially larger top end', () => {
    expect(UI_FONT_SIZES.map((o) => [o.id, o.label, o.px])).to.deep.equal(EXPECTED_OPTIONS);
    expect(DEFAULT_UI_FONT_SIZE_ID).to.equal('medium');
    const px = UI_FONT_SIZES.map((o) => o.px);
    expect([...px].sort((a, b) => a - b)).to.deep.equal(px);
    expect(uiFontSizePx('xhuge') - uiFontSizePx('xlarge')).to.be.greaterThan(4);
  });

  it('resolves stored/posted values with a Medium fallback', () => {
    for (const [id] of EXPECTED_OPTIONS) {
      expect(resolveUIFontSize(id)).to.equal(id);
    }
    for (const bad of [undefined, null, '', 'XXL', 'HUGE', 42]) {
      expect(resolveUIFontSize(bad), JSON.stringify(bad)).to.equal('medium');
    }
    expect(uiFontSizePx('bogus')).to.equal(uiFontSizePx('medium'));
  });
});

// ---------------------------------------------------------------------------
// Sidebar surface
// ---------------------------------------------------------------------------

function loadSidebarHtml(): string {
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
  provider.resolveWebviewView({
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
  } as unknown as Parameters<typeof provider.resolveWebviewView>[0]);
  return captured;
}

function loadSidebarScript(): { script: string; html: string } {
  const html = loadSidebarHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(script, 'sidebar script must be present').to.not.be.null;
  return { script: script![1], html };
}

describe('Shared font size: sidebar surface', () => {
  it('renders the canonical six options with Medium selected by default', () => {
    const { html } = loadSidebarScript();
    expect(optionValues(html, 'fontSizeSelect')).to.deep.equal(EXPECTED_OPTIONS.map(([id]) => id));
    for (const [, label] of EXPECTED_OPTIONS) {
      expect(html).to.contain(`>${label}<`);
    }
    expect(html).to.contain('<option value="medium" selected>Medium</option>');
  });

  it('carries data-cs-font rules for all six levels', () => {
    const { html } = loadSidebarScript();
    for (const [id, , px] of EXPECTED_OPTIONS) {
      expect(html, id).to.contain(`body[data-cs-font="${id}"]`);
      expect(html, `${id}px`).to.contain(`font-size: ${px}px`);
    }
  });

  it('resolves all six ids in the shipped webview script', () => {
    const { script } = loadSidebarScript();
    const sandbox: Record<string, unknown> = {
      acquireVsCodeApi: () => ({ postMessage: () => undefined, getState: () => null, setState: () => undefined }),
      document: { getElementById: () => null },
      window: { addEventListener: () => undefined },
    };
    vm.createContext(sandbox);
    vm.runInContext(script + '\n;this.__fs = { resolveFontSize };', sandbox);
    const resolveFontSize = (sandbox as Record<string, unknown>).__fs as {
      resolveFontSize(v: unknown): string;
    };
    for (const [id] of EXPECTED_OPTIONS) {
      expect(resolveFontSize.resolveFontSize(id)).to.equal(id);
    }
    expect(resolveFontSize.resolveFontSize('XXL')).to.equal('medium');
  });
});

// ---------------------------------------------------------------------------
// Provider host seam: ready push + incoming setFontSize
// ---------------------------------------------------------------------------

describe('Shared font size: provider host seam', () => {
  function wiredProvider(hostSize: string): {
    posted: unknown[];
    setFontSizeCalls: unknown[];
    incoming: (msg: unknown) => void;
  } {
    const posted: unknown[] = [];
    const setFontSizeCalls: unknown[] = [];
    let handler: ((msg: unknown) => void) | null = null;
    const provider = new CodeSenseSidebarProvider({
      startSession: () => undefined,
      endSession: () => undefined,
      startProblem: () => undefined,
      endProblem: () => undefined,
      setProblemState: () => undefined,
      showProblemHistory: () => undefined,
      aiReply: () => undefined,
      getFontSize: () => hostSize,
      setFontSize: (size: string) => {
        setFontSizeCalls.push(size);
      },
    });
    provider.resolveWebviewView({
      webview: {
        options: {},
        set html(_h: string) {
          /* sidebar shell not asserted here */
        },
        get html(): string {
          return '';
        },
        onDidReceiveMessage: (h: (msg: unknown) => void) => {
          handler = h;
        },
        postMessage: (m: unknown) => {
          posted.push(m);
        },
      },
      onDidDispose: () => undefined,
    } as unknown as Parameters<typeof provider.resolveWebviewView>[0]);
    expect(handler, 'message handler must be registered').to.not.be.null;
    return {
      posted,
      setFontSizeCalls,
      incoming: (msg: unknown) => handler!(msg),
    };
  }

  it('pushes the host-owned size on ready for adoption', () => {
    const { posted, incoming } = wiredProvider('huge');
    incoming({ command: 'ready' });
    expect(posted).to.deep.include({ command: 'fontSize', size: 'huge' });
  });

  it('forwards sidebar changes to the host and host pushes to the webview', () => {
    const { posted, setFontSizeCalls, incoming } = wiredProvider('medium');
    incoming({ command: 'setFontSize', size: 'xhuge' });
    expect(setFontSizeCalls).to.deep.equal(['xhuge']);
    incoming({ command: 'setFontSize', size: 42 });
    expect(setFontSizeCalls).to.deep.equal(['xhuge']);
    expect(posted.length).to.be.greaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Start Problem surface
// ---------------------------------------------------------------------------

describe('Shared font size: Start Problem surface', () => {
  it('bakes the shared size and offers the canonical options', () => {
    const html = renderStartProblemHtml('xlarge');
    expect(html).to.contain('data-cs-font="xlarge"');
    expect(html).to.contain('<option value="xlarge" selected>Extra Large</option>');
    expect(optionValues(html, 'fontSize')).to.deep.equal(EXPECTED_OPTIONS.map(([id]) => id));
    const fallback = renderStartProblemHtml('bogus');
    expect(fallback).to.contain('data-cs-font="medium"');
  });

  it('keeps every existing Start Problem field and control', () => {
    const html = renderStartProblemHtml('medium');
    for (const id of ['url', 'title', 'statement', 'constraints', 'difficulty', 'topics', 'startBtn', 'cancelBtn', 'status', 'fontSize']) {
      expect(html, id).to.contain(`id="${id}"`);
    }
    expect(html).to.contain('for="fontSize"');
  });

  it('carries data-cs-font rules for all six levels with em-based controls', () => {
    const html = renderStartProblemHtml('medium');
    for (const [id, , px] of EXPECTED_OPTIONS) {
      expect(html, id).to.contain(`body[data-cs-font="${id}"]`);
      expect(html, `${id}px`).to.contain(`font-size: ${px}px`);
    }
    expect(html).to.contain('font-size: 1em');
    expect(html).to.contain('min-height: 12em');
  });
});

// ---------------------------------------------------------------------------
// Start Problem runtime: bake respected, messages applied, changes posted
// ---------------------------------------------------------------------------

interface PanelEl {
  value: string;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  textContent: string;
  className: string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  addEventListener(t: string, f: (...args: unknown[]) => void): void;
  fire(t: string, event?: unknown): void;
}

function loadPanel(initialBaked: string | null): {
  posted: unknown[];
  els: Record<string, PanelEl>;
  bodyAttrs: Record<string, string>;
  windowFire: (msg: unknown) => void;
  fontSize(): string;
} {
  const html = renderStartProblemHtml('medium');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(script, 'panel script must be present').to.not.be.null;
  const els: Record<string, PanelEl> = {};
  const posted: unknown[] = [];
  const windowListeners: Array<(event: unknown) => void> = [];
  function makeEl(): PanelEl {
    const el: PanelEl = {
      value: '',
      attrs: {},
      listeners: {},
      textContent: '',
      className: '',
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
  const body = makeEl();
  if (initialBaked !== null) {
    body.attrs['data-cs-font'] = initialBaked;
  }
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({
      postMessage: (m: unknown) => {
        posted.push(m);
      },
    }),
    document: {
      body,
      getElementById: (id: string): PanelEl => {
        if (!els[id]) {
          els[id] = makeEl();
        }
        return els[id];
      },
    },
    window: {
      addEventListener: (_t: string, f: (event: unknown) => void) => {
        windowListeners.push(f);
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    script![1] + '\n;this.__panel = { getFontSize: function () { return fontSize; } };',
    sandbox,
  );
  const api = (sandbox as Record<string, unknown>).__panel as { getFontSize(): string };
  return {
    posted,
    els,
    bodyAttrs: body.attrs,
    windowFire: (msg: unknown) => {
      for (const f of windowListeners) {
        f({ data: msg });
      }
    },
    fontSize: () => api.getFontSize(),
  };
}

describe('Shared font size: Start Problem runtime', () => {
  it('adopts a host-pushed size live', () => {
    const page = loadPanel('medium');
    expect(page.fontSize()).to.equal('medium');
    page.windowFire({ command: 'fontSize', size: 'huge' });
    // Body attribute is the single application point for the whole page.
    expect(page.fontSize()).to.equal('huge');
    expect(page.bodyAttrs['data-cs-font']).to.equal('huge');
  });

  it('posts local changes to the host for broadcast', () => {
    const page = loadPanel('medium');
    page.els.fontSize.value = 'xhuge';
    page.els.fontSize.fire('change', { target: page.els.fontSize });
    expect(page.posted).to.deep.equal([{ command: 'fontSize', size: 'xhuge' }]);
  });

  it('ignores malformed pushed sizes safely', () => {
    const page = loadPanel('medium');
    page.windowFire({ command: 'fontSize', size: 42 });
    expect(page.fontSize()).to.equal('medium');
    page.windowFire({ command: 'fontSize' });
    expect(page.fontSize()).to.equal('medium');
  });
});
