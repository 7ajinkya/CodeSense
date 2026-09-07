import {
  ManualProblemFields,
  Problem,
  buildProblemId,
  canonicalizeUrl,
  createManualProblem,
  detectProvider,
  extractProviderId,
  isUsableProblem,
  isValidProblemUrl,
  missingProblemFields,
  normalizeProblem,
  supplementWithManual,
} from './problem';
import { IScraper, ScrapedProblemData } from './scraperClient';

/**
 * Provider-agnostic problem resolution:
 *
 *   Problem URL -> automatic scrape (primary) -> manual paste (guaranteed fallback)
 *
 * No platform APIs are used anywhere. The URL is the authoritative external
 * reference; scraping is best-effort and deterministic (no LLM).
 */

export type ResolutionStatus = 'scraped' | 'partial' | 'failed';

export interface ResolutionSuccess {
  status: 'scraped';
  problem: Problem;
}

export interface ResolutionPartial {
  /** Scraping returned something usable but incomplete; learner may supplement. */
  status: 'partial';
  problem: Problem;
  missing: string[];
  scrapeError: string | null;
}

export interface ResolutionFailure {
  /** Nothing usable was extracted; learner must paste manually. */
  status: 'failed';
  error: string;
  sourceUrl: string;
  canonicalUrl: string;
}

export type ResolutionOutcome = ResolutionSuccess | ResolutionPartial | ResolutionFailure;

function scrapedToProblem(
  sourceUrl: string,
  canonicalUrl: string,
  data: ScrapedProblemData,
  source: 'scraped' | 'scraped+manual',
  now?: string,
): Problem {
  const provider = detectProvider(sourceUrl);
  return normalizeProblem({
    provider,
    providerId: extractProviderId(sourceUrl, provider),
    canonicalUrl,
    sourceUrl,
    title: data.title,
    statement: data.statement,
    constraints: data.constraints,
    examples: data.examples,
    difficulty: data.difficulty,
    topics: data.topics,
    source,
    fetchedAt: now,
  });
}

export class ProblemResolver {
  constructor(private readonly scraper: IScraper) {}

  /**
   * Attempt automatic extraction for `rawUrl`. Never throws for invalid
   * input — returns `failed` so the UI can offer manual paste instead.
   */
  async resolve(rawUrl: string, now?: string): Promise<ResolutionOutcome> {
    const sourceUrl = rawUrl.trim();
    if (!isValidProblemUrl(sourceUrl)) {
      return {
        status: 'failed',
        error: 'Please enter a valid http(s) problem URL.',
        sourceUrl,
        canonicalUrl: sourceUrl,
      };
    }
    const canonicalUrl = canonicalizeUrl(sourceUrl);
    let result;
    try {
      result = await this.scraper.scrape(sourceUrl);
    } catch (err) {
      return {
        status: 'failed',
        error: `Problem fetch failed (${String(err)}). Paste the statement manually to continue.`,
        sourceUrl,
        canonicalUrl,
      };
    }
    if (result.ok) {
      const problem = scrapedToProblem(sourceUrl, canonicalUrl, result.data, 'scraped', now);
      const missing = missingProblemFields(problem);
      if (missing.length === 0 || isUsableProblem(problem)) {
        // A usable statement with minor gaps is still `scraped`; the setup
        // UI shows `missing` so the learner can supplement if they wish.
        if (missing.length === 0) {
          return { status: 'scraped', problem };
        }
        return { status: 'partial', problem, missing, scrapeError: null };
      }
      return {
        status: 'failed',
        error: 'Automatic retrieval returned no usable statement. Paste it manually to continue.',
        sourceUrl,
        canonicalUrl,
      };
    }
    // Scrape failed: keep any partial extraction for the supplement UI.
    if (result.partial && result.partial.statement) {
      const problem = scrapedToProblem(sourceUrl, canonicalUrl, result.partial, 'scraped', now);
      return {
        status: 'partial',
        problem,
        missing: missingProblemFields(problem),
        scrapeError: result.error,
      };
    }
    return { status: 'failed', error: result.error, sourceUrl, canonicalUrl };
  }

  /** Build the final problem from manual learner input (fallback path). */
  buildFromManual(sourceUrl: string, fields: ManualProblemFields, now?: string): Problem {
    return createManualProblem(sourceUrl, fields, now);
  }

  /**
   * Fill gaps in a scraped/partial problem with manual learner input.
   * Successful extraction is preserved; only missing fields are filled.
   */
  supplement(base: Problem, manual: ManualProblemFields, now?: string): Problem {
    return supplementWithManual(base, manual, now);
  }

  /** Recompute the stable id for a URL (used to reuse existing Problems). */
  problemIdForUrl(sourceUrl: string): string {
    const provider = detectProvider(sourceUrl);
    return buildProblemId(provider, extractProviderId(sourceUrl, provider), canonicalizeUrl(sourceUrl));
  }
}
