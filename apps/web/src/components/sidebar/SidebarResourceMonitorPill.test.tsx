import type { ServerResourceSample } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { memoryPresentation, memoryTone } from "./SidebarResourceMonitorPill.tsx";

const gib = 1024 ** 3;

function makeSample(cgroup: ServerResourceSample["cgroup"]): ServerResourceSample {
  return {
    version: 1,
    sampledAt: DateTime.makeUnsafe("2026-08-04T00:00:00.000Z"),
    process: {
      rssBytes: 3.5 * gib,
      heapUsedBytes: 1.2 * gib,
      heapTotalBytes: 2 * gib,
      externalBytes: 512 * 1024 ** 2,
      cpuPercent: 25,
    },
    system: {
      totalMemoryBytes: 30 * gib,
      freeMemoryBytes: 10 * gib,
      loadAverage1m: 1,
      loadAverage5m: 2,
      loadAverage15m: 3,
      cpuCount: 16,
    },
    cgroup,
    disk: null,
  };
}

describe("sidebar server memory presentation", () => {
  it("renders Node and whole-service memory as separate concepts", () => {
    const presentation = memoryPresentation(
      makeSample({
        memoryCurrentBytes: 12 * gib,
        memoryHighBytes: 16 * gib,
        memoryMaxBytes: 16 * gib,
        memoryPeakBytes: 14 * gib,
        memoryWorkingSetBytes: 8.2 * gib,
        memoryAnonBytes: 5 * gib,
        memoryFileBytes: 6 * gib,
        memoryInactiveFileBytes: 3.8 * gib,
        memorySlabReclaimableBytes: 200 * 1024 ** 2,
        memorySwapCurrentBytes: 500 * 1024 ** 2,
        pidsCurrent: 120,
        memoryEventsHigh: 0,
        memoryEventsMax: 0,
        memoryEventsOom: 0,
        memoryEventsOomKill: 0,
        cpuPercent: 60,
      }),
    );

    expect(presentation.node).toBe("Node 3.5 GB RSS · heap 1.2 GB/2.0 GB · external 512 MB");
    expect(presentation.service).toBe("Service 8.2 GB working · 12 GB accounted");
    expect(presentation.serviceDetails).toContain("agents, MCPs, kernel memory");
    expect(presentation.serviceDetails).toContain("reclaimable filesystem cache");
  });

  it("keeps warning and danger thresholds tied to enforced memory.current limits", () => {
    const withCurrent = (current: number) =>
      makeSample({
        memoryCurrentBytes: current,
        memoryHighBytes: 12 * gib,
        memoryMaxBytes: 16 * gib,
        memoryPeakBytes: current,
        memoryWorkingSetBytes: 4 * gib,
        cpuPercent: 0,
      });

    expect(memoryTone(withCurrent(10 * gib))).toBe("default");
    expect(memoryTone(withCurrent(13 * gib))).toBe("warning");
    expect(memoryTone(withCurrent(15 * gib))).toBe("danger");
  });
});
