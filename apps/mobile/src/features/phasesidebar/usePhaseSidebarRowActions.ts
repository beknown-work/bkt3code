// T3-CUSTOM(expbkt3): the long-press action set for a sidebar row.
//
// Every action is capability-gated by the row model, so an older server simply
// offers fewer items rather than failing an RPC. Each action that can be
// entered can also be left — settle/unsettle, snooze/unsnooze, pin/unpin — per
// the fork's rule that a one-way door is a bug.
import {
  phaseSidebarCanForceStopAgent,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

export type PhaseSidebarRowActionId =
  | "people"
  | "settle"
  | "unsettle"
  | "snooze"
  | "unsnooze"
  | "pin"
  | "unpin"
  | "archive"
  | "force-stop"
  | `priority:${number}`;

export interface PhaseSidebarRowAction {
  readonly id: PhaseSidebarRowActionId;
  readonly title: string;
  /** SF Symbol name; Android falls back to its own mapping. */
  readonly image: string;
  readonly destructive?: boolean;
}

/**
 * The actions to offer for one row, in the order a thumb should meet them:
 * people first because tagging is the most common reason to long-press, then
 * lifecycle, then the destructive ones last.
 */
export function buildPhaseSidebarRowActions(input: {
  readonly row: PhaseSidebarRow;
  readonly now: string;
  /**
   * Mobile has no auto-settle setting of its own, so null: a row is settled
   * only when the server says so, never because a timer elapsed locally.
   */
  readonly autoSettleAfterDays?: number | null;
}): ReadonlyArray<PhaseSidebarRowAction> {
  const { row } = input;
  const thread = row.thread;
  const actions: PhaseSidebarRowAction[] = [{ id: "people", title: "People", image: "person.2" }];

  if (row.settlementSupported) {
    const settled = effectiveSettled(thread, {
      now: input.now,
      autoSettleAfterDays: input.autoSettleAfterDays ?? null,
    });
    actions.push(
      settled
        ? { id: "unsettle", title: "Reopen", image: "arrow.uturn.backward" }
        : { id: "settle", title: "Settle", image: "checkmark.circle" },
    );
  }

  if (row.snoozeSupported) {
    const snoozed = effectiveSnoozed(thread, { now: input.now });
    actions.push(
      snoozed
        ? { id: "unsnooze", title: "Wake", image: "bell" }
        : { id: "snooze", title: "Snooze", image: "clock" },
    );
  }

  actions.push(
    thread.pinnedAt == null
      ? { id: "pin", title: "Pin", image: "pin" }
      : { id: "unpin", title: "Unpin", image: "pin.slash" },
  );

  if (row.prioritySupported) {
    for (const choice of PHASE_SIDEBAR_PRIORITY_CHOICES) {
      actions.push({
        id: `priority:${choice.value}`,
        title: choice.label,
        image: "flag",
      });
    }
  }

  if (phaseSidebarCanForceStopAgent(thread.session)) {
    actions.push({
      id: "force-stop",
      title: "Force stop agent",
      image: "stop.circle",
      destructive: true,
    });
  }

  actions.push({ id: "archive", title: "Archive", image: "archivebox", destructive: true });
  return actions;
}
