import { ActivityEvent } from '../events/activityEvent';
import { CodingSession } from '../session/codingSession';

/**
 * Persistence interface, deliberately decoupled from implementation so the
 * storage technology can evolve (e.g. to SQLite) without touching capture.
 */
export interface SessionStore {
  /** Create storage for a new session. */
  createSession(session: CodingSession): Promise<void>;
  /** Append a single event to an existing session. */
  appendEvent(sessionId: string, event: ActivityEvent): Promise<void>;
  /** Mark a session as finalized (write endedAt etc.). */
  finalizeSession(session: CodingSession): Promise<void>;
  /** Load a session with all of its events. */
  getSession(sessionId: string): Promise<CodingSession | null>;
  /** List all stored session ids, newest first. */
  listSessionIds(): Promise<string[]>;
  /** Delete a session and its events (privacy). */
  deleteSession(sessionId: string): Promise<boolean>;
}
