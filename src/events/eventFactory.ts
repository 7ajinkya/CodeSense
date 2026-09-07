import { ActivityEvent, EventType, EventSource, SCHEMA_VERSION } from './activityEvent';
import { generateEventId } from '../util/ids';

/**
 * Creates event envelopes. Kept separate from capture code so that
 * event creation and envelope rules are unit-testable without VS Code.
 */
export interface CreateEventOptions<P> {
  sessionId: string;
  eventType: EventType;
  source: EventSource;
  payload: P;
  timestamp?: string;
  eventId?: string;
}

export function createEvent<P>(opts: CreateEventOptions<P>): ActivityEvent<P> {
  return {
    eventId: opts.eventId ?? generateEventId(),
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    eventType: opts.eventType,
    source: opts.source,
    schemaVersion: SCHEMA_VERSION,
    payload: opts.payload,
  };
}

/** Parse and validate a serialized event; tolerant of unknown optional fields. */
export function parseEvent(raw: unknown): ActivityEvent | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const required = ['eventId', 'sessionId', 'timestamp', 'eventType', 'source', 'schemaVersion', 'payload'];
  for (const key of required) {
    if (e[key] === undefined || e[key] === null) {
      return null;
    }
  }
  if (typeof e.eventId !== 'string' || typeof e.sessionId !== 'string' ||
      typeof e.timestamp !== 'string' || typeof e.eventType !== 'string' ||
      typeof e.source !== 'string' || typeof e.schemaVersion !== 'number' ||
      typeof e.payload !== 'object') {
    return null;
  }
  // Tolerant: newer/older minor additions pass through untouched.
  return raw as ActivityEvent;
}
