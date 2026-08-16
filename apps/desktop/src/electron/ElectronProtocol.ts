import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): client-only builds read packaged assets from disk.
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
// T3-CUSTOM(expbkt3): used to resolve packaged client asset paths.
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clerkFrontendApiHostname: string | undefined;
  // T3-CUSTOM(expbkt3): managed BK builds contain only the web client. When
  // present, serve those packaged files instead of proxying a spawned server.
  readonly clientAssetsDirectory?: string;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  // T3-CUSTOM(expbkt3): a Plannotator review is served by the environment that
  // owns the thread, not by this renderer's origin, so the review iframe is
  // cross-origin. Those environment origins are unknown here for the same
  // reason as connect-src, so allow the network schemes rather than hosts. The
  // frame itself stays sandboxed without `allow-same-origin`, so it runs in an
  // opaque origin and cannot reach renderer state.
  const frameSources = ["'self'", "http:", "https:", "https://challenges.cloudflare.com"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    // T3-CUSTOM(expbkt3): the fork's preview surface embeds managed-environment
    // frames, so frame-src is composed rather than fixed.
    `frame-src ${frameSources.join(" ")}`,
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

// T3-CUSTOM(expbkt3): BEGIN - serve a packaged client without a local backend.
const CLIENT_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function resolveClientAssetPath(
  path: Path.Path,
  clientAssetsDirectory: string,
  encodedPathname: string,
): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(encodedPathname);
  } catch {
    return null;
  }

  const root = path.resolve(clientAssetsDirectory);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

const isFile = Effect.fn("desktop.electron.protocol.isFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(path).pipe(Effect.orElseSucceed(() => null));
  return info?.type === "File";
});

const clientAssetResponse = Effect.fn("desktop.electron.protocol.clientAssetResponse")(function* (
  request: Request,
  clientAssetsDirectory: string,
  contentSecurityPolicy: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }

  const requestedPath = resolveClientAssetPath(path, clientAssetsDirectory, requestUrl.pathname);
  if (requestedPath === null) return new Response(null, { status: 404 });

  const assetPath = (yield* isFile(requestedPath))
    ? requestedPath
    : path.extname(requestedPath).length === 0
      ? path.join(path.resolve(clientAssetsDirectory), "index.html")
      : null;
  if (assetPath === null || !(yield* isFile(assetPath))) {
    return new Response(null, { status: 404 });
  }

  const headers = new Headers({
    "content-type":
      CLIENT_ASSET_CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ??
      "application/octet-stream",
  });
  const response = new Response(
    request.method === "HEAD" ? null : new Uint8Array(yield* fileSystem.readFile(assetPath)),
    { status: 200, headers },
  );
  return withContentSecurityPolicy(response, contentSecurityPolicy);
});
// T3-CUSTOM(expbkt3): END

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  // T3-CUSTOM(expbkt3): platform services for reading packaged client assets.
  const platformContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              // T3-CUSTOM(expbkt3): managed builds serve their packaged client
              // directly and never need a server process just to render a window.
              input.clientAssetsDirectory
                ? Effect.runPromiseWith(platformContext)(
                    clientAssetResponse(
                      request,
                      input.clientAssetsDirectory,
                      contentSecurityPolicy,
                    ),
                  )
                : proxyRequest(request, input.targetOrigin, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
