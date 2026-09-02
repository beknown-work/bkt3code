import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase, threadSyncLabel } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  // T3-CUSTOM(expbkt3): BEGIN — an unreachable host is a settled state.
  it("reports a cached copy rather than a sync that cannot happen", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hostReachable: false,
      }),
    ).toBe("offline");
  });

  it("does not promise a load from a host that cannot answer", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        hostReachable: false,
      }),
    ).toBe("offline");
  });

  it("keeps the live phases when the host is reachable", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hostReachable: true,
      }),
    ).toBe("syncing");
  });
  // T3-CUSTOM(expbkt3): END

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
    // T3-CUSTOM(expbkt3): names what is on screen, not a promise about the network.
    expect(threadSyncLabel("offline")).toBe("Cached copy — host offline");
  });
});
