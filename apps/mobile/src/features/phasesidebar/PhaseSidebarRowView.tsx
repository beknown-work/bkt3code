// T3-CUSTOM(expbkt3): one thread row in the mobile phase sidebar.
//
// The metadata lane is the whole point of this sidebar, so it carries the same
// facts as web: repository, worktree codename, Linear tag, Mattermost mark, PR
// number, priority, owner, provider and relative time. Every one of those is
// resolved by client-runtime; this component only lays them out.
//
// Interaction matches the stock thread list exactly, because that is what a
// thumb already knows: tap opens, hold opens the menu, swipe left reveals the
// lifecycle action (Settle / Reopen) and Snooze, and a full swipe commits the
// lifecycle action.
import {
  compactPhaseSidebarTimeLabel,
  formatThreadPriority,
  phaseSidebarRowOwnerAvatarUserId,
  phaseSidebarWorktreeRowProps,
  resolvePhaseSidebarLinearIssue,
  resolvePhaseSidebarMattermostLink,
  resolvePhaseSidebarProviderCode,
  type PhaseSidebarRow,
  type PhaseSidebarWorktreeView,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { worktreeCodenameToneIndex } from "@t3tools/shared/worktreeCodename";
import type { UserId } from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Pressable, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import {
  phaseSidebarCheckoutToneClassName,
  phaseSidebarPriorityToneClassName,
} from "./phaseSidebarRowTone";

/** What a swipe on this row does; resolved by the list from the row model. */
export interface PhaseSidebarRowSwipe {
  readonly primary: "settle" | "unsettle" | "archive" | "unsnooze";
  /** Snooze presets to offer from the swipe's secondary action; null hides it. */
  readonly snoozeMenu: MenuAction[] | null;
}

export interface PhaseSidebarRowViewProps {
  readonly row: PhaseSidebarRow;
  /** Whose avatar to omit: the row shows only *other* people's. */
  readonly viewerUserId: UserId | null;
  readonly worktreeView: PhaseSidebarWorktreeView;
  readonly indentDepth: number;
  readonly isActive: boolean;
  readonly subtreeCount: number;
  readonly isExpanded: boolean;
  readonly onPress: (row: PhaseSidebarRow) => void;
  /** Mutable because MenuView's prop type is not readonly. */
  readonly actions: MenuAction[];
  readonly onPressAction: (row: PhaseSidebarRow, actionId: string) => void;
  readonly swipe: PhaseSidebarRowSwipe;
  /** Reports this row's box so a drop can be resolved without measuring. */
  readonly onLayoutGeometry?: (key: string, y: number, height: number, depth: number) => void;
  readonly rowKey: string;
  readonly isDragging?: boolean;
  readonly isDropTarget?: boolean;
  readonly dropRejectionLabel?: string | null;
  /**
   * The grab affordance, supplied by the list because it owns the gesture.
   * Long-press is already the context menu, so dragging needs its own target.
   */
  readonly dragHandle?: ReactNode;
  readonly onToggleExpanded: (row: PhaseSidebarRow) => void;
}

/** One indent step, kept small: a phone has no horizontal room to spare. */
const INDENT_STEP = 14;

const PRIMARY_SWIPE: Record<
  PhaseSidebarRowSwipe["primary"],
  {
    readonly icon: "checkmark" | "arrow.uturn.backward" | "archivebox" | "clock";
    readonly label: string;
  }
> = {
  settle: { icon: "checkmark", label: "Settle" },
  unsettle: { icon: "arrow.uturn.backward", label: "Reopen" },
  archive: { icon: "archivebox", label: "Archive" },
  unsnooze: { icon: "clock", label: "Wake" },
};

export const PhaseSidebarRowView = memo(function PhaseSidebarRowView(
  props: PhaseSidebarRowViewProps,
) {
  const { row, worktreeView, onPressAction } = props;
  const thread = row.thread;
  const { width: windowWidth } = useWindowDimensions();
  const screenColor = String(useThemeColor("--color-screen"));
  const worktree = phaseSidebarWorktreeRowProps(worktreeView, thread.worktreePath);
  const linearIssue = row.linearIssueSupported
    ? resolvePhaseSidebarLinearIssue(thread.branch, thread.linearIssueUrl)
    : null;
  const mattermost = row.mattermostLinkSupported
    ? resolvePhaseSidebarMattermostLink(thread.mattermostThreadUrl)
    : null;
  const ownerAvatarUserId = phaseSidebarRowOwnerAvatarUserId({
    ownerUserId: thread.ownerUserId,
    currentUserId: props.viewerUserId,
  });
  const providerCode = resolvePhaseSidebarProviderCode(row.providerKind);
  const priority = thread.priority ?? null;

  const handlePress = useCallback(() => props.onPress(row), [props, row]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      props.onLayoutGeometry?.(props.rowKey, y, height, props.indentDepth);
    },
    [props],
  );
  const handlePressAction = useCallback(
    (event: NativeActionEvent) => onPressAction(row, event.nativeEvent.event),
    [onPressAction, row],
  );
  const handleToggle = useCallback(() => props.onToggleExpanded(row), [props, row]);

  const primary = PRIMARY_SWIPE[props.swipe.primary];
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `${primary.label} ${thread.title}`,
      icon: primary.icon,
      label: primary.label,
      onPress: () => onPressAction(row, props.swipe.primary),
    }),
    [onPressAction, primary, props.swipe.primary, row, thread.title],
  );
  const snoozeMenu = props.swipe.snoozeMenu;
  const secondaryAction = useMemo(
    () =>
      snoozeMenu === null
        ? null
        : {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozeMenu,
              onPressAction: handlePressAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          },
    [handlePressAction, snoozeMenu, thread.title],
  );
  const handleDelete = useCallback(() => onPressAction(row, "delete"), [onPressAction, row]);

  return (
    <ThreadSwipeable
      backgroundColor={screenColor}
      compactActions
      enableTrackpadSwipe
      fullSwipeAction="primary"
      fullSwipeWidth={windowWidth - 32}
      onDelete={handleDelete}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      resetKey={props.rowKey}
      threadTitle={thread.title}
    >
      {(close) => (
        <ControlPillMenu
          actions={props.actions}
          isAnchoredToRight
          onPressAction={handlePressAction}
          shouldOpenOnLongPress
        >
          <Pressable
            accessibilityHint={
              secondaryAction === null
                ? `Opens the thread. Swipe left to ${primary.label.toLowerCase()}.`
                : `Opens the thread. Swipe left for ${primary.label.toLowerCase()} and snooze.`
            }
            accessibilityLabel={thread.title}
            accessibilityRole="button"
            accessibilityState={{ selected: props.isActive }}
            className={cn(
              "min-h-[56px] flex-row items-start gap-2 bg-screen py-2.5 pr-3",
              props.isActive && "bg-primary/10",
              props.isDragging === true && "opacity-40",
              props.isDropTarget === true &&
                (props.dropRejectionLabel === null ? "bg-emerald-500/15" : "bg-rose-500/15"),
            )}
            onLayout={handleLayout}
            onPress={() => {
              close();
              handlePress();
            }}
            style={({ pressed }) => ({
              paddingLeft: 16 + props.indentDepth * INDENT_STEP,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            {props.subtreeCount > 0 ? (
              <Pressable
                className="mt-0.5 flex-row items-center gap-0.5"
                hitSlop={8}
                onPress={handleToggle}
              >
                <Text className="font-t3-mono text-[11px] text-muted-foreground">
                  {props.isExpanded ? "⌄" : "›"}
                </Text>
                <Text className="font-t3-mono text-[11px] text-muted-foreground">
                  {props.subtreeCount}
                </Text>
              </Pressable>
            ) : null}

            {row.isUnreadCompletion ? (
              <View className="mt-2 h-2 w-2 rounded-full bg-emerald-500" />
            ) : null}

            <View className="min-w-0 flex-1">
              <View className="flex-row items-baseline gap-2">
                <Text
                  className={cn(
                    "min-w-0 flex-1 text-[15px] leading-5",
                    row.isUnreadCompletion
                      ? "font-t3-bold text-foreground"
                      : "font-t3-medium text-foreground/90",
                  )}
                  numberOfLines={2}
                >
                  {thread.title}
                </Text>
                <Text className="shrink-0 font-t3-mono text-[11px] text-muted-foreground">
                  {compactPhaseSidebarTimeLabel(thread.updatedAt)}
                </Text>
              </View>

              {/* The metadata lane. Order matches web so the two read the same. */}
              <View className="mt-1 flex-row items-center gap-2">
                <Text
                  className="shrink font-t3-mono text-[11px] text-muted-foreground"
                  numberOfLines={1}
                >
                  {row.repositoryLabel}
                </Text>
                {worktree.worktreeCodename === null ? null : (
                  <Text
                    className={cn(
                      "shrink-0 font-t3-mono text-[11px]",
                      phaseSidebarCheckoutToneClassName(
                        worktreeCodenameToneIndex(worktree.worktreeCodename),
                      ),
                    )}
                    numberOfLines={1}
                  >
                    {worktree.worktreeCodename}
                    {worktree.worktreeSharedCount > 0 ? ` ×${worktree.worktreeSharedCount}` : ""}
                  </Text>
                )}
                {linearIssue === null ? null : (
                  <Text
                    className="shrink-0 font-t3-mono text-[11px] text-muted-foreground"
                    numberOfLines={1}
                  >
                    {linearIssue.identifier}
                  </Text>
                )}
                {mattermost === null ? null : (
                  <Text className="shrink-0 font-t3-mono text-[11px] text-sky-600 dark:text-sky-300">
                    mm
                  </Text>
                )}

                <View className="flex-1" />

                {priority === null || !row.prioritySupported ? null : (
                  <Text
                    className={cn(
                      "shrink-0 overflow-hidden rounded px-1 font-t3-mono text-[11px]",
                      phaseSidebarPriorityToneClassName(priority),
                    )}
                  >
                    {formatThreadPriority(priority)}
                  </Text>
                )}
                {ownerAvatarUserId === null ? null : (
                  <View className="h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/70">
                    <Text className="font-t3-mono text-[8px] text-primary-foreground">
                      {ownerAvatarUserId.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text className="shrink-0 font-t3-mono text-[11px] uppercase text-muted-foreground">
                  {providerCode}
                </Text>
                {props.dragHandle}
              </View>
            </View>
          </Pressable>
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  );
});
