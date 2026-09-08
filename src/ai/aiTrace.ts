import { loadJsonArray, saveJsonArray } from '../persistence/storeFiles';
import { isRecord } from '../persistence/storeFiles';

/**
 * Minimal developer-oriented AI interaction trace (Phase E §21).
 *
 * Correlates, per evaluation turn: trigger → assembled context → outbound
 * request → provider response → parsing → validation → final
 * evaluation/intervention → display decision. This is a DEBUG aid, not
 * learner data: it lives in its own local file (`ai-trace.json`), capped
 * and separate from learner evidence persistence, and it NEVER records
 * secrets (no API keys, no authorization headers — the trace path only
 * ever sees the request BODY object, byte counts, and truncated,
 * learner-local previews).
 */

const TRACE_FILE = 'ai-trace.json';
/** Ring-buffer cap: newest turns kept, oldest dropped. */
export const MAX_TRACE_EVENTS = 200;

export type AITraceStage =
  | 'context-assembled'
  | 'request-sent'
  | 'response-received'
  | 'validation-passed'
  | 'validation-failed'
  | 'completed';

export const AI_TRACE_STAGES: readonly AITraceStage[] = [
  'context-assembled',
  'request-sent',
  'response-received',
  'validation-passed',
  'validation-failed',
  'completed',
];

export function isKnownTraceStage(value: unknown): value is AITraceStage {
  return typeof value === 'string' && (AI_TRACE_STAGES as readonly string[]).includes(value);
}

export interface AITraceEvent {
  traceId: string;
  /** ISO-8601 UTC timestamp. */
  at: string;
  stage: AITraceStage;
  attemptId: string | null;
  evaluationId: string | null;
  triggerKind: string | null;
  /** Short secret-free summary (byte counts, outcome kinds, error classes). */
  summary: string;
  /** Truncated learner-local preview (rendered context / raw JSON head). */
  preview?: string;
}

export const MAX_TRACE_SUMMARY_CHARS = 300;
export const MAX_TRACE_PREVIEW_CHARS = 500;

export function truncateTraceText(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

function parseTraceEvent(raw: unknown): AITraceEvent | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.traceId !== 'string' ||
    typeof raw.at !== 'string' ||
    !isKnownTraceStage(raw.stage) ||
    typeof raw.summary !== 'string'
  ) {
    return null;
  }
  if (raw.attemptId !== null && typeof raw.attemptId !== 'string') {
    return null;
  }
  if (raw.evaluationId !== null && typeof raw.evaluationId !== 'string') {
    return null;
  }
  if (raw.triggerKind !== null && typeof raw.triggerKind !== 'string') {
    return null;
  }
  if (raw.preview !== undefined && typeof raw.preview !== 'string') {
    return null;
  }
  return {
    traceId: raw.traceId,
    at: raw.at,
    stage: raw.stage,
    attemptId: raw.attemptId,
    evaluationId: raw.evaluationId,
    triggerKind: raw.triggerKind,
    summary: raw.summary,
    ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
  };
}

function secretScan(text: string): boolean {
  return /sk-[A-Za-z0-9]|bearer\s+[A-Za-z0-9._~+/-]+=*|authorization/i.test(text);
}

export interface AiTraceStore {
  appendTrace(event: AITraceEvent): Promise<void>;
  listTrace(): Promise<AITraceEvent[]>;
  listTraceForAttempt(attemptId: string): Promise<AITraceEvent[]>;
}

/**
 * Local capped trace ring. Refuses events whose text trips the secret
 * scan (defense in depth — callers must already exclude secrets).
 */
export class LocalAiTraceStore implements AiTraceStore {
  constructor(private readonly workspacePath?: string) {}

  private loadAll(): AITraceEvent[] {
    const out: AITraceEvent[] = [];
    for (const item of loadJsonArray<unknown>(TRACE_FILE, this.workspacePath)) {
      const parsed = parseTraceEvent(item);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  async appendTrace(event: AITraceEvent): Promise<void> {
    if (parseTraceEvent(event) === null) {
      throw new Error('Cannot persist a malformed AI trace event.');
    }
    if (secretScan(event.summary) || (event.preview !== undefined && secretScan(event.preview))) {
      throw new Error('Refusing AI trace event that looks like it contains a secret.');
    }
    const merged = [...this.loadAll(), event].sort(
      (a, b) => a.at.localeCompare(b.at) || a.traceId.localeCompare(b.traceId),
    );
    saveJsonArray(TRACE_FILE, merged.slice(-MAX_TRACE_EVENTS), this.workspacePath);
  }

  async listTrace(): Promise<AITraceEvent[]> {
    return this.loadAll().sort((a, b) => a.at.localeCompare(b.at) || a.traceId.localeCompare(b.traceId));
  }

  async listTraceForAttempt(attemptId: string): Promise<AITraceEvent[]> {
    return (await this.listTrace()).filter((e) => e.attemptId === attemptId);
  }
}
