import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { parseRecommendation } from './recommendation';
import type { LongTermRecommendation } from './recommendation';

const RECOMMENDATIONS_FILE = 'recommendations.json';

export interface RecommendationStore {
  upsertRecommendation(recommendation: LongTermRecommendation): Promise<void>;
  getRecommendation(recommendationId: string): Promise<LongTermRecommendation | null>;
  listRecommendations(): Promise<LongTermRecommendation[]>;
}

/**
 * Local-first durable recommendation storage (mirrors the problem-knowledge
 * store). Writes validate strictly; reads stay lenient so one bad row never
 * breaks loading. Fresh-read on every operation (no cache). Keyed by
 * deterministic `recommendationId`, so re-derivation upserts instead of
 * duplicating. Stores recommendation state + provenance only — never D/F3
 * row copies.
 */
export class LocalRecommendationStore implements RecommendationStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): LongTermRecommendation[] {
    const out: LongTermRecommendation[] = [];
    for (const item of loadJsonArray<unknown>(RECOMMENDATIONS_FILE, this.workspacePath)) {
      if (!isRecord(item)) {
        continue;
      }
      const parsed = parseRecommendation(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  /**
   * Upsert with lifecycle-finality protection: a re-derived `offered` row
   * must never resurrect a stored row that has moved beyond `offered`.
   * Learner disposition (accepted/deferred) and terminal states
   * (skipped/completed/superseded) survive identical re-derivation — the
   * stored row is kept as-is. Deliberate forward transitions (which arrive
   * as non-`offered` rows built from the loaded row) always persist.
   * No timestamps or clocks are consulted: purely status-based.
   */
  async upsertRecommendation(recommendation: LongTermRecommendation): Promise<void> {
    if (parseRecommendation(recommendation) === null) {
      throw new Error('Cannot persist a malformed long-term recommendation.');
    }
    const all = this.loadAll();
    const existing = all.find((r) => r.recommendationId === recommendation.recommendationId) ?? null;
    if (existing !== null && existing.status !== 'offered' && recommendation.status === 'offered') {
      return;
    }
    const rest = all.filter((r) => r.recommendationId !== recommendation.recommendationId);
    rest.push(recommendation);
    rest.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.recommendationId.localeCompare(b.recommendationId));
    saveJsonArray(RECOMMENDATIONS_FILE, rest, this.workspacePath);
  }

  async getRecommendation(recommendationId: string): Promise<LongTermRecommendation | null> {
    return this.loadAll().find((r) => r.recommendationId === recommendationId) ?? null;
  }

  async listRecommendations(): Promise<LongTermRecommendation[]> {
    return this.loadAll().sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.recommendationId.localeCompare(b.recommendationId),
    );
  }
}
