/**
 * T3-CUSTOM(expbkt3): the central server a managed BK build orchestrates.
 *
 * A managed BK desktop build points its *primary environment* at a central
 * Beknown T3 server (bkt3 or expbkt3) instead of the backend Electron bundles.
 * That is what makes the desktop useful to the team: projects, sessions, the
 * member directory and thread tagging all live on the central server, and the
 * member picker (`state/orgMembers`) reads them through the primary HTTP
 * client.
 *
 * Two axes are easy to confuse and are deliberately kept apart here:
 *
 * - **`PRIMARY_LOCAL_ENVIRONMENT_ID`** (`"primary"`) is the *id of the
 *   desktop's bundled local backend*, assigned by the Electron main process. It
 *   is unchanged by this module and must stay that way.
 * - **The primary target** is *where the primary environment points*. That is
 *   what a managed build redirects.
 *
 * The bundled local backend keeps running and stays reachable as its own
 * environment; see the seam in `connection/desktopLocal.ts`.
 *
 * The value is baked in at build time by `apps/web/vite.config.ts` from
 * `scripts/lib/bk-managed-environment.ts`. It is `null` in every ordinary
 * build, and the constant is absent entirely under vitest — both mean
 * "unmanaged", so upstream behaviour is untouched.
 *
 * @module fork/managedEnvironment
 */
import type { PrimaryEnvironmentTarget } from "../environments/primary/target";

declare const __T3CODE_BK_MANAGED_ENVIRONMENT__: unknown;

export type BkManagedChannel = "staging" | "production";

export interface BkManagedEnvironment {
  readonly channel: BkManagedChannel;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * Validates the baked constant. Anything that is not a complete, well-formed
 * managed environment reads as "unmanaged" rather than throwing: a renderer
 * that refuses to boot is a worse failure than one that falls back to the local
 * backend, and the build script already rejects a bad channel at build time.
 */
export function parseBkManagedEnvironment(raw: unknown): BkManagedEnvironment | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Partial<BkManagedEnvironment>;
  if (candidate.channel !== "staging" && candidate.channel !== "production") {
    return null;
  }
  if (typeof candidate.httpBaseUrl !== "string" || candidate.httpBaseUrl.length === 0) {
    return null;
  }
  if (typeof candidate.wsBaseUrl !== "string" || candidate.wsBaseUrl.length === 0) {
    return null;
  }
  return {
    channel: candidate.channel,
    httpBaseUrl: candidate.httpBaseUrl,
    wsBaseUrl: candidate.wsBaseUrl,
  };
}

let managedEnvironmentOverride: BkManagedEnvironment | null | undefined;

function readBakedManagedEnvironment(): BkManagedEnvironment | null {
  if (typeof __T3CODE_BK_MANAGED_ENVIRONMENT__ === "undefined") {
    return null;
  }
  return parseBkManagedEnvironment(__T3CODE_BK_MANAGED_ENVIRONMENT__);
}

/** The managed environment this build targets, or `null` for every other build. */
export function readBkManagedEnvironment(): BkManagedEnvironment | null {
  return managedEnvironmentOverride ?? readBakedManagedEnvironment();
}

/** Whether the primary environment is a managed central server. */
export function isBkManagedPrimary(): boolean {
  return readBkManagedEnvironment() !== null;
}

/**
 * The primary target for a managed build.
 *
 * Reported as `"configured"` rather than a new source: the target is fixed at
 * build time, which is exactly what that source means, and widening the
 * upstream `KnownEnvironmentSource` union for a label nothing branches on would
 * cost a merge conflict for no behaviour.
 */
export function readBkManagedPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  const managed = readBkManagedEnvironment();
  if (managed === null) {
    return null;
  }
  return {
    source: "configured",
    target: {
      httpBaseUrl: managed.httpBaseUrl,
      wsBaseUrl: managed.wsBaseUrl,
    },
  };
}

/**
 * Cache slot the connection platform keeps the *primary* registration under.
 *
 * Unmanaged, the primary registration and the bundled local backend are the
 * same thing, so upstream keys it by `PRIMARY_LOCAL_ENVIRONMENT_ID`. In a
 * managed build they are two different environments that both want that key —
 * the central server as primary, the bundled backend as a secondary registered
 * under its own bootstrap id — so the primary moves to a slot of its own.
 * Returns the upstream key unchanged for every other build.
 */
export function bkPrimaryRegistrationCacheKey(localEnvironmentId: string): string {
  return isBkManagedPrimary() ? "bk-managed-primary" : localEnvironmentId;
}

export function __setBkManagedEnvironmentForTests(value: BkManagedEnvironment | null): void {
  managedEnvironmentOverride = value ?? undefined;
}

export function __resetBkManagedEnvironmentForTests(): void {
  managedEnvironmentOverride = undefined;
}
