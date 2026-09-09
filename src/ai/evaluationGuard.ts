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

/**
 * Check-in panel status values mirrored from the host panel model
 * (duplicated as a plain union so this module stays vscode-free).
 */
export type CheckinPanelStatus = 'idle' | 'evaluating' | 'unavailable' | 'error';

/** How one async evaluation completion resolves, for panel-status purposes. */
export type CheckinCompletionKind = 'evaluated-displayed' | 'evaluated-silent' | 'failed';

/**
 * Recency gate for check-in panel STATUS (message content already has the
 * runner's `displayed` guard). Only the currently visible attempt may move
 * the status: a slow completion landing after the learner moved on — or
 * after a newer completion already updated the panel — must not resurrect
 * or plant a banner for another context. Every completion stays in logs
 * and persisted history regardless; this affects panel display only.
 */
export function nextCheckinStatus(
  current: CheckinPanelStatus,
  completion: CheckinCompletionKind,
  completionVisible: boolean,
): CheckinPanelStatus {
  if (!completionVisible) {
    return current;
  }
  if (completion === 'failed') {
    return 'error';
  }
  return 'idle';
}

/**
 * Attempt-boundary scope for transient check-in status: starting or ending
 * a problem retires a leftover `evaluating`/`error` state so it cannot
 * leak into the next (or empty) attempt context. Steady states (`idle`,
 * `unavailable`) pass through untouched.
 */
export function resetCheckinStatusOnAttemptBoundary(current: CheckinPanelStatus): CheckinPanelStatus {
  if (current === 'evaluating' || current === 'error') {
    return 'idle';
  }
  return current;
}
