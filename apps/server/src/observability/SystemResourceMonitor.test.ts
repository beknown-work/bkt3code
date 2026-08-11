import { describe, expect, it } from "vite-plus/test";

import { parseCgroupMemoryDetails } from "./SystemResourceMonitor.ts";

describe("parseCgroupMemoryDetails", () => {
  it("parses complete cgroup v2 memory accounting", () => {
    expect(
      parseCgroupMemoryDetails({
        memoryCurrent: "1000\n",
        memoryStat: "anon 400\nfile 500\ninactive_file 300\nslab_reclaimable 50\n",
        memorySwapCurrent: "20\n",
        pidsCurrent: "8\n",
        memoryEvents: "low 0\nhigh 2\nmax 1\noom 3\noom_kill 1\n",
      }),
    ).toEqual({
      memoryWorkingSetBytes: 700,
      memoryAnonBytes: 400,
      memoryFileBytes: 500,
      memoryInactiveFileBytes: 300,
      memorySlabReclaimableBytes: 50,
      memorySwapCurrentBytes: 20,
      pidsCurrent: 8,
      memoryEventsHigh: 2,
      memoryEventsMax: 1,
      memoryEventsOom: 3,
      memoryEventsOomKill: 1,
    });
  });

  it("omits details whose cgroup files or keys are missing", () => {
    expect(
      parseCgroupMemoryDetails({
        memoryCurrent: "1000\n",
        memoryStat: "anon 400\n",
        memorySwapCurrent: null,
        pidsCurrent: null,
        memoryEvents: "high 2\n",
      }),
    ).toEqual({
      memoryAnonBytes: 400,
      memoryEventsHigh: 2,
    });
  });

  it("clamps the computed working set at zero", () => {
    expect(
      parseCgroupMemoryDetails({
        memoryCurrent: "100\n",
        memoryStat: "inactive_file 200\n",
        memorySwapCurrent: null,
        pidsCurrent: null,
        memoryEvents: null,
      }).memoryWorkingSetBytes,
    ).toBe(0);
  });
});
