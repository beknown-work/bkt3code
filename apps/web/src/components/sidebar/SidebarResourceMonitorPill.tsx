import type { ServerResourceSample } from "@t3tools/contracts";
import { ActivityIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function memoryTone(sample: ServerResourceSample): "default" | "warning" | "danger" {
  const cgroup = sample.cgroup;
  const current = cgroup?.memoryCurrentBytes ?? null;
  if (cgroup === null || current === null) return "default";
  if (cgroup.memoryMaxBytes !== null && current >= cgroup.memoryMaxBytes * 0.9) return "danger";
  if (cgroup.memoryHighBytes !== null && current > cgroup.memoryHighBytes) return "warning";
  return "default";
}

export function memoryPresentation(sample: ServerResourceSample): {
  readonly node: string;
  readonly service: string | null;
  readonly serviceDetails: string | null;
} {
  const cgroup = sample.cgroup;
  const node = `Node ${formatBytes(sample.process.rssBytes)} RSS · heap ${formatBytes(sample.process.heapUsedBytes)}/${formatBytes(sample.process.heapTotalBytes)} · external ${formatBytes(sample.process.externalBytes)}`;
  if (cgroup === null || cgroup.memoryCurrentBytes === null) {
    return { node, service: null, serviceDetails: null };
  }

  const working = cgroup.memoryWorkingSetBytes ?? cgroup.memoryCurrentBytes;
  const service = `Service ${formatBytes(working)} working · ${formatBytes(cgroup.memoryCurrentBytes)} accounted`;
  const details = [
    cgroup.memoryAnonBytes === undefined ? null : `anon ${formatBytes(cgroup.memoryAnonBytes)}`,
    cgroup.memoryFileBytes === undefined ? null : `file ${formatBytes(cgroup.memoryFileBytes)}`,
    cgroup.memoryInactiveFileBytes === undefined
      ? null
      : `inactive file ${formatBytes(cgroup.memoryInactiveFileBytes)}`,
    cgroup.memorySlabReclaimableBytes === undefined
      ? null
      : `reclaimable slab ${formatBytes(cgroup.memorySlabReclaimableBytes)}`,
    cgroup.memorySwapCurrentBytes === undefined
      ? null
      : `swap ${formatBytes(cgroup.memorySwapCurrentBytes)}`,
    cgroup.pidsCurrent === undefined ? null : `${cgroup.pidsCurrent} PIDs`,
  ]
    .filter((detail): detail is string => detail !== null)
    .join(" · ");

  return {
    node,
    service,
    serviceDetails:
      details === ""
        ? "Includes agents, MCPs, kernel memory, and reclaimable filesystem cache."
        : `Includes agents, MCPs, kernel memory, and reclaimable filesystem cache. ${details}.`,
  };
}

function MemoryUsageBar({ sample }: { sample: ServerResourceSample }) {
  const cgroup = sample.cgroup;
  const current = cgroup?.memoryCurrentBytes ?? null;
  // The bar only makes sense against a known cgroup ceiling.
  const limit = cgroup === null ? null : (cgroup.memoryMaxBytes ?? cgroup.memoryHighBytes);
  if (cgroup === null || current === null || limit === null || limit === 0) return null;

  const tone = memoryTone(sample);
  const percent = Math.min(100, (current / limit) * 100);
  const label = [
    formatBytes(current),
    cgroup.memoryHighBytes !== null ? `high ${formatBytes(cgroup.memoryHighBytes)}` : null,
    cgroup.memoryMaxBytes !== null ? `max ${formatBytes(cgroup.memoryMaxBytes)}` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="flex flex-col gap-0.5">
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary/60 transition-[width]",
            tone === "warning" && "bg-amber-500",
            tone === "danger" && "bg-destructive",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        className={cn(
          "truncate tabular-nums text-muted-foreground/70",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
          tone === "danger" && "text-destructive",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function ResourceMonitorCard() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const connected = primaryEnvironment?.connection.phase === "connected";
  const { data: sample } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.resources({ environmentId, input: {} }),
  );
  const memory = sample === null ? null : memoryPresentation(sample);

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/40 bg-muted/30 px-2 py-1.5 text-[11px] leading-4">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ActivityIcon className="size-3 shrink-0" />
        <span className="font-medium">Server resources</span>
      </div>
      {!connected || sample === null ? (
        <span className="text-muted-foreground/60">
          {connected ? "Waiting for samples…" : "Unavailable while disconnected"}
        </span>
      ) : (
        <div className="flex flex-col gap-1 text-muted-foreground">
          <span className="truncate tabular-nums">{memory?.node}</span>
          {memory?.service ? (
            <span className="truncate tabular-nums">{memory?.service}</span>
          ) : null}
          <MemoryUsageBar sample={sample} />
          {memory?.serviceDetails ? (
            <span className="text-[10px] leading-3 text-muted-foreground/60">
              {memory?.serviceDetails}
            </span>
          ) : null}
          <span className="truncate tabular-nums">
            CPU {Math.round(sample.cgroup?.cpuPercent ?? sample.process.cpuPercent)}% · load{" "}
            {sample.system.loadAverage1m.toFixed(1)} / {sample.system.cpuCount}
          </span>
          {sample.disk !== null ? (
            <span className="truncate tabular-nums">
              Disk {formatBytes(sample.disk.freeBytes)} free of{" "}
              {formatBytes(sample.disk.totalBytes)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function SidebarResourceMonitorPill() {
  const resourceMonitorEnabled = useClientSettings((settings) => settings.resourceMonitorEnabled);
  // Gate before mounting the card so the ws subscription only exists while
  // the experiment is on.
  if (!resourceMonitorEnabled) return null;
  return <ResourceMonitorCard />;
}
