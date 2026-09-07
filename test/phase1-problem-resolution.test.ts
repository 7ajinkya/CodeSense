import { expect } from 'chai';
import {
  buildProblemId,
  canonicalizeUrl,
  createManualProblem,
  detectProvider,
  extractProviderId,
  isUsableProblem,
  isValidProblemUrl,
  missingProblemFields,
  normalizeProblem,
  problemLabel,
  supplementWithManual,
} from 'codesense/problems/problem';
import { LocalProblemStore } from 'codesense/problems/problemStore';
import { FakeScraperClient, ScrapedProblemData } from 'codesense/problems/scraperClient';
import { ProblemResolver } from 'codesense/problems/resolver';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

const STORE = tmpDir('codesense-test-problems');

beforeEach(() => clean(STORE));
afterEach(() => clean(STORE));

const FULL_SCRAPE: ScrapedProblemData = {
  title: 'Two Sum',
  statement: 'Given an array of integers nums...',
  constraints: '2 <= nums.length <= 10^4',
  examples: [{ input: 'nums = [2,7,11,15], target = 9', output: '[0,1]' }],
  difficulty: 'Easy',
  topics: ['Array', 'Hash Table'],
};

describe('Problem URL identity', () => {
  it('validates http(s) URLs only', () => {
    expect(isValidProblemUrl('https://leetcode.com/problems/two-sum/')).to.be.true;
    expect(isValidProblemUrl('http://codeforces.com/problemset/problem/4/A')).to.be.true;
    expect(isValidProblemUrl('not a url')).to.be.false;
    expect(isValidProblemUrl('ftp://example.com/x')).to.be.false;
    expect(isValidProblemUrl('')).to.be.false;
  });

  it('canonicalizes URLs for stable identity', () => {
    expect(canonicalizeUrl('https://leetcode.com/problems/two-sum/')).to.equal(
      canonicalizeUrl('https://leetcode.com/problems/two-sum?x=1#frag'),
    );
    expect(canonicalizeUrl('https://LEETCODE.com/problems/Two-Sum/')).to.equal(
      'https://leetcode.com/problems/Two-Sum',
    );
  });

  it('detects providers from hostnames', () => {
    expect(detectProvider('https://leetcode.com/problems/two-sum/')).to.equal('leetcode');
    expect(detectProvider('https://codeforces.com/problemset/problem/4/A')).to.equal('codeforces');
    expect(detectProvider('https://algozenith.com/problems/abc')).to.equal('algozenith');
    expect(detectProvider('https://example.com/q/1')).to.equal('generic');
    expect(detectProvider('garbage')).to.equal('unknown');
  });

  it('extracts provider ids from known URL shapes', () => {
    expect(extractProviderId('https://leetcode.com/problems/two-sum/', 'leetcode')).to.equal('two-sum');
    expect(extractProviderId('https://codeforces.com/problemset/problem/4/A', 'codeforces')).to.equal('4/A');
    expect(extractProviderId('https://codeforces.com/contest/4/problem/A', 'codeforces')).to.equal('4/A');
    expect(extractProviderId('https://leetcode.com/explore/', 'leetcode')).to.be.null;
    expect(extractProviderId('https://example.com/q/1', 'generic')).to.be.null;
  });

  it('builds stable ids: same problem URL => same problemId', () => {
    const a = buildProblemId('leetcode', 'two-sum', 'https://leetcode.com/problems/two-sum');
    const b = buildProblemId('leetcode', 'two-sum', 'https://leetcode.com/problems/two-sum');
    const c = buildProblemId('leetcode', 'three-sum', 'https://leetcode.com/problems/three-sum');
    expect(a).to.equal(b);
    expect(a).to.not.equal(c);
  });
});

describe('Problem normalization (no hallucination)', () => {
  it('keeps missing fields null instead of inventing them', () => {
    const problem = normalizeProblem({
      provider: 'generic',
      providerId: null,
      canonicalUrl: 'https://example.com/q',
      sourceUrl: 'https://example.com/q',
      title: null,
      statement: 'Do a thing.',
      source: 'scraped',
    });
    expect(problem.title).to.be.null;
    expect(problem.difficulty).to.be.null;
    expect(problem.topics).to.deep.equal([]);
    expect(problem.examples).to.deep.equal([]);
    expect(missingProblemFields(problem)).to.include('title');
    expect(isUsableProblem(problem)).to.be.true;
  });

  it('labels problems for the UI', () => {
    const withTitle = normalizeProblem({
      provider: 'leetcode',
      providerId: 'two-sum',
      canonicalUrl: 'https://leetcode.com/problems/two-sum',
      sourceUrl: 'https://leetcode.com/problems/two-sum/',
      title: 'Two Sum',
      statement: 's',
      source: 'scraped',
    });
    expect(problemLabel(withTitle)).to.equal('Two Sum');
  });
});

describe('ProblemResolver with mocked scraper boundary', () => {
  it('returns scraped problem on full scrape success', async () => {
    const resolver = new ProblemResolver(FakeScraperClient.success(FULL_SCRAPE));
    const outcome = await resolver.resolve('https://leetcode.com/problems/two-sum/');
    expect(outcome.status).to.equal('scraped');
    if (outcome.status !== 'scraped') {
      return;
    }
    expect(outcome.problem.provider).to.equal('leetcode');
    expect(outcome.problem.providerId).to.equal('two-sum');
    expect(outcome.problem.title).to.equal('Two Sum');
    expect(outcome.problem.provenance.source).to.equal('scraped');
    expect(outcome.problem.provenance.sourceUrl).to.equal('https://leetcode.com/problems/two-sum/');
  });

  it('returns partial when fields are missing and allows manual supplementation', async () => {
    const partial: ScrapedProblemData = {
      title: 'Mystery',
      statement: 'Solve it.',
      constraints: null,
      examples: [],
      difficulty: null,
      topics: [],
    };
    const resolver = new ProblemResolver(FakeScraperClient.success(partial));
    const outcome = await resolver.resolve('https://example.com/q/9');
    expect(outcome.status).to.equal('partial');
    if (outcome.status !== 'partial') {
      return;
    }
    expect(outcome.missing).to.include('constraints');
    // Supplementation fills ONLY missing fields; extraction is preserved.
    const supplemented = resolver.supplement(outcome.problem, {
      statement: 'SHOULD NOT OVERWRITE',
      constraints: 'n <= 5',
      difficulty: 'Easy',
    });
    expect(supplemented.statement).to.equal('Solve it.');
    expect(supplemented.constraints).to.equal('n <= 5');
    expect(supplemented.provenance.source).to.equal('scraped+manual');
  });

  it('returns failed on scrape failure and supports the manual fallback', async () => {
    const resolver = new ProblemResolver(FakeScraperClient.failure('HTTP 403: access forbidden', 'blocked'));
    const outcome = await resolver.resolve('https://leetcode.com/problems/two-sum/');
    expect(outcome.status).to.equal('failed');

    const manual = resolver.buildFromManual('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Pasted by the learner.',
    });
    expect(manual.provenance.source).to.equal('manual');
    expect(manual.provenance.sourceUrl).to.equal('https://leetcode.com/problems/two-sum/');
    expect(manual.provider).to.equal('leetcode');
    expect(manual.providerId).to.equal('two-sum');
    expect(isUsableProblem(manual)).to.be.true;
  });

  it('keeps scraper partial content on failure-with-partial', async () => {
    const partial: ScrapedProblemData = {
      title: null,
      statement: 'Partial statement survived.',
      constraints: null,
      examples: [],
      difficulty: null,
      topics: [],
    };
    const resolver = new ProblemResolver(FakeScraperClient.failure('timeout', 'timeout', partial));
    const outcome = await resolver.resolve('https://example.com/q/1');
    expect(outcome.status).to.equal('partial');
    if (outcome.status !== 'partial') {
      return;
    }
    expect(outcome.problem.statement).to.equal('Partial statement survived.');
    expect(outcome.scrapeError).to.equal('timeout');
  });

  it('rejects invalid URLs without touching the scraper', async () => {
    let called = false;
    const counting = new FakeScraperClient(() => {
      called = true;
      return { ok: false, error: 'x', errorKind: 'unknown', partial: null };
    });
    const resolver = new ProblemResolver(counting);
    const outcome = await resolver.resolve('not a url');
    expect(outcome.status).to.equal('failed');
    expect(called).to.be.false;
  });
});

describe('Problem store reuse', () => {
  it('reuses the same Problem entity for the same URL (stable id)', async () => {
    const store = new LocalProblemStore(STORE);
    const first = createManualProblem('https://leetcode.com/problems/two-sum/', {
      statement: 'v1',
    });
    await store.upsertProblem(first);
    const second = createManualProblem('https://leetcode.com/problems/two-sum/?ref=x', {
      statement: 'v2',
    });
    expect(second.problemId).to.equal(first.problemId);
    await store.upsertProblem(second);
    const problems = await store.listProblems();
    expect(problems.length).to.equal(1);
    expect(problems[0].statement).to.equal('v2');
    expect(await store.getProblemByUrl('https://leetcode.com/problems/two-sum')).to.not.be.null;
  });
});
