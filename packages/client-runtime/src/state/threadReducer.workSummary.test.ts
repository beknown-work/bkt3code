// T3-CUSTOM(expbkt3): active-thread work summary stream coverage for the composer player.
import { describe, expect, it } from "vite-plus/test";

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const threadId = ThreadId.make("thread-summary");
const requestedAt = "2026-09-17T10:00:00.000Z";
const requestId = CommandId.make("summary-request-current");

const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-summary"),
  title: "Summary test",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  sourceControlProfileId: null,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  ownerUserId: null,
  memberUserIds: [],
  createdAt: requestedAt,
  updatedAt: requestedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  rollingSummary: null,
  workSummary: null,
  turnSummaries: [],
  session: null,
};

const eventFields = {
  eventId: EventId.make("event-summary"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: requestedAt,
} as const;

function requested(id: CommandId, sequence: number): OrchestrationEvent {
  return {
    ...eventFields,
    sequence,
    type: "thread.work-summary-requested",
    payload: { threadId, requestId: id, requestedAt },
  };
}

function updated(id: CommandId, sequence: number): OrchestrationEvent {
  return {
    ...eventFields,
    sequence,
    type: "thread.work-summary-updated",
    payload: {
      threadId,
      requestId: id,
      workSummary: {
        status: "ready",
        summary: "The requested spoken summary is ready.",
        stage: "done",
        remaining: "",
        percent: 100,
        error: null,
        requestId: id,
        updatedAt: requestedAt,
      },
    },
  };
}

describe("active thread work summary events", () => {
  it("moves the live detail from pending to ready", () => {
    const pending = applyThreadDetailEvent(thread, requested(requestId, 1));
    expect(pending.kind).toBe("updated");
    if (pending.kind !== "updated") return;
    expect(pending.thread.workSummary).toMatchObject({ status: "pending", requestId });

    const ready = applyThreadDetailEvent(pending.thread, updated(requestId, 2));
    expect(ready.kind).toBe("updated");
    if (ready.kind !== "updated") return;
    expect(ready.thread.workSummary).toMatchObject({
      status: "ready",
      requestId,
      summary: "The requested spoken summary is ready.",
    });
  });

  it("ignores a superseded request's late result", () => {
    const latestRequestId = CommandId.make("summary-request-latest");
    const pending = applyThreadDetailEvent(thread, requested(latestRequestId, 2));
    if (pending.kind !== "updated") throw new Error("expected pending work summary");

    expect(applyThreadDetailEvent(pending.thread, updated(requestId, 3))).toEqual({
      kind: "unchanged",
    });
  });
});
