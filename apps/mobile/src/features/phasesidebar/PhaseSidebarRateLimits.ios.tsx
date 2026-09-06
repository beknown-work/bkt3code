// T3-CUSTOM(expbkt3): iOS keeps quota in the phase-sidebar header without
// letting full-width meters push the session list down.
import { useAtomValue } from "@effect/atom-react";
import {
  buildProviderRateLimitRows,
  formatSingleUnitMinutes,
  providerRateLimitTone,
  type ProviderRateLimitRowView,
  type ProviderRateLimitTone,
} from "@t3tools/client-runtime/state/provider-rate-limits";
import type { EnvironmentId, ProviderRateLimitsStreamSnapshot } from "@t3tools/contracts";
import { useMemo, type ComponentProps } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentAppearances } from "../environments/useEnvironmentAppearance";

function toneTextClassName(tone: ProviderRateLimitTone): string {
  switch (tone) {
    case "danger":
      return "text-rose-500";
    case "warning":
      return "text-amber-500";
    case "healthy":
      return "text-emerald-500";
    case "unknown":
      return "text-foreground-muted";
  }
}

function providerLabel(row: ProviderRateLimitRowView): "CX" | "CC" {
  return row.displayName === "Codex" ? "CX" : "CC";
}

function CompactRateLimit(props: {
  readonly environmentName: string;
  readonly environmentSymbol: ComponentProps<typeof SymbolView>["name"];
  readonly environmentColor: string;
  readonly row: ProviderRateLimitRowView;
}) {
  const { row } = props;
  if (row.remainingPercent === null) return null;
  const clamped = Math.max(0, Math.min(100, row.remainingPercent));
  const resetLabel =
    row.headlineMinutesUntilReset === null
      ? "Reset time unavailable"
      : row.headlineMinutesUntilReset === 0
        ? "Resets now"
        : `Resets in ${formatSingleUnitMinutes(row.headlineMinutesUntilReset)}`;

  return (
    <View
      accessibilityLabel={`${props.environmentName}, ${row.displayName}, ${Math.round(clamped)}% quota remaining. ${resetLabel}.`}
      accessibilityRole="text"
      className="min-w-9 items-center gap-0.5"
    >
      <View className="flex-row items-center gap-1">
        <SymbolView
          name={props.environmentSymbol}
          size={10}
          tintColor={props.environmentColor}
          type="monochrome"
        />
        <Text className="font-t3-mono text-[9px] font-t3-medium text-foreground-muted">
          {providerLabel(row)}
        </Text>
      </View>
      <Text
        className={cn(
          "font-t3-mono text-[12px] font-t3-semibold tabular-nums",
          toneTextClassName(providerRateLimitTone(clamped)),
        )}
      >
        {Math.round(clamped)}%
      </Text>
    </View>
  );
}

function EnvironmentRateLimits(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentName: string;
  readonly environmentSymbol: ComponentProps<typeof SymbolView>["name"];
  readonly environmentColor: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
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

  if (!supported || rows.length === 0) return null;
  return (
    <View className="flex-row items-start gap-2.5">
      {rows.map((row) => (
        <CompactRateLimit
          environmentColor={props.environmentColor}
          environmentName={props.environmentName}
          environmentSymbol={props.environmentSymbol}
          key={`${props.environmentId}:${row.providerInstanceId}`}
          row={row}
        />
      ))}
    </View>
  );
}

export function PhaseSidebarRateLimits() {
  const { environments } = useEnvironments();
  const appearances = useEnvironmentAppearances();

  return (
    <ScrollView
      className="min-w-0 flex-1"
      contentContainerClassName="flex-grow flex-row items-start justify-end gap-3"
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {environments.map((environment) => {
        const appearance = appearances.get(environment.environmentId);
        return (
          <EnvironmentRateLimits
            environmentColor={appearance?.color ?? "#94a3b8"}
            environmentId={environment.environmentId}
            environmentName={appearance?.name ?? environment.label}
            environmentSymbol={appearance?.symbol ?? "server.rack"}
            key={environment.environmentId}
          />
        );
      })}
    </ScrollView>
  );
}
