/**
 * T3-CUSTOM(expbkt3): Narrow HTTP proxy boundary for dedicated Plannotator
 * review sessions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
  HttpRouter,
} from "effect/unstable/http";

import { PlannotatorManager, type PlannotatorSessionStatus } from "./PlannotatorManager.ts";
import { parsePlannotatorDecision, rewritePlannotatorHtml } from "./model.ts";

const PLANNOTATOR_PROXY_PATH = /^\/plannotator\/([A-Za-z0-9_-]+)(\/.*)?$/;
export const PLANNOTATOR_STATUS_PATH = "/__t3/status";

export function plannotatorStatusPayload(status: PlannotatorSessionStatus) {
  return {
    status,
    decision: status === "approved" || status === "feedback" || status === "denied" ? status : null,
  } as const;
}
const PLANNOTATOR_IFRAME_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;
const REQUEST_HEADERS_NOT_FORWARDED = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const;
const RESPONSE_HEADERS_NOT_FORWARDED = new Set([
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "connection",
  "content-length",
  "content-security-policy",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
]);

function proxyResponseHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  proxyPrefix: string,
): Record<string, string> {
  const output: Record<string, string> = {
    ...PLANNOTATOR_IFRAME_CORS_HEADERS,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || RESPONSE_HEADERS_NOT_FORWARDED.has(key.toLowerCase())) {
      continue;
    }
    if (key.toLowerCase() === "cache-control" || key.toLowerCase() === "referrer-policy") {
      continue;
    }
    output[key] = key === "location" && value.startsWith("/") ? `${proxyPrefix}${value}` : value;
  }
  return output;
}

export const plannotatorProxyRouteLayer = HttpRouter.add(
  "*",
  "/plannotator/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parsedUrl = HttpServerRequest.toURL(request);
    if (Option.isNone(parsedUrl)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const match = parsedUrl.value.pathname.match(PLANNOTATOR_PROXY_PATH);
    const token = match?.[1];
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const manager = yield* PlannotatorManager;
    const session = yield* manager.getByToken(token);
    if (!session) {
      return HttpServerResponse.text("Plannotator review not found.", { status: 404 });
    }
    const proxyPath = match?.[2] || "/";
    // T3-CUSTOM(expbkt3): The parent T3 surface cannot inspect the sandboxed
    // iframe. This token-scoped status response lets it close completed reviews
    // and synchronize Build mode after approval.
    if (request.method === "GET" && proxyPath === PLANNOTATOR_STATUS_PATH) {
      return HttpServerResponse.jsonUnsafe(plannotatorStatusPayload(session.status), {
        status: 200,
        headers: {
          ...PLANNOTATOR_IFRAME_CORS_HEADERS,
          "cache-control": "no-store",
        },
      });
    }
    if (session.port === null) {
      return HttpServerResponse.text("Plannotator review is still starting.", { status: 425 });
    }
    const proxyPrefix = `/plannotator/${token}`;

    if (request.method === "OPTIONS") {
      return HttpServerResponse.empty({
        status: 204,
        headers: PLANNOTATOR_IFRAME_CORS_HEADERS,
      });
    }

    if (request.method !== "GET") {
      const body = new Uint8Array(yield* request.arrayBuffer);
      const decision = parsePlannotatorDecision(proxyPath, body);
      if (decision) {
        return yield* manager.applyDecision(token, decision).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { ok: true, captured: true, decision: decision.kind },
              {
                status: 202,
                headers: {
                  ...PLANNOTATOR_IFRAME_CORS_HEADERS,
                  "cache-control": "no-store",
                },
              },
            ),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to apply Plannotator decision", {
              cause,
              plannotatorSessionId: session.id,
              threadId: session.threadId,
            }).pipe(
              Effect.as(
                HttpServerResponse.jsonUnsafe(
                  { error: "plannotator_decision_failed", message: cause.message },
                  {
                    status: 502,
                    headers: {
                      ...PLANNOTATOR_IFRAME_CORS_HEADERS,
                      "cache-control": "no-store",
                    },
                  },
                ),
              ),
            ),
          ),
        );
      }
    }

    const incoming = yield* HttpServerRequest.toWeb(request);
    const targetOrigin = `http://127.0.0.1:${session.port}`;
    const targetUrl = `${targetOrigin}${proxyPath}${parsedUrl.value.search}`;
    const withTarget = HttpClientRequest.fromWeb(incoming).pipe(
      HttpClientRequest.setUrl(targetUrl),
    );
    const outgoing = HttpClientRequest.makeWith(
      withTarget.method,
      withTarget.url,
      withTarget.urlParams,
      withTarget.hash,
      Headers.removeMany(withTarget.headers, REQUEST_HEADERS_NOT_FORWARDED),
      withTarget.body,
    ).pipe(
      HttpClientRequest.setHeader("host", `127.0.0.1:${session.port}`),
      HttpClientRequest.setHeader("origin", targetOrigin),
    );
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.execute(outgoing).pipe(
      Effect.flatMap((response) => {
        const contentType = response.headers["content-type"] ?? "";
        if (contentType.includes("text/html")) {
          return response.text.pipe(
            Effect.map((html) =>
              HttpServerResponse.text(rewritePlannotatorHtml(html, proxyPrefix), {
                status: response.status,
                contentType,
                headers: proxyResponseHeaders(response.headers, proxyPrefix),
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpServerResponse.stream(response.stream, {
            status: response.status,
            headers: proxyResponseHeaders(response.headers, proxyPrefix),
          }),
        );
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Plannotator proxy request failed", {
          cause,
          plannotatorSessionId: session.id,
          targetUrl,
        }).pipe(Effect.as(HttpServerResponse.text("Plannotator is unavailable.", { status: 502 }))),
      ),
    );
  }),
);
