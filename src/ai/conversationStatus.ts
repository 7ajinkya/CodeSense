import { AIConversationMessage, AIEvaluation } from './aiTypes';

/**
 * Phase A idle-suppression state (pure, no vscode dependency).
 *
 * A conversation counts as "awaiting learner response" only when the latest
 * message is a CodeSense intervention that genuinely expects the learner to
 * respond/engage. Today that is exactly `SOCRATIC_QUESTION`: a targeted
 * question is pointless to stack another idle evaluation on top of.
 * Informational interventions (ACKNOWLEDGE, HINT, EXPLANATION,
 * DEBUGGING_HELP, CONCEPT_REVIEW, SOLUTION_GUIDANCE) are consumable without
 * replying, so they never suppress. A learner reply is the newest message
 * afterwards, which clears the condition by construction.
 *
 * Uses only existing conversation/evaluation state — no new store, no
 * conversation state machine.
 */
export function isAwaitingLearnerResponse(
  conversation: AIConversationMessage[],
  evaluations: AIEvaluation[],
): boolean {
  if (conversation.length === 0) {
    return false;
  }
  const ordered = [...conversation].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const last = ordered[ordered.length - 1];
  if (!last || last.role !== 'coach') {
    return false;
  }
  if (!last.evaluationId) {
    return false;
  }
  const evaluation = evaluations.find((e) => e.evaluationId === last.evaluationId);
  return evaluation?.interventionType === 'SOCRATIC_QUESTION';
}
