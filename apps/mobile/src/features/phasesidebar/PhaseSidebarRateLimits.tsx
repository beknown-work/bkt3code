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
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
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
      return "bg-muted-foreground/40";
  }
}

function RateLimitBar(props: { readonly row: ProviderRateLimitRowView }) {
  const { row } = props;
  // A provider that reports no weekly quota has nothing to draw; showing an
  // empty bar would read as "you are out".
  if (row.remainingPercent === null) return null;
  const tone = providerRateLimitTone(row.remainingPercent);
  const clamped = Math.max(0, Math.min(100, row.remainingPercent));

  return (
    <View className="flex-row items-center gap-1.5">
      <Text className="w-10 shrink-0 font-t3-mono text-[9px] uppercase text-muted-foreground">
        {row.displayName}
      </Text>
      <View className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <View
          className={cn("h-full rounded-full", toneBarClassName(tone))}
          style={{ width: `${clamped}%` }}
        />
      </View>
      <Text className="shrink-0 font-t3-mono text-[9px] text-muted-foreground">
        {Math.round(clamped)}%
      </Text>
    </View>
  );
}

export function PhaseSidebarRateLimits(props: {
  readonly environmentId: EnvironmentId | null;
  readonly onPress?: () => void;
}) {
  const config = useAtomValue(
    serverEnvironment.configValueAtom(props.environmentId ?? NO_ENVIRONMENT),
  );
  // Absent on upstream servers and on fork servers from before the stream
  // shipped, so hide rather than probe.
  const supported =
    props.environmentId !== null && config?.environment.capabilities.providerRateLimits === true;
  const { data } = useEnvironmentQuery<ProviderRateLimitsStreamSnapshot, unknown>(
    supported && props.environmentId !== null
      ? serverEnvironment.providerRateLimits({ environmentId: props.environmentId, input: {} })
      : null,
  );

  const rows = useMemo(() => {
    if (data === null) return [];
    return buildProviderRateLimitRows({
      providers: config?.providers ?? [],
      entries: data.entries,
      now: Date.now(),
    });
  }, [config?.providers, data]);

  const visible = rows.filter((row) => row.remainingPercent !== null);
  if (!supported || visible.length === 0) return null;

  return (
    <Pressable
      className="gap-1 px-3 py-2"
      disabled={props.onPress === undefined}
      onPress={props.onPress}
    >
      {visible.map((row) => (
        <RateLimitBar key={row.providerInstanceId} row={row} />
      ))}
    </Pressable>
  );
}

// Atom families are keyed; a stable placeholder avoids minting one per render.
const NO_ENVIRONMENT = "__phase-sidebar-no-environment__" as EnvironmentId;
