import { Problem } from './problem';
import { asOptionalString, isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const PROBLEMS_FILE = 'problems.json';

/**
 * Local-first problem persistence. Problems are keyed by stable problemId so
 * retrying the same URL reuses the Problem instead of duplicating it.
 */
export interface ProblemStore {
  upsertProblem(problem: Problem): Promise<void>;
  getProblem(problemId: string): Promise<Problem | null>;
  getProblemByUrl(canonicalUrl: string): Promise<Problem | null>;
  listProblems(): Promise<Problem[]>;
}

function parseProblem(raw: unknown): Problem | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.problemId !== 'string' || typeof raw.canonicalUrl !== 'string') {
    return null;
  }
  const prov = isRecord(raw.provenance) ? raw.provenance : null;
  if (prov === null || typeof prov.sourceUrl !== 'string' || typeof prov.source !== 'string') {
    return null;
  }
  const examplesRaw: unknown = raw.examples;
  const examples = Array.isArray(examplesRaw)
    ? examplesRaw
        .filter(isRecord)
        .filter((e) => typeof e.input === 'string' && typeof e.output === 'string')
        .map((e) => ({
          input: e.input as string,
          output: e.output as string,
          ...(typeof e.explanation === 'string' ? { explanation: e.explanation as string } : {}),
        }))
    : [];
  const topicsRaw: unknown = raw.topics;
  const topics = Array.isArray(topicsRaw) ? topicsRaw.filter((t): t is string => typeof t === 'string') : [];
  return {
    problemId: raw.problemId,
    provider: typeof raw.provider === 'string' ? (raw.provider as Problem['provider']) : 'unknown',
    providerId: asOptionalString(raw.providerId),
    canonicalUrl: raw.canonicalUrl,
    title: asOptionalString(raw.title),
    statement: asOptionalString(raw.statement),
    constraints: asOptionalString(raw.constraints),
    examples,
    difficulty: asOptionalString(raw.difficulty),
    topics,
    provenance: {
      source: prov.source as Problem['provenance']['source'],
      sourceUrl: prov.sourceUrl,
      fetchedAt: typeof prov.fetchedAt === 'string' ? prov.fetchedAt : new Date(0).toISOString(),
      extractionVersion: typeof prov.extractionVersion === 'number' ? prov.extractionVersion : 1,
    },
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export class LocalProblemStore implements ProblemStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): Problem[] {
    const raw = loadJsonArray<unknown>(PROBLEMS_FILE, this.workspacePath);
    const out: Problem[] = [];
    for (const item of raw) {
      const parsed = parseProblem(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  private saveAll(problems: Problem[]): void {
    saveJsonArray(PROBLEMS_FILE, problems, this.workspacePath);
  }

  async upsertProblem(problem: Problem): Promise<void> {
    const all = this.loadAll();
    const existing = all.find((p) => p.problemId === problem.problemId);
    const rest = all.filter((p) => p.problemId !== problem.problemId);
    rest.push({
      ...problem,
      createdAt: existing ? existing.createdAt : problem.createdAt,
    });
    this.saveAll(rest);
  }

  async getProblem(problemId: string): Promise<Problem | null> {
    return this.loadAll().find((p) => p.problemId === problemId) ?? null;
  }

  async getProblemByUrl(canonicalUrl: string): Promise<Problem | null> {
    const needle = canonicalUrl.toLowerCase();
    return this.loadAll().find((p) => p.canonicalUrl.toLowerCase() === needle) ?? null;
  }

  async listProblems(): Promise<Problem[]> {
    return this.loadAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
