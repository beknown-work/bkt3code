// T3-CUSTOM(expbkt3): the whole phase sidebar as one mountable pane.
//
// Two surfaces need it and neither may drift from the other: `HomeScreen` is the
// thread list on a phone (compact layout), while `ThreadNavigationSidebar` is
// the split-view pane on a tablet. Wiring it in only one of those was the
// original bug — the tablet pane does not render at all on a phone, so the
// Settings toggle appeared to do nothing.
//
// Everything below is wiring. Grouping, filtering, sorting, row metadata and
// the drop rules all live in client-runtime or this feature's pure modules.
import { useNavigation } from "@react-navigation/native";
import {
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  type PhaseSidebarFilters,
  type PhaseSidebarRow,
  type PhaseSidebarSortPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { phaseSidebarFiltersActive } from "@t3tools/client-runtime/state/phase-sidebar-tree";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "../home/useThreadListActions";
import { PhaseSidebarFilterSheet } from "./PhaseSidebarFilterSheet";
import { PhaseSidebarList } from "./PhaseSidebarList";
import { PhaseSidebarRateLimits } from "./PhaseSidebarRateLimits";
import { useMarkPhaseSidebarThreadVisited } from "./phaseSidebarVisitStore";
import { usePhaseSidebarRows, usePhaseSidebarViewerUserId } from "./usePhaseSidebarRows";

/** A day, the single snooze the row menu offers; the thread screen has a picker. */
const ROW_MENU_SNOOZE_MS = 24 * 60 * 60_000;

export function PhaseSidebarPane(props: {
  /** Whose operator identity the ownership facets resolve against. */
  readonly viewerEnvironmentId: EnvironmentId | null;
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const navigation = useNavigation();
  const mutedColor = String(useThemeColor("--color-icon"));
  const projects = useProjects();
  const rows = usePhaseSidebarRows({ viewerEnvironmentId: props.viewerEnvironmentId });
  const viewerUserId = usePhaseSidebarViewerUserId(props.viewerEnvironmentId);
  const markVisited = useMarkPhaseSidebarThreadVisited();

  const [filters, setFilters] = useState<PhaseSidebarFilters>(EMPTY_PHASE_SIDEBAR_FILTERS);
  const [sort, setSort] = useState<PhaseSidebarSortPreferences>(DEFAULT_PHASE_SIDEBAR_SORT);
  const [filterOpen, setFilterOpen] = useState(false);

  const {
    archiveThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    movePinnedThread,
  } = useThreadListActions();
  // The two row actions useThreadListActions does not cover.
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "phase sidebar update thread metadata",
  );
  const stopExecution = useAtomCommand(threadEnvironment.stopExecution, "phase sidebar force stop");

  const handleSelect = useCallback(
    (row: PhaseSidebarRow) => {
      markVisited(`${row.thread.environmentId}:${row.thread.id}`);
      props.onSelectThread(row.thread);
    },
    [markVisited, props],
  );

  const handleRowAction = useCallback(
    (row: PhaseSidebarRow, actionId: string) => {
      const thread = row.thread;

      if (actionId.startsWith("priority:")) {
        const parsed = Number.parseInt(actionId.slice("priority:".length), 10);
        const priority = PHASE_SIDEBAR_PRIORITY_CHOICES.find(
          (choice) => choice.value === parsed,
        )?.value;
        if (priority === undefined) return;
        void updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, priority },
        });
        return;
      }

      switch (actionId) {
        case "people":
          navigation.navigate("ThreadMembers", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
          return;
        case "settle":
          void settleThread(thread);
          return;
        case "unsettle":
          void unsettleThread(thread);
          return;
        case "snooze":
          void snoozeThread(thread, new Date(Date.now() + ROW_MENU_SNOOZE_MS).toISOString());
          return;
        case "unsnooze":
          void unsnoozeThread(thread);
          return;
        case "pin":
          void pinThread(thread);
          return;
        case "unpin":
          void unpinThread(thread);
          return;
        case "archive":
          archiveThread(thread);
          return;
        case "force-stop":
          void stopExecution({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          });
          return;
      }
    },
    [
      archiveThread,
      navigation,
      pinThread,
      settleThread,
      snoozeThread,
      stopExecution,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  const handleReparent = useCallback(
    (subject: PhaseSidebarRow, parent: PhaseSidebarRow | null) => {
      // Same command web's setThreadParent uses; the drop was already validated
      // against cycles and the depth limit before it got here.
      void updateThreadMetadata({
        environmentId: subject.thread.environmentId,
        input: {
          threadId: subject.thread.id,
          parentThreadId: parent === null ? null : parent.thread.id,
          // T3-CUSTOM(expbkt3): a drop is always within one environment (the
          // validator rejects cross-environment targets), so the parent's
          // environment is this thread's own. Sending null rather than omitting
          // it matters: omitting leaves the field unchanged, which would strand
          // a thread that used to have a parent on another machine pointing at
          // that machine with a local thread id.
          parentEnvironmentId: null,
        },
      });
    },
    [updateThreadMetadata],
  );

  const handleReorder = useCallback(
    (subject: PhaseSidebarRow, before: PhaseSidebarRow) => {
      // Direction comes from the pin ORDER (`pinOrderKey`, the sortable key the
      // server assigns), not `pinnedAt`, which is when the pin happened.
      // movePinnedThread owns the fractional-index planning and moves one
      // position per call, so a long drag needs repeating.
      const subjectKey = subject.thread.pinOrderKey ?? "";
      const beforeKey = before.thread.pinOrderKey ?? "";
      void movePinnedThread(subject.thread, subjectKey > beforeKey ? "up" : "down");
    },
    [movePinnedThread],
  );

  return (
    <View className="flex-1">
      {filterOpen ? (
        <View className="max-h-[60%] border-b border-border">
          <PhaseSidebarFilterSheet
            filters={filters}
            onChangeFilters={setFilters}
            onChangeSort={setSort}
            projects={projects}
            rows={rows}
            sort={sort}
          />
        </View>
      ) : null}
      <PhaseSidebarList
        ListHeaderComponent={
          <View>
            <PhaseSidebarRateLimits environmentId={props.viewerEnvironmentId} />
            <View className="flex-row items-center justify-between px-3 pb-1 pt-2">
              <Text className="text-[11px] font-t3-bold uppercase tracking-wide text-muted-foreground">
                Lifecycle
              </Text>
              <Pressable
                className={cn(
                  "flex-row items-center gap-1.5 rounded-lg border px-2.5 py-1",
                  phaseSidebarFiltersActive(filters)
                    ? "border-primary bg-primary/15"
                    : "border-border",
                )}
                hitSlop={6}
                onPress={() => setFilterOpen((open) => !open)}
              >
                <SymbolView
                  name="line.3.horizontal.decrease"
                  size={12}
                  tintColor={mutedColor}
                  type="monochrome"
                />
                <Text className="text-xs text-foreground">Filter</Text>
              </Pressable>
            </View>
          </View>
        }
        activeThreadKey={props.selectedThreadKey}
        filters={filters}
        onReorderRow={handleReorder}
        onReparentRow={handleReparent}
        onRowAction={handleRowAction}
        onSelectRow={handleSelect}
        rows={rows}
        sort={sort}
        viewerUserId={viewerUserId}
      />
    </View>
  );
}
