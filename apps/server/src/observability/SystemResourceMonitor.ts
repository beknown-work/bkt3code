// @effect-diagnostics nodeBuiltinImport:off
/**
 * SystemResourceMonitor - Live host/process resource sampling.
 *
 * Streams periodic samples of the server process (memory, CPU), the host
 * (total/free memory, load average), the cgroup v2 limits the service runs
 * under (when present), and free disk space on the filesystem holding the
 * server's base directory. Backs the experimental live resource monitor in
 * the web client.
 *
 * Every probe is best-effort: cgroup files are absent on macOS and
 * non-systemd hosts, and `statfs` can fail on exotic filesystems. Failures
 * degrade to nulls; the stream itself never fails.
 *
 * @module SystemResourceMonitor
 */
import type { ServerResourceCgroupSample, ServerResourceSample } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";

const SAMPLE_INTERVAL = "2 seconds";
const CGROUP_ROOT = "/sys/fs/cgroup";
/** Below this the CPU delta window is too small to yield a stable percent. */
const MIN_CPU_DELTA_MS = 200;

export class SystemResourceMonitor extends Context.Service<
  SystemResourceMonitor,
  {
    /**
     * Emits a sample immediately on subscription, then every ~2 seconds.
     * Each subscription keeps its own CPU-delta state, so concurrent
     * subscribers do not skew each other's percentages.
     */
    readonly stream: Stream.Stream<ServerResourceSample>;
  }
>()("t3/observability/SystemResourceMonitor") {}

const readTextFile = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => NodeFSP.readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => null));

/** Parses a cgroup scalar file; "max" (no limit) and malformed values → null. */
function parseCgroupScalar(content: string | null): number | null {
  if (content === null) return null;
  const trimmed = content.trim();
  if (trimmed === "" || trimmed === "max") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseCpuStatUsageUsec(content: string | null): number | null {
  if (content === null) return null;
  for (const line of content.split("\n")) {
    const [key, raw] = line.trim().split(/\s+/);
    if (key === "usage_usec" && raw !== undefined) {
      const value = Number.parseInt(raw, 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
  }
  return null;
}

/**
 * Resolves this process's cgroup v2 directory from /proc/self/cgroup
 * (a "0::<path>" line under the unified hierarchy). Null when the file is
 * missing (macOS), the hierarchy is v1-only, or the directory is unreadable.
 */
export const resolveCgroupDirectory: Effect.Effect<string | null> = Effect.gen(function* () {
  const content = yield* readTextFile("/proc/self/cgroup");
  if (content === null) return null;
  const unifiedLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("0::"));
  if (unifiedLine === undefined) return null;
  const relativePath = unifiedLine.slice("0::".length);
  const directory = relativePath === "/" ? CGROUP_ROOT : `${CGROUP_ROOT}${relativePath}`;
  const accessible = yield* Effect.tryPromise(() => NodeFSP.access(directory)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return accessible ? directory : null;
});

interface CpuDeltaState {
  lastCpuUsage: NodeJS.CpuUsage;
  lastCgroupUsageUsec: number | null;
  lastSampledAtNs: bigint;
}

const readCgroupSample = (
  directory: string,
  state: CpuDeltaState,
  elapsedMs: number,
): Effect.Effect<ServerResourceCgroupSample> =>
  Effect.gen(function* () {
    const [memoryCurrent, memoryHigh, memoryMax, memoryPeak, cpuStat] = yield* Effect.all(
      [
        readTextFile(`${directory}/memory.current`),
        readTextFile(`${directory}/memory.high`),
        readTextFile(`${directory}/memory.max`),
        readTextFile(`${directory}/memory.peak`),
        readTextFile(`${directory}/cpu.stat`),
      ],
      { concurrency: "unbounded" },
    );
    const usageUsec = parseCpuStatUsageUsec(cpuStat);
    const previousUsageUsec = state.lastCgroupUsageUsec;
    state.lastCgroupUsageUsec = usageUsec;
    const cpuPercent =
      usageUsec !== null && previousUsageUsec !== null && elapsedMs >= MIN_CPU_DELTA_MS
        ? Math.max(0, ((usageUsec - previousUsageUsec) / (elapsedMs * 1_000)) * 100)
        : null;
    return {
      memoryCurrentBytes: parseCgroupScalar(memoryCurrent),
      memoryHighBytes: parseCgroupScalar(memoryHigh),
      memoryMaxBytes: parseCgroupScalar(memoryMax),
      memoryPeakBytes: parseCgroupScalar(memoryPeak),
      cpuPercent,
    };
  });

const readDiskSample = (path: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(path)).pipe(
    Effect.map((stats) => ({
      path,
      freeBytes: Math.max(0, stats.bavail * stats.bsize),
      totalBytes: Math.max(0, stats.blocks * stats.bsize),
    })),
    Effect.orElseSucceed(() => null),
  );

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const cgroupDirectory = yield* resolveCgroupDirectory;

  const sampleOnce = (state: CpuDeltaState): Effect.Effect<ServerResourceSample> =>
    Effect.gen(function* () {
      const sampledAt = yield* DateTime.now;
      const sampledAtNs = process.hrtime.bigint();
      const elapsedMs = Number(sampledAtNs - state.lastSampledAtNs) / 1_000_000;
      const cpuUsage = process.cpuUsage();
      const cpuDeltaUsec =
        cpuUsage.user + cpuUsage.system - (state.lastCpuUsage.user + state.lastCpuUsage.system);
      const processCpuPercent =
        elapsedMs >= MIN_CPU_DELTA_MS ? Math.max(0, (cpuDeltaUsec / (elapsedMs * 1_000)) * 100) : 0;
      state.lastCpuUsage = cpuUsage;
      state.lastSampledAtNs = sampledAtNs;

      const memory = process.memoryUsage();
      const loadAverage = NodeOS.loadavg();
      const [cgroup, disk] = yield* Effect.all(
        [
          cgroupDirectory === null
            ? Effect.succeed(null)
            : readCgroupSample(cgroupDirectory, state, elapsedMs),
          readDiskSample(config.baseDir),
        ],
        { concurrency: "unbounded" },
      );

      return {
        version: 1 as const,
        sampledAt,
        process: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          cpuPercent: processCpuPercent,
        },
        system: {
          totalMemoryBytes: NodeOS.totalmem(),
          freeMemoryBytes: NodeOS.freemem(),
          loadAverage1m: loadAverage[0] ?? 0,
          loadAverage5m: loadAverage[1] ?? 0,
          loadAverage15m: loadAverage[2] ?? 0,
          cpuCount: NodeOS.cpus().length,
        },
        cgroup,
        disk,
      };
    });

  const stream: Stream.Stream<ServerResourceSample> = Stream.unwrap(
    Effect.sync(() => {
      // Fresh per-subscription delta state; the stream runs on a single
      // fiber so plain mutation is safe. The first sample reports 0/null
      // CPU (no meaningful delta window yet).
      const state: CpuDeltaState = {
        lastCpuUsage: process.cpuUsage(),
        lastCgroupUsageUsec: null,
        lastSampledAtNs: process.hrtime.bigint(),
      };
      return Stream.tick(SAMPLE_INTERVAL).pipe(Stream.mapEffect(() => sampleOnce(state)));
    }),
  );

  return SystemResourceMonitor.of({ stream });
});

export const layer = Layer.effect(SystemResourceMonitor, make);
