import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { ProblemExample } from './problem';

/**
 * Clean boundary between the VS Code extension (TypeScript) and the isolated
 * Python scraper (`scraper/scrape.py`).
 *
 * - The scraper is invoked as a short-lived child process with a timeout.
 * - All failures (missing Python, missing script, timeout, bad JSON,
 *   scraper-reported `ok: false`) become a typed `ScrapeFailure` — never an
 *   exception escaping into the problem-start flow (except programmer errors).
 * - Tests inject `FakeScraperClient`; no test touches the network.
 */

export interface ScrapedProblemData {
  title: string | null;
  statement: string | null;
  constraints: string | null;
  examples: ProblemExample[];
  difficulty: string | null;
  topics: string[];
}

export type ScrapeErrorKind =
  | 'network'
  | 'http'
  | 'parse'
  | 'timeout'
  | 'blocked'
  | 'unsupported'
  | 'unavailable'
  | 'unknown';

export interface ScrapeSuccess {
  ok: true;
  data: ScrapedProblemData;
}

export interface ScrapeFailure {
  ok: false;
  error: string;
  errorKind: ScrapeErrorKind;
  partial: ScrapedProblemData | null;
}

export type ScrapeResult = ScrapeSuccess | ScrapeFailure;

export interface IScraper {
  scrape(url: string): Promise<ScrapeResult>;
}

export interface ScraperClientOptions {
  /** Override the Python executable (default: auto-detect `python3`/`python`). */
  pythonPath?: string;
  /** Override the scraper script location (default: `<repo>/scraper/scrape.py`). */
  scriptPath?: string;
  /** Kill and fail after this long (default 20000ms). */
  timeoutMs?: number;
}

export const DEFAULT_SCRAPE_TIMEOUT_MS = 20000;

function defaultScriptPath(): string {
  // Compiled layout: out/problems/scraperClient.js -> repo root is ../..
  // Source layout (tests): src/problems/scraperClient.ts -> repo root is ../..
  return path.resolve(__dirname, '..', '..', 'scraper', 'scrape.py');
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseScrapedData(raw: unknown): ScrapedProblemData | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const examplesRaw = r.examples;
  const examples: ProblemExample[] = Array.isArray(examplesRaw)
    ? examplesRaw
        .filter(
          (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
        )
        .filter((e) => typeof e.input === 'string' && typeof e.output === 'string')
        .map((e) => ({
          input: e.input as string,
          output: e.output as string,
          ...(typeof e.explanation === 'string' ? { explanation: e.explanation as string } : {}),
        }))
    : [];
  const topicsRaw = r.topics;
  return {
    title: asOptionalString(r.title),
    statement: typeof r.statement === 'string' && r.statement.trim().length > 0 ? r.statement : null,
    constraints: asOptionalString(r.constraints),
    examples,
    difficulty: asOptionalString(r.difficulty),
    topics: Array.isArray(topicsRaw) ? topicsRaw.filter((t): t is string => typeof t === 'string') : [],
  };
}

const KNOWN_ERROR_KINDS: ScrapeErrorKind[] = [
  'network',
  'http',
  'parse',
  'timeout',
  'blocked',
  'unsupported',
  'unavailable',
  'unknown',
];

function parseScrapeOutput(stdout: string): ScrapeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'scraper returned invalid JSON', errorKind: 'parse', partial: null };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'scraper returned invalid JSON', errorKind: 'parse', partial: null };
  }
  const p = parsed as Record<string, unknown>;
  if (p.ok === true) {
    const data = parseScrapedData(p.data);
    if (data === null || data.statement === null) {
      return {
        ok: false,
        error: 'scraper returned no usable statement',
        errorKind: 'parse',
        partial: data,
      };
    }
    return { ok: true, data };
  }
  const error = typeof p.error === 'string' && p.error.length > 0 ? p.error : 'scraper failed';
  const kindRaw = p.errorKind;
  const errorKind: ScrapeErrorKind =
    typeof kindRaw === 'string' && (KNOWN_ERROR_KINDS as string[]).includes(kindRaw)
      ? (kindRaw as ScrapeErrorKind)
      : 'unknown';
  const partialRaw = p.partial;
  const partial =
    typeof partialRaw === 'object' && partialRaw !== null ? parseScrapedData(partialRaw) : null;
  return { ok: false, error, errorKind, partial };
}

export class PythonScraperClient implements IScraper {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(opts: ScraperClientOptions = {}) {
    this.pythonPath = opts.pythonPath ?? detectPython();
    this.scriptPath = opts.scriptPath ?? defaultScriptPath();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS;
  }

  /** False when no Python interpreter or no script is configured. */
  isAvailable(): boolean {
    return this.pythonPath.length > 0;
  }

  scrape(url: string): Promise<ScrapeResult> {
    if (!this.isAvailable()) {
      return Promise.resolve({
        ok: false,
        error: 'Python is unavailable; paste the problem statement manually.',
        errorKind: 'unavailable',
        partial: null,
      });
    }
    return new Promise<ScrapeResult>((resolve) => {
      let settled = false;
      const done = (result: ScrapeResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      let child;
      try {
        child = spawn(this.pythonPath, [this.scriptPath, url], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (err) {
        done({
          ok: false,
          error: `could not launch scraper: ${String(err)}`,
          errorKind: 'unavailable',
          partial: null,
        });
        return;
      }
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
        // Guard against pathological pages echoed back by a broken script.
        if (stdout.length > 1024 * 1024) {
          child.kill();
          done({ ok: false, error: 'scraper output too large', errorKind: 'parse', partial: null });
        }
      });
      child.on('error', (err: Error) => {
        done({
          ok: false,
          error: `scraper process error: ${err.message}`,
          errorKind: 'unavailable',
          partial: null,
        });
      });
      child.on('close', () => {
        done(parseScrapeOutput(stdout.trim()));
      });
      setTimeout(() => {
        child.kill();
        done({
          ok: false,
          error: `scraper timed out after ${this.timeoutMs}ms`,
          errorKind: 'timeout',
          partial: null,
        });
      }, this.timeoutMs).unref();
    });
  }
}

/**
 * Detect a usable Python interpreter without executing untrusted input:
 * honours PYTHON env override, else tries `python3` then `python` via
 * `--version`. Returns '' when none is found (caller degrades to manual).
 */
export function detectPython(): string {
  const envOverride = process.env.CODESENSE_PYTHON?.trim();
  if (envOverride) {
    return envOverride;
  }
  const candidates = ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const res = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      if (res.status === 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

/** In-memory scraper for tests and for offline/manual verification. */
export class FakeScraperClient implements IScraper {
  private readonly handler: (url: string) => ScrapeResult;

  constructor(handler: (url: string) => ScrapeResult) {
    this.handler = handler;
  }

  scrape(url: string): Promise<ScrapeResult> {
    return Promise.resolve(this.handler(url));
  }

  static success(data: ScrapedProblemData): FakeScraperClient {
    return new FakeScraperClient(() => ({ ok: true, data }));
  }

  static failure(error: string, errorKind: ScrapeErrorKind = 'network', partial: ScrapedProblemData | null = null): FakeScraperClient {
    return new FakeScraperClient(() => ({ ok: false, error, errorKind, partial }));
  }
}
