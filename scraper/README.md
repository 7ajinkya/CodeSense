# CodeSense Problem Scraper (Phase 1 — DORMANT)

> Status: preserved but **not used** in the normal Phase 1 flow. Start
> Problem uses manual URL + pasted-statement input only, so scraping
> reliability (anti-bot protection, layout churn, network) can never block
> problem solving. This scraper, `PythonScraperClient`, and
> `ProblemResolver.resolve` remain intact so automatic retrieval can be
> re-enabled in a future phase without redesign.

Isolated, deterministic problem-statement extraction. Standard library only —
no third-party packages, no platform APIs, no LLM.

## Contract

```
python scrape.py <url> [--timeout SECONDS]
```

Prints exactly one JSON object to stdout and exits 0:

- Success: `{"ok": true, "data": {...}}`
- Failure (first-class, never fatal): `{"ok": false, "error": "...", "errorKind": "...", "partial": {...} | null}`

`errorKind` is one of `network | http | parse | timeout | blocked | unsupported`.

`data` fields: `title`, `statement`, `constraints`, `examples[]`,
`difficulty`, `topics[]`. Missing fields are `null`/`[]` — never hallucinated.

## Providers

- `leetcode` — best-effort parse of the embedded `__NEXT_DATA__` JSON
  (pages are JS-rendered; static HTML alone rarely contains the statement).
- `codeforces` — static HTML parse of `.problem-statement`, sample tests,
  time/memory limits.
- `algozenith` / anything else — generic parse (`og:title`, `<title>`,
  meta description, main/article text).

## Failure is expected

JS rendering, login walls, anti-bot (403/429), layout changes, and network
problems all yield `ok: false`. The extension then uses the manual-paste
fallback; the learner is never blocked.
