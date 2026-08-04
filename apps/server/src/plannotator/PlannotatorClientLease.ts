/**
 * T3-CUSTOM(expbkt3): In-memory browser ownership for durable Plannotator
 * reviews. Durable review data stays outside this registry; losing every lease
 * only makes the review process eligible for suspension.
 */
export const PLANNOTATOR_CLIENT_LEASE_MS = 120_000;
export const PLANNOTATOR_CLIENT_REAPER_MS = 30_000;
export const LEGACY_PLANNOTATOR_CLIENT_ID = "legacy";

interface LeaseEntry {
  acquisitionExpiresAt: number | null;
  readonly clients: Map<string, number>;
  unownedReported: boolean;
}

export class PlannotatorClientLease {
  readonly #entries = new Map<string, LeaseEntry>();

  registerReview(token: string, now: number): void {
    const entry = this.#entries.get(token) ?? {
      acquisitionExpiresAt: null,
      clients: new Map<string, number>(),
      unownedReported: false,
    };
    entry.acquisitionExpiresAt = now + PLANNOTATOR_CLIENT_LEASE_MS;
    entry.unownedReported = false;
    this.#entries.set(token, entry);
  }

  renew(token: string, clientId: string | null, now: number): void {
    const entry = this.#entries.get(token) ?? {
      acquisitionExpiresAt: null,
      clients: new Map<string, number>(),
      unownedReported: false,
    };
    entry.clients.set(clientId ?? LEGACY_PLANNOTATOR_CLIENT_ID, now + PLANNOTATOR_CLIENT_LEASE_MS);
    entry.acquisitionExpiresAt = null;
    entry.unownedReported = false;
    this.#entries.set(token, entry);
  }

  release(token: string, clientId: string, now: number): boolean {
    const entry = this.#entries.get(token);
    if (!entry || !entry.clients.delete(clientId)) return false;
    this.#prune(entry, now);
    if (this.#isEntryOwned(entry, now) || entry.unownedReported) return false;
    entry.unownedReported = true;
    return true;
  }

  collectExpired(now: number): ReadonlyArray<string> {
    const expired: string[] = [];
    for (const [token, entry] of this.#entries) {
      this.#prune(entry, now);
      if (this.#isEntryOwned(entry, now) || entry.unownedReported) continue;
      entry.unownedReported = true;
      expired.push(token);
    }
    return expired;
  }

  isOwned(token: string, now: number): boolean {
    const entry = this.#entries.get(token);
    if (!entry) return false;
    this.#prune(entry, now);
    return this.#isEntryOwned(entry, now);
  }

  removeReview(token: string): void {
    this.#entries.delete(token);
  }

  retryUnowned(token: string): void {
    const entry = this.#entries.get(token);
    if (entry) entry.unownedReported = false;
  }

  trackUnowned(token: string): void {
    this.#entries.set(token, {
      acquisitionExpiresAt: null,
      clients: new Map<string, number>(),
      unownedReported: false,
    });
  }

  clear(): void {
    this.#entries.clear();
  }

  clientIds(token: string): ReadonlyArray<string> {
    return [...(this.#entries.get(token)?.clients.keys() ?? [])];
  }

  #prune(entry: LeaseEntry, now: number): void {
    if (entry.acquisitionExpiresAt !== null && entry.acquisitionExpiresAt <= now) {
      entry.acquisitionExpiresAt = null;
    }
    for (const [clientId, expiresAt] of entry.clients) {
      if (expiresAt <= now) entry.clients.delete(clientId);
    }
  }

  #isEntryOwned(entry: LeaseEntry, now: number): boolean {
    if (entry.acquisitionExpiresAt !== null && entry.acquisitionExpiresAt > now) return true;
    for (const expiresAt of entry.clients.values()) {
      if (expiresAt > now) return true;
    }
    return false;
  }
}
