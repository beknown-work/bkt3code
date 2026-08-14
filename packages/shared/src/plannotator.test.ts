import { describe, expect, it } from "vite-plus/test";

import {
  plannotatorPlanMarker,
  plannotatorProxyPath,
  plannotatorProxyPathFromPlan,
  resolvePlannotatorReviewUrl,
  withoutPlannotatorPlanMarker,
  withPlannotatorPlanMarker,
} from "./plannotator.ts";

describe("Plannotator plan metadata", () => {
  it("round-trips an opaque proxy path through a hidden markdown marker", () => {
    const path = plannotatorProxyPath("token_123");
    const markdown = withPlannotatorPlanMarker("# Ship it\n\n- validate", path);

    expect(path).toBe("/plannotator/token_123/");
    expect(markdown).toContain(plannotatorPlanMarker(path));
    expect(plannotatorProxyPathFromPlan(markdown)).toBe(path);
  });

  it("replaces an existing marker instead of accumulating stale review URLs", () => {
    const original = withPlannotatorPlanMarker("# Plan", "/plannotator/old/");
    const updated = withPlannotatorPlanMarker(original, "/plannotator/new/");

    expect(updated).not.toContain("/plannotator/old/");
    expect(plannotatorProxyPathFromPlan(updated)).toBe("/plannotator/new/");
    expect(withoutPlannotatorPlanMarker(updated)).toBe("# Plan");
  });

  it("ignores arbitrary comments and unsafe paths", () => {
    expect(plannotatorProxyPathFromPlan("<!-- t3-plannotator:https://evil.test/ -->")).toBeNull();
    expect(plannotatorProxyPathFromPlan("<!-- ordinary comment -->")).toBeNull();
  });
});

describe("resolvePlannotatorReviewUrl", () => {
  it("resolves the review against the environment that owns it", () => {
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", "https://t3.beknown.work/")).toBe(
      "https://t3.beknown.work/plannotator/token_123/",
    );
    // A base URL with a path is still an origin-rooted proxy path.
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", "http://127.0.0.1:3773")).toBe(
      "http://127.0.0.1:3773/plannotator/token_123/",
    );
  });

  it("refuses to guess an origin when the environment is not connected", () => {
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", null)).toBeNull();
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", undefined)).toBeNull();
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", "")).toBeNull();
    expect(resolvePlannotatorReviewUrl("/plannotator/token_123/", "not a url")).toBeNull();
  });
});
