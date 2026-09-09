// T3-CUSTOM(expbkt3): snapshot sync must retain request ownership when activity reads use the kind index.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as SessionRecoveryStateLayer } from "../persistence/SessionRecoveryState.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";
import { ThreadExecutionSupervisorLive } from "./ThreadExecutionSupervisorLive.ts";

const createdAt = "2026-09-09T00:00:00.000Z";
const threadId = ThreadId.make("indexed-snapshot");
const otherThreadId = ThreadId.make("indexed-snapshot-other");
const providerInstanceId = ProviderInstanceId.make("codex");
const turnId = TurnId.make("indexed-turn");

it.layer(SqlitePersistenceMemory)("indexed snapshot activity reads", (it) => {
  it.effect("keeps concurrent blockers scoped to their thread, kind, order and active turn", () =>
    Effect.gen(function* () {
      const start = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.concat(
          Stream.fromEffect(
            Deferred.await(start).pipe(
              Effect.as({
                type: "turn.started" as const,
                eventId: EventId.make("indexed-turn-started"),
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId,
                threadId,
                sessionGeneration: 1,
                turnId,
                createdAt,
                payload: {},
              }),
            ),
          ),
          Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
        ),
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* supervisor.admitIdleTurn({
          threadId,
          executionId: "indexed-execution",
          expectedExecutionRevision: 0,
          providerInstanceId,
          startedAt: createdAt,
        });
        yield* Deferred.succeed(start, undefined);
        yield* Deferred.await(delivered);
        const add = Effect.fn(function* (
          id: string,
          kind: string,
          requestId: string,
          sequence: number,
          target = threadId,
          detail?: string,
        ) {
          yield* sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES (${id}, ${target}, ${turnId}, 'info', ${kind}, ${id},
              ${JSON.stringify({ requestId, ...(detail === undefined ? {} : { detail }) })}, ${sequence}, ${createdAt})`;
        });
        const expectState = Effect.fn(function* (state: string) {
          const single = yield* supervisor.getSnapshot(threadId);
          const batch = yield* supervisor.getSnapshots([otherThreadId, threadId]);
          assert.strictEqual(single.turn?.state, state);
          assert.strictEqual(single.activity, state.startsWith("waiting") ? "blocked" : "active");
          assert.deepStrictEqual(batch.get(threadId), single);
          assert.strictEqual(batch.get(otherThreadId)?.activity, "idle");
        });
        yield* add("approval", "approval.requested", "approval", 10);
        yield* add("question-a", "user-input.requested", "a", 11);
        yield* add("question-b", "user-input.requested", "b", 12);
        yield* add("other-thread", "approval.resolved", "approval", 20, otherThreadId);
        yield* add("unrelated-kind", "tool.completed", "approval", 21);
        yield* add("old-resolution", "approval.resolved", "approval", 9);
        yield* expectState("waiting-for-approval");
        yield* add("approval-answer", "approval.resolved", "approval", 22);
        yield* expectState("waiting-for-input");
        yield* add(
          "retryable",
          "provider.user-input.respond.failed",
          "a",
          23,
          threadId,
          "Network timeout; retry response",
        );
        yield* add("b-answer", "user-input.resolved", "b", 24);
        yield* expectState("waiting-for-input");
        yield* add(
          "terminal-stale",
          "provider.user-input.respond.failed",
          "a",
          25,
          threadId,
          "Unknown pending codex user input request",
        );
        yield* expectState("running");
        yield* add("completed-request", "approval.requested", "completed", 26);
        yield* expectState("waiting-for-approval");
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
          VALUES (${threadId}, ${turnId}, 'completed', ${createdAt}, ${createdAt}, '[]')`;
        yield* expectState("running");
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );
});
