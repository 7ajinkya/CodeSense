import { AIConversationMessage, AIEvaluation } from './aiTypes';
import { isRecord, loadJsonArray, saveJsonArray } from '../persistence/storeFiles';

const EVALUATIONS_FILE = 'evaluations.json';
const CONVERSATION_FILE = 'conversation.json';

/** Cap stored conversation per attempt; prompts take a smaller tail anyway. */
export const MAX_STORED_MESSAGES_PER_ATTEMPT = 200;

/**
 * Local-first AI persistence. Evaluations and conversation are learner data
 * scoped to attempts — stored beside the other `.codesense` files, never
 * uploaded anywhere.
 */
export interface AiStore {
  saveEvaluation(evaluation: AIEvaluation): Promise<void>;
  listEvaluationsForAttempt(attemptId: string): Promise<AIEvaluation[]>;
  appendConversation(message: AIConversationMessage): Promise<void>;
  listConversation(attemptId: string): Promise<AIConversationMessage[]>;
}

function parseEvaluation(raw: unknown): AIEvaluation | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.evaluationId !== 'string' ||
    typeof raw.attemptId !== 'string' ||
    typeof raw.timestamp !== 'string' ||
    typeof raw.triggerKind !== 'string' ||
    typeof raw.shouldIntervene !== 'boolean' ||
    typeof raw.interventionType !== 'string' ||
    typeof raw.urgency !== 'string' ||
    typeof raw.message !== 'string'
  ) {
    return null;
  }
  if (!isRecord(raw.reasoningSignals)) {
    return null;
  }
  return raw as unknown as AIEvaluation;
}

function parseConversationMessage(raw: unknown): AIConversationMessage | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.messageId !== 'string' ||
    typeof raw.attemptId !== 'string' ||
    typeof raw.timestamp !== 'string' ||
    typeof raw.text !== 'string' ||
    (raw.role !== 'coach' && raw.role !== 'learner')
  ) {
    return null;
  }
  const message: AIConversationMessage = {
    messageId: raw.messageId,
    attemptId: raw.attemptId,
    timestamp: raw.timestamp,
    role: raw.role,
    text: raw.text,
  };
  if (typeof raw.evaluationId === 'string') {
    message.evaluationId = raw.evaluationId;
  }
  return message;
}

export class LocalAiStore implements AiStore {
  constructor(private readonly workspacePath?: string) {}

  async saveEvaluation(evaluation: AIEvaluation): Promise<void> {
    const rest = loadJsonArray<unknown>(EVALUATIONS_FILE, this.workspacePath)
      .map(parseEvaluation)
      .filter((e): e is AIEvaluation => e !== null)
      .filter((e) => e.evaluationId !== evaluation.evaluationId);
    rest.push(evaluation);
    saveJsonArray(EVALUATIONS_FILE, rest, this.workspacePath);
  }

  async listEvaluationsForAttempt(attemptId: string): Promise<AIEvaluation[]> {
    return loadJsonArray<unknown>(EVALUATIONS_FILE, this.workspacePath)
      .map(parseEvaluation)
      .filter((e): e is AIEvaluation => e !== null)
      .filter((e) => e.attemptId === attemptId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async appendConversation(message: AIConversationMessage): Promise<void> {
    const all = loadJsonArray<unknown>(CONVERSATION_FILE, this.workspacePath)
      .map(parseConversationMessage)
      .filter((m): m is AIConversationMessage => m !== null);
    const others = all.filter((m) => m.attemptId !== message.attemptId);
    const mine = [...all.filter((m) => m.attemptId === message.attemptId), message].slice(
      -MAX_STORED_MESSAGES_PER_ATTEMPT,
    );
    saveJsonArray(CONVERSATION_FILE, [...others, ...mine], this.workspacePath);
  }

  async listConversation(attemptId: string): Promise<AIConversationMessage[]> {
    return loadJsonArray<unknown>(CONVERSATION_FILE, this.workspacePath)
      .map(parseConversationMessage)
      .filter((m): m is AIConversationMessage => m !== null)
      .filter((m) => m.attemptId === attemptId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
