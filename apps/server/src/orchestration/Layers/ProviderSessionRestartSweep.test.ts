import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "../decider.ts";
import {
  buildRestartPrompt,
  collectOpenBlockingRequests,
  findLatestUserPrompt,
  isStaleProviderSession,
  shouldRestartInterruptedTurn,
  stalePendingRequestDetailForRestart,
} from "./ProviderSessionRestartSweep.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeSession(
  status: OrchestrationSession["status"],
  activeTurnId: TurnId | null = null,
): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: NOW,
  };
}

function activity(
  kind: string,
  requestId: string,
  payload: Record<string, unknown> = {},
): OrchestrationThread["activities"][number] {
  return {
    id: EventId.make(`activity-${kind}-${requestId}`),
    tone: "approval" as const,
    kind,
    summary: kind,
    payload: { requestId, ...payload },
    turnId: null,
    createdAt: NOW,
  } as OrchestrationThread["activities"][number];
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } as OrchestrationThread;
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  };
}

describe("isStaleProviderSession", () => {
  it("selects sessions the projection still believes are live", () => {
    expect(isStaleProviderSession(makeThread({ session: makeSession("running") }))).toBe(true);
    expect(isStaleProviderSession(makeThread({ session: makeSession("starting") }))).toBe(true);
  });

  it("selects a settled-looking session that is still pinned to a turn", () => {
    // The status looks healthy but activeTurnId keeps the UI on "Working" and
    // makes the reaper skip the thread forever.
    expect(
      isStaleProviderSession(makeThread({ session: makeSession("ready", TurnId.make("turn-1")) })),
    ).toBe(true);
  });

  it("ignores idle, stopped and deleted threads", () => {
    expect(isStaleProviderSession(makeThread({ session: makeSession("ready") }))).toBe(false);
    expect(isStaleProviderSession(makeThread({ session: makeSession("stopped") }))).toBe(false);
    expect(isStaleProviderSession(makeThread({ session: null }))).toBe(false);
    expect(
      isStaleProviderSession(makeThread({ session: makeSession("running"), deletedAt: NOW })),
    ).toBe(false);
  });
});

describe("shouldRestartInterruptedTurn", () => {
  it("restarts a turn the provider had picked up", () => {
    expect(
      shouldRestartInterruptedTurn({
        session: makeSession("running", TurnId.make("turn-1")),
        activeTurnId: TurnId.make("turn-1"),
        latestTurnState: "running",
      }),
    ).toBe(true);
  });

  it("restarts a turn that never reached the provider", () => {
    // "starting" is the shape of a turn requested just before the restart:
    // the message exists, but no provider ever saw it.
    expect(
      shouldRestartInterruptedTurn({
        session: makeSession("starting"),
        activeTurnId: null,
        latestTurnState: null,
      }),
    ).toBe(true);
  });

  it("leaves an idle session alone", () => {
    expect(
      shouldRestartInterruptedTurn({
        session: makeSession("ready"),
        activeTurnId: null,
        latestTurnState: "completed",
      }),
    ).toBe(false);
  });
});

describe("collectOpenBlockingRequests", () => {
  it("returns requests with no later resolution", () => {
    const open = collectOpenBlockingRequests({
      activities: [
        activity("approval.requested", "req-1"),
        activity("user-input.requested", "req-2"),
      ],
    });
    expect(open).toEqual([
      { requestId: "req-1", kind: "approval" },
      { requestId: "req-2", kind: "user-input" },
    ]);
  });

  it("drops resolved and already-failed requests", () => {
    const open = collectOpenBlockingRequests({
      activities: [
        activity("approval.requested", "req-1"),
        activity("approval.resolved", "req-1"),
        activity("user-input.requested", "req-2"),
        activity("provider.user-input.respond.failed", "req-2", { detail: "boom" }),
        activity("approval.requested", "req-3"),
      ],
    });
    expect(open).toEqual([{ requestId: "req-3", kind: "approval" }]);
  });
});

it.layer(NodeServices.layer)("restart sweep decider contract", (it) => {
  it.effect("its released-request activity lets the decider settle the thread", () =>
    Effect.gen(function* () {
      // Pins the two duplications this module carries: the open-request scan
      // mirrored from the decider, and the stale-detail wording the decider
      // and projection pattern-match on. If either drifts, a swept thread
      // silently becomes unsettleable again.
      const openOnly = makeThread({
        activities: [activity("approval.requested", "req-1")],
      });
      expect(collectOpenBlockingRequests(openOnly).length).toBe(1);

      const blocked = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-blocked"),
          threadId: THREAD_ID,
        },
        readModel: makeReadModel(openOnly),
      }).pipe(Effect.flip);
      expect(blocked._tag).toBe("OrchestrationCommandInvariantError");

      const swept = makeThread({
        activities: [
          activity("approval.requested", "req-1"),
          activity("provider.approval.respond.failed", "req-1", {
            detail: stalePendingRequestDetailForRestart("approval", "req-1"),
          }),
        ],
      });
      expect(collectOpenBlockingRequests(swept)).toEqual([]);

      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-swept"),
          threadId: THREAD_ID,
        },
        readModel: makeReadModel(swept),
      });
      expect(settled).toBeDefined();
    }),
  );

  it.effect("releases user-input requests the same way", () =>
    Effect.gen(function* () {
      const swept = makeThread({
        activities: [
          activity("user-input.requested", "req-2"),
          activity("provider.user-input.respond.failed", "req-2", {
            detail: stalePendingRequestDetailForRestart("user-input", "req-2"),
          }),
        ],
      });
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-user-input"),
          threadId: THREAD_ID,
        },
        readModel: makeReadModel(swept),
      });
      expect(settled).toBeDefined();
    }),
  );
});

describe("restart prompt", () => {
  it("restates the interrupted request and warns about partial work", () => {
    const prompt = buildRestartPrompt("Refactor the billing module");
    expect(prompt).toContain("A server restart interrupted this session.");
    expect(prompt).toContain("Refactor the billing module");
    expect(prompt).toContain("check for partially completed work before redoing anything");
  });

  it("still asks the agent to continue when no prompt survived", () => {
    const prompt = buildRestartPrompt(null);
    expect(prompt).toContain("Continue the work that was in progress");
    expect(prompt).toContain("check for partially completed work before redoing anything");
  });

  it("truncates an oversized original prompt", () => {
    const prompt = buildRestartPrompt("x".repeat(10_000));
    expect(prompt).toContain("[...truncated]");
    expect(prompt.length).toBeLessThan(5_000);
  });

  it("quotes the newest user message", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("m1"),
          role: "user",
          text: "first",
          turnId: null,
          sentByUserId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: MessageId.make("m2"),
          role: "assistant",
          text: "working on it",
          turnId: null,
          sentByUserId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: MessageId.make("m3"),
          role: "user",
          text: "actually do this instead",
          turnId: null,
          sentByUserId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ] satisfies OrchestrationThread["messages"],
    });
    expect(findLatestUserPrompt(thread)).toBe("actually do this instead");
  });

  it("returns null when the thread has no user message", () => {
    expect(findLatestUserPrompt(makeThread())).toBe(null);
  });
});
