/**
 * T3-CUSTOM(expbkt3): Focused coverage for the token-scoped review HTTP boundary.
 */
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  __testing,
  parsePlannotatorClientIdHeader,
  PLANNOTATOR_CLIENT_ID_HEADER,
  PLANNOTATOR_IFRAME_CORS_HEADERS,
  PLANNOTATOR_STATUS_PATH,
  plannotatorStatusPayload,
} from "./http.ts";

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
        let upstreamBody = "";
        yield* HttpRouter.serve(
          HttpRouter.add(
            "POST",
            "/upstream",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              upstreamBody = new TextDecoder().decode(new Uint8Array(yield* request.arrayBuffer));
              return HttpServerResponse.text(upstreamBody);
            }),
          ),
          {
            disableListenLog: true,
            disableLogger: true,
          },
        ).pipe(Layer.build);

        const payload = '{"prompt":"streamed Plannotator request"}';
        const encoded = new TextEncoder().encode(payload);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.subarray(0, 12));
            controller.enqueue(encoded.subarray(12));
            controller.close();
          },
        });
        const incoming = new Request("http://127.0.0.1/plannotator/test/api/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit);
        const outgoing = yield* __testing.makeForwardedRequest(incoming, {
          url: "/upstream",
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(outgoing);

        expect(response.status).toBe(200);
        expect(response.status).not.toBe(502);
        expect(yield* response.text).toBe(payload);
        expect(upstreamBody).toBe(payload);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
