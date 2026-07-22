/**
 * Deadlines for awaits that can hang forever.
 *
 * A `try/catch` around an `await` catches throws — it cannot catch a promise that never
 * settles. The background runner is a single sequential loop, so one unresolved promise
 * anywhere on its path stops the whole campaign engine silently: no error, no log line,
 * nothing but runs that report `running` while doing nothing. That is exactly how outreach
 * stalled for two days in production, wedged in an IMAP sync whose only exit was a callback
 * that never fired.
 *
 * Kept dependency-free so it can be unit tested without loading Playwright or SQLite.
 */

export class WatchdogTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${Math.round(timeoutMs / 1000)}s watchdog deadline`);
    this.name = "WatchdogTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Reject with a {@link WatchdogTimeoutError} if `promise` has not settled within `ms`.
 *
 * This bounds the CALLER's wait, not the underlying socket or browser call — the orphaned
 * work may still be pending in the background and may still complete later. Callers must
 * therefore be idempotent and safe to re-run. Every current caller is: each is a throttled
 * sync or a step execution that re-runs on the next poll.
 *
 * Rejections from `promise` itself pass through unchanged, so a timeout is distinguishable
 * from a genuine failure via `instanceof WatchdogTimeoutError`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WatchdogTimeoutError(label, ms)), ms);
    // Never hold the event loop open on the watchdog alone — a pending timer would keep the
    // process alive past shutdown. Node-only API, guarded for non-Node runtimes.
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run `fn` under a deadline, swallowing BOTH timeouts and errors after reporting them.
 *
 * For the runner's periodic side-work (inbox syncs, connection reconciliation): one bad
 * mailbox or a hung browser must degrade that one subsystem, never halt the loop. Returns
 * true when the work completed, false when it timed out or threw.
 */
export async function guard(
  label: string,
  ms: number,
  fn: () => Promise<unknown>,
  onFailure?: (err: Error) => void,
): Promise<boolean> {
  try {
    await withTimeout(fn(), ms, label);
    return true;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error instanceof WatchdogTimeoutError) {
      console.error(`[watchdog] ${error.message} — abandoning this pass, will retry`);
    } else {
      console.error(`[watchdog] ${label} failed:`, error.message);
    }
    onFailure?.(error);
    return false;
  }
}
