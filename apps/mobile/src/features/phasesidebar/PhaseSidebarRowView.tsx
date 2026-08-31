// T3-CUSTOM(expbkt3): one thread row in the mobile phase sidebar.
//
// The metadata lane is the whole point of this sidebar, so it carries the same
// facts as web: repository, worktree codename, Linear tag, Mattermost mark, PR
// number, priority, owner, provider and relative time. Every one of those is
// resolved by client-runtime; this component only lays them out.
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
import { memo, useCallback } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import {
  phaseSidebarCheckoutToneClassName,
  phaseSidebarPriorityToneClassName,
} from "./phaseSidebarRowTone";

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
  readonly onToggleExpanded: (row: PhaseSidebarRow) => void;
}

/** One indent step, kept small: a phone has no horizontal room to spare. */
const INDENT_STEP = 14;

export const PhaseSidebarRowView = memo(function PhaseSidebarRowView(
  props: PhaseSidebarRowViewProps,
) {
  const { row, worktreeView } = props;
  const thread = row.thread;
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
  const handlePressAction = useCallback(
    (event: NativeActionEvent) => props.onPressAction(row, event.nativeEvent.event),
    [props, row],
  );
  const handleToggle = useCallback(() => props.onToggleExpanded(row), [props, row]);

  return (
    <ControlPillMenu actions={props.actions} isAnchoredToRight onPressAction={handlePressAction}>
      <Pressable
        className={cn("flex-row items-start gap-2 px-3 py-2", props.isActive && "bg-primary/10")}
        onPress={handlePress}
        style={{ paddingLeft: 12 + props.indentDepth * INDENT_STEP }}
      >
        {props.subtreeCount > 0 ? (
          <Pressable
            className="mt-0.5 flex-row items-center gap-0.5"
            hitSlop={8}
            onPress={handleToggle}
          >
            <Text className="font-t3-mono text-[10px] text-muted-foreground">
              {props.isExpanded ? "⌄" : "›"}
            </Text>
            <Text className="font-t3-mono text-[10px] text-muted-foreground">
              {props.subtreeCount}
            </Text>
          </Pressable>
        ) : null}

        {row.isUnreadCompletion ? (
          <View className="mt-1.5 h-2 w-2 rounded-full bg-emerald-500" />
        ) : null}

        <View className="min-w-0 flex-1">
          <View className="flex-row items-baseline gap-2">
            <Text
              className={cn(
                "min-w-0 flex-1 text-sm",
                row.isUnreadCompletion ? "font-t3-bold text-foreground" : "text-foreground/90",
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            <Text className="shrink-0 font-t3-mono text-[10px] text-muted-foreground">
              {compactPhaseSidebarTimeLabel(thread.updatedAt)}
            </Text>
          </View>

          {/* The metadata lane. Order matches web so the two read the same. */}
          <View className="mt-0.5 flex-row items-center gap-2">
            <Text
              className="shrink-0 font-t3-mono text-[10px] text-muted-foreground"
              numberOfLines={1}
            >
              {row.repositoryLabel}
            </Text>
            {worktree.worktreeCodename === null ? null : (
              <Text
                className={cn(
                  "shrink-0 font-t3-mono text-[10px]",
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
                className="shrink-0 font-t3-mono text-[10px] text-muted-foreground"
                numberOfLines={1}
              >
                {linearIssue.identifier}
              </Text>
            )}
            {mattermost === null ? null : (
              <Text className="shrink-0 font-t3-mono text-[10px] text-sky-600 dark:text-sky-300">
                mm
              </Text>
            )}

            <View className="flex-1" />

            {priority === null || !row.prioritySupported ? null : (
              <Text
                className={cn(
                  "shrink-0 overflow-hidden rounded px-1 font-t3-mono text-[10px]",
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
            <Text className="shrink-0 font-t3-mono text-[10px] uppercase text-muted-foreground">
              {providerCode}
            </Text>
          </View>
        </View>
      </Pressable>
    </ControlPillMenu>
  );
});
