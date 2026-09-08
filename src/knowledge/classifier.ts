import { ChatReasonerOptions, postChatCompletions } from '../ai/reasoners';
import type { KnowledgeGraph } from './ontologyStore';
import {
  CLASSIFIER_VERSION,
  ClassificationPayload,
  ProblemClassification,
  finalizeClassification,
  validateClassificationPayload,
} from './classification';
import type { ClassificationStore } from './classificationStore';
import type { Problem } from '../problems/problem';
import {
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
  renderEntityReference,
  renderProblemForClassification,
} from './classifierPrompt';

/**
 * Phase C problem classifier — automatic, never manual.
 *
 * Learner workflow stays: Start Problem (URL + description) → CodeSense
 * classifies. The learner is never asked for topics/concepts/frameworks/
 * forms/patterns/tactics, and no new tagging UI exists anywhere.
 *
 * AI integration reuses the existing provider layer: classification goes
 * through the SAME chat-completions transport (`postChatCompletions`) as
 * coaching evaluation, with a dedicated classification operation, prompt,
 * and strict validation. Coaching evaluation code is untouched — the two
 * operations share transport but nothing else.
 *
 * Failure philosophy (mirrors `evaluationRunner.ts`): every failure is an
 * explicit outcome, never an exception into the caller, never a corrupted
 * Problem record. Classification is supporting infrastructure — a problem
 * without classification remains fully usable for solving.
 */

/** Minimal problem-derived classifier input (problem scope ONLY). */
export interface ClassificationInput {
  problemId: string;
  title: string | null;
  statement: string | null;
  constraints: string | null;
  examples: Array<{ input: string; output: string }>;
  difficulty: string | null;
  /** Source-provided labels, passed as explicitly-untrusted hints. */
  topics: string[];
  provider: string;
  sourceUrl: string;
}

/**
 * Build the classifier input from a Problem. Copies ONLY problem fields —
 * no workspace content, no attempt data, no learner data can reach the
 * classifier through this boundary (privacy by construction).
 */
export function buildClassificationInput(problem: Problem): ClassificationInput {
  return {
    problemId: problem.problemId,
    title: problem.title,
    statement: problem.statement,
    constraints: problem.constraints,
    examples: problem.examples
      .filter((e) => typeof e.input === 'string' && typeof e.output === 'string')
      .map((e) => ({ input: e.input, output: e.output })),
    difficulty: problem.difficulty,
    topics: [...problem.topics],
    provider: problem.provider,
    sourceUrl: problem.provenance.sourceUrl,
  };
}

/** Pure request builder (unit-testable without network). */
export function buildClassificationRequest(
  model: string,
  input: ClassificationInput,
  graph: KnowledgeGraph,
): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: 'system',
        content:
          `${CLASSIFICATION_SYSTEM_PROMPT}\n\n` +
          `Classification prompt version: ${CLASSIFICATION_PROMPT_VERSION}\n` +
          `Ontology version: ${graph.ontologyVersion}\n\n` +
          `Allowed entity IDs for this ontology version:\n${renderEntityReference(graph)}`,
      },
      { role: 'user', content: renderProblemForClassification(input) },
    ],
    temperature: 0.2,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
  };
}

/**
 * Dedicated classification operation. Implementations must not throw for
 * validation concerns — return raw parsed JSON and let the classifier
 * validate. Transport failures (network/HTTP/timeout) SHOULD throw.
 */
export interface ProblemClassificationReasoner {
  readonly name: string;
  classify(request: Record<string, unknown>): Promise<unknown>;
}

/**
 * HTTP classification reasoner sharing the single chat-completions
 * transport with coaching evaluation (see `postChatCompletions`).
 */
export class HttpProblemClassificationReasoner implements ProblemClassificationReasoner {
  readonly name = 'http-classification';

  constructor(private readonly options: ChatReasonerOptions) {}

  async classify(request: Record<string, unknown>): Promise<unknown> {
    return postChatCompletions(this.options, request, {});
  }
}

/**
 * Scripted reasoner for tests and offline harnesses. Replays queued raw
 * payloads in order (defaulting to an honest low-confidence empty claim),
 * recording every request it saw.
 */
export class FakeProblemClassificationReasoner implements ProblemClassificationReasoner {
  readonly name = 'fake-classification';
  readonly seen: Array<Record<string, unknown>> = [];

  constructor(private readonly script: unknown[] = []) {}

  async classify(request: Record<string, unknown>): Promise<unknown> {
    this.seen.push(request);
    if (this.script.length > 0) {
      const next = this.script.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
    return { confidence: 'low' } satisfies Partial<ClassificationPayload> as unknown;
  }
}

export interface ClassificationPorts {
  reasoner: ProblemClassificationReasoner;
  store: ClassificationStore;
  graph: KnowledgeGraph;
  model: string;
  nowIso(): string;
  timeoutMs: number;
}

export type ClassificationOutcome =
  | { status: 'classified'; classification: ProblemClassification }
  | { status: 'skipped'; reason: 'already-classified' | 'no-content' }
  | {
      status: 'failed';
      reason: 'timeout' | 'provider-error' | 'malformed-response' | 'invalid-entity' | 'persistence-error';
      detail: string;
    };

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Problem classification timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).then(
    (result) => {
      if (timer) {
        clearTimeout(timer);
      }
      return result as T;
    },
    (err: unknown) => {
      if (timer) {
        clearTimeout(timer);
      }
      throw err;
    },
  );
}

/**
 * Classify one problem's knowledge requirements and persist the result.
 * Pure with respect to its input: the passed Problem is only read, never
 * mutated (async persistence goes to the ClassificationStore keyed by
 * problemId). Never throws for classification concerns — transport,
 * validation, and persistence failures all surface as explicit outcomes.
 */
export async function runProblemClassification(
  ports: ClassificationPorts,
  problem: Problem,
): Promise<ClassificationOutcome> {
  const input = buildClassificationInput(problem);
  if ((input.statement === null || input.statement.trim().length === 0) && (input.title === null || input.title.trim().length === 0)) {
    return { status: 'skipped', reason: 'no-content' };
  }
  // Idempotency: a record stamped with the CURRENT ontology version is
  // already classified. An ontology bump (or no record) re-runs explicitly.
  const existing = await ports.store.getClassification(problem.problemId);
  if (existing && existing.ontologyVersion === ports.graph.ontologyVersion) {
    return { status: 'skipped', reason: 'already-classified' };
  }
  const request = buildClassificationRequest(ports.model, input, ports.graph);
  let raw: unknown;
  try {
    raw = await withTimeout(ports.reasoner.classify(request), ports.timeoutMs);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Problem classification timed out')) {
      return { status: 'failed', reason: 'timeout', detail: err.message };
    }
    if (err instanceof SyntaxError) {
      return { status: 'failed', reason: 'malformed-response', detail: err.message };
    }
    return {
      status: 'failed',
      reason: 'provider-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const validated = validateClassificationPayload(raw, { graph: ports.graph });
  if (!validated.ok) {
    return { status: 'failed', reason: validated.reason, detail: validated.detail };
  }
  const classification = finalizeClassification(validated.value, {
    problemId: problem.problemId,
    ontologyVersion: ports.graph.ontologyVersion,
    classifierVersion: CLASSIFIER_VERSION,
    classifiedAt: ports.nowIso(),
    problemSourceUrl: problem.provenance.sourceUrl,
    source: 'ai',
  });
  try {
    await ports.store.saveClassification(classification);
  } catch (err) {
    return {
      status: 'failed',
      reason: 'persistence-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { status: 'classified', classification };
}
