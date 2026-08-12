// T3-CUSTOM(expbkt3): title ownership decider coverage. A name the user typed
// has to survive the periodic refresh; a prompt-derived one must not, and the
// clients apply that one with the very same command.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

/** The decider returns one event or a list; every command here plans exactly one. */
function metaUpdatedPayload(result: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const event = Array.isArray(result) ? result[0] : (result as PlannedEvent);
  expect(event?.type).toBe("thread.meta-updated");
  if (!event) throw new Error("decider planned no event");
  return event.payload;
}

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(
  overrides: { readonly title?: string; readonly titleManuallySet?: boolean } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: overrides.title ?? "New thread",
        ...(overrides.titleManuallySet !== undefined
          ? { titleManuallySet: overrides.titleManuallySet }
          : {}),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        latestTurn: null,
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        priority: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        rollingSummary: null,
        turnSummaries: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const renameCommand = (commandId: string, title: string, titleOrigin?: "user" | "generated") =>
  ({
    type: "thread.meta.update",
    commandId: CommandId.make(commandId),
    threadId: THREAD_ID,
    title,
    ...(titleOrigin ? { titleOrigin } : {}),
  }) as const;

it.layer(NodeServices.layer)("thread title ownership decider", (it) => {
  it.effect("records a typed rename as manually set", () =>
    Effect.gen(function* () {
      const payload = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: renameCommand("cmd-rename-user", "Release checklist", "user"),
          readModel: makeReadModel(),
        }),
      );

      expect(payload).toMatchObject({
        title: "Release checklist",
        titleManuallySet: true,
      });
    }),
  );

  it.effect("hands ownership back to the generator", () =>
    Effect.gen(function* () {
      const payload = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: renameCommand("cmd-rename-generated", "Fix reconnect races", "generated"),
          readModel: makeReadModel({ title: "Release checklist", titleManuallySet: true }),
        }),
      );

      expect(payload).toMatchObject({
        title: "Fix reconnect races",
        titleManuallySet: false,
      });
    }),
  );

  it.effect("leaves ownership alone when the origin is unstated", () =>
    Effect.gen(function* () {
      // This is the clients' optimistic first-prompt title. It is derived from
      // the prompt, so it must stay replaceable by the generated one.
      const payload = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: renameCommand("cmd-seed", "Please investigate reconnect failures aft..."),
          readModel: makeReadModel(),
        }),
      );

      expect(payload).toMatchObject({ title: "Please investigate reconnect failures aft..." });
      expect(payload).not.toHaveProperty("titleManuallySet");
    }),
  );

  it.effect("a completed regeneration is a generated title", () =>
    Effect.gen(function* () {
      const requestId = CommandId.make("cmd-regen-request");
      const requested = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: requestId,
            threadId: THREAD_ID,
            regenerateTitle: true,
          },
          readModel: makeReadModel({ title: "Release checklist", titleManuallySet: true }),
        }),
      );
      expect(requested).toMatchObject({ regenerateTitle: true });

      const completed = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.title.regeneration.complete",
            commandId: CommandId.make("cmd-regen-complete"),
            threadId: THREAD_ID,
            requestId,
            title: "Ship the release checklist",
          },
          readModel: {
            ...makeReadModel({ title: "Release checklist", titleManuallySet: true }),
            threads: makeReadModel({
              title: "Release checklist",
              titleManuallySet: true,
            }).threads.map((thread) => ({
              ...thread,
              titleRegeneration: { requestId, startedAt: NOW },
            })),
          },
        }),
      );

      expect(completed).toMatchObject({
        title: "Ship the release checklist",
        titleManuallySet: false,
      });
    }),
  );

  it.effect("a superseded regeneration changes nothing", () =>
    Effect.gen(function* () {
      const payload = metaUpdatedPayload(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.title.regeneration.complete",
            commandId: CommandId.make("cmd-regen-stale"),
            threadId: THREAD_ID,
            requestId: CommandId.make("cmd-regen-other"),
            title: "Stale generated title",
          },
          readModel: makeReadModel({ title: "Release checklist", titleManuallySet: true }),
        }),
      );

      expect(payload).not.toHaveProperty("title");
      expect(payload).not.toHaveProperty("titleManuallySet");
    }),
  );
});
