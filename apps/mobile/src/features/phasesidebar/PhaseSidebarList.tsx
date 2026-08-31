// T3-CUSTOM(expbkt3): the mobile phase-grouped sidebar list.
//
// Grouping, nesting, filtering and sorting are all decided by client-runtime, so
// this component owns exactly two things: expansion state, and turning the
// resulting tree into a flat list a FlatList can render efficiently. Rendering
// the tree as one flat array matters on a phone — a nested render tree of
// hundreds of rows drops frames on scroll.
import {
  buildPhaseSidebarTreeGroups,
  flattenPhaseSidebarTree,
  type PhaseSidebarTreeNode,
} from "@t3tools/client-runtime/state/phase-sidebar-tree";
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
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  type SidebarThreadSortOrder,
  type UserId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo, useState } from "react";
import { FlatList, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { PhaseSidebarRowView } from "./PhaseSidebarRowView";
import { phaseSidebarSectionToneClassName } from "./phaseSidebarRowTone";
import { buildPhaseSidebarRowActions } from "./usePhaseSidebarRowActions";

/** A flattened list entry: either a lifecycle header or a thread row. */
type PhaseSidebarListItem =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly phaseId: PhaseSidebarRow["phaseId"];
      readonly label: string;
      readonly helperText: string;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly node: PhaseSidebarTreeNode;
    };

export interface PhaseSidebarListProps {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly viewerUserId: UserId | null;
  readonly activeThreadKey: string | null;
  readonly filters?: PhaseSidebarFilters;
  readonly sort?: PhaseSidebarSortPreferences;
  readonly sortOrder?: SidebarThreadSortOrder;
  readonly onSelectRow: (row: PhaseSidebarRow) => void;
  /** Fired with the chosen action id from the row's long-press menu. */
  readonly onRowAction: (row: PhaseSidebarRow, actionId: string) => void;
  readonly ListHeaderComponent?: React.ComponentProps<typeof FlatList>["ListHeaderComponent"];
}

export function PhaseSidebarList(props: PhaseSidebarListProps) {
  const filters = props.filters ?? EMPTY_PHASE_SIDEBAR_FILTERS;
  const sort = props.sort ?? DEFAULT_PHASE_SIDEBAR_SORT;
  const sortOrder = props.sortOrder ?? DEFAULT_SIDEBAR_THREAD_SORT_ORDER;
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const worktreeView = useMemo(
    // Resolved across the whole set, not per row: codenames disambiguate against
    // each other and occupancy is a count.
    () => resolvePhaseSidebarWorktreeView(props.rows.map((row) => row.thread)),
    [props.rows],
  );

  const { groups, forcedExpansionKeys } = useMemo(
    () =>
      buildPhaseSidebarTreeGroups({
        rows: props.rows,
        filters,
        compareSiblings: (left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort),
      }),
    [filters, props.rows, sort, sortOrder],
  );

  // Parents default to open, so a session tree is visible without hunting. A
  // filter can force a parent open; that never touches the user's own state.
  const isExpanded = useCallback(
    (key: string) => forcedExpansionKeys.has(key) || !collapsedKeys.has(key),
    [collapsedKeys, forcedExpansionKeys],
  );

  const items = useMemo<ReadonlyArray<PhaseSidebarListItem>>(() => {
    const flat: PhaseSidebarListItem[] = [];
    for (const group of groups) {
      if (group.nodes.length === 0) continue;
      flat.push({
        kind: "section",
        key: `section:${group.id}`,
        phaseId: group.id,
        label: group.label,
        helperText: group.helperText,
        count: group.nodes.length,
      });
      for (const node of flattenPhaseSidebarTree(group.nodes, isExpanded)) {
        flat.push({ kind: "row", key: node.key, node });
      }
    }
    return flat;
  }, [groups, isExpanded]);

  const nowIso = useMemo(() => new Date().toISOString(), [props.rows]);
  const rowActionsFor = useCallback(
    (row: PhaseSidebarRow): MenuAction[] =>
      buildPhaseSidebarRowActions({ row, now: nowIso }).map((action) => ({
        id: action.id,
        title: action.title,
        image: action.image,
        attributes: action.destructive === true ? { destructive: true } : undefined,
      })),
    [nowIso],
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

  return (
    <FlatList
      ListHeaderComponent={props.ListHeaderComponent}
      data={items}
      initialNumToRender={24}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) =>
        item.kind === "section" ? (
          <View className="flex-row items-center gap-2 px-3 pb-1 pt-3">
            <Text
              className={cn(
                "font-t3-bold text-[11px] uppercase tracking-wide",
                phaseSidebarSectionToneClassName(item.phaseId),
              )}
            >
              {item.label}
            </Text>
            <Text className="min-w-0 flex-1 text-[10px] text-muted-foreground" numberOfLines={1}>
              {item.helperText}
            </Text>
            <Text className="font-t3-mono text-[10px] text-muted-foreground">{item.count}</Text>
          </View>
        ) : (
          <PhaseSidebarRowView
            indentDepth={item.node.depth}
            isActive={props.activeThreadKey === item.node.key}
            isExpanded={isExpanded(item.node.key)}
            actions={rowActionsFor(item.node.row)}
            onPress={props.onSelectRow}
            onPressAction={props.onRowAction}
            onToggleExpanded={handleToggleExpanded}
            row={item.node.row}
            subtreeCount={item.node.descendantCount}
            viewerUserId={props.viewerUserId}
            worktreeView={worktreeView}
          />
        )
      }
      windowSize={11}
    />
  );
}
