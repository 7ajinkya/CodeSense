import { AIConversationMessage, AIEvaluation } from './aiTypes';

/**
 * Phase A idle-suppression state (pure, no vscode dependency), Phase B rule.
 *
 * A conversation counts as "awaiting learner response" only when the latest
 * message is a CodeSense intervention whose own evaluation explicitly sets
 * requiresLearnerResponse. The flag is deliberately SEPARATE from
 * interventionType: a HINT may ask a real question the learner should
 * answer, while an EXPLANATION may expect nothing back. This fixes the
 * Phase-A edge case where a question labeled HINT could not suppress.
 *
 * Latest-message-wins: a learner reply afterwards clears the condition by
 * construction. Evaluations predating the flag (or unlinkable messages)
 * count as NOT awaiting, so suppression fails open toward evaluating.
 *
 * Uses only existing conversation/evaluation state — no new store, no
 * conversation state machine. The 45-minute hard boundary never consults
 * this helper (see extension.ts checkTriggers).
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
  return evaluation?.requiresLearnerResponse === true;
}
