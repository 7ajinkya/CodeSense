/**
 * Phase A -- safe Markdown rendering for the AI Coach webview.
 *
 * Zero-dependency, XSS-safe renderer for the small Markdown subset the
 * coach actually emits. Supported:
 *   - paragraphs (blank-line separated, single newline => <br>)
 *   - headings (# .. ###### + space)
 *   - bold (**text**, __text__)
 *   - italic (*text*, _text_ with word-boundary guard for snake_case)
 *   - inline code (`code`)
 *   - unordered lists (-, *, +)
 *   - ordered lists (1. 2. ...)
 *   - fenced code blocks (```lang ... ```) with language label
 *
 * Safety model:
 *   - No raw HTML passthrough: every user/model character is HTML-escaped
 *     before any tag is emitted.
 *   - Only a fixed whitelist of tags is ever emitted
 *     (p/h1-h6/strong/em/code/pre/div/ul/ol/li/br).
 *   - No links, images, tables, or attributes carrying user data -- except
 *     the code language label, which is strict-sanitized.
 *   - Code spans/blocks are extracted BEFORE inline formatting so `**`
 *     inside code is never interpreted as markup.
 *
 * The same algorithm is mirrored in the webview script inside
 * `ui/sidebarView.ts` (the webview cannot import from `src/`). Keep the
 * two implementations in sync: escape-first, code placeholders, block
 * state machine, inline bold/italic/code.
 */

/** HTML-escape text content (code and prose alike). */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Keep language labels useful for Python/Java while blocking attribute
 * injection. Returns '' for "no label", otherwise a safe label.
 */
export function sanitizeCodeLanguage(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0) {
    return '';
  }
  if (/^[A-Za-z0-9+#_.-]{1,24}$/.test(first)) {
    return first;
  }
  return 'code';
}

const INLINE_TOKEN_PREFIX = 'CODESENSEMDINLINE';
const INLINE_TOKEN_SUFFIX = 'CODESENSEMD';

function restoreInlineCodePlaceholders(escaped: string, codeSpans: string[]): string {
  let out = escaped;
  for (let i = 0; i < codeSpans.length; i++) {
    const token = INLINE_TOKEN_PREFIX + i + INLINE_TOKEN_SUFFIX;
    out = out.split(token).join('<code>' + escapeHtml(codeSpans[i]) + '</code>');
  }
  return out;
}

/** Inline formatting for a single prose line (no block structure). */
export function inlineToSafeHtml(rawLine: string): string {
  // Extract `inline code` first so markup inside code stays literal.
  const codeSpans: string[] = [];
  const withoutCode = rawLine.replace(/`([^`\n]+?)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return INLINE_TOKEN_PREFIX + (codeSpans.length - 1) + INLINE_TOKEN_SUFFIX;
  });
  let out = escapeHtml(withoutCode);
  // Bold before italic so ** is not consumed as two * pairs.
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic: *text* is straightforward; _text_ requires word boundaries so
  // Python identifiers like visited_nodes or my_var are never mangled.
  out = out.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  out = out.replace(/(^|\W)_([^_\n]+?)_(?=\W|$)/g, '$1<em>$2</em>');
  return restoreInlineCodePlaceholders(out, codeSpans);
}

export interface ExtractedCodeBlock {
  language: string;
  code: string;
}

export type MarkdownLine = { kind: 'text'; line: string } | { kind: 'code'; index: number };

/**
 * Split input into text/code line segments. Fenced code regions become
 * standalone code segments. Unclosed fences run to end-of-input.
 */
export function extractMarkdownLines(input: string): { lines: MarkdownLine[]; blocks: ExtractedCodeBlock[] } {
  const blocks: ExtractedCodeBlock[] = [];
  const lines: MarkdownLine[] = [];
  const rawLines = input.replace(/\r\n/g, '\n').split('\n');
  let inCode = false;
  let language = '';
  let codeLines: string[] = [];
  const closeCode = (): void => {
    blocks.push({ language, code: codeLines.join('\n') });
    lines.push({ kind: 'code', index: blocks.length - 1 });
    inCode = false;
    language = '';
    codeLines = [];
  };
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!inCode && trimmed.startsWith('```')) {
      inCode = true;
      language = sanitizeCodeLanguage(trimmed.slice(3));
      codeLines = [];
      continue;
    }
    if (inCode && trimmed.startsWith('```')) {
      closeCode();
      continue;
    }
    if (inCode) {
      codeLines.push(line);
    } else {
      lines.push({ kind: 'text', line });
    }
  }
  if (inCode) {
    closeCode();
  }
  return { lines, blocks };
}

function renderCodeBlock(block: ExtractedCodeBlock): string {
  const code = escapeHtml(block.code);
  if (block.language.length > 0) {
    return (
      '<pre class="codeblock"><div class="code-lang">' +
      escapeHtml(block.language) +
      '</div><code>' +
      code +
      '</code></pre>'
    );
  }
  return '<pre class="codeblock"><code>' + code + '</code></pre>';
}

/**
 * Render Markdown to a safe HTML fragment (no outer wrapper).
 * Empty/whitespace input renders as ''.
 */
export function markdownToSafeHtml(input: string): string {
  if (!input || input.trim().length === 0) {
    return '';
  }
  const { lines, blocks } = extractMarkdownLines(input);
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const seg = lines[i];
    if (seg.kind === 'code') {
      const block = blocks[seg.index];
      if (block !== undefined) {
        html.push(renderCodeBlock(block));
      }
      i++;
      continue;
    }
    const line = seg.line;
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      html.push('<h' + level + '>' + inlineToSafeHtml(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+.+$/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.kind !== 'text' || !/^\s*[-*+]\s+.+$/.test(cur.line)) {
          break;
        }
        items.push('<li>' + inlineToSafeHtml(cur.line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
        i++;
      }
      html.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+.+$/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.kind !== 'text' || !/^\s*\d+\.\s+.+$/.test(cur.line)) {
          break;
        }
        items.push('<li>' + inlineToSafeHtml(cur.line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
        i++;
      }
      html.push('<ol>' + items.join('') + '</ol>');
      continue;
    }
    // Paragraph: consecutive prose lines joined with <br>.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.kind !== 'text') {
        break;
      }
      if (cur.line.trim().length === 0) {
        break;
      }
      const t = cur.line.trim();
      if (/^(#{1,6})\s+.+?\s*$/.test(t)) {
        break;
      }
      if (/^\s*[-*+]\s+.+$/.test(cur.line) || /^\s*\d+\.\s+.+$/.test(cur.line)) {
        break;
      }
      paraLines.push(inlineToSafeHtml(cur.line.trim()));
      i++;
    }
    if (paraLines.length > 0) {
      html.push('<p>' + paraLines.join('<br>') + '</p>');
    }
  }
  return html.join('');
}
