/**
 * Minimal serial task queue (no dependencies, no vscode).
 *
 * Chains background tasks so that check-then-act sequences spanning awaits
 * (list state, decide purely, persist) cannot interleave with each other.
 * Each enqueued task runs only after all previously enqueued tasks settle;
 * a rejecting task reports to its own caller without breaking the tail.
 */
export interface AsyncQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createAsyncQueue(): AsyncQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
