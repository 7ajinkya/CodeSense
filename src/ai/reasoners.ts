import { AIConversationMessage, AIReasoner, generateConversationMessageId } from './aiTypes';
import { AIContext } from '../context/aiContext';
import { COACHING_SYSTEM_PROMPT, renderContextForPrompt } from './aiPrompt';

/**
 * AIReasoner implementations. The extension depends only on the `AIReasoner`
 * interface; vendors live here and are chosen in exactly one place.
 */

export interface ChatReasonerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * OpenAI-compatible chat-completions reasoner (works with OpenAI and any
 * compatible local gateway). Uses global fetch — no new dependencies.
 * Transport problems throw; validation is the runner's job, not the
 * provider's. The model MUST return a single JSON object (requested via
 * response_format); anything else surfaces as a thrown error.
 */
export class HttpChatReasoner implements AIReasoner {
  readonly name = 'http-chat';

  constructor(private readonly options: ChatReasonerOptions) {}

  async evaluate(context: AIContext, opts: { signal?: AbortSignal }): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey.length > 0) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildChatRequest(this.options.model, context)),
        signal: opts.signal,
      });
    } catch (err) {
      throw new Error(`AI provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new Error(`AI provider HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('AI provider returned invalid JSON envelope');
    }
    return extractJsonContent(payload);
  }
}

/** Pure request builder (unit-testable without network). */
export function buildChatRequest(
  model: string,
  context: AIContext,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: COACHING_SYSTEM_PROMPT },
      { role: 'user', content: renderContextForPrompt(context) },
    ],
    temperature: 0.3,
    max_tokens: 900,
    response_format: { type: 'json_object' },
  };
}

/** Pure extractor for OpenAI-style chat envelopes (unit-testable). */
export function extractJsonContent(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('AI provider returned an unrecognized envelope');
  }
  const choices: unknown = (envelope as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('AI provider returned no choices');
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) {
    throw new Error('AI provider returned an unrecognized choice');
  }
  const message: unknown = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    throw new Error('AI provider returned a choice without a message');
  }
  const content: unknown = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('AI provider returned empty content');
  }
  // Deliberately uncaught: JSON SyntaxError must propagate so the runner
  // classifies malformed model output as 'malformed-response'.
  return JSON.parse(content) as unknown;
}

/**
 * Scripted reasoner for tests, smoke harnesses, and offline demos.
 * Returns queued raw payloads in order (defaulting to a calm
 * no-intervention evaluation), recording every context it saw.
 */
export class FakeReasoner implements AIReasoner {
  readonly name = 'fake';
  readonly seen: AIContext[] = [];

  constructor(private readonly script: unknown[] = []) {}

  async evaluate(context: AIContext): Promise<unknown> {
    this.seen.push(context);
    if (this.script.length > 0) {
      const next = this.script.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
    return {
      shouldIntervene: false,
      interventionType: 'NONE',
      urgency: 'low',
      message: '',
      reasoningSignals: {
        observedApproach: null,
        suspectedIssue: null,
        confidence: null,
        relevantEvidence: [],
      },
    };
  }
}

/** Convenience constructor for learner-visible coach messages in tests. */
export function coachMessage(
  attemptId: string,
  text: string,
  opts: { timestamp?: string; evaluationId?: string } = {},
): AIConversationMessage {
  return {
    messageId: generateConversationMessageId(),
    attemptId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    role: 'coach',
    text,
    ...(opts.evaluationId !== undefined ? { evaluationId: opts.evaluationId } : {}),
  };
}

/** Convenience constructor for learner replies in tests. */
export function learnerMessage(
  attemptId: string,
  text: string,
  timestamp?: string,
): AIConversationMessage {
  return {
    messageId: generateConversationMessageId(),
    attemptId,
    timestamp: timestamp ?? new Date().toISOString(),
    role: 'learner',
    text,
  };
}
