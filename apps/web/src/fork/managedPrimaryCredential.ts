/**
 * T3-CUSTOM(expbkt3): the bearer credential for a managed primary environment.
 *
 * An unmanaged desktop authenticates its primary environment with a token the
 * Electron main process hands over (`desktopBridge.getLocalEnvironmentBearerToken`),
 * because the primary environment *is* the bundled local backend. A managed BK
 * build points primary at the central server instead, where that token means
 * nothing, so the operator pairs once with a pairing credential and the
 * resulting access token is kept here.
 *
 * The token is bound to the base URL it was issued for, so a build switched
 * between channels — or a stale token left by an older build — is discarded
 * rather than presented to the wrong server.
 *
 * Persisted in `localStorage` so a restart does not force re-pairing, with an
 * in-memory mirror so the module also works where storage is unavailable
 * (private modes, tests). Both are best-effort: losing the token costs one
 * re-pair, never correctness.
 *
 * @module fork/managedPrimaryCredential
 */
import { readBkManagedEnvironment } from "./managedEnvironment";

const STORAGE_KEY = "expbkt3:managed-primary-credential";

/** Presented tokens are dropped this long before expiry, to avoid a race with the server. */
const EXPIRY_SKEW_MS = 30_000;

interface StoredManagedPrimaryCredential {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
}

let cachedCredential: StoredManagedPrimaryCredential | null = null;
let hydrated = false;

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function parseStoredManagedPrimaryCredential(
  raw: string | null,
): StoredManagedPrimaryCredential | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<StoredManagedPrimaryCredential>;
  if (
    typeof candidate.httpBaseUrl !== "string" ||
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    typeof candidate.expiresAtEpochMs !== "number" ||
    !Number.isFinite(candidate.expiresAtEpochMs)
  ) {
    return null;
  }
  return {
    httpBaseUrl: candidate.httpBaseUrl,
    accessToken: candidate.accessToken,
    expiresAtEpochMs: candidate.expiresAtEpochMs,
  };
}

/** Whether a stored credential may still be presented to the managed server. */
export function isManagedPrimaryCredentialUsable(
  credential: StoredManagedPrimaryCredential | null,
  managedHttpBaseUrl: string | null,
  nowEpochMs: number,
): boolean {
  if (credential === null || managedHttpBaseUrl === null) {
    return false;
  }
  return (
    credential.httpBaseUrl === managedHttpBaseUrl &&
    nowEpochMs < credential.expiresAtEpochMs - EXPIRY_SKEW_MS
  );
}

function hydrate(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  const storage = readStorage();
  if (storage === null) {
    return;
  }
  try {
    cachedCredential = parseStoredManagedPrimaryCredential(storage.getItem(STORAGE_KEY));
  } catch {
    cachedCredential = null;
  }
}

/** The access token to present to the managed primary environment, or null. */
export function readManagedPrimaryAccessToken(): string | null {
  hydrate();
  const managed = readBkManagedEnvironment();
  if (
    !isManagedPrimaryCredentialUsable(cachedCredential, managed?.httpBaseUrl ?? null, Date.now())
  ) {
    return null;
  }
  return cachedCredential?.accessToken ?? null;
}

/** Records the token a pairing exchange produced. */
export function writeManagedPrimaryAccessToken(input: {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}): void {
  hydrated = true;
  const managed = readBkManagedEnvironment();
  if (managed === null) {
    return;
  }
  const credential: StoredManagedPrimaryCredential = {
    httpBaseUrl: managed.httpBaseUrl,
    accessToken: input.accessToken,
    expiresAtEpochMs: Date.now() + Math.max(0, input.expiresInSeconds) * 1_000,
  };
  cachedCredential = credential;
  try {
    readStorage()?.setItem(STORAGE_KEY, JSON.stringify(credential));
  } catch {
    // Storage is best effort; the in-memory mirror carries this session.
  }
}

/** Forgets the token, sending the app back to the pairing gate. */
export function clearManagedPrimaryAccessToken(): void {
  hydrated = true;
  cachedCredential = null;
  try {
    readStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the in-memory mirror is already cleared.
  }
}

export function __resetManagedPrimaryCredentialForTests(): void {
  cachedCredential = null;
  hydrated = false;
}
