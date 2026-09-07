#!/usr/bin/env python3
"""CodeSense isolated problem scraper (Phase 1).

Reads a problem URL, fetches the page with the standard library only
(no third-party dependencies, no platform APIs), and prints a single
JSON object to stdout:

  {"ok": true, "data": {...}}                      on success
  {"ok": false, "error": "...", "errorKind": "...", "partial": {...|None}}

Scraping is best-effort and deterministic (no LLM, no search). Fields that
cannot be reliably extracted are null/empty -- never hallucinated. The
VS Code extension treats any failure as a first-class case and falls back
to manual problem paste.

Usage:
    python scrape.py <url> [--timeout SECONDS]
"""

import html
import json
import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0 Safari/537.36"
)
MAX_STATEMENT_CHARS = 30000
MAX_FIELD_CHARS = 8000


# ---------------------------------------------------------------------------
# Generic HTML helpers
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """Strip tags to text; block-level tags become newlines."""

    BLOCK_TAGS = {
        "p", "br", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4",
        "pre", "tr", "table", "section", "article", "header",
    }

    def __init__(self) -> None:
        super().__init__()
        self._parts: List[str] = []
        self._skip = 0  # nesting depth inside script/style

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        tag = tag.lower()
        if tag in ("script", "style", "noscript"):
            self._skip += 1
            return
        if tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("script", "style", "noscript"):
            self._skip = max(0, self._skip - 1)
            return
        if tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip == 0:
            self._parts.append(data)

    def text(self) -> str:
        raw = "".join(self._parts)
        raw = html.unescape(raw)
        lines = [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in raw.split("\n")]
        # collapse runs of blank lines
        out: List[str] = []
        blank = 0
        for ln in lines:
            if not ln:
                blank += 1
                if blank <= 1:
                    out.append("")
            else:
                blank = 0
                out.append(ln)
        return "\n".join(out).strip("\n ")


def html_to_text(fragment: str) -> str:
    parser = _TextExtractor()
    parser.feed(fragment)
    parser.close()
    return parser.text()


def _search(pattern: str, page: str, flags: int = 0) -> Optional[str]:
    m = re.search(pattern, page, flags)
    if not m:
        return None
    return html.unescape(m.group(1)).strip() or None


def extract_title(page: str) -> Optional[str]:
    for pattern in (
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']',
        r'<meta[^>]+content=["\'](.*?)["\'][^>]+property=["\']og:title["\']',
        r"<title[^>]*>(.*?)</title>",
        r"<h1[^>]*>(.*?)</h1>",
    ):
        found = _search(pattern, page, re.IGNORECASE | re.DOTALL)
        if found:
            return html_to_text(found).split("\n")[0].strip()[:500] or None
    return None


def extract_meta_description(page: str) -> Optional[str]:
    for pattern in (
        r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\'](.*?)["\']',
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']',
    ):
        found = _search(pattern, page, re.IGNORECASE | re.DOTALL)
        if found:
            text = html_to_text(found).strip()
            if text:
                return text[:MAX_FIELD_CHARS]
    return None


def detect_provider(url: str) -> str:
    host = (urllib.request.urlparse(url).hostname or "").lower()
    if host == "leetcode.com" or host.endswith(".leetcode.com") or host == "leetcode.cn":
        return "leetcode"
    if host == "codeforces.com" or host.endswith(".codeforces.com"):
        return "codeforces"
    if "algozenith" in host:
        return "algozenith"
    if host:
        return "generic"
    return "unknown"


# ---------------------------------------------------------------------------
# Provider extractors (all best-effort; missing -> None)
# ---------------------------------------------------------------------------

def _truncate(text: Optional[str], limit: int = MAX_FIELD_CHARS) -> Optional[str]:
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None
    if len(text) > limit:
        return text[:limit].rstrip() + "\n…[truncated]"
    return text


def extract_leetcode(page: str) -> Dict[str, Any]:
    """LeetCode pages are JS-rendered; use embedded JSON when present."""
    data: Dict[str, Any] = {
        "title": None, "statement": None, "constraints": None,
        "examples": [], "difficulty": None, "topics": [],
    }
    # __NEXT_DATA__ blob (double-escaped JSON inside HTML).
    next_data = _search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        page, re.IGNORECASE | re.DOTALL,
    )
    blob = next_data or page
    # Unescape one level so \" becomes " for regex matching.
    blob_unescaped = blob.replace('\\"', '"').replace("\\n", "\n")

    title = _search(r'"questionTitle"\s*:\s*"((?:[^"\\]|\\.)*)"', blob_unescaped)
    if title:
        data["title"] = html.unescape(title).strip()[:500]
    content = _search(
        r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"', blob_unescaped, re.DOTALL,
    )
    difficulty = _search(r'"difficulty"\s*:\s*"([A-Za-z]+)"', blob_unescaped)
    if difficulty and difficulty.lower() in ("easy", "medium", "hard"):
        data["difficulty"] = difficulty.capitalize()
    topics = re.findall(r'"topicTags"\s*:\s*\[(.*?)\]', blob_unescaped, re.DOTALL)
    names: List[str] = []
    for chunk in topics:
        for name in re.findall(r'"name"\s*:\s*"((?:[^"\\]|\\.)*)"', chunk):
            label = html.unescape(name).strip()
            if label and label not in names:
                names.append(label)
    data["topics"] = names[:20]

    if content:
        content_html = content.replace("\\/", "/")
        # The embedded JSON escapes HTML as \u003c etc.; decode those so
        # tags become real tags before text extraction.
        content_html = re.sub(
            r"\\u([0-9a-fA-F]{4})",
            lambda m: chr(int(m.group(1), 16)),
            content_html,
        )
        statement_text = html_to_text(content_html)
        data["statement"] = _truncate(statement_text, MAX_STATEMENT_CHARS)
        data["examples"] = parse_examples_from_text(statement_text)
        data["constraints"] = parse_constraints_from_text(statement_text)

    if not data["title"]:
        data["title"] = extract_title(page)
    return data


def parse_examples_from_text(text: str) -> List[Dict[str, str]]:
    """Parse 'Example N: Input: ... Output: ... [Explanation: ...]' blocks."""
    examples: List[Dict[str, str]] = []
    blocks = re.split(r"(?im)^\s*example\s*\d+\s*:\s*", text)
    for block in blocks[1:]:
        inp = re.search(r"(?im)^\s*input\s*:\s*(.*?)(?=^\s*output\s*:|\Z)",
                        block, re.DOTALL)
        outp = re.search(r"(?im)^\s*output\s*:\s*(.*?)(?=^\s*explanation\s*:|\Z)",
                         block, re.DOTALL)
        expl = re.search(r"(?im)^\s*explanation\s*:\s*(.*)", block, re.DOTALL)
        if inp and outp:
            example: Dict[str, str] = {
                "input": inp.group(1).strip()[:2000],
                "output": outp.group(1).strip()[:2000],
            }
            if expl and expl.group(1).strip():
                example["explanation"] = expl.group(1).strip()[:2000]
            if example["input"] and example["output"]:
                examples.append(example)
        if len(examples) >= 10:
            break
    return examples


def parse_constraints_from_text(text: str) -> Optional[str]:
    m = re.search(r"(?im)^\s*constraints\s*:\s*(.*)", text, re.DOTALL)
    if not m:
        return None
    tail = m.group(1).strip()
    # Constraints run until a blank-line followed by a new section header.
    stop = re.search(r"(?im)^\s*(follow-up|hint|note|example|related topics)\b", tail)
    if stop:
        tail = tail[: stop.start()].strip()
    return _truncate(tail, 4000)


def _cf_limit(scope: str, label: str) -> Optional[str]:
    """Extract `label: value` from `<div class="property-title">label</div>value`."""
    m = re.search(
        r'<div class="property-title">\s*' + re.escape(label) + r"\s*</div>\s*([^<>]+)",
        scope, re.IGNORECASE,
    )
    if not m:
        return None
    value = html_to_text(m.group(1)).strip()
    return ("%s: %s" % (label, value)) if value else label


def _strip_section_titles(fragment: str) -> str:
    return re.sub(
        r'<div class="(?:section-title|title)">.*?</div>',
        "", fragment, flags=re.IGNORECASE | re.DOTALL,
    )


def extract_codeforces(page: str) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "title": None, "statement": None, "constraints": None,
        "examples": [], "difficulty": None, "topics": [],
    }
    stmt = _search(
        r'<div class="problem-statement">(.*)',
        page, re.IGNORECASE | re.DOTALL,
    )
    scope = stmt or page

    header = _search(
        r'<div class="header">.*?<div class="title">(.*?)</div>',
        scope, re.IGNORECASE | re.DOTALL,
    )
    if header:
        data["title"] = _truncate(html_to_text(header), 500)

    limits: List[str] = []
    time_limit = _cf_limit(scope, "time limit per test")
    if time_limit:
        limits.append(time_limit)
    memory_limit = _cf_limit(scope, "memory limit per test")
    if memory_limit:
        limits.append(memory_limit)

    body_parts: List[str] = []
    for pattern in (
        r'<div class="header">.*?</div>\s*<div>(.*?)</div>\s*<div class="input-specification">',
        r'<div>(.*?)</div>\s*<div class="input-specification">',
    ):
        body = _search(pattern, scope, re.IGNORECASE | re.DOTALL)
        if body:
            body_parts.append(html_to_text(body).strip())
            break
    # Section-title divs ("Input"/"Output"/"Examples"/"Note") are layout, not
    # content: strip them before extracting section bodies.
    clean_scope = _strip_section_titles(scope)
    input_spec = _search(
        r'<div class="input-specification">(.*?)</div>\s*<div class="output-specification">',
        clean_scope, re.IGNORECASE | re.DOTALL,
    )
    output_spec = _search(
        r'<div class="output-specification">(.*?)</div>\s*<div class="(?:sample-tests|note)"',
        clean_scope, re.IGNORECASE | re.DOTALL,
    )
    if output_spec is None:
        # Fallback for pages without sample/note sections: the section holds
        # only paragraphs after title-stripping, so its own close is first.
        output_spec = _search(
            r'<div class="output-specification">(.*?)</div>',
            clean_scope, re.IGNORECASE | re.DOTALL,
        )
    note_spec = _search(
        r'<div class="note">(.*?)</div>',
        clean_scope, re.IGNORECASE | re.DOTALL,
    )
    spec_parts: List[str] = []
    if input_spec:
        spec_parts.append("Input\n" + html_to_text(input_spec).strip())
    if output_spec:
        spec_parts.append("Output\n" + html_to_text(output_spec).strip())
    if note_spec:
        note_text = html_to_text(note_spec).strip()
        if note_text:
            spec_parts.append("Note\n" + note_text)

    statement_chunks = [c for c in (body_parts + spec_parts) if c]
    if statement_chunks:
        data["statement"] = _truncate("\n\n".join(statement_chunks), MAX_STATEMENT_CHARS)
    else:
        generic_text = html_to_text(scope)
        data["statement"] = _truncate(generic_text, MAX_STATEMENT_CHARS)

    constraints: List[str] = []
    constraints.extend(limits)
    data["constraints"] = _truncate("\n".join(constraints)) if constraints else None

    inputs = re.findall(
        r'<div class="input">.*?<pre>(.*?)</pre>', clean_scope, re.IGNORECASE | re.DOTALL,
    )
    outputs = re.findall(
        r'<div class="output">.*?<pre>(.*?)</pre>', clean_scope, re.IGNORECASE | re.DOTALL,
    )
    for inp, outp in zip(inputs[:10], outputs[:10]):
        data["examples"].append({
            "input": html_to_text(inp).strip()[:2000],
            "output": html_to_text(outp).strip()[:2000],
        })

    if not data["title"]:
        data["title"] = extract_title(page)
    return data


def extract_generic(page: str) -> Dict[str, Any]:
    text = html_to_text(page)
    return {
        "title": extract_title(page),
        "statement": _truncate(text, MAX_STATEMENT_CHARS),
        "constraints": parse_constraints_from_text(text),
        "examples": parse_examples_from_text(text),
        "difficulty": None,
        "topics": [],
    }


# ---------------------------------------------------------------------------
# Fetch + main
# ---------------------------------------------------------------------------

def fetch(url: str, timeout: float) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", 200)
            if status == 403:
                raise PermissionError("HTTP 403: access forbidden (anti-bot or login required)")
            if status == 404:
                raise FileNotFoundError("HTTP 404: page not found")
            if status is not None and status >= 400:
                raise ConnectionError("HTTP %s" % status)
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                return raw.decode(charset, errors="replace")
            except (LookupError, UnicodeError):
                return raw.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise PermissionError(
                "HTTP 403: access forbidden (anti-bot or login required)") from exc
        if exc.code == 404:
            raise FileNotFoundError("HTTP 404: page not found") from exc
        if exc.code == 429:
            raise ConnectionError("HTTP 429: rate limited") from exc
        raise ConnectionError("HTTP %s" % exc.code) from exc
    except urllib.error.URLError as exc:
        raise ConnectionError("network error: %s" % exc.reason) from exc


def error_kind(exc: BaseException) -> str:
    if isinstance(exc, PermissionError):
        return "blocked"
    if isinstance(exc, FileNotFoundError):
        return "http"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ConnectionError):
        return "network"
    if isinstance(exc, ValueError):
        return "unsupported"
    return "parse"


def emit(payload: Dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    try:
        sys.stdout.write(text + "\n")
    except UnicodeEncodeError:
        # Non-UTF-8 console (e.g. Windows cp1252): fall back to ASCII-safe
        # JSON, which parses to identical strings downstream.
        sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")


def main(argv: List[str]) -> int:
    try:
        # Windows consoles default to cp1252, which cannot encode problem
        # text (e.g. 1 ≤ w ≤ 100). Prefer UTF-8 for the JSON contract.
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(argv) < 2 or not argv[1].strip():
        emit({"ok": False, "error": "no URL provided",
              "errorKind": "unsupported", "partial": None})
        return 0
    url = argv[1].strip()
    timeout = 15.0
    for i, arg in enumerate(argv[2:]):
        if arg == "--timeout" and i + 3 <= len(argv):
            try:
                timeout = max(2.0, min(60.0, float(argv[2 + i + 1])))
            except ValueError:
                pass
    if not re.match(r"^https?://", url, re.IGNORECASE):
        emit({"ok": False, "error": "unsupported URL scheme (expected http/https)",
              "errorKind": "unsupported", "partial": None})
        return 0

    provider = detect_provider(url)
    try:
        page = fetch(url, timeout)
    except Exception as exc:  # failure is first-class: report, don't crash
        emit({"ok": False, "error": str(exc),
              "errorKind": error_kind(exc), "partial": None})
        return 0
    if not page or not page.strip():
        emit({"ok": False, "error": "empty response body",
              "errorKind": "parse", "partial": None})
        return 0

    try:
        if provider == "leetcode":
            extracted = extract_leetcode(page)
        elif provider == "codeforces":
            extracted = extract_codeforces(page)
        else:
            extracted = extract_generic(page)
    except Exception as exc:
        emit({"ok": False, "error": "parse error: %s" % exc,
              "errorKind": "parse", "partial": None})
        return 0

    if not extracted.get("statement"):
        desc = extract_meta_description(page)
        partial = dict(extracted)
        if desc and not partial.get("statement"):
            partial["statement"] = desc
        emit({"ok": False,
              "error": "could not extract a problem statement from this page "
                       "(JavaScript-rendered, login-required, or changed layout)",
              "errorKind": "parse",
              "partial": partial})
        return 0

    emit({"ok": True, "data": extracted})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
