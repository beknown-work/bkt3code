// T3-CUSTOM(expbkt3): coverage for the stalled-execution watchdog sweep.
//
// The policy decides *whether* a turn is stalled; these tests cover the sweep
// around it: which rows it even considers, that supervisor memory outranks the
// projection it selected from, and that a judged stall is handed to durable
// recovery rather than acted on here.
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryLive,
} from "./DurableExecutionIntentRepository.ts";
import { makeStalledExecutionWatchdog } from "./StalledExecutionWatchdog.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";

const layer = it.layer(
  DurableExecutionIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const nowIso = "2026-01-01T12:00:00.000Z";
const nowMs = Date.parse(nowIso);
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutes * 60_000));
const instanceId = ProviderInstanceId.make("codex");

const settings = {
  enabled: true,
  pollIntervalMs: 30_000,
  startedButNotTakenMs: 90_000,
  dispatchDeadlineMs: 300_000,
  deadRuntimeGraceMs: 60_000,
  silentTurnMs: 90 * 60_000,
};

/**
 * A durable intent for this thread, created through the real repository. The
 * sequence is per-test because `request_event_sequence` is unique table-wide and
 * every test in this block shares one in-memory database.
 */
const seedIntent = Effect.fnUntraced(function* (suffix: string, sequence: number) {
  const repository = yield* DurableExecutionIntentRepository;
  const threadId = ThreadId.make(`thread-${suffix}`);
  const commandId = CommandId.make(`command-${suffix}`);
  const event = {
    type: "thread.turn-start-requested" as const,
    sequence,
    eventId: EventId.make(`event-${suffix}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: minutesAgo(120),
    commandId,
    causationEventId: null,
    correlationId: CorrelationId.make(`command-${suffix}`),
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(`message-${suffix}`),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: minutesAgo(120),
    },
  };
  yield* repository.acceptFromEvent({
    event,
    message: {
      messageId: event.payload.messageId,
      threadId,
      turnId: null,
      role: "user",
      text: "do the thing",
      attachments: [],
      isStreaming: false,
      sentByUserId: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    },
  });
  return { threadId, workItemId: String(commandId) };
});

/** Force an intent into the phase a delivered-then-silent turn would sit in. */
const setIntentPhase = (workItemId: string, phase: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE projection_thread_execution_intents
      SET phase = ${phase}, updated_at = ${nowIso}
      WHERE work_item_id = ${workItemId}
    `,
  ).pipe(Effect.asVoid, Effect.orDie);

const dismissIntent = (workItemId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE projection_thread_execution_intents
      SET dismissed_at = ${nowIso} WHERE work_item_id = ${workItemId}
    `,
  ).pipe(Effect.asVoid, Effect.orDie);

const seedExecutionRow = (input: {
  readonly threadId: ThreadId;
  readonly activity: string;
  readonly turnState: string | null;
  readonly turnStartedAt: string | null;
  readonly stopRequestedAt?: string | null;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO projection_thread_executions (
        thread_id, authority_epoch, revision, observed_at, activity, can_stop,
        provider_session_state, provider_generation, provider_instance_id,
        provider_started_at, provider_last_observed_at, provider_last_error,
        execution_id, provider_turn_id, turn_state, turn_started_at,
        stop_requested_at, turn_completed_at, turn_last_error
      ) VALUES (
        ${String(input.threadId)}, 'epoch-1', 5, ${nowIso}, ${input.activity}, 1,
        'ready', 1, ${String(instanceId)},
        ${input.turnStartedAt}, ${input.turnStartedAt}, NULL,
        ${`execution-${String(input.threadId)}`}, 'provider-turn-1', ${input.turnState},
        ${input.turnStartedAt}, ${input.stopRequestedAt ?? null}, NULL, NULL
      )
    `,
  ).pipe(Effect.asVoid, Effect.orDie);

/** One appended thread event, which is what the sweep measures silence from. */
const seedThreadEvent = (threadId: ThreadId, occurredAt: string, sequenceSuffix: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json
      ) VALUES (
        ${`appended-${String(threadId)}-${sequenceSuffix}`}, 'thread', ${String(threadId)},
        ${sequenceSuffix}, 'thread.activity-appended', ${occurredAt}, NULL, NULL, NULL,
        'provider', '{}', '{}'
      )
    `,
  ).pipe(Effect.asVoid, Effect.orDie);

const makeSnapshot = (
  threadId: ThreadId,
  overrides: {
    readonly activity?: ThreadExecutionSnapshot["activity"];
    readonly turnState?: NonNullable<ThreadExecutionSnapshot["turn"]>["state"];
    readonly providerSessionState?: ThreadExecutionSnapshot["providerSession"]["state"];
    readonly turnStartedAt?: string;
    readonly stopRequestedAt?: string | null;
  } = {},
): ThreadExecutionSnapshot => ({
  threadId,
  authorityEpoch: "epoch-1",
  revision: 5,
  observedAt: nowIso,
  activity: overrides.activity ?? "active",
  canStop: true,
  providerSession: {
    state: overrides.providerSessionState ?? "ready",
    generation: 1,
    providerInstanceId: instanceId,
    startedAt: minutesAgo(120),
    lastObservedAt: minutesAgo(115),
    lastError: null,
  },
  turn: {
    executionId: `execution-${String(threadId)}`,
    providerTurnId: null,
    state: overrides.turnState ?? "running",
    startedAt: overrides.turnStartedAt ?? minutesAgo(120),
    stopRequestedAt: overrides.stopRequestedAt ?? null,
    completedAt: null,
    lastError: null,
  },
});

interface HarnessInput {
  readonly snapshot: ThreadExecutionSnapshot;
  readonly workItemId: string;
  /** "error" makes `inspectSession` fail, which must not skip the candidate. */
  readonly runtimeAlive: boolean | null | "error";
  readonly enabled?: boolean;
  /** Supplied by tests that assert the watchdog ended the execution itself. */
  readonly failures?: Ref.Ref<Array<{ readonly executionId: string; readonly detail: string }>>;
}

/**
 * Every test in this block shares one database, so earlier rows stay visible to
 * later sweeps. The harness therefore answers only for the thread under test —
 * others come back idle — and callers assert on that thread's reports alone.
 */
const runSweep = Effect.fnUntraced(function* (input: HarnessInput) {
  const reported = yield* Ref.make<
    Array<{ workItemId: string; failureType: string; detail: string }>
  >([]);
  const underTest = String(input.snapshot.threadId);
  const provider = {
    inspectSession: (threadId: ThreadId) =>
      input.runtimeAlive === "error" && String(threadId) === underTest
        ? Effect.die(new Error("adapter cannot answer"))
        : Effect.succeed(
            String(threadId) !== underTest || input.runtimeAlive === null
              ? null
              : {
                  threadId,
                  generation: 1,
                  state: "ready" as const,
                  activeProviderTurnId: null,
                  runtimeAlive: input.runtimeAlive === true,
                },
          ),
  } as unknown as typeof ProviderService.Service;
  const supervisor = {
    getSnapshot: (threadId: ThreadId) =>
      Effect.succeed(
        String(threadId) === underTest
          ? input.snapshot
          : { ...makeSnapshot(threadId), activity: "idle" as const, turn: null },
      ),
    failExecution: (threadId: ThreadId, executionId: string, detail: string) =>
      (input.failures === undefined
        ? Effect.void
        : Ref.update(input.failures, (all) => [...all, { executionId, detail }])
      ).pipe(Effect.as(makeSnapshot(threadId))),
  } as unknown as typeof ThreadExecutionSupervisor.Service;

  const watchdog = yield* makeStalledExecutionWatchdog({
    settings: () => Effect.succeed({ ...settings, enabled: input.enabled ?? true }),
    failObserved: (report) => Ref.update(reported, (all) => [...all, report]),
    now: () => Effect.succeed(nowMs),
  }).pipe(
    Effect.provideService(ProviderService, provider),
    Effect.provideService(ThreadExecutionSupervisor, supervisor),
  );
  yield* watchdog.sweep;
  const all = yield* Ref.get(reported);
  return all.filter((report) => report.workItemId === input.workItemId);
});

layer("StalledExecutionWatchdog", (it) => {
  it.effect("revives a ready provider that never took the turn, which no queue can reach", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const { threadId, workItemId } = yield* seedIntent("ready-never-took", 20);
      // The production shape: recovery already ran once and acknowledged, so
      // the intent sits at phase "running" with no next attempt scheduled.
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(15),
      });

      // This is the crux of the whole bug: `listRunnable` excludes phase
      // "running", so the coordinator's own loop can never pick this up. If a
      // future change makes the queue cover it, this assertion is the warning
      // that the detector below is no longer the only thing standing here.
      const due = yield* repository.listRunnable({ now: nowIso, limit: 50 });
      assert.isFalse(due.some((candidate) => candidate.workItemId === workItemId));

      const reported = yield* runSweep({
        workItemId,
        snapshot: makeSnapshot(threadId, {
          turnState: "starting",
          providerSessionState: "ready",
          turnStartedAt: minutesAgo(15),
        }),
        // Alive and idle, exactly as the stuck processes were.
        runtimeAlive: true,
      });
      assert.strictEqual(reported.length, 1);
      assert.strictEqual(reported[0]?.failureType, "provider-turn-never-started");
      assert.include(reported[0]?.detail ?? "", "was ready but never started the turn");
    }),
  );

  // The expbkt3 incident of 2026-08-11, in full. Four sessions launched seconds
  // apart into one worktree: codex accepted every turn and returned a turn id,
  // none of the turn events ever arrived, and the detector fired exactly as
  // designed. Then recovery attempt two asked codex for the thread history, was
  // told that same turn id had `state: "completed"`, and marked the work item
  // finished — `desired_state='stopped'`, `runnable=0`, phase left at 'running',
  // failure detail cleared. The execution stayed at active/starting forever, and
  // the sweep went silent because its candidate filter required a *running*
  // intent. Detection without a landing is worse than no detection: it looks
  // handled.
  it.effect("still ends a session after recovery declares the turn complete from history", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("history-completed", 23);
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`
          UPDATE projection_thread_execution_intents
          SET desired_state = 'stopped', phase = 'running', runnable = 0,
              delivery_certainty = 'completed', recovery_attempts = 2,
              next_attempt_at = NULL, claim_owner = NULL,
              last_failure_type = NULL, last_failure_detail = NULL,
              terminal_at = ${nowIso}
          WHERE work_item_id = ${workItemId}
        `,
      ).pipe(Effect.orDie);
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(15),
      });

      const failures = yield* Ref.make<Array<{ executionId: string; detail: string }>>([]);
      const reported = yield* runSweep({
        workItemId,
        snapshot: makeSnapshot(threadId, {
          turnState: "starting",
          providerSessionState: "ready",
          turnStartedAt: minutesAgo(15),
        }),
        runtimeAlive: true,
        failures,
      });

      // The ladder is gone — a stopped item refuses a claim — so there is
      // nothing to revive and the sweep must end the execution itself.
      assert.deepStrictEqual(reported, []);
      const failed = yield* Ref.get(failures);
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0]?.executionId, `execution-${String(threadId)}`);
      assert.include(failed[0]?.detail ?? "", "never started the turn");
    }),
  );

  it.effect("ends a stalled session that has no durable work item at all", () =>
    Effect.gen(function* () {
      // Threads predating durable intents, and anything whose item was
      // dismissed, must not be permanently invisible either.
      const threadId = ThreadId.make("thread-no-intent");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(15),
      });

      const failures = yield* Ref.make<Array<{ executionId: string; detail: string }>>([]);
      yield* runSweep({
        workItemId: "no-such-work-item",
        snapshot: makeSnapshot(threadId, {
          turnState: "starting",
          providerSessionState: "ready",
          turnStartedAt: minutesAgo(15),
        }),
        runtimeAlive: true,
        failures,
      });

      const failed = yield* Ref.get(failures);
      assert.strictEqual(failed.length, 1);
      assert.include(failed[0]?.detail ?? "", "never started the turn");
    }),
  );

  it.effect("still reports when the adapter cannot say whether the runtime is alive", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("liveness-unknown", 21);
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(15),
      });

      const reported = yield* runSweep({
        workItemId,
        snapshot: makeSnapshot(threadId, {
          turnState: "starting",
          providerSessionState: "ready",
          turnStartedAt: minutesAgo(15),
        }),
        runtimeAlive: "error",
      });
      assert.strictEqual(reported.length, 1);
      assert.strictEqual(reported[0]?.failureType, "provider-turn-never-started");
    }),
  );

  it.effect("leaves a turn that was only just admitted alone", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("just-admitted", 22);
      yield* setIntentPhase(workItemId, "starting");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(0.5),
      });

      const reported = yield* runSweep({
        workItemId,
        snapshot: makeSnapshot(threadId, {
          turnState: "starting",
          providerSessionState: "ready",
          turnStartedAt: minutesAgo(0.5),
        }),
        runtimeAlive: true,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("reports a delivered turn that has gone silent", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("silent", 11);
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(120),
      });
      yield* seedThreadEvent(threadId, minutesAgo(94), 1);

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId),
        runtimeAlive: true,
      });
      assert.strictEqual(reported.length, 1);
      assert.strictEqual(reported[0]?.workItemId, workItemId);
      assert.strictEqual(reported[0]?.failureType, "provider-output-silent");
      assert.include(reported[0]?.detail ?? "", "No output from the agent for 94 minutes");
    }),
  );

  it.effect("reports a turn whose provider session never appeared", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("never-started", 12);
      yield* setIntentPhase(workItemId, "starting");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "starting",
        turnStartedAt: minutesAgo(7),
      });

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId, { turnState: "starting", turnStartedAt: minutesAgo(7) }),
        runtimeAlive: null,
      });
      assert.strictEqual(reported.length, 1);
      assert.strictEqual(reported[0]?.failureType, "provider-never-started");
      assert.include(reported[0]?.detail ?? "", "The agent never started");
    }),
  );

  it.effect("leaves a session that is waiting for a human alone", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("blocked", 13);
      yield* setIntentPhase(workItemId, "running");
      // The projection still says "active" — a stale row is exactly the case
      // where the supervisor's live snapshot has to win.
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(300),
      });
      yield* seedThreadEvent(threadId, minutesAgo(300), 1);

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId, {
          activity: "blocked",
          turnState: "waiting-for-approval",
          turnStartedAt: minutesAgo(300),
        }),
        runtimeAlive: true,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("never selects a blocked or stopping projection row in the first place", () =>
    Effect.gen(function* () {
      const blocked = yield* seedIntent("blocked-row", 14);
      yield* setIntentPhase(blocked.workItemId, "waiting-for-approval");
      yield* seedExecutionRow({
        threadId: blocked.threadId,
        activity: "blocked",
        turnState: "waiting-for-input",
        turnStartedAt: minutesAgo(300),
      });

      const reported = yield* runSweep({
        workItemId: blocked.workItemId,
        // A snapshot that would be reported if the row had been selected.
        snapshot: makeSnapshot(blocked.threadId, { turnStartedAt: minutesAgo(300) }),
        runtimeAlive: null,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("ignores a stop that is already in flight", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("stopping", 15);
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(300),
        stopRequestedAt: minutesAgo(30),
      });

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId, { stopRequestedAt: minutesAgo(30) }),
        runtimeAlive: true,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("leaves work the coordinator already owns to the coordinator", () =>
    Effect.gen(function* () {
      const retrying = yield* seedIntent("retry-wait", 16);
      yield* setIntentPhase(retrying.workItemId, "retry-wait");
      yield* seedExecutionRow({
        threadId: retrying.threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(300),
      });

      const reported = yield* runSweep({
        workItemId: retrying.workItemId,
        snapshot: makeSnapshot(retrying.threadId),
        runtimeAlive: null,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("ignores an intent the user already dismissed", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("dismissed", 17);
      yield* setIntentPhase(workItemId, "running");
      yield* dismissIntent(workItemId);
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(300),
      });

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId),
        runtimeAlive: null,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("keeps quiet while the turn is still producing output", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("healthy", 18);
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(180),
      });
      // Three hours into the turn, streaming as it goes.
      yield* seedThreadEvent(threadId, minutesAgo(0.5), 1);

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId, { turnStartedAt: minutesAgo(180) }),
        runtimeAlive: true,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );

  it.effect("does nothing at all when the watchdog is turned off", () =>
    Effect.gen(function* () {
      const { threadId, workItemId } = yield* seedIntent("disabled", 19);
      yield* setIntentPhase(workItemId, "running");
      yield* seedExecutionRow({
        threadId,
        activity: "active",
        turnState: "running",
        turnStartedAt: minutesAgo(300),
      });

      const reported = yield* runSweep({
        workItemId: workItemId,
        snapshot: makeSnapshot(threadId),
        runtimeAlive: null,
        enabled: false,
      });
      assert.deepStrictEqual(reported, []);
    }),
  );
});
