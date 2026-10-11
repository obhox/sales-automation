// Accounts whose proxy did not answer, and when each is tried again.
//
// Kept in memory on purpose. Losing it (a restart) costs one more attempt through the
// proxy, which is what a person would try anyway, and nothing reaches LinkedIn without
// the proxy either way.

/** How long an account waits before its proxy is tried again. */
export const PROXY_RETRY_MINUTES = 30;

const holds = new Map<string, number>();

export function holdForProxy(accountId: string, now: number = Date.now()): void {
  holds.set(accountId, now + PROXY_RETRY_MINUTES * 60_000);
}

/** When the account's proxy is tried again (ms), or null when it is not being held. */
export function proxyHeldUntil(accountId: string, now: number = Date.now()): number | null {
  const until = holds.get(accountId);
  if (until === undefined) return null;
  if (until <= now) {
    holds.delete(accountId);
    return null;
  }
  return until;
}

/** Stop holding an account (it signed in again), or every account when none is named. */
export function releaseProxyHold(accountId?: string): void {
  if (accountId === undefined) holds.clear();
  else holds.delete(accountId);
}
