import { ActivityEvent } from '../events/activityEvent';

/**
 * A coding session. Sessions do NOT require a problem — a learner can code
 * on an arbitrary task. Problem integration arrives in a later phase.
 */
export interface CodingSession {
  sessionId: string;
  /** ISO-8601 UTC timestamp. */
  startedAt: string;
  /** ISO-8601 UTC timestamp; null while the session is active. */
  endedAt: string | null;
  workspaceId: string;
  workspacePath?: string;
  /** Most-observed language during the session, if determinable. */
  primaryLanguage?: string;
  /** Nullable by design; future phase concern. */
  problemId: string | null;
  events: ActivityEvent[];
}

export function createCodingSession(opts: {
  sessionId: string;
  startedAt?: string;
  workspaceId: string;
  workspacePath?: string;
  problemId?: string | null;
}): CodingSession {
  return {
    sessionId: opts.sessionId,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    endedAt: null,
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
    primaryLanguage: undefined,
    problemId: opts.problemId ?? null,
    events: [],
  };
}

export function appendEvent(session: CodingSession, event: ActivityEvent): void {
  if (event.sessionId !== session.sessionId) {
    throw new Error(
      `Event ${event.eventId} references session ${event.sessionId}, expected ${session.sessionId}`
    );
  }
  session.events.push(event);
  updatePrimaryLanguage(session);
}

export function finalizeSession(session: CodingSession, endedAt?: string): void {
  session.endedAt = endedAt ?? new Date().toISOString();
}

export function updatePrimaryLanguage(session: CodingSession): void {
  const counts = new Map<string, number>();
  for (const e of session.events) {
    const p = e.payload as Record<string, unknown> | null;
    if (p && typeof p === 'object' && typeof p.languageId === 'string') {
      counts.set(p.languageId, (counts.get(p.languageId) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  session.primaryLanguage = best;
}
