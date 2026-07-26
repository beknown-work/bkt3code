import { describe, expect, it } from "vite-plus/test";

import {
  plannotatorPlanMarker,
  plannotatorProxyPath,
  plannotatorProxyPathFromPlan,
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
