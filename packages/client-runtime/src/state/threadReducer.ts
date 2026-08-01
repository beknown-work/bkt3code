import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import { computeTurnDurationMs } from "@t3tools/contracts";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationTurnCatchupSummary,
  TurnId,
} from "@t3tools/contracts";

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | { readonly kind: "unchanged" };

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const turnSummaryOrder = O.mapInput(
  O.String,
  (summary: OrchestrationTurnCatchupSummary) => summary.createdAt,
);

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
): ThreadDetailReducerResult {
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          ownerUserId: event.payload.createdByUserId ?? null,
          memberUserIds: [],
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          rollingSummary: null,
          turnSummaries: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          titleRegeneration: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    case "thread.settled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: "settled",
          settledAt: event.payload.settledAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsettled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: event.payload.reason === "user" ? "active" : null,
          settledAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.snoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsnoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.titleRegeneration !== undefined
            ? { titleRegeneration: event.payload.titleRegeneration }
            : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          // T3-CUSTOM(expbkt3): session priority.
          ...(event.payload.priority !== undefined ? { priority: event.payload.priority } : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.member-added":
      return thread.memberUserIds.includes(event.payload.userId)
        ? { kind: "unchanged" }
        : {
            kind: "updated",
            thread: {
              ...thread,
              memberUserIds: [...thread.memberUserIds, event.payload.userId],
              updatedAt: event.payload.addedAt,
            },
          };

    case "thread.member-removed":
      return thread.memberUserIds.includes(event.payload.userId)
        ? {
            kind: "updated",
            thread: {
              ...thread,
              memberUserIds: thread.memberUserIds.filter((id) => id !== event.payload.userId),
              updatedAt: event.payload.removedAt,
            },
          }
        : { kind: "unchanged" };

    case "thread.owner-transferred": {
      const memberUserIds = thread.memberUserIds.filter((id) => id !== event.payload.ownerUserId);
      if (
        event.payload.previousOwnerUserId !== null &&
        event.payload.previousOwnerUserId !== event.payload.ownerUserId &&
        !memberUserIds.includes(event.payload.previousOwnerUserId)
      ) {
        memberUserIds.push(event.payload.previousOwnerUserId);
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          ownerUserId: event.payload.ownerUserId,
          memberUserIds,
          updatedAt: event.payload.transferredAt,
        },
      };
    }

    case "project.member-added":
    case "project.member-removed":
    case "project.owner-transferred":
      return { kind: "unchanged" };

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            durationMs: computeTurnDurationMs(
              latestTurn.startedAt ?? event.payload.createdAt,
              latestTurn.completedAt ?? event.payload.createdAt,
            ),
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        sentByUserId: event.payload.sentByUserId ?? null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      const existingMessage = thread.messages.find((entry) => entry.id === message.id);
      const messages = existingMessage
        ? Arr.map(thread.messages, (entry) =>
            entry.id !== message.id
              ? entry
              : {
                  ...entry,
                  text: message.streaming
                    ? `${entry.text}${message.text}`
                    : message.text.length > 0
                      ? message.text
                      : entry.text,
                  streaming: message.streaming,
                  ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                  ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                  ...(message.attachments !== undefined
                    ? { attachments: message.attachments }
                    : {}),
                },
          )
        : Arr.append(thread.messages, message);
      // Messages can annotate a turn, but they cannot settle it. Only an
      // observed execution transition has lifecycle authority.
      const messageTurnStartedAt =
        thread.latestTurn?.turnId === event.payload.turnId
          ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
          : event.payload.createdAt;
      const messageTurnCompletedAt =
        thread.latestTurn?.turnId === event.payload.turnId
          ? (thread.latestTurn.completedAt ?? null)
          : null;
      const latestTurn: OrchestrationThread["latestTurn"] =
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: thread.latestTurn?.state ?? "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt: messageTurnStartedAt,
              completedAt: messageTurnCompletedAt,
              assistantMessageId: event.payload.messageId,
              durationMs: computeTurnDurationMs(messageTurnStartedAt, messageTurnCompletedAt),
            }
          : thread.latestTurn;

      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.session-stop-requested":
    case "thread.session-restart-requested":
      // An intent receipt is not a lifecycle observation. The execution
      // snapshot (and, for internal cleanup, a later session-set event) owns
      // the visible state transition.
      return { kind: "unchanged" };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, checkpoints, updatedAt: event.occurredAt },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds);
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      );
      // Drop catch-up cards for turns the revert removed.
      const turnSummaries = pipe(
        thread.turnSummaries,
        Arr.filter((entry) => retainedTurnIds.has(entry.turnId)),
      );
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          turnSummaries,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  // Reverted turns collapse to a single checkpoint instant.
                  durationMs: 0,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Catch-up summaries ──────────────────────────────────────────
    case "thread.catchup-summary-updated": {
      // A null rolling summary means "unchanged" (e.g. the pending marker).
      const rollingSummary = event.payload.rollingSummary ?? thread.rollingSummary;
      const withoutTurn = pipe(
        thread.turnSummaries,
        Arr.filter((entry) => entry.turnId !== event.payload.turnId),
      );

      // "cleared" retracts the card for a below-cutoff turn. Failures remain
      // present as an "error" summary so the user can retry in place.
      if (event.payload.progress === "cleared") {
        return {
          kind: "updated",
          thread: { ...thread, rollingSummary, turnSummaries: withoutTurn },
        };
      }

      const turnSummaries = pipe(
        withoutTurn,
        Arr.append({
          turnId: event.payload.turnId,
          assistantMessageId: event.payload.assistantMessageId,
          summary: event.payload.displaySummary,
          status: event.payload.progress,
          createdAt: event.payload.createdAt,
        }),
        Arr.sort(turnSummaryOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, rollingSummary, turnSummaries },
      };
    }

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.id !== event.payload.activity.id),
        Arr.append(event.payload.activity),
        Arr.sort(activityOrder),
      );

      return {
        kind: "updated",
        thread: { ...thread, activities, updatedAt: event.occurredAt },
      };
    }

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}
