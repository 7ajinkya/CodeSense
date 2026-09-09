import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import { isKnownEvidenceDimension } from '../learner/learnerTypes';
import type { EvidenceConfidence, EvidenceDimension, EvidenceType } from '../learner/learnerTypes';
import { isRecord } from '../persistence/storeFiles';
import { postChatCompletions } from '../ai/reasoners';
import type { ChatReasonerOptions } from '../ai/reasoners';
import type { ReflectionCategory } from './reflectionTypes';
import {
  MAX_REFLECTION_MISTAKE_CATEGORY_CHARS,
  isEmittableReflectionEvidenceType,
} from './reflectionTypes';

/**
 * Phase G optional AI structuring (enhancement, never a dependency).
 *
 * The deterministic category→evidence path works fully without this
 * module. When enabled, the model may PROPOSE a narrowed structured
 * reading of the learner's explicit free text (entities, dimension,
 * mistake category). The proposal is display-only until the learner
 * explicitly confirms it; `validateReflectionInterpretation` then decides
 * whether it is durable. Unconfirmed, uncertain, or invalid proposals are
 * discarded and the deterministic path proceeds unchanged.
 *
 * Transport is the shared `postChatCompletions` boundary (one HTTP policy
 * for the extension). Prompt philosophy lives HERE and nowhere else.
 */

export const REFLECTION_PROMPT_VERSION = 1;

export const MAX_REFLECTION_PROMPT_TEXT_CHARS = 500;
export const MAX_REFLECTION_PROMPT_TITLE_CHARS = 160;

export const REFLECTION_STRUCTURING_SYSTEM_PROMPT = `You help structure a learner's EXPLICIT reflection about a problem they just finished. You never diagnose the learner and never claim mastery.

Given the learner's chosen category and their own words, propose the most likely structured reading using ONLY entity IDs from the allowed list.

Rules:
- Use ONLY entity IDs from the allowed list. Never invent IDs, never use display names as IDs.
- dimension is one of: recognition, conceptual, implementation, debugging, transfer, independence. Never use exposure.
- evidenceType is one of: RECOGNITION, CONCEPTUAL_SUCCESS, CONCEPTUAL_CONFUSION, RECURRING_MISTAKE. It must agree with dimension: RECOGNITION needs recognition; CONCEPTUAL_SUCCESS/CONFUSION need conceptual; RECURRING_MISTAKE carries any non-exposure dimension.
- confidence is low or medium only. When unsure, use low or abstain — preserving uncertainty beats inventing precision.
- mistakeCategory is a kebab-case tag (e.g. forgot-visited-marking, off-by-one) ONLY when the learner describes a concrete repeated mistake pattern; otherwise omit it.
- If the learner's words are too vague to structure, abstain rather than guessing.

Response contract (MUST be a single JSON object, no other text):
{"entityIds": [string], "dimension": string, "evidenceType": "RECOGNITION"|"CONCEPTUAL_SUCCESS"|"CONCEPTUAL_CONFUSION"|"RECURRING_MISTAKE", "mistakeCategory": string|null, "confidence": "low"|"medium"}
OR, when too vague:
{"abstain": true}`;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n…[truncated for prompt budget]';
}

/** Deterministic bounded entity reference (allowed ids only). */
export function renderReflectionEntityReference(graph: KnowledgeGraph): string {
  return graph
    .listEntities()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `- ${e.id} — ${e.name}`)
    .join('\n');
}

export interface ReflectionStructuringInput {
  category: ReflectionCategory;
  freeText: string;
  problemTitle: string | null;
}

export function renderReflectionForStructuring(input: ReflectionStructuringInput): string {
  const lines: string[] = [];
  lines.push(`Learner category: ${input.category}`);
  lines.push(`Problem: ${truncate(input.problemTitle ?? '(untitled)', MAX_REFLECTION_PROMPT_TITLE_CHARS)}`);
  lines.push(`Learner words:\n${truncate(input.freeText, MAX_REFLECTION_PROMPT_TEXT_CHARS)}`);
  return lines.join('\n');
}

export interface ReflectionAiCandidate {
  entityIds: string[];
  dimension: EvidenceDimension;
  evidenceType: EvidenceType;
  mistakeCategory?: string;
  confidence: EvidenceConfidence;
}

function isValidMistakeCategory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REFLECTION_MISTAKE_CATEGORY_CHARS &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

/**
 * Validates a raw AI candidate. Returns the narrowed proposal or null
 * (abstain / malformed / unknown entity / capped confidence / bad shape).
 * The host still needs explicit learner confirmation before this becomes
 * a `ReflectionInterpretation`.
 */
export function validateReflectionAiCandidate(
  raw: unknown,
  opts: { graph: KnowledgeGraph },
): ReflectionAiCandidate | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.abstain === true) {
    return null;
  }
  const entityIds: unknown = raw.entityIds;
  if (
    !Array.isArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.length > 12 ||
    entityIds.some((e: unknown) => typeof e !== 'string' || (e as string).trim().length === 0)
  ) {
    return null;
  }
  for (const id of entityIds as string[]) {
    if (!opts.graph.hasEntity(id)) {
      return null;
    }
  }
  if (!isKnownEvidenceDimension(raw.dimension) || raw.dimension === 'exposure') {
    return null;
  }
  if (!isEmittableReflectionEvidenceType(raw.evidenceType)) {
    return null;
  }
  // Dimension must agree with the evidence type (RECURRING_MISTAKE carries
  // its dimension explicitly; every other type maps to a fixed dimension).
  const expectedDimension =
    raw.evidenceType === 'RECURRING_MISTAKE'
      ? raw.dimension
      : raw.evidenceType === 'RECOGNITION'
        ? 'recognition'
        : 'conceptual';
  if (raw.dimension !== expectedDimension) {
    return null;
  }
  if (raw.confidence !== 'low' && raw.confidence !== 'medium') {
    return null;
  }
  const mistakeCategory: unknown = raw.mistakeCategory;
  if (raw.evidenceType === 'RECURRING_MISTAKE') {
    if (
      mistakeCategory !== undefined &&
      mistakeCategory !== null &&
      !isValidMistakeCategory(mistakeCategory)
    ) {
      return null;
    }
  } else if (mistakeCategory !== undefined && mistakeCategory !== null) {
    return null;
  }
  return {
    entityIds: [...(entityIds as string[])],
    dimension: raw.dimension,
    evidenceType: raw.evidenceType,
    ...(typeof mistakeCategory === 'string' && isValidMistakeCategory(mistakeCategory)
      ? { mistakeCategory }
      : {}),
    confidence: raw.confidence,
  };
}

export interface ReflectionStructuringReasoner {
  structure(request: Record<string, unknown>): Promise<unknown>;
}

export class HttpReflectionStructuringReasoner implements ReflectionStructuringReasoner {
  readonly name = 'http-reflection';
  constructor(private readonly options: ChatReasonerOptions) {}
  structure(request: Record<string, unknown>): Promise<unknown> {
    return postChatCompletions(this.options, request, {});
  }
}

export class FakeReflectionStructuringReasoner implements ReflectionStructuringReasoner {
  readonly seen: Array<Record<string, unknown>> = [];
  constructor(private readonly script: unknown[] = [], private readonly fallback?: unknown) {}
  async structure(request: Record<string, unknown>): Promise<unknown> {
    this.seen.push(request);
    if (this.script.length > 0) {
      const next = this.script.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
    if (this.fallback !== undefined) {
      return this.fallback;
    }
    return { abstain: true };
  }
}

export function buildReflectionStructuringRequest(
  model: string,
  graph: KnowledgeGraph,
  input: ReflectionStructuringInput,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: REFLECTION_STRUCTURING_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Allowed entities (ontology version ${graph.ontologyVersion}):\n` +
          `${renderReflectionEntityReference(graph)}\n\n` +
          `${renderReflectionForStructuring(input)}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: 'json_object' },
  };
}

export type ReflectionProposalOutcome =
  | { status: 'proposed'; candidate: ReflectionAiCandidate }
  | { status: 'abstained'; reason: 'abstained' }
  | { status: 'failed'; reason: 'provider-error' | 'malformed-response' | 'invalid-entity' };

/**
 * Runs one structuring proposal: build request → reason → validate.
 * Never throws; every failure degrades to abstained/failed so the caller
 * falls back to the deterministic path with the raw text preserved.
 */
export async function proposeReflectionInterpretation(
  ports: { reasoner: ReflectionStructuringReasoner; graph: KnowledgeGraph; model: string },
  input: ReflectionStructuringInput,
): Promise<ReflectionProposalOutcome> {
  try {
    const request = buildReflectionStructuringRequest(ports.model, ports.graph, input);
    let raw: unknown;
    try {
      raw = await ports.reasoner.structure(request);
    } catch {
      return { status: 'failed', reason: 'provider-error' };
    }
    if (!isRecord(raw)) {
      return { status: 'failed', reason: 'malformed-response' };
    }
    if (raw.abstain === true) {
      return { status: 'abstained', reason: 'abstained' };
    }
    const candidate = validateReflectionAiCandidate(raw, { graph: ports.graph });
    if (!candidate) {
      // Distinguish unknown-entity from malformed for test clarity: any
      // string entityIds that fail graph membership count as invalid-entity.
      const ids = (raw as Record<string, unknown>).entityIds;
      if (
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.some((e: unknown) => typeof e === 'string' && !ports.graph.hasEntity(e))
      ) {
        return { status: 'failed', reason: 'invalid-entity' };
      }
      return { status: 'failed', reason: 'malformed-response' };
    }
    return { status: 'proposed', candidate };
  } catch {
    return { status: 'failed', reason: 'provider-error' };
  }
}
