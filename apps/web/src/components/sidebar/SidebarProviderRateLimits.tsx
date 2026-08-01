import { useAtomValue } from "@effect/atom-react";
import type { ProviderRateLimitsStreamSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useState } from "react";

import { ClaudeAI, OpenAI } from "../Icons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  buildProviderRateLimitRows,
  providerRateLimitBoundaryTimes,
  selectProviderRateLimitEnvironmentId,
  summarizeProviderRateLimitRows,
  type ProviderRateLimitRowView,
  type ProviderRateLimitTone,
} from "./SidebarProviderRateLimits.logic";

const toneClass: Record<ProviderRateLimitTone, string> = {
  healthy: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  unknown: "bg-muted-foreground/35",
};

function formatLocalDateTime(value: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(value)).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function freshnessLabel(row: ProviderRateLimitRowView): string {
  if (row.lastRefreshFailed && row.availability === "available") {
    return "Latest refresh failed; showing the last valid reading";
  }
  switch (row.freshness) {
    case "fresh":
      return "Fresh";
    case "stale":
      return "Stale; awaiting provider refresh";
    case "not-applicable":
      return "Subscription quota does not apply";
    case "error":
      return "Refresh failed";
    case "unknown":
      return "Waiting for provider activity";
  }
}

function ProviderRateLimitIcon({ row }: { row: ProviderRateLimitRowView }) {
  const Icon = row.driverKind === "codex" ? OpenAI : ClaudeAI;
  return <Icon aria-hidden="true" className="size-2.5 shrink-0" />;
}

function ProviderRateLimitProgressRow({
  row,
  onBackdrop,
}: {
  row: ProviderRateLimitRowView;
  onBackdrop: boolean;
}) {
  const remaining = row.remainingPercent;
  return (
    <span className="flex h-3 items-center gap-1" data-provider={row.driverKind}>
      <ProviderRateLimitIcon row={row} />
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-8 shrink-0 overflow-hidden rounded-full",
          onBackdrop ? "bg-white/20" : "bg-muted",
        )}
      >
        <span
          className={cn("block h-full rounded-full", toneClass[row.tone])}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </span>
      <span
        className={cn(
          "w-7 text-right text-[9px] font-semibold leading-none tabular-nums",
          onBackdrop ? "text-white/75" : "text-muted-foreground",
        )}
      >
        {remaining === null ? "—" : `${remaining}%`}
      </span>
    </span>
  );
}

export function ProviderRateLimitsDetails({
  rows,
  environmentLabel,
}: {
  rows: ReadonlyArray<ProviderRateLimitRowView>;
  environmentLabel: string;
  now: number;
}) {
  return (
    <div className="w-72 space-y-3 text-xs">
      <div>
        <div className="font-semibold text-foreground">Provider usage limits</div>
        <div className="mt-0.5 text-muted-foreground">{environmentLabel}</div>
      </div>
      {rows.map((row) => (
        <section className="space-y-1.5" key={row.providerInstanceId}>
          <div className="flex items-center gap-1.5">
            <ProviderRateLimitIcon row={row} />
            <span className="font-medium text-foreground">{row.displayName}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {row.remainingPercent === null ? "—" : `${row.remainingPercent}% remaining`}
            </span>
          </div>
          {row.freshness === "not-applicable" ? (
            <p className="text-muted-foreground">
              Subscription limits unavailable for API-key billing
            </p>
          ) : row.windows.length === 0 ? (
            <p className="text-muted-foreground">Waiting for provider activity</p>
          ) : (
            <div className="space-y-1">
              {row.windows.map(({ window, remainingPercent, status }) => (
                <div
                  className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
                  key={window.windowId}
                >
                  <div className="flex gap-2">
                    <span className="truncate font-medium text-foreground">{window.label}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {remainingPercent === null ? "—" : `${remainingPercent}% remaining`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {status === "awaiting-refresh"
                      ? "Reset passed; awaiting refresh"
                      : status === "stale"
                        ? "Stale; awaiting refresh"
                        : window.resetsAt === null
                          ? "Reset time unavailable"
                          : `Resets ${formatLocalDateTime(window.resetsAt)}`}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground">
            {row.observedAt === null
              ? freshnessLabel(row)
              : `Last observed ${formatLocalDateTime(row.observedAt)} · ${freshnessLabel(row)}`}
          </div>
        </section>
      ))}
      <p className="text-[10px] leading-4 text-muted-foreground">
        Read-only subscription quotas. Provider selection remains manual.
      </p>
    </div>
  );
}

export function SidebarProviderRateLimitsView({
  rows,
  environmentLabel,
  now,
  onBackdrop,
}: {
  rows: ReadonlyArray<ProviderRateLimitRowView>;
  environmentLabel: string;
  now: number;
  onBackdrop: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={summarizeProviderRateLimitRows(rows)}
        className={cn(
          "flex h-7 max-w-full shrink-0 flex-col items-start justify-center overflow-hidden rounded-md px-0.5 outline-hidden ring-ring focus-visible:ring-2",
          onBackdrop ? "text-white/80 hover:bg-white/10" : "hover:bg-muted/70",
        )}
        title="Provider usage limits"
      >
        {rows.map((row) => (
          <ProviderRateLimitProgressRow
            key={row.providerInstanceId}
            row={row}
            onBackdrop={onBackdrop}
          />
        ))}
      </PopoverTrigger>
      <PopoverPopup align="start" className="shadow-lg" side="bottom" sideOffset={6}>
        <ProviderRateLimitsDetails environmentLabel={environmentLabel} now={now} rows={rows} />
      </PopoverPopup>
    </Popover>
  );
}

function useBoundaryClock(rows: ReadonlyArray<ProviderRateLimitRowView>): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const nextBoundary = providerRateLimitBoundaryTimes(rows)
      .filter((boundary) => boundary > current)
      .toSorted((left, right) => left - right)[0];
    if (nextBoundary === undefined) return;
    const timeout = window.setTimeout(
      () => setTick(Date.now()),
      Math.min(2_147_483_647, Math.max(1, nextBoundary - current + 10)),
    );
    return () => window.clearTimeout(timeout);
  }, [rows]);
  return Math.max(tick, Date.now());
}

export function SidebarProviderRateLimits({ onBackdrop }: { onBackdrop: boolean }) {
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = selectProviderRateLimitEnvironmentId(
    activeEnvironmentId,
    primaryEnvironmentId,
  );
  const environment = useEnvironment(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.providerRateLimits === true;
  const { data } = useEnvironmentQuery<ProviderRateLimitsStreamSnapshot, unknown>(
    environmentId !== null && supported
      ? serverEnvironment.providerRateLimits({ environmentId, input: {} })
      : null,
  );
  const provisionalRows = useMemo(
    () =>
      buildProviderRateLimitRows({
        providers: config?.providers ?? [],
        entries: data?.entries ?? [],
        now: Date.now(),
      }),
    [config?.providers, data?.entries],
  );
  const now = useBoundaryClock(provisionalRows);
  const rows = useMemo(
    () =>
      buildProviderRateLimitRows({
        providers: config?.providers ?? [],
        entries: data?.entries ?? [],
        now,
      }),
    [config?.providers, data?.entries, now],
  );

  if (!supported) return null;
  return (
    <SidebarProviderRateLimitsView
      environmentLabel={environment?.label ?? config.environment.label}
      now={now}
      onBackdrop={onBackdrop}
      rows={rows}
    />
  );
}
