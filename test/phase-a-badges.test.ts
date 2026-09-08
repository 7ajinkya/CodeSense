import { expect } from 'chai';
import * as vm from 'vm';
import { CodeSenseSidebarProvider, withBadgeMetadata } from 'codesense/ui/sidebarView';

/**
 * Post-polish semantic badges: every coach message shows WHY CodeSense is
 * talking (triggerKind) and WHAT kind of coaching it is (interventionType),
 * using only already-persisted metadata. Learner messages never get badges;
 * missing/unknown metadata renders the message normally with no badge.
 */

interface BadgeApi {
  triggerBadge(kind: unknown): string;
  actionBadge(type: unknown): string;
  aiHtml(ai: {
    status: 'idle' | 'evaluating' | 'unavailable' | 'error';
    message: string | null;
    exchange: Array<{
      role: 'coach' | 'learner';
      text: string;
      triggerKind?: string;
      interventionType?: string;
    }>;
    canReply: boolean;
  }): string;
}

function loadBadgeApi(): { api: BadgeApi; html: string } {
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
    acquireVsCodeApi: () => ({
      postMessage: () => undefined,
      getState: () => null,
      setState: () => undefined,
    }),
    document: { getElementById: () => null },
    window: { addEventListener: () => undefined },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    script![1] + '\n;this.__badges = { triggerBadge, actionBadge, aiHtml };',
    sandbox,
  );
  return {
    api: (sandbox as Record<string, unknown>).__badges as BadgeApi,
    html: captured,
  };
}

// ---------------------------------------------------------------------------
// Mapping: triggerKind -> context badge
// ---------------------------------------------------------------------------

describe('Badges: trigger/context mapping', () => {
  const { api } = loadBadgeApi();

  it('maps every existing triggerKind', () => {
    expect(api.triggerBadge('idle')).to.contain('10 MIN CHECK-IN');
    expect(api.triggerBadge('hard45')).to.contain('45 MIN CHECK-IN');
    expect(api.triggerBadge('reply')).to.contain('YOU REPLIED');
    expect(api.triggerBadge('manual')).to.contain('MANUAL CHECK-IN');
  });

  it('omits the badge for missing or unknown triggerKinds', () => {
    for (const bad of [undefined, null, '', 'bogus', 'IDLE', '<script>']) {
      expect(api.triggerBadge(bad), JSON.stringify(bad)).to.equal('');
    }
  });
});

// ---------------------------------------------------------------------------
// Mapping: interventionType -> coaching-action badge
// ---------------------------------------------------------------------------

describe('Badges: coaching-action mapping', () => {
  const { api } = loadBadgeApi();

  it('maps every existing intervention type', () => {
    const cases: Array<[string, string]> = [
      ['SOCRATIC_QUESTION', 'QUESTION'],
      ['HINT', 'HINT'],
      ['EXPLANATION', 'EXPLANATION'],
      ['ACKNOWLEDGE', 'ACKNOWLEDGEMENT'],
      ['DEBUGGING_HELP', 'DEBUGGING HELP'],
      ['CONCEPT_REVIEW', 'CONCEPT REVIEW'],
      ['SOLUTION_GUIDANCE', 'SOLUTION GUIDANCE'],
    ];
    for (const [input, label] of cases) {
      expect(api.actionBadge(input), input).to.contain(label);
    }
  });

  it('renders no badge for NONE or unknown/missing types', () => {
    for (const bad of ['NONE', undefined, null, '', 'MIND_READ', '<b>HINT</b>']) {
      expect(api.actionBadge(bad), JSON.stringify(bad)).to.equal('');
    }
  });
});

// ---------------------------------------------------------------------------
// Host attach: persisted metadata -> snapshot exchange (pure helper)
// ---------------------------------------------------------------------------

describe('Badges: host metadata attach (existing stores only)', () => {
  const evaluations = [
    { evaluationId: 'eval_q', triggerKind: 'idle', interventionType: 'SOCRATIC_QUESTION' },
    { evaluationId: 'eval_h', triggerKind: 'reply', interventionType: 'HINT' },
  ];

  it('attaches metadata to linked coach messages only', () => {
    const out = withBadgeMetadata(
      [
        { role: 'coach', text: 'q?', evaluationId: 'eval_q' },
        { role: 'learner', text: 'a' },
        { role: 'coach', text: 'hint', evaluationId: 'eval_h' },
      ],
      evaluations,
    );
    expect(out).to.deep.equal([
      { role: 'coach', text: 'q?', triggerKind: 'idle', interventionType: 'SOCRATIC_QUESTION' },
      { role: 'learner', text: 'a' },
      { role: 'coach', text: 'hint', triggerKind: 'reply', interventionType: 'HINT' },
    ]);
  });

  it('leaves text/role/order intact when metadata is missing', () => {
    const out = withBadgeMetadata(
      [
        { role: 'coach', text: 'orphan', evaluationId: 'eval_gone' },
        { role: 'coach', text: 'unlinked' },
        { role: 'learner', text: 'hi', evaluationId: 'eval_q' },
      ],
      evaluations,
    );
    expect(out).to.deep.equal([
      { role: 'coach', text: 'orphan' },
      { role: 'coach', text: 'unlinked' },
      { role: 'learner', text: 'hi' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rendering: badges on coach rows only, never crashing
// ---------------------------------------------------------------------------

describe('Badges: rendering on coach rows only', () => {
  const { api } = loadBadgeApi();

  function panel(
    exchange: Array<{ role: 'coach' | 'learner'; text: string; triggerKind?: string; interventionType?: string }>,
  ): string {
    return api.aiHtml({ status: 'idle', message: null, exchange, canReply: false });
  }

  it('shows both badges above the coach message body', () => {
    const html = panel([
      {
        role: 'coach',
        text: 'Which elements become the minima?',
        triggerKind: 'idle',
        interventionType: 'SOCRATIC_QUESTION',
      },
    ]);
    expect(html).to.contain('10 MIN CHECK-IN');
    expect(html).to.contain('QUESTION');
    expect(html.indexOf('10 MIN CHECK-IN')).to.be.lessThan(html.indexOf('minima'));
  });

  it('renders the message normally when metadata is absent', () => {
    const html = panel([{ role: 'coach', text: 'Plain hello.' }]);
    expect(html).to.contain('Plain hello.');
    expect(html).to.not.contain('badge');
  });

  it('never puts coach badges on learner messages', () => {
    const html = panel([
      { role: 'learner', text: 'I tried it.', triggerKind: 'idle', interventionType: 'HINT' },
    ]);
    expect(html).to.contain('I tried it.');
    expect(html).to.not.contain('badge');
  });

  it('renders unknown metadata without crashing and without badges', () => {
    const html = panel([
      {
        role: 'coach',
        text: 'Weird meta.',
        triggerKind: 'someday',
        interventionType: 'MIND_READ',
      },
    ]);
    expect(html).to.contain('Weird meta.');
    expect(html).to.not.contain('badge');
  });

  it('keeps badges small pills with text meaning (not color alone)', () => {
    const { html } = loadBadgeApi();
    expect(html).to.contain('.badge');
    expect(html).to.contain('trig-idle');
    expect(html).to.contain('act-question');
  });
});
