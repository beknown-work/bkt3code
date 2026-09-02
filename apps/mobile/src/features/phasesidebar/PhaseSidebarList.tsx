// T3-CUSTOM(expbkt3): the mobile phase-grouped sidebar list.
//
// Grouping, nesting, filtering and sorting are all decided by client-runtime, so
// this component owns exactly two things: expansion state, and turning the
// resulting sections into a flat list a FlatList can render efficiently.
// Rendering the tree as one flat array matters on a phone — a nested render
// tree of hundreds of rows drops frames on scroll.
import {
  flattenPhaseSidebarTree,
  type PhaseSidebarTreeNode,
} from "@t3tools/client-runtime/state/phase-sidebar-tree";
import {
  buildPhaseSidebarSections,
  phaseSidebarSectionPhase,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupingPreferences,
  type PhaseSidebarSection,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import {
  comparePhaseSidebarRows,
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  resolvePhaseSidebarWorktreeView,
  type PhaseSidebarFilters,
  type PhaseSidebarRow,
  type PhaseSidebarSortPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  resolveSnoozePresets,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  type SidebarThreadSortOrder,
  type UserId,
} from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { useCallback, useMemo, useState, type ComponentProps } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { PhaseSidebarRowView, type PhaseSidebarRowSwipe } from "./PhaseSidebarRowView";
import { phaseSidebarSectionToneClassName } from "./phaseSidebarRowTone";
import {
  buildPhaseSidebarRowActions,
  phaseSidebarRowActionsToMenu,
} from "./usePhaseSidebarRowActions";
import { usePhaseSidebarDrag } from "./usePhaseSidebarDrag";

/** A flattened list entry: either a section header or a thread row. */
type PhaseSidebarListItem =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly section: PhaseSidebarSection;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly node: PhaseSidebarTreeNode;
    };

/** What the header of a custom group can do, beyond collapsing. */
export type PhaseSidebarSectionActionId = "rename" | "delete" | "move-up" | "move-down";

export interface PhaseSidebarListProps {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly viewerUserId: UserId | null;
  readonly activeThreadKey: string | null;
  readonly filters?: PhaseSidebarFilters;
  readonly sort?: PhaseSidebarSortPreferences;
  readonly sortOrder?: SidebarThreadSortOrder;
  readonly grouping: PhaseSidebarGroupingPreferences;
  readonly onChangeGrouping: (
    apply: (current: PhaseSidebarGroupingPreferences) => PhaseSidebarGroupingPreferences,
  ) => void;
  readonly projectLabelFor?: (environmentId: string, projectId: string) => string | null;
  readonly environmentLabelFor?: (environmentId: string) => string | null;
  readonly onSelectRow: (row: PhaseSidebarRow) => void;
  /** Fired with the chosen action id from the row's long-press menu or swipe. */
  readonly onRowAction: (row: PhaseSidebarRow, actionId: string) => void;
  readonly onSectionAction: (
    section: PhaseSidebarSection,
    actionId: PhaseSidebarSectionActionId,
  ) => void;
  /** Re-parent a thread. Null parent means 'make this a root thread'. */
  readonly onReparentRow?: (subject: PhaseSidebarRow, parent: PhaseSidebarRow | null) => void;
  /** Reorder a pinned thread to sit before another. */
  readonly onReorderRow?: (subject: PhaseSidebarRow, before: PhaseSidebarRow) => void;
  readonly ListHeaderComponent?: ComponentProps<typeof FlatList>["ListHeaderComponent"];
  readonly ListEmptyComponent?: ComponentProps<typeof FlatList>["ListEmptyComponent"];
  readonly contentInsetAdjustmentBehavior?: ComponentProps<
    typeof FlatList
  >["contentInsetAdjustmentBehavior"];
  readonly contentContainerStyle?: ComponentProps<typeof FlatList>["contentContainerStyle"];
}

function resolveRowSwipe(
  row: PhaseSidebarRow,
  now: string,
  snoozeMenu: MenuAction[],
): PhaseSidebarRowSwipe {
  const thread = row.thread;
  if (row.snoozeSupported && effectiveSnoozed(thread, { now })) {
    return { primary: "unsnooze", snoozeMenu: null };
  }
  const settled =
    row.settlementSupported && effectiveSettled(thread, { now, autoSettleAfterDays: null });
  const snoozable = row.snoozeSupported && !settled && canSnooze(thread, { now });
  return {
    primary: settled ? "unsettle" : row.settlementSupported ? "settle" : "archive",
    snoozeMenu: snoozable ? snoozeMenu : null,
  };
}

export function PhaseSidebarList(props: PhaseSidebarListProps) {
  const filters = props.filters ?? EMPTY_PHASE_SIDEBAR_FILTERS;
  const sort = props.sort ?? DEFAULT_PHASE_SIDEBAR_SORT;
  const sortOrder = props.sortOrder ?? DEFAULT_SIDEBAR_THREAD_SORT_ORDER;
  const { grouping, onChangeGrouping, onSectionAction } = props;
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const mutedColor = String(useThemeColor("--color-icon"));
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate();

  const worktreeView = useMemo(
    // Resolved across the whole set, not per row: codenames disambiguate against
    // each other and occupancy is a count.
    () => resolvePhaseSidebarWorktreeView(props.rows.map((row) => row.thread)),
    [props.rows],
  );

  const { sections, forcedExpansionKeys } = useMemo(
    () =>
      buildPhaseSidebarSections({
        rows: props.rows,
        filters,
        compareSiblings: (left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort),
        grouping,
        ...(props.projectLabelFor ? { projectLabelFor: props.projectLabelFor } : {}),
        ...(props.environmentLabelFor ? { environmentLabelFor: props.environmentLabelFor } : {}),
      }),
    [
      filters,
      grouping,
      props.environmentLabelFor,
      props.projectLabelFor,
      props.rows,
      sort,
      sortOrder,
    ],
  );
  const collapsedSectionKeys = useMemo(
    () => new Set(grouping.collapsedSectionKeys),
    [grouping.collapsedSectionKeys],
  );

  // Parents default to open, so a session tree is visible without hunting. A
  // filter can force a parent open; that never touches the user's own state.
  const isExpanded = useCallback(
    (key: string) => forcedExpansionKeys.has(key) || !collapsedKeys.has(key),
    [collapsedKeys, forcedExpansionKeys],
  );

  const items = useMemo<ReadonlyArray<PhaseSidebarListItem>>(() => {
    const flat: PhaseSidebarListItem[] = [];
    for (const section of sections) {
      // Lifecycle and project sections exist only because they have rows; an
      // empty custom group still renders so it can be found and filled.
      if (section.nodes.length === 0 && section.kind !== "custom") continue;
      const collapsed = collapsedSectionKeys.has(section.key);
      flat.push({ kind: "section", key: section.key, section, collapsed });
      if (collapsed) continue;
      for (const node of flattenPhaseSidebarTree(section.nodes, isExpanded)) {
        flat.push({ kind: "row", key: node.key, node });
      }
    }
    return flat;
  }, [collapsedSectionKeys, isExpanded, sections]);

  // Presets are relative to now, so they refresh whenever the rows do — the
  // same cadence the stock list uses.
  const nowIso = useMemo(() => new Date().toISOString(), [props.rows]);
  const snoozePresets = useMemo<ReadonlyArray<SnoozePreset>>(
    () => resolveSnoozePresets(new Date(nowIso)),
    [nowIso],
  );
  const snoozeMenu = useMemo<MenuAction[]>(
    () =>
      snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
    [snoozePresets],
  );
  const customGroups = useMemo(
    () => grouping.customGroups.map((group) => ({ id: group.id, label: group.label })),
    [grouping.customGroups],
  );
  const customGroupIdByThreadKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of grouping.customGroups) {
      for (const key of group.threadKeys) map.set(key, group.id);
    }
    return map;
  }, [grouping.customGroups]);
  const rowActionsFor = useCallback(
    (row: PhaseSidebarRow, rowKey: string): MenuAction[] =>
      phaseSidebarRowActionsToMenu(
        buildPhaseSidebarRowActions({
          row,
          now: nowIso,
          snoozePresets,
          ...(customGroups.length > 0 || grouping.groupBy === "custom"
            ? { customGroups, customGroupId: customGroupIdByThreadKey.get(rowKey) ?? null }
            : {}),
        }),
      ) as MenuAction[],
    [customGroupIdByThreadKey, customGroups, grouping.groupBy, nowIso, snoozePresets],
  );

  const noopReparent = useCallback(() => {}, []);
  const dragEnabled = props.onReparentRow !== undefined || props.onReorderRow !== undefined;
  const dragController = usePhaseSidebarDrag({
    rows: props.rows,
    rowKeyFor: (row) => `${row.thread.environmentId}:${row.thread.id}`,
    onReparent: props.onReparentRow ?? noopReparent,
    onReorder: props.onReorderRow ?? noopReparent,
  });

  const handleRowGeometry = useCallback(
    (key: string, y: number, height: number, depth: number) => {
      dragController.registerGeometry(key, { y, height, depth });
    },
    [dragController],
  );

  // A dedicated grab handle rather than a long-press: long-press already opens
  // the row's context menu, and a pan that activates anywhere on the row fights
  // the list's scroll. The handle makes the intent unambiguous.
  const dragHandleFor = useCallback(
    (rowKey: string) => {
      const gesture = Gesture.Pan()
        .activateAfterLongPress(0)
        .onStart(() => {
          runOnJS(dragController.beginDrag)(rowKey);
        })
        .onUpdate((event) => {
          runOnJS(dragController.updateDrag)(event.absoluteY);
        })
        .onEnd(() => {
          runOnJS(dragController.endDrag)();
        })
        .onFinalize(() => {
          runOnJS(dragController.cancelDrag)();
        });
      return (
        <GestureDetector gesture={gesture}>
          <View className="ml-1 shrink-0 px-1 py-1">
            <Text className="font-t3-mono text-[11px] text-muted-foreground">≡</Text>
          </View>
        </GestureDetector>
      );
    },
    [dragController],
  );

  const handleToggleExpanded = useCallback((row: PhaseSidebarRow) => {
    setCollapsedKeys((current) => {
      const key = `${row.thread.environmentId}:${row.thread.id}`;
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleToggleSection = useCallback(
    (section: PhaseSidebarSection) =>
      onChangeGrouping((current) => togglePhaseSidebarSectionCollapsed(current, section.key)),
    [onChangeGrouping],
  );

  const sectionMenuFor = useCallback(
    (section: PhaseSidebarSection, index: number): MenuAction[] => {
      const customIndex = grouping.customGroups.findIndex((group) => group.id === section.id);
      const manual = grouping.groupOrder === "manual";
      void index;
      return [
        { id: "rename", title: "Rename group", image: "pencil" },
        ...(manual
          ? [
              {
                id: "move-up",
                title: "Move up",
                image: "arrow.up",
                attributes: { disabled: customIndex <= 0 },
              },
              {
                id: "move-down",
                title: "Move down",
                image: "arrow.down",
                attributes: { disabled: customIndex >= grouping.customGroups.length - 1 },
              },
            ]
          : []),
        {
          id: "delete",
          title: "Delete group",
          image: "trash",
          attributes: { destructive: true },
        },
      ];
    },
    [grouping.customGroups, grouping.groupOrder],
  );

  const renderSectionHeader = (section: PhaseSidebarSection, collapsed: boolean, index: number) => {
    const phaseId = phaseSidebarSectionPhase(section);
    const { summary } = section;
    const header = (
      <Pressable
        accessibilityLabel={`${section.label}, ${section.nodes.length} session${section.nodes.length === 1 ? "" : "s"}${collapsed ? ", collapsed" : ""}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        className="flex-row items-center gap-2 px-4 pb-1.5 pt-4"
        onPress={() => handleToggleSection(section)}
      >
        <SymbolView
          name={collapsed ? "chevron.right" : "chevron.down"}
          size={10}
          tintColor={mutedColor}
          type="monochrome"
        />
        <Text
          className={cn(
            "font-t3-bold text-[11px] uppercase tracking-wide",
            phaseId === null ? "text-foreground/80" : phaseSidebarSectionToneClassName(phaseId),
          )}
          numberOfLines={1}
        >
          {section.label}
        </Text>
        <Text className="min-w-0 flex-1 text-[10px] text-muted-foreground" numberOfLines={1}>
          {section.helperText}
        </Text>
        {collapsed && summary.attention > 0 ? (
          <Text className="rounded-full bg-rose-500/15 px-1.5 font-t3-mono text-[10px] text-rose-700 dark:text-rose-300">
            {summary.attention}
          </Text>
        ) : null}
        {collapsed && summary.running > 0 ? (
          <Text className="rounded-full bg-sky-500/15 px-1.5 font-t3-mono text-[10px] text-sky-700 dark:text-sky-300">
            {summary.running}
          </Text>
        ) : null}
        {collapsed && summary.unread > 0 ? (
          <Text className="rounded-full bg-emerald-500/15 px-1.5 font-t3-mono text-[10px] text-emerald-700 dark:text-emerald-300">
            {summary.unread}
          </Text>
        ) : null}
        <Text className="font-t3-mono text-[10px] text-muted-foreground">
          {section.nodes.length}
        </Text>
      </Pressable>
    );
    if (section.kind !== "custom" || section.isUngrouped) return header;
    // A custom group's header is also where it is managed: hold for rename,
    // reorder and delete, the same way a row is managed.
    return (
      <ControlPillMenu
        actions={sectionMenuFor(section, index)}
        isAnchoredToRight
        onPressAction={(event: NativeActionEvent) =>
          onSectionAction(section, event.nativeEvent.event as PhaseSidebarSectionActionId)
        }
        shouldOpenOnLongPress
        title={section.label}
      >
        {header}
      </ControlPillMenu>
    );
  };

  return (
    <SwipeableScrollGateProvider enabled={swipeEnabled}>
      <FlatList
        ListEmptyComponent={props.ListEmptyComponent}
        ListHeaderComponent={props.ListHeaderComponent}
        automaticallyAdjustsScrollIndicatorInsets={
          props.contentInsetAdjustmentBehavior === "automatic"
        }
        contentContainerStyle={props.contentContainerStyle}
        contentInsetAdjustmentBehavior={props.contentInsetAdjustmentBehavior ?? "never"}
        data={items}
        initialNumToRender={24}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.key}
        renderItem={({ item, index }) =>
          item.kind === "section" ? (
            renderSectionHeader(item.section, item.collapsed, index)
          ) : (
            <PhaseSidebarRowView
              dragHandle={dragEnabled ? dragHandleFor(item.node.key) : undefined}
              dropRejectionLabel={dragController.drag?.rejectionLabel ?? null}
              indentDepth={item.node.depth}
              isDragging={dragController.drag?.subjectKey === item.node.key}
              isDropTarget={dragController.drag?.intent.targetKey === item.node.key}
              onLayoutGeometry={handleRowGeometry}
              rowKey={item.node.key}
              isActive={props.activeThreadKey === item.node.key}
              isExpanded={isExpanded(item.node.key)}
              actions={rowActionsFor(item.node.row, item.node.key)}
              onPress={props.onSelectRow}
              onPressAction={props.onRowAction}
              onToggleExpanded={handleToggleExpanded}
              row={item.node.row}
              subtreeCount={item.node.descendantCount}
              swipe={resolveRowSwipe(item.node.row, nowIso, snoozeMenu)}
              viewerUserId={props.viewerUserId}
              worktreeView={worktreeView}
            />
          )
        }
        showsVerticalScrollIndicator={false}
        {...scrollGateHandlers}
        scrollEventThrottle={16}
        windowSize={11}
      />
    </SwipeableScrollGateProvider>
  );
}
