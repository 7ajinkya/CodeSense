import { LearnerEvidence, parseLearnerEvidence } from './learnerEvidence';
import { loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const EVIDENCE_FILE = 'learner-evidence.json';

/**
 * Append growth is expected over months of use; this bound (≈ years of
 * active practice at realistic evidence rates) keeps a single JSON file
 * practical. Pruning drops the OLDEST records first and is documented in
 * the learner-model report — recency lives in trajectory/state, and the
 * bound is high enough that tests and real histories never approach it
 * silently: `appendEvidence` reports how many records were pruned.
 */
export const MAX_EVIDENCE_RECORDS = 5000;

export interface EvidenceStore {
  appendEvidence(evidence: LearnerEvidence): Promise<{ pruned: number }>;
  appendEvidenceBatch(records: LearnerEvidence[]): Promise<{ stored: number; pruned: number }>;
  listEvidence(): Promise<LearnerEvidence[]>;
  listEvidenceForEntity(entityId: string): Promise<LearnerEvidence[]>;
  countEvidence(): Promise<number>;
}

/**
 * Local-first, append-oriented evidence history. Records are validated at
 * the feed boundary (`validateLearnerEvidence`) so the store can stay
 * dumb; reads are lenient (`parseLearnerEvidence`) so one hand-edited
 * record can never break loading. Never uploaded anywhere.
 */
export class LocalLearnerEvidenceStore implements EvidenceStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): LearnerEvidence[] {
    const out: LearnerEvidence[] = [];
    for (const item of loadJsonArray<unknown>(EVIDENCE_FILE, this.workspacePath)) {
      const parsed = parseLearnerEvidence(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  private writeAll(records: LearnerEvidence[]): number {
    let pruned = 0;
    let kept = records;
    if (records.length > MAX_EVIDENCE_RECORDS) {
      pruned = records.length - MAX_EVIDENCE_RECORDS;
      kept = records.slice(records.length - MAX_EVIDENCE_RECORDS);
    }
    saveJsonArray(EVIDENCE_FILE, kept, this.workspacePath);
    return pruned;
  }

  async appendEvidence(evidence: LearnerEvidence): Promise<{ pruned: number }> {
    const result = await this.appendEvidenceBatch([evidence]);
    return { pruned: result.pruned };
  }

  async appendEvidenceBatch(records: LearnerEvidence[]): Promise<{ stored: number; pruned: number }> {
    if (records.length === 0) {
      return { stored: 0, pruned: 0 };
    }
    const seen = new Set(this.loadAll().map((e) => e.evidenceId));
    const fresh = records.filter((e) => !seen.has(e.evidenceId));
    if (fresh.length === 0) {
      return { stored: 0, pruned: 0 };
    }
    // Deterministic order: observation time, then id (stable rebuilds).
    const merged = [...this.loadAll(), ...fresh].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId),
    );
    const pruned = this.writeAll(merged);
    return { stored: fresh.length, pruned };
  }

  async listEvidence(): Promise<LearnerEvidence[]> {
    return this.loadAll().sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.evidenceId.localeCompare(b.evidenceId),
    );
  }

  async listEvidenceForEntity(entityId: string): Promise<LearnerEvidence[]> {
    return (await this.listEvidence()).filter((e) => e.entityIds.includes(entityId));
  }

  async countEvidence(): Promise<number> {
    return this.loadAll().length;
  }
}
