import { LearnerProfile, parseLearnerProfile } from './learnerModel';
import { loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const MODEL_FILE = 'learner-model.json';

export interface LearnerModelStore {
  loadProfile(): Promise<LearnerProfile | null>;
  saveProfile(profile: LearnerProfile): Promise<void>;
}

/**
 * Local-first storage for the DERIVED learner profile. This file is a
 * rebuildable cache: `rebuildLearnerModel(evidence, graph)` reproduces it
 * byte-for-byte from `learner-evidence.json`, so corruption or version
 * drift is recoverable by deleting this file (never the evidence file).
 */
export class LocalLearnerModelStore implements LearnerModelStore {
  constructor(private readonly workspacePath?: string) {}

  async loadProfile(): Promise<LearnerProfile | null> {
    const raw = loadJsonArray<unknown>(MODEL_FILE, this.workspacePath);
    if (raw.length === 0) {
      return null;
    }
    // Newest write wins; the file normally holds exactly one profile.
    for (let i = raw.length - 1; i >= 0; i--) {
      const parsed = parseLearnerProfile(raw[i]);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  async saveProfile(profile: LearnerProfile): Promise<void> {
    if (parseLearnerProfile(profile) === null) {
      throw new Error('Cannot persist a malformed learner profile.');
    }
    saveJsonArray(MODEL_FILE, [profile], this.workspacePath);
  }
}
