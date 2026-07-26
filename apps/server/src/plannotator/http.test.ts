/**
 * T3-CUSTOM(expbkt3): Focused coverage for the token-scoped review status API.
 */
import { describe, expect, it } from "vite-plus/test";

import { PLANNOTATOR_STATUS_PATH, plannotatorStatusPayload } from "./http.ts";

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
  });
});
