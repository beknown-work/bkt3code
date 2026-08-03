import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryLive,
} from "./DurableExecutionIntentRepository.ts";

const layer = it.layer(
  DurableExecutionIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("DurableExecutionIntentRepository", (it) => {
  it.effect("persists an exact accepted request once by command id", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const acceptedAt = "2026-01-01T00:00:00.000Z";
      const event = {
        type: "thread.turn-start-requested" as const,
        sequence: 42,
        eventId: EventId.make("event-1"),
        aggregateKind: "thread" as const,
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: acceptedAt,
        commandId: CommandId.make("command-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("command-1"),
        actor: "client" as const,
        metadata: { actorUserId: UserId.make("user-1") },
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          bootstrap: {
            runSetupScript: true,
            resolvedRequest: {
              bootstrapId: "bootstrap-command-1",
              threadId: ThreadId.make("thread-1"),
              projectId: ProjectId.make("project-1"),
              title: "Durable thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              workspace: {
                mode: "new-worktree" as const,
                projectCwd: "/workspace/project",
                baseRef: { kind: "repository-default" as const, source: "origin" as const },
                newBranch: "t3code/durable-command-1",
                intendedPath: "/workspace/worktrees/durable-command-1",
              },
              initialTurn: {
                messageId: MessageId.make("message-1"),
                text: "exact request",
                attachments: [],
              },
              sourceControlProfileId: null,
              priority: null,
              createdAt: acceptedAt,
            },
          },
          createdAt: acceptedAt,
        },
      };
      const message = {
        messageId: MessageId.make("message-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: null,
        role: "user" as const,
        text: "exact request",
        attachments: [],
        isStreaming: false,
        sentByUserId: UserId.make("user-1"),
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      };

      yield* repository.acceptFromEvent({ event, message });
      yield* repository.acceptFromEvent({ event, message });

      const stored = yield* repository.getByWorkItemId({ workItemId: "command-1" });
      assert.isTrue(stored._tag === "Some");
      if (stored._tag === "None") return;
      assert.strictEqual(stored.value.commandId, "command-1");
      assert.strictEqual(stored.value.requestEventSequence, 42);
      assert.strictEqual(stored.value.messageText, "exact request");
      assert.deepStrictEqual(stored.value.modelSelection, event.payload.modelSelection);
      assert.deepStrictEqual(stored.value.bootstrap, event.payload.bootstrap);
      assert.strictEqual(stored.value.actingUserId, "user-1");
      assert.strictEqual(stored.value.phase, "queued");
      assert.strictEqual(stored.value.recoveryAttempts, 0);

      const threadItems = yield* repository.listByThreadId({
        threadId: ThreadId.make("thread-1"),
      });
      assert.lengthOf(threadItems, 1);

      const bootstrap = yield* repository.getBootstrapOperation({ workItemId: "command-1" });
      assert.isTrue(bootstrap._tag === "Some");
      if (bootstrap._tag === "None") return;
      assert.strictEqual(bootstrap.value.worktreePhase, "pending");
      assert.strictEqual(bootstrap.value.worktreePath, "/workspace/worktrees/durable-command-1");
      assert.strictEqual(bootstrap.value.setupPhase, "pending");
      assert.strictEqual(bootstrap.value.setupTerminalId, "setup-command-1");

      const claim = yield* repository.claim({
        workItemId: "command-1",
        owner: "worker-bootstrap",
        now: acceptedAt,
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
      assert.isTrue(claim._tag === "Some");
      if (claim._tag === "None") return;
      const started = yield* repository.beginBootstrapStep({
        workItemId: "command-1",
        owner: "worker-bootstrap",
        generation: claim.value.claimGeneration,
        step: "setup",
        at: acceptedAt,
      });
      assert.isTrue(started._tag === "Some");
      if (started._tag === "None") return;
      assert.strictEqual(started.value, "pending");
      assert.isTrue(
        yield* repository.acknowledgeBootstrapStep({
          workItemId: "command-1",
          owner: "worker-bootstrap",
          generation: claim.value.claimGeneration,
          step: "setup",
          at: acceptedAt,
        }),
      );
      yield* repository.stopThread({
        threadId: event.payload.threadId,
        reason: "test-completed",
        at: acceptedAt,
      });
    }),
  );

  it.effect("a new message supersedes an undismissed exhausted attention item", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const threadId = ThreadId.make("thread-supersede");
      const makeEvent = (suffix: string, sequence: number, occurredAt: string) => ({
        type: "thread.turn-start-requested" as const,
        sequence,
        eventId: EventId.make(`event-${suffix}`),
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make(`command-${suffix}`),
        causationEventId: null,
        correlationId: CorrelationId.make(`command-${suffix}`),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make(`message-${suffix}`),
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt: occurredAt,
        },
      });
      const first = makeEvent("superseded", 50, "2026-01-01T00:00:00.000Z");
      yield* repository.acceptFromEvent({
        event: first,
        message: {
          messageId: first.payload.messageId,
          threadId,
          turnId: null,
          role: "user",
          text: "first",
          attachments: [],
          isStreaming: false,
          sentByUserId: null,
          createdAt: first.occurredAt,
          updatedAt: first.occurredAt,
        },
      });
      const claim = yield* repository.claim({
        workItemId: "command-superseded",
        owner: "worker-supersede",
        now: first.occurredAt,
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
      assert.isTrue(claim._tag === "Some");
      if (claim._tag === "None") return;
      yield* repository.markFailedAttention({
        workItemId: "command-superseded",
        owner: "worker-supersede",
        generation: claim.value.claimGeneration,
        failureType: "provider-removed",
        detail: "provider removed",
        at: first.occurredAt,
      });

      const second = makeEvent("replacement", 51, "2026-01-01T00:02:00.000Z");
      yield* repository.acceptFromEvent({
        event: second,
        message: {
          messageId: second.payload.messageId,
          threadId,
          turnId: null,
          role: "user",
          text: "replacement",
          attachments: [],
          isStreaming: false,
          sentByUserId: null,
          createdAt: second.occurredAt,
          updatedAt: second.occurredAt,
        },
      });

      const items = yield* repository.listByThreadId({ threadId });
      assert.lengthOf(items, 2);
      assert.strictEqual(items[0]?.dismissedAt, second.occurredAt);
      assert.strictEqual(items[1]?.desiredState, "running");
      assert.strictEqual(items[1]?.recoveryAttempts, 0);
    }),
  );

  it.effect(
    "fences claims, exhausts exactly ten recovery attempts, and supports retry/dismiss",
    () =>
      Effect.gen(function* () {
        const repository = yield* DurableExecutionIntentRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-recovery");
        const acceptedAt = "2026-01-01T00:00:00.000Z";
        const event = {
          type: "thread.turn-start-requested" as const,
          sequence: 100,
          eventId: EventId.make("event-recovery"),
          aggregateKind: "thread" as const,
          aggregateId: threadId,
          occurredAt: acceptedAt,
          commandId: CommandId.make("command-recovery"),
          causationEventId: null,
          correlationId: CorrelationId.make("command-recovery"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-recovery"),
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            createdAt: acceptedAt,
          },
        };
        yield* repository.acceptFromEvent({
          event,
          message: {
            messageId: event.payload.messageId,
            threadId,
            turnId: null,
            role: "user",
            text: "recover me",
            attachments: [],
            isStreaming: false,
            sentByUserId: null,
            createdAt: acceptedAt,
            updatedAt: acceptedAt,
          },
        });

        const firstClaim = yield* repository.claim({
          workItemId: "command-recovery",
          owner: "worker-a",
          now: acceptedAt,
          expiresAt: "2026-01-01T00:01:00.000Z",
        });
        assert.isTrue(firstClaim._tag === "Some");
        if (firstClaim._tag === "None") return;
        const blockedClaim = yield* repository.claim({
          workItemId: "command-recovery",
          owner: "worker-b",
          now: acceptedAt,
          expiresAt: "2026-01-01T00:01:00.000Z",
        });
        assert.isTrue(blockedClaim._tag === "None");
        yield* repository.markOriginalDispatchFailed({
          workItemId: "command-recovery",
          owner: "worker-a",
          generation: firstClaim.value.claimGeneration,
          failureType: "transport-lost",
          detail: "connection closed before acknowledgement",
          deliveryUncertain: true,
          at: acceptedAt,
        });

        const interruptedRecoveryClaim = yield* repository.claim({
          workItemId: "command-recovery",
          owner: "worker-before-restart",
          now: "2026-01-01T00:00:01.000Z",
          expiresAt: "2026-01-01T00:01:01.000Z",
        });
        assert.isTrue(interruptedRecoveryClaim._tag === "Some");
        if (interruptedRecoveryClaim._tag === "None") return;
        const interruptedAttempt = yield* repository.beginRecoveryAttempt({
          workItemId: "command-recovery",
          owner: "worker-before-restart",
          generation: interruptedRecoveryClaim.value.claimGeneration,
          at: "2026-01-01T00:00:01.000Z",
        });
        assert.strictEqual(
          interruptedAttempt._tag === "Some" ? interruptedAttempt.value.recoveryAttempts : null,
          1,
        );
        assert.isTrue(
          yield* repository.markProviderStarting({
            workItemId: "command-recovery",
            owner: "worker-before-restart",
            generation: interruptedRecoveryClaim.value.claimGeneration,
            at: "2026-01-01T00:00:01.500Z",
          }),
        );
        assert.strictEqual(
          yield* repository.reconcileStartup({ at: "2026-01-01T00:00:02.000Z" }),
          1,
        );
        const afterRestart = yield* repository.getByWorkItemId({
          workItemId: "command-recovery",
        });
        assert.isTrue(afterRestart._tag === "Some");
        if (afterRestart._tag === "None") return;
        assert.strictEqual(afterRestart.value.phase, "recovering");
        assert.strictEqual(afterRestart.value.deliveryCertainty, "uncertain");
        assert.strictEqual(afterRestart.value.claimOwner, null);
        assert.strictEqual(afterRestart.value.nextAttemptAt, "2026-01-01T00:00:02.000Z");

        for (let attempt = 2; attempt <= 10; attempt += 1) {
          const at = `2026-01-01T00:00:${String(attempt).padStart(2, "0")}.000Z`;
          const claim = yield* repository.claim({
            workItemId: "command-recovery",
            owner: "worker-b",
            now: at,
            expiresAt: `2026-01-01T00:01:${String(attempt).padStart(2, "0")}.000Z`,
          });
          assert.isTrue(claim._tag === "Some", `attempt ${attempt} was not claimable`);
          if (claim._tag === "None") return;
          const started = yield* repository.beginRecoveryAttempt({
            workItemId: "command-recovery",
            owner: "worker-b",
            generation: claim.value.claimGeneration,
            at,
          });
          assert.isTrue(started._tag === "Some");
          if (started._tag === "None") return;
          assert.strictEqual(started.value.recoveryAttempts, attempt);
          yield* repository.markRecoveryAttemptFailed({
            workItemId: "command-recovery",
            owner: "worker-b",
            generation: claim.value.claimGeneration,
            failureType: "provider-startup-failed",
            detail: `attempt ${attempt}`,
            nextAttemptAt:
              attempt === 10
                ? null
                : `2026-01-01T00:00:${String(attempt + 1).padStart(2, "0")}.000Z`,
            at,
          });
        }

        const exhausted = yield* repository.getByWorkItemId({
          workItemId: "command-recovery",
        });
        assert.isTrue(exhausted._tag === "Some");
        if (exhausted._tag === "None") return;
        assert.strictEqual(exhausted.value.recoveryAttempts, 10);
        assert.strictEqual(exhausted.value.desiredState, "stopped");
        assert.strictEqual(exhausted.value.phase, "recovery-exhausted");
        assert.isFalse(exhausted.value.runnable);
        const compatibility = yield* sql<{
          readonly desiredState: string;
          readonly attempts: number;
          readonly gaveUpAt: string | null;
        }>`
        SELECT desired_state AS "desiredState", attempts, gave_up_at AS "gaveUpAt"
        FROM session_recovery_state
        WHERE thread_id = ${threadId}
      `;
        assert.strictEqual(compatibility[0]?.desiredState, "stopped");
        assert.strictEqual(compatibility[0]?.attempts, 10);
        assert.strictEqual(compatibility[0]?.gaveUpAt, "2026-01-01T00:00:10.000Z");

        const attemptEleven = yield* repository.claim({
          workItemId: "command-recovery",
          owner: "worker-a",
          now: "2026-01-01T00:10:00.000Z",
          expiresAt: "2026-01-01T00:11:00.000Z",
        });
        assert.isTrue(attemptEleven._tag === "None");

        assert.isTrue(
          yield* repository.retryExhausted({
            threadId,
            at: "2026-01-01T00:12:00.000Z",
          }),
        );
        const retried = yield* repository.getByWorkItemId({ workItemId: "command-recovery" });
        assert.isTrue(retried._tag === "Some");
        if (retried._tag === "None") return;
        assert.strictEqual(retried.value.recoveryAttempts, 0);
        assert.strictEqual(retried.value.desiredState, "running");
        assert.strictEqual(retried.value.phase, "recovering");

        yield* repository.observeBlockingActivity({
          threadId,
          kind: "approval.requested",
          at: "2026-01-01T00:12:30.000Z",
        });
        const awaitingApproval = yield* repository.getByWorkItemId({
          workItemId: "command-recovery",
        });
        assert.isTrue(awaitingApproval._tag === "Some");
        if (awaitingApproval._tag === "None") return;
        assert.strictEqual(awaitingApproval.value.phase, "waiting-for-approval");
        assert.isFalse(awaitingApproval.value.runnable);

        yield* repository.observeBlockingActivity({
          threadId,
          kind: "approval.resolved",
          at: "2026-01-01T00:12:31.000Z",
        });
        const resumed = yield* repository.getByWorkItemId({ workItemId: "command-recovery" });
        assert.isTrue(resumed._tag === "Some");
        if (resumed._tag === "None") return;
        assert.strictEqual(resumed.value.phase, "running");
        assert.isTrue(resumed.value.runnable);

        yield* repository.stopThread({
          threadId,
          reason: "user-stop",
          at: "2026-01-01T00:13:00.000Z",
        });
        assert.isFalse(
          yield* repository.isClaimCurrent({
            workItemId: "command-recovery",
            owner: "worker-b",
            generation: retried.value.claimGeneration,
            now: "2026-01-01T00:13:00.000Z",
          }),
        );
      }),
  );
});
