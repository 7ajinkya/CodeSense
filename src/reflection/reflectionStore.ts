import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { parseReflection } from './reflectionTypes';
import type { LearnerReflection } from './reflectionTypes';

const REFLECTIONS_FILE = 'reflections.json';

export interface ReflectionStore {
  upsertReflection(reflection: LearnerReflection): Promise<void>;
  getReflection(reflectionId: string): Promise<LearnerReflection | null>;
  getReflectionForAttempt(attemptId: string): Promise<LearnerReflection | null>;
  listReflections(): Promise<LearnerReflection[]>;
}

/**
 * Local-first durable reflection storage (mirrors goal/activity/progress
 * stores). Writes validate strictly; reads stay lenient so one bad row
 * never breaks loading. Fresh-read on every operation (no cache).
 */
export class LocalReflectionStore implements ReflectionStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): LearnerReflection[] {
    const out: LearnerReflection[] = [];
    for (const item of loadJsonArray<unknown>(REFLECTIONS_FILE, this.workspacePath)) {
      if (!isRecord(item)) {
        continue;
      }
      const parsed = parseReflection(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async upsertReflection(reflection: LearnerReflection): Promise<void> {
    if (parseReflection(reflection) === null) {
      throw new Error('Cannot persist a malformed learner reflection.');
    }
    const rest = this.loadAll().filter((r) => r.reflectionId !== reflection.reflectionId);
    rest.push(reflection);
    rest.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.reflectionId.localeCompare(b.reflectionId),
    );
    saveJsonArray(REFLECTIONS_FILE, rest, this.workspacePath);
  }

  async getReflection(reflectionId: string): Promise<LearnerReflection | null> {
    return this.loadAll().find((r) => r.reflectionId === reflectionId) ?? null;
  }

  async getReflectionForAttempt(attemptId: string): Promise<LearnerReflection | null> {
    return this.loadAll().find((r) => r.provenance.attemptId === attemptId) ?? null;
  }

  async listReflections(): Promise<LearnerReflection[]> {
    return this.loadAll().sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.reflectionId.localeCompare(b.reflectionId),
    );
  }
}
