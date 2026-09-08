import { expect } from 'chai';
import * as vm from 'vm';
import { escapeHtml, markdownToSafeHtml, sanitizeCodeLanguage } from 'codesense/ui/markdown';
import { CodeSenseSidebarProvider } from 'codesense/ui/sidebarView';

/**
 * Phase A (AI UX) — safe Markdown rendering.
 *
 * The host renderer (`ui/markdown.ts`) is the tested contract; the webview
 * embeds a mirrored implementation (it cannot import from `src/`), so a
 * parity test below executes the SHIPPED webview script and compares outputs.
 */

describe('Phase A safe Markdown (host renderer)', () => {
  it('renders paragraphs and single-newline breaks', () => {
    expect(markdownToSafeHtml('Hello.')).to.equal('<p>Hello.</p>');
    expect(markdownToSafeHtml('line one\nline two')).to.equal('<p>line one<br>line two</p>');
    expect(markdownToSafeHtml('first\n\nsecond')).to.equal('<p>first</p><p>second</p>');
    expect(markdownToSafeHtml('   ')).to.equal('');
    expect(markdownToSafeHtml('')).to.equal('');
  });

  it('renders headings', () => {
    expect(markdownToSafeHtml('# Big')).to.equal('<h1>Big</h1>');
    expect(markdownToSafeHtml('## Mid')).to.equal('<h2>Mid</h2>');
    expect(markdownToSafeHtml('### Small')).to.equal('<h3>Small</h3>');
  });

  it('renders bold and italic', () => {
    expect(markdownToSafeHtml('a **strong** word')).to.equal('<p>a <strong>strong</strong> word</p>');
    expect(markdownToSafeHtml('a __strong__ word')).to.equal('<p>a <strong>strong</strong> word</p>');
    expect(markdownToSafeHtml('a *soft* word')).to.equal('<p>a <em>soft</em> word</p>');
    expect(markdownToSafeHtml('a _soft_ word')).to.equal('<p>a <em>soft</em> word</p>');
  });

  it('never mangles Python snake_case identifiers', () => {
    const html = markdownToSafeHtml('check visited_nodes and my_var first');
    expect(html).to.not.contain('<em>');
    expect(html).to.contain('visited_nodes');
    expect(html).to.contain('my_var');
  });

  it('renders inline code literally', () => {
    expect(markdownToSafeHtml('use `visited[nr][nc]` here')).to.equal(
      '<p>use <code>visited[nr][nc]</code> here</p>',
    );
    // Markup inside code spans stays literal.
    expect(markdownToSafeHtml('`a **b** c`')).to.equal('<p><code>a **b** c</code></p>');
  });

  it('renders unordered and ordered lists', () => {
    expect(markdownToSafeHtml('- apple\n- banana')).to.equal(
      '<ul><li>apple</li><li>banana</li></ul>',
    );
    expect(markdownToSafeHtml('* one\n* two')).to.equal('<ul><li>one</li><li>two</li></ul>');
    expect(markdownToSafeHtml('1. first\n2. second')).to.equal(
      '<ol><li>first</li><li>second</li></ol>',
    );
  });

  it('renders the Phase A example (Java fence with language label)', () => {
    const input =
      "You're on the right track.\n\n" +
      'Try checking what happens when you revisit a node.\n\n' +
      '```java\nif (!visited[nr][nc]) {\n    queue.add(new int[]{nr, nc});\n}\n```';
    const html = markdownToSafeHtml(input);
    expect(html).to.contain('<p>You&#39;re on the right track.</p>');
    expect(html).to.contain('<div class="code-lang">java</div>');
    expect(html).to.contain('queue.add(new int[]{nr, nc});');
  });

  it('renders Python fences with the label preserved', () => {
    const html = markdownToSafeHtml('```python\ndef f():\n    pass\n```');
    expect(html).to.contain('<div class="code-lang">python</div>');
    expect(html).to.contain('def f():');
  });

  it('renders unlabeled fences without a label element', () => {
    const html = markdownToSafeHtml('```\nplain\n```');
    expect(html).to.contain('<pre class="codeblock">');
    expect(html).to.not.contain('code-lang');
  });

  it('treats an unclosed fence as a code block to end-of-input', () => {
    const html = markdownToSafeHtml("note\n\n```python\nprint('hi')\n");
    expect(html).to.contain('<div class="code-lang">python</div>');
    expect(html).to.contain('print(&#39;hi&#39;)');
  });

  it('escapes hostile markup and never emits raw tags', () => {
    const html = markdownToSafeHtml(
      '<script>alert(1)</script>\n\n[x](javascript:alert(2)) <img src=x onerror=alert(3)>',
    );
    expect(html).to.not.contain('<script>');
    expect(html).to.contain('&lt;script&gt;');
    expect(html).to.contain('&lt;img');
  });

  it('sanitizes code language labels', () => {
    expect(sanitizeCodeLanguage('java')).to.equal('java');
    expect(sanitizeCodeLanguage('python')).to.equal('python');
    expect(sanitizeCodeLanguage('')).to.equal('');
    expect(sanitizeCodeLanguage('"><script>')).to.equal('code');
    expect(escapeHtml('<b>"q"</b>')).to.equal('&lt;b&gt;&quot;q&quot;&lt;/b&gt;');
  });
});

describe('Phase A webview mirror parity (shipped script)', () => {
  function webviewMdToHtml(): (input: string) => string {
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
    provider.resolveWebviewView(fakeView as unknown as Parameters<typeof provider.resolveWebviewView>[0]);
    const script = captured.match(/<script>([\s\S]*?)<\/script>/);
    expect(script, 'webview script must be present').to.not.be.null;
    const sandbox: Record<string, unknown> = {
      acquireVsCodeApi: () => ({ postMessage: () => undefined }),
      document: { getElementById: () => null },
      window: { addEventListener: () => undefined },
    };
    vm.createContext(sandbox);
    vm.runInContext(script![1] + '\n;this.__mdToHtml = mdToHtml;', sandbox);
    return sandbox.__mdToHtml as (input: string) => string;
  }

  it('renders the shipped webview script identically to the host renderer', () => {
    const webviewMd = webviewMdToHtml();
    const cases = [
      "You're on the right track.\n\nTry checking what happens when you revisit a node.\n\n```java\nif (!visited[nr][nc]) {\n    queue.add(new int[]{nr, nc});\n}\n```\n",
      '```python\ndef two_sum(nums, target):\n    return []\n```',
      '# Title\n\nSome **bold**, *italic*, and `code`.\n\n- a\n- b\n\n1. x\n2. y\n',
      '<script>alert(1)</script> visited_nodes stay literal',
      '```"><script>\ncode\n```',
      "Unclosed:\n\n```java\nint x = 1;\n",
    ];
    for (const input of cases) {
      expect(webviewMd(input), JSON.stringify(input)).to.equal(markdownToSafeHtml(input));
    }
  });
});
