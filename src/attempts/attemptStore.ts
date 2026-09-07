import { Attempt, AttemptStateTransition, isKnownAttemptState } from './attempt';
import { asOptionalString, isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const ATTEMPTS_FILE = 'attempts.json';

/** Local-first attempt persistence (append-only state history preserved). */
export interface AttemptStore {
  saveAttempt(attempt: Attempt): Promise<void>;
  getAttempt(attemptId: string): Promise<Attempt | null>;
  listAttemptsForProblem(problemId: string): Promise<Attempt[]>;
  listAttemptsForSession(sessionId: string): Promise<Attempt[]>;
  getActiveAttemptForSession(sessionId: string): Promise<Attempt | null>;
}

function parseTransition(raw: unknown, attemptId: string): AttemptStateTransition | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.toState !== 'string' || !isKnownAttemptState(raw.toState)) {
    return null;
  }
  if (typeof raw.fromState !== 'string' || !isKnownAttemptState(raw.fromState)) {
    return null;
  }
  if (typeof raw.timestamp !== 'string') {
    return null;
  }
  const source = raw.source === 'system' ? 'system' : 'learner';
  const transition: AttemptStateTransition = {
    attemptId,
    timestamp: raw.timestamp,
    fromState: raw.fromState,
    toState: raw.toState,
    source,
  };
  if (typeof raw.note === 'string') {
    transition.note = raw.note;
  }
  return transition;
}

function parseAttempt(raw: unknown): Attempt | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.attemptId !== 'string' ||
    typeof raw.problemId !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.startedAt !== 'string'
  ) {
    return null;
  }
  if (typeof raw.currentState !== 'string' || !isKnownAttemptState(raw.currentState)) {
    return null;
  }
  const historyRaw = raw.stateHistory;
  const stateHistory: AttemptStateTransition[] = Array.isArray(historyRaw)
    ? historyRaw
        .map((t) => parseTransition(t, raw.attemptId as string))
        .filter((t): t is AttemptStateTransition => t !== null)
    : [];
  const attempt: Attempt = {
    attemptId: raw.attemptId,
    problemId: raw.problemId,
    sessionId: raw.sessionId,
    startedAt: raw.startedAt,
    completedAt: asOptionalString(raw.completedAt),
    currentState: raw.currentState,
    stateHistory,
  };
  const language = asOptionalString(raw.language);
  if (language !== null) {
    attempt.language = language;
  }
  return attempt;
}

export class LocalAttemptStore implements AttemptStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): Attempt[] {
    const raw = loadJsonArray<unknown>(ATTEMPTS_FILE, this.workspacePath);
    const out: Attempt[] = [];
    for (const item of raw) {
      const parsed = parseAttempt(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    const rest = this.loadAll().filter((a) => a.attemptId !== attempt.attemptId);
    rest.push(attempt);
    saveJsonArray(ATTEMPTS_FILE, rest, this.workspacePath);
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    return this.loadAll().find((a) => a.attemptId === attemptId) ?? null;
  }

  async listAttemptsForProblem(problemId: string): Promise<Attempt[]> {
    return this.loadAll()
      .filter((a) => a.problemId === problemId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async listAttemptsForSession(sessionId: string): Promise<Attempt[]> {
    return this.loadAll()
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async getActiveAttemptForSession(sessionId: string): Promise<Attempt | null> {
    return this.loadAll().find((a) => a.sessionId === sessionId && a.completedAt === null) ?? null;
  }
}
