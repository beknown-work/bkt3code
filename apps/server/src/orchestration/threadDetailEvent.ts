/**
 * Events that mutate the live thread-detail document delivered to clients.
 *
 * T3-CUSTOM(expbkt3): Keep catch-up summary progress in this routing list.
 * The projection can persist a summary successfully while an already-open
 * thread remains stale if its event is omitted here.
 */
import type { OrchestrationEvent } from "@t3tools/contracts";

export type ThreadDetailEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.catchup-summary-updated"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.member-added"
      | "thread.member-removed"
      | "thread.owner-transferred";
  }
>;

export function isThreadDetailEvent(event: OrchestrationEvent): event is ThreadDetailEvent {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.catchup-summary-updated" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type === "thread.member-added" ||
    event.type === "thread.member-removed" ||
    event.type === "thread.owner-transferred"
  );
}
