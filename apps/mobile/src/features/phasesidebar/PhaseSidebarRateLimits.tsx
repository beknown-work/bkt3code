// T3-CUSTOM(expbkt3): Claude and Codex quota at a glance, in the sidebar header.
//
// The mobile counterpart of web's SidebarProviderRateLimits. All of the
// arithmetic — which window is the headline, what tone it deserves, how to word
// the reset — is already shared in client-runtime, so this is layout only.
//
// Mobile already has a full Usage screen (Settings → Usage) with per-day charts.
// This deliberately does not duplicate it: it answers "how much have I got left"
// in one glance and links through for the detail.
import { useAtomValue } from "@effect/atom-react";
import {
  buildProviderRateLimitRows,
  providerRateLimitTone,
  type ProviderRateLimitRowView,
  type ProviderRateLimitTone,
} from "@t3tools/client-runtime/state/provider-rate-limits";
import type { EnvironmentId, ProviderRateLimitsStreamSnapshot } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

function toneBarClassName(tone: ProviderRateLimitTone): string {
  switch (tone) {
    case "danger":
      return "bg-rose-500";
    case "warning":
      return "bg-amber-500";
    case "healthy":
      return "bg-emerald-500";
    case "unknown":
      return "bg-subtle-strong";
  }
}

/**
 * One provider's quota as a full-width row: name, bar, percent. Rows sit in a
 * two-column grid so four providers across two machines fit in two lines and
 * the bars get real width instead of a 48px stub.
 */
function RateLimitBar(props: {
  readonly row: ProviderRateLimitRowView;
  readonly prefix: string | null;
}) {
  const { row } = props;
  // A provider that reports no weekly quota has nothing to draw; showing an
  // empty bar would read as "you are out".
  if (row.remainingPercent === null) return null;
  const tone = providerRateLimitTone(row.remainingPercent);
  const clamped = Math.max(0, Math.min(100, row.remainingPercent));

  return (
    <View className="w-1/2 flex-row items-center gap-2 pr-3">
      <Text
        className="w-[72px] shrink-0 font-t3-mono text-[10px] uppercase text-foreground-muted"
        numberOfLines={1}
      >
        {props.prefix === null ? row.displayName : `${props.prefix} ${row.displayName}`}
      </Text>
      <View className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle-strong">
        <View
          className={cn("h-full rounded-full", toneBarClassName(tone))}
          style={{ width: `${clamped}%` }}
        />
      </View>
      <Text className="w-8 shrink-0 text-right font-t3-mono text-[10px] text-foreground-muted">
        {Math.round(clamped)}%
      </Text>
    </View>
  );
}

/** One environment's bars, or nothing when it cannot report them. */
function EnvironmentRateLimits(props: {
  readonly environmentId: EnvironmentId;
  /** Shown before the provider name when more than one environment reports. */
  readonly environmentLabel: string | null;
  readonly onVisible: (environmentId: EnvironmentId, visible: boolean) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // Absent on upstream servers and on fork servers from before the stream
  // shipped, so hide rather than probe.
  const supported = config?.environment.capabilities.providerRateLimits === true;
  const { data } = useEnvironmentQuery<ProviderRateLimitsStreamSnapshot, unknown>(
    supported
      ? serverEnvironment.providerRateLimits({ environmentId: props.environmentId, input: {} })
      : null,
  );

  const rows = useMemo(() => {
    if (data === null) return [];
    return buildProviderRateLimitRows({
      providers: config?.providers ?? [],
      entries: data.entries,
      now: Date.now(),
    }).filter((row) => row.remainingPercent !== null);
  }, [config?.providers, data]);

  const { onVisible, environmentId } = props;
  const visible = supported && rows.length > 0;
  useEffect(() => {
    onVisible(environmentId, visible);
    return () => onVisible(environmentId, false);
  }, [environmentId, onVisible, visible]);

  if (!visible) return null;
  return (
    <>
      {rows.map((row) => (
        <RateLimitBar
          key={`${props.environmentId}:${row.providerInstanceId}`}
          prefix={props.environmentLabel}
          row={row}
        />
      ))}
    </>
  );
}

/**
 * Bars for every connected environment. Mobile has no primary environment the
 * way desktop does — the phone may be paired to two machines — so each one
 * that reports quota gets its bars, prefixed by machine only when it matters.
 */
export function PhaseSidebarRateLimits(props: { readonly onPress?: () => void }) {
  const { environments } = useEnvironments();
  const [visibleById, setVisibleById] = useState<ReadonlyMap<EnvironmentId, boolean>>(
    () => new Map(),
  );
  const handleVisible = useCallback((environmentId: EnvironmentId, visible: boolean) => {
    setVisibleById((current) => {
      if ((current.get(environmentId) ?? false) === visible) return current;
      const next = new Map(current);
      next.set(environmentId, visible);
      return next;
    });
  }, []);
  const visibleCount = [...visibleById.values()].filter(Boolean).length;
  const anyVisible = visibleCount > 0;

  return (
    <Pressable
      className={cn(
        "flex-row flex-wrap gap-y-1.5 px-4",
        anyVisible ? "pb-1 pt-2" : "h-0 overflow-hidden",
      )}
      disabled={props.onPress === undefined}
      onPress={props.onPress}
    >
      {environments.map((environment) => (
        <EnvironmentRateLimits
          environmentId={environment.environmentId}
          environmentLabel={visibleCount > 1 ? environment.label : null}
          key={environment.environmentId}
          onVisible={handleVisible}
        />
      ))}
    </Pressable>
  );
}
