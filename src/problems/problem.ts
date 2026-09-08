/**
 * Phase 1 Problem model.
 *
 * Problem = WHAT is being solved (reusable across attempts).
 * Attempt = THIS particular solving occasion (see `attempts/attempt.ts`).
 *
 * Identity is derived from the provider + providerId when the URL structure
 * allows it, otherwise from the canonical URL. The URL is always the
 * authoritative external reference — no platform API dependency.
 */

import type { ProblemClassification } from '../knowledge/classification';

export const PROBLEM_EXTRACTION_VERSION = 1;

/** Where the problem statement was extracted from (site identity). */
export type ProblemProvider = 'leetcode' | 'codeforces' | 'algozenith' | 'generic' | 'unknown';

/** How the stored problem content was obtained (provenance, not identity). */
export type ProblemSource = 'scraped' | 'manual' | 'scraped+manual';

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface ProblemProvenance {
  source: ProblemSource;
  /** The exact URL the learner entered (authoritative external reference). */
  sourceUrl: string;
  /** ISO-8601 UTC timestamp of extraction/manual entry. */
  fetchedAt: string;
  extractionVersion: number;
}

export interface Problem {
  /** Stable local identity: `prob_<hash(provider, providerId, canonicalUrl)>`. */
  problemId: string;
  provider: ProblemProvider;
  providerId: string | null;
  canonicalUrl: string;
  title: string | null;
  statement: string | null;
  constraints: string | null;
  examples: ProblemExample[];
  difficulty: string | null;
  topics: string[];
  provenance: ProblemProvenance;
  createdAt: string;
  updatedAt: string;
  /**
   * Phase C cached classification (Problem → knowledge requirements).
   * Optional for backward compatibility: problems created before Phase C
   * simply lack it (unclassified) and stay fully usable. The canonical
   * lookup is the ClassificationStore keyed by problemId; this field is a
   * convenience copy attached via `attachClassificationToProblem`, which
   * verifies the problemId match. Classification never affects usability
   * (see `isUsableProblem`) and never requires learner input.
   */
  classification?: ProblemClassification | null;
}

/** Fields the learner may supply when scraping fails or is incomplete. */
export interface ManualProblemFields {
  title?: string;
  statement: string;
  constraints?: string;
  difficulty?: string;
  topics?: string[];
  examples?: ProblemExample[];
}

// ---------------------------------------------------------------------------
// URL handling (deterministic, no network)
// ---------------------------------------------------------------------------

/** True for http(s) URLs with a hostname. */
export function isValidProblemUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Normalize a URL for identity purposes: lowercase host, drop query/hash, trim trailing slash. */
export function canonicalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return `${protocol}//${host}${port}${pathname}`;
}

/** Identify the provider from the URL hostname (structure only, no fetching). */
export function detectProvider(rawUrl: string): ProblemProvider {
  let host = '';
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host === 'leetcode.com' || host.endsWith('.leetcode.com') || host === 'leetcode.cn') {
    return 'leetcode';
  }
  if (host === 'codeforces.com' || host.endsWith('.codeforces.com')) {
    return 'codeforces';
  }
  if (host.includes('algozenith')) {
    return 'algozenith';
  }
  if (host.length === 0) {
    return 'unknown';
  }
  return 'generic';
}

/**
 * Extract a provider-scoped problem id from known URL shapes.
 * Returns null when the shape is unrecognized — the canonical URL then
 * serves as the identity. Never throws for parseable URLs.
 */
export function extractProviderId(rawUrl: string, provider: ProblemProvider): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (provider === 'leetcode') {
    // https://leetcode.com/problems/<slug>/[description/]
    const idx = segments.indexOf('problems');
    if (idx >= 0 && idx + 1 < segments.length) {
      const slug = segments[idx + 1].toLowerCase();
      if (slug.length > 0) {
        return slug;
      }
    }
    return null;
  }
  if (provider === 'codeforces') {
    // https://codeforces.com/problemset/problem/<contest>/<index>
    // https://codeforces.com/contest/<contest>/problem/<index>
    // https://codeforces.com/gym/<contest>/problem/<index>
    if (segments[0] === 'problemset' && segments[1] === 'problem' && segments.length >= 4) {
      return `${segments[2]}/${segments[3]}`.toUpperCase();
    }
    const pIdx = segments.indexOf('problem');
    if ((segments[0] === 'contest' || segments[0] === 'gym') && pIdx === 2 && segments.length >= 4) {
      return `${segments[1]}/${segments[3]}`.toUpperCase();
    }
    return null;
  }
  return null;
}

/** Stable, dependency-free identity hash (FNV-1a, hex). */
export function hashIdentity(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Build the stable problem id. Same URL (canonically) => same id. */
export function buildProblemId(provider: ProblemProvider, providerId: string | null, canonicalUrl: string): string {
  const key = providerId !== null ? `${provider}:${providerId}` : canonicalUrl.toLowerCase();
  return `prob_${hashIdentity(key)}`;
}

// ---------------------------------------------------------------------------
// Construction / normalization (no hallucination: unknown fields stay null)
// ---------------------------------------------------------------------------

export interface NormalizedProblemInput {
  provider: ProblemProvider;
  providerId: string | null;
  canonicalUrl: string;
  sourceUrl: string;
  title?: string | null;
  statement?: string | null;
  constraints?: string | null;
  examples?: ProblemExample[];
  difficulty?: string | null;
  topics?: string[];
  source: ProblemSource;
  fetchedAt?: string;
}

function cleanOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanExamples(examples: ProblemExample[] | undefined): ProblemExample[] {
  if (!examples) {
    return [];
  }
  return examples
    .filter((e) => typeof e.input === 'string' && typeof e.output === 'string')
    .map((e) => ({
      input: e.input,
      output: e.output,
      ...(e.explanation !== undefined ? { explanation: e.explanation } : {}),
    }));
}

function cleanTopics(topics: string[] | undefined): string[] {
  if (!topics) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    if (typeof t !== 'string') {
      continue;
    }
    const trimmed = t.trim();
    if (trimmed.length > 0 && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      out.push(trimmed);
    }
  }
  return out;
}

export function normalizeProblem(input: NormalizedProblemInput): Problem {
  const now = input.fetchedAt ?? new Date().toISOString();
  return {
    problemId: buildProblemId(input.provider, input.providerId, input.canonicalUrl),
    provider: input.provider,
    providerId: input.providerId,
    canonicalUrl: input.canonicalUrl,
    title: cleanOptionalText(input.title),
    statement: cleanOptionalText(input.statement),
    constraints: cleanOptionalText(input.constraints),
    examples: cleanExamples(input.examples),
    difficulty: cleanOptionalText(input.difficulty),
    topics: cleanTopics(input.topics),
    provenance: {
      source: input.source,
      sourceUrl: input.sourceUrl,
      fetchedAt: now,
      extractionVersion: PROBLEM_EXTRACTION_VERSION,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a problem purely from manual learner input (scraping failed). */
export function createManualProblem(sourceUrl: string, fields: ManualProblemFields, now?: string): Problem {
  const provider = detectProvider(sourceUrl);
  const canonicalUrl = canonicalizeUrl(sourceUrl);
  return normalizeProblem({
    provider,
    providerId: extractProviderId(sourceUrl, provider),
    canonicalUrl,
    sourceUrl: sourceUrl.trim(),
    title: fields.title ?? null,
    statement: fields.statement,
    constraints: fields.constraints ?? null,
    examples: fields.examples,
    difficulty: fields.difficulty ?? null,
    topics: fields.topics,
    source: 'manual',
    fetchedAt: now,
  });
}

/**
 * Supplement a (possibly partial) scraped problem with manual learner input.
 * Manual values fill ONLY fields the scraper left empty — successful
 * extraction is never thrown away. Provenance becomes `scraped+manual`.
 */
export function supplementWithManual(scraped: Problem, manual: ManualProblemFields, now?: string): Problem {
  const timestamp = now ?? new Date().toISOString();
  const manualTitle = cleanOptionalText(manual.title);
  const manualStatement = cleanOptionalText(manual.statement);
  const manualConstraints = cleanOptionalText(manual.constraints);
  const manualDifficulty = cleanOptionalText(manual.difficulty);
  return {
    ...scraped,
    title: scraped.title ?? manualTitle,
    statement: scraped.statement ?? manualStatement,
    constraints: scraped.constraints ?? manualConstraints,
    examples: scraped.examples.length > 0 ? scraped.examples : cleanExamples(manual.examples),
    difficulty: scraped.difficulty ?? manualDifficulty,
    topics: scraped.topics.length > 0 ? scraped.topics : cleanTopics(manual.topics),
    provenance: {
      source: 'scraped+manual',
      sourceUrl: scraped.provenance.sourceUrl,
      fetchedAt: timestamp,
      extractionVersion: PROBLEM_EXTRACTION_VERSION,
    },
    updatedAt: timestamp,
  };
}

/** Fields still missing after resolution (for the "supplement" UX). */
export function missingProblemFields(problem: Problem): string[] {
  const missing: string[] = [];
  if (problem.title === null) {
    missing.push('title');
  }
  if (problem.statement === null) {
    missing.push('statement');
  }
  if (problem.constraints === null) {
    missing.push('constraints');
  }
  if (problem.examples.length === 0) {
    missing.push('examples');
  }
  if (problem.difficulty === null) {
    missing.push('difficulty');
  }
  if (problem.topics.length === 0) {
    missing.push('topics');
  }
  return missing;
}

/** A problem is usable for an attempt when it has at least a statement. */
export function isUsableProblem(problem: Problem): boolean {
  return problem.statement !== null && problem.statement.length > 0;
}

/** Short human-readable label for UI lists. */
export function problemLabel(problem: Problem): string {
  if (problem.title !== null) {
    return problem.title;
  }
  if (problem.providerId !== null) {
    return `${problem.provider} ${problem.providerId}`;
  }
  return problem.canonicalUrl;
}
