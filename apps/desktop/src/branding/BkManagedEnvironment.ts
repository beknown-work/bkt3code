/**
 * Fork-owned runtime selection for client-only managed BK desktop builds.
 *
 * The build pipeline bakes the same managed-environment object into both the
 * renderer and Electron main bundles. The renderer uses it as its primary
 * connection target; Electron uses it to skip the bundled backend and serve
 * the packaged client assets directly.
 */

declare const __T3CODE_BK_MANAGED_ENVIRONMENT__: unknown;

export type BkManagedChannel = "staging" | "production";

export interface BkManagedEnvironment {
  readonly channel: BkManagedChannel;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface BkClientRendererSource {
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clientAssetsDirectory?: string;
}

export function resolveBkClientRendererSource(input: {
  readonly managedHttpBaseUrl: string;
  readonly isDevelopment: boolean;
  readonly devServerUrl: URL | null;
  readonly clientAssetsDirectory: string;
}): BkClientRendererSource {
  const backendOrigin = new URL(input.managedHttpBaseUrl);
  if (input.isDevelopment && input.devServerUrl !== null) {
    return { targetOrigin: input.devServerUrl, backendOrigin };
  }
  return {
    targetOrigin: backendOrigin,
    backendOrigin,
    clientAssetsDirectory: input.clientAssetsDirectory,
  };
}

export function parseBkManagedEnvironment(raw: unknown): BkManagedEnvironment | null {
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as Partial<BkManagedEnvironment>;
  if (candidate.channel !== "staging" && candidate.channel !== "production") return null;
  if (typeof candidate.httpBaseUrl !== "string" || candidate.httpBaseUrl.length === 0) return null;
  if (typeof candidate.wsBaseUrl !== "string" || candidate.wsBaseUrl.length === 0) return null;

  try {
    const httpUrl = new URL(candidate.httpBaseUrl);
    const wsUrl = new URL(candidate.wsBaseUrl);
    if (httpUrl.protocol !== "https:" || wsUrl.protocol !== "wss:") return null;
  } catch {
    return null;
  }

  return {
    channel: candidate.channel,
    httpBaseUrl: candidate.httpBaseUrl,
    wsBaseUrl: candidate.wsBaseUrl,
  };
}

export function readBkManagedEnvironment(): BkManagedEnvironment | null {
  if (typeof __T3CODE_BK_MANAGED_ENVIRONMENT__ === "undefined") return null;
  return parseBkManagedEnvironment(__T3CODE_BK_MANAGED_ENVIRONMENT__);
}
