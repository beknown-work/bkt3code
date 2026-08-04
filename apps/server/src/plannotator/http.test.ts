/**
 * T3-CUSTOM(expbkt3): Focused coverage for the token-scoped review status API.
 */
import { describe, expect, it } from "vite-plus/test";

import {
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
