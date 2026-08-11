/**
 * T3-CUSTOM(expbkt3): Cross-tab alert suppression.
 *
 * Three open tabs observe the same thread stream and would each play the same
 * tone. Rather than elect a leader — which has to survive tab close, sleep, and
 * clock skew — each tab claims an alert in shared storage before playing it.
 * The claim is a compare-and-set on a timestamp, so the loser simply skips.
 *
 * localStorage writes are synchronous and same-origin serialized, which is what
 * makes the read-then-write cheap enough to be effectively atomic here. The
 * failure mode if two tabs still race is one duplicate tone, never a missed one.
 */

const CLAIM_KEY_PREFIX = "t3code:notification-claim:";
/** Long enough to cover a re-render storm, short enough not to swallow a repeat. */
export const ALERT_CLAIM_TTL_MS = 4_000;

export function claimStorageKey(dedupeKey: string): string {
  return `${CLAIM_KEY_PREFIX}${dedupeKey}`;
}

/** Pure decision so the TTL rule is testable without a DOM. */
export function claimIsStale(rawValue: string | null, now: number): boolean {
  if (rawValue === null) return true;
  const claimedAt = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(claimedAt)) return true;
  // A claim timestamped in the future means another tab's clock jumped; treat it
  // as valid rather than stampeding.
  if (claimedAt > now) return false;
  return now - claimedAt >= ALERT_CLAIM_TTL_MS;
}

/**
 * True when this tab won the right to present `dedupeKey`. Storage failures
 * (private mode, quota, disabled) resolve to true: a duplicate tone is a much
 * better outcome than silence.
 */
export function claimAlert(dedupeKey: string, now: number): boolean {
  if (typeof window === "undefined") return true;
  try {
    const key = claimStorageKey(dedupeKey);
    if (!claimIsStale(window.localStorage.getItem(key), now)) return false;
    window.localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

/** Drops expired claim keys so localStorage does not grow without bound. */
export function pruneAlertClaims(now: number): void {
  if (typeof window === "undefined") return;
  try {
    const expired: Array<string> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null || !key.startsWith(CLAIM_KEY_PREFIX)) continue;
      if (claimIsStale(window.localStorage.getItem(key), now)) expired.push(key);
    }
    for (const key of expired) window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
