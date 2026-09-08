import { ProblemClassification, parseProblemClassification } from './classification';
import { loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const CLASSIFICATIONS_FILE = 'classifications.json';

/**
 * Keep only the newest few records per problem so history stays bounded
 * while reclassification never silently destroys provenance.
 */
export const MAX_RECORDS_PER_PROBLEM = 10;

/**
 * Local-first problem-classification persistence. Records are keyed by the
 * stable `problemId` (the same identity the Problem/Attempt stores use), so
 * classification NEVER mutates the Problem record itself — a classification
 * failure, or its absence, cannot corrupt problem data, and pre-Phase-C
 * problems simply have no record (unclassified, still usable).
 *
 * Storage reads are lenient (`parseProblemClassification`): historical
 * records survive ontology evolution instead of failing to load.
 */
export interface ClassificationStore {
  saveClassification(classification: ProblemClassification): Promise<void>;
  getClassification(problemId: string): Promise<ProblemClassification | null>;
  /** Newest record per problem, most recently classified first. */
  listClassifications(): Promise<ProblemClassification[]>;
}

export class LocalClassificationStore implements ClassificationStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): ProblemClassification[] {
    const out: ProblemClassification[] = [];
    for (const item of loadJsonArray<unknown>(CLASSIFICATIONS_FILE, this.workspacePath)) {
      const parsed = parseProblemClassification(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async saveClassification(classification: ProblemClassification): Promise<void> {
    if (parseProblemClassification(classification) === null) {
      throw new Error('Cannot persist a malformed problem classification.');
    }
    const all = this.loadAll();
    const rest = all.filter((c) => c.problemId !== classification.problemId);
    const mine = [...all.filter((c) => c.problemId === classification.problemId), classification]
      .sort((a, b) => a.classifiedAt.localeCompare(b.classifiedAt))
      .slice(-MAX_RECORDS_PER_PROBLEM);
    saveJsonArray(CLASSIFICATIONS_FILE, [...rest, ...mine], this.workspacePath);
  }

  async getClassification(problemId: string): Promise<ProblemClassification | null> {
    const mine = this.loadAll()
      .filter((c) => c.problemId === problemId)
      .sort((a, b) => a.classifiedAt.localeCompare(b.classifiedAt));
    return mine.length > 0 ? mine[mine.length - 1] : null;
  }

  async listClassifications(): Promise<ProblemClassification[]> {
    const latest = new Map<string, ProblemClassification>();
    for (const record of this.loadAll()) {
      const current = latest.get(record.problemId);
      if (!current || record.classifiedAt.localeCompare(current.classifiedAt) >= 0) {
        latest.set(record.problemId, record);
      }
    }
    return [...latest.values()].sort((a, b) => b.classifiedAt.localeCompare(a.classifiedAt));
  }
}
