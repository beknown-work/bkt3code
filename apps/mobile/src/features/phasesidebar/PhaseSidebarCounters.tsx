// T3-CUSTOM(expbkt3): the three counters from the desktop sidebar chrome —
// unread, running, unsettled — in the same order, so the two surfaces read the
// same at a glance. The arithmetic is shared (`summarizeSidebarSessions`);
// this is layout, and the snooze-wake timer that keeps "unsettled" honest.
import { summarizeSidebarSessions } from "@t3tools/client-runtime/state/phase-sidebar";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { usePhaseSidebarVisitTimestamps } from "./phaseSidebarVisitStore";

function Counter(props: {
  readonly value: number;
  readonly label: string;
  readonly toneClassName: string;
  readonly textClassName: string;
}) {
  return (
    <View
      accessibilityLabel={`${props.value} ${props.label}`}
      accessibilityRole="text"
      className={cn(
        "h-7 min-w-8 items-center justify-center rounded-lg border px-1.5",
        props.toneClassName,
      )}
    >
      <Text className={cn("font-t3-bold text-[15px] tabular-nums", props.textClassName)}>
        {props.value}
      </Text>
    </View>
  );
}

export function PhaseSidebarCounters() {
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const lastVisitedAtByThreadKey = usePhaseSidebarVisitTimestamps();
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const counts = useMemo(() => {
    void snoozeWakeTick;
    return summarizeSidebarSessions(threads, {
      now: new Date().toISOString(),
      snoozeSupported: (thread) =>
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true,
      lastVisitedAtByThreadKey,
    });
  }, [lastVisitedAtByThreadKey, serverConfigs, snoozeWakeTick, threads]);
  useEffect(() => {
    const nextWakeAtMs = Date.parse(counts.nextSnoozeWakeAt ?? "");
    if (!Number.isFinite(nextWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [counts.nextSnoozeWakeAt]);

  return (
    <View accessibilityLabel="Session status summary" className="flex-row items-center gap-1">
      <Counter
        label={`unread session${counts.unread === 1 ? "" : "s"}`}
        textClassName={
          counts.unread > 0 ? "text-sky-700 dark:text-sky-300" : "text-foreground-tertiary"
        }
        toneClassName={
          counts.unread > 0 ? "border-sky-500/35 bg-sky-500/15" : "border-border/60 bg-subtle/40"
        }
        value={counts.unread}
      />
      <Counter
        label={`session${counts.running === 1 ? "" : "s"} running`}
        textClassName="text-emerald-600 dark:text-emerald-400"
        toneClassName="border-emerald-500/35 bg-emerald-500/12"
        value={counts.running}
      />
      <Counter
        label={`unsettled session${counts.nonRunning === 1 ? "" : "s"} waiting on you`}
        textClassName={
          counts.nonRunning >= 2
            ? "text-orange-600 dark:text-orange-300"
            : "text-emerald-700 dark:text-emerald-300"
        }
        toneClassName={
          counts.nonRunning >= 2
            ? "border-orange-500/45 bg-orange-500/12"
            : "border-emerald-500/35 bg-emerald-500/20"
        }
        value={counts.nonRunning}
      />
    </View>
  );
}
