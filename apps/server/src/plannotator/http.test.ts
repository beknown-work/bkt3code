/**
 * T3-CUSTOM(expbkt3): Focused coverage for the token-scoped review HTTP boundary.
 */
import { NodeHttpServer } from "@effect/platform-node";
import { OrchestrationProposedPlanId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import {
  parsePlannotatorClientIdHeader,
  PLANNOTATOR_CLIENT_ID_HEADER,
  PLANNOTATOR_IFRAME_CORS_HEADERS,
  PLANNOTATOR_STATUS_PATH,
  plannotatorProxyRouteLayer,
  plannotatorStatusPayload,
} from "./http.ts";
import { PlannotatorManager, type PlannotatorSession } from "./PlannotatorManager.ts";

const makeSession = (port: number): PlannotatorSession => ({
  id: "streamed-proxy-session",
  threadId: ThreadId.make("thread-streamed-proxy"),
  planId: OrchestrationProposedPlanId.make("plan-streamed-proxy"),
  format: "md",
  planPath: "/tmp/plan.md",
  logPath: "/tmp/plan.log",
  proxyPath: "/plannotator/streamed_proxy_token/",
  pid: 123,
  port,
  directUrl: null,
  status: "running",
  feedback: "",
  annotationHistory: [],
  error: null,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
});

describe("Plannotator HTTP status endpoint", () => {
  it("uses a proxy-relative path that cannot collide with Plannotator assets", () => {
    expect(PLANNOTATOR_STATUS_PATH).toBe("/__t3/status");
    expect(PLANNOTATOR_STATUS_PATH.startsWith("/__t3/")).toBe(true);
  });

  it("exposes only terminal review decisions", () => {
    expect(plannotatorStatusPayload("running")).toEqual({
      status: "running",
      decision: null,
    });
    expect(plannotatorStatusPayload("approved")).toEqual({
      status: "approved",
      decision: "approved",
    });
    expect(plannotatorStatusPayload("feedback")).toEqual({
      status: "feedback",
      decision: "feedback",
    });
    expect(plannotatorStatusPayload("denied")).toEqual({
      status: "denied",
      decision: "denied",
    });
    expect(plannotatorStatusPayload("exited")).toEqual({
      status: "exited",
      decision: null,
    });
    expect(plannotatorStatusPayload("error")).toEqual({
      status: "error",
      decision: null,
    });
  });

  it("accepts UUID browser leases while preserving the legacy GET client", () => {
    expect(parsePlannotatorClientIdHeader(undefined)).toEqual({
      kind: "legacy",
      clientId: null,
    });
    expect(parsePlannotatorClientIdHeader("11111111-1111-4111-8111-111111111111")).toEqual({
      kind: "client",
      clientId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects malformed or oversized browser lease IDs", () => {
    expect(parsePlannotatorClientIdHeader("not-a-uuid")).toEqual({ kind: "invalid" });
    expect(parsePlannotatorClientIdHeader("x".repeat(256))).toEqual({ kind: "invalid" });
  });

  it("allows the browser lease header at the iframe boundary", () => {
    expect(PLANNOTATOR_CLIENT_ID_HEADER).toBe("x-t3-plannotator-client-id");
    expect(PLANNOTATOR_IFRAME_CORS_HEADERS["access-control-allow-headers"]).toContain(
      PLANNOTATOR_CLIENT_ID_HEADER,
    );
  });
});

describe("Plannotator HTTP proxy", () => {
  it.effect("forwards a streamed POST body without surfacing the 502 fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const upstream = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<{
                readonly close: () => Promise<void>;
                readonly port: number;
                readonly received: Promise<string>;
              }>((resolve, reject) => {
                let receiveBody: ((body: string) => void) | undefined;
                const received = new Promise<string>((resolveBody) => {
                  receiveBody = resolveBody;
                });
                const server = NodeHttp.createServer((request, response) => {
                  const chunks: Buffer[] = [];
                  request.on("data", (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                  });
                  request.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8");
                    receiveBody?.(body);
                    receiveBody = undefined;
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify({ body }));
                  });
                });
                server.on("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (!address || typeof address === "string") {
                    reject(new Error("Expected local Plannotator upstream TCP address"));
                    return;
                  }
                  resolve({
                    port: address.port,
                    received,
                    close: () =>
                      new Promise<void>((resolveClose, rejectClose) => {
                        server.close((error) => {
                          if (error) {
                            rejectClose(error);
                            return;
                          }
                          resolveClose();
                        });
                      }),
                  });
                });
              }),
          ),
          (server) => Effect.promise(server.close),
        );
        const session = makeSession(upstream.port);
        const managerLayer = Layer.succeed(
          PlannotatorManager,
          PlannotatorManager.of({
            start: () => Effect.succeed(session),
            discard: () => Effect.void,
            getByToken: () => Effect.succeed(session),
            getById: () => Effect.succeed(session),
            list: () => Effect.succeed([session]),
            renewClientLease: () => Effect.void,
            releaseClientLease: () => Effect.void,
            reopen: () => Effect.succeed(session),
            applyDecision: () => Effect.succeed(session),
          }),
        );
        yield* HttpRouter.serve(plannotatorProxyRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.provide(Layer.merge(managerLayer, FetchHttpClient.layer)), Layer.build);

        const proxy = yield* HttpServer.HttpServer;
        const proxyAddress = proxy.address;
        if (typeof proxyAddress === "string" || !("port" in proxyAddress)) {
          return yield* Effect.die(new Error("Expected local Plannotator proxy TCP address"));
        }
        const payload = JSON.stringify({ prompt: "streamed Plannotator request" });
        const encoded = new TextEncoder().encode(payload);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.subarray(0, 12));
            controller.enqueue(encoded.subarray(12));
            controller.close();
          },
        });
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${proxyAddress.port}/plannotator/streamed_proxy_token/api/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            duplex: "half",
          } as RequestInit),
        );

        expect(response.status).toBe(200);
        expect(response.status).not.toBe(502);
        expect(yield* Effect.promise(() => response.json())).toEqual({ body: payload });
        expect(yield* Effect.promise(() => upstream.received)).toBe(payload);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
