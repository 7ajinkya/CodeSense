import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { parseProblemKnowledge } from './problemKnowledge';
import type { ProblemKnowledgeRecord } from './problemKnowledge';

const PROBLEM_KNOWLEDGE_FILE = 'problem-knowledge.json';

export interface ProblemKnowledgeStore {
  upsertKnowledge(record: ProblemKnowledgeRecord): Promise<void>;
  getKnowledgeForProblem(problemId: string): Promise<ProblemKnowledgeRecord | null>;
  listKnowledge(): Promise<ProblemKnowledgeRecord[]>;
}

/**
 * Local-first durable problem-knowledge storage (mirrors the reflection /
 * goal / activity / progress stores). Writes validate strictly; reads stay
 * lenient so one bad row never breaks loading. Fresh-read on every
 * operation (no cache). Keyed by deterministic `recordId`
 * (`pk_<problemId>`), so one canonical problem can hold exactly one current
 * record no matter how many attempts it has.
 */
export class LocalProblemKnowledgeStore implements ProblemKnowledgeStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): ProblemKnowledgeRecord[] {
    const out: ProblemKnowledgeRecord[] = [];
    for (const item of loadJsonArray<unknown>(PROBLEM_KNOWLEDGE_FILE, this.workspacePath)) {
      if (!isRecord(item)) {
        continue;
      }
      const parsed = parseProblemKnowledge(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async upsertKnowledge(record: ProblemKnowledgeRecord): Promise<void> {
    if (parseProblemKnowledge(record) === null) {
      throw new Error('Cannot persist a malformed problem knowledge record.');
    }
    const rest = this.loadAll().filter((r) => r.recordId !== record.recordId);
    rest.push(record);
    rest.sort((a, b) => a.problemId.localeCompare(b.problemId));
    saveJsonArray(PROBLEM_KNOWLEDGE_FILE, rest, this.workspacePath);
  }

  async getKnowledgeForProblem(problemId: string): Promise<ProblemKnowledgeRecord | null> {
    return this.loadAll().find((r) => r.problemId === problemId) ?? null;
  }

  async listKnowledge(): Promise<ProblemKnowledgeRecord[]> {
    return this.loadAll().sort((a, b) => a.problemId.localeCompare(b.problemId));
  }
}
