/**
 * Phase A duplicate-submit protection (pure, no vscode dependency).
 *
 * Thin, testable protocol over the host-owned in-flight set: back-to-back
 * learner replies persist every message but start exactly one conversational
 * evaluation. The host still owns the set; these helpers only make the
 * reserve/release transitions explicit and unit-testable.
 */
export function tryReserveEvaluation(inFlight: Set<string>, attemptId: string): boolean {
  if (inFlight.has(attemptId)) {
    return false;
  }
  inFlight.add(attemptId);
  return true;
}

export function releaseEvaluation(inFlight: Set<string>, attemptId: string): void {
  inFlight.delete(attemptId);
}
