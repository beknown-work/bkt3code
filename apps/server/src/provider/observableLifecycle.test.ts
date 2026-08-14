import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - the tests drive real OS processes.
import * as NodeChildProcess from "node:child_process";

import { afterEach, assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeObservableLifecycle } from "./observableLifecycle.ts";
import { isProcessAlive, supportsProcessTreeInspection } from "./processTree.ts";
import {
  clearProviderRuntimeProcesses,
  findProviderRuntimeProcessesForThread,
  registerProviderRuntimeProcess,
} from "./providerRuntimeProcesses.ts";

const threadId = ThreadId.make("observable-lifecycle");
/** Above `pid_max`, so it can never name a live process. */
const DEAD_PID = 2_147_483_646;
afterEach(() => {
  clearProviderRuntimeProcesses();
});

class StopSessionTestError extends Data.TaggedError("StopSessionTestError")<{
  readonly detail: string;
}> {}

const trackRuntimeProcess = (pid: number) =>
  registerProviderRuntimeProcess({
    pid,
    provider: "opencode",
    threadId,
    command: "opencode serve --hostname=127.0.0.1 --port=4096",
    registeredAtMillis: 0,
  });

const stoppableSource = (options?: { readonly stopFails?: boolean }) => {
  let sessionActive = true;
  return {
    hasSession: (_id: ThreadId) => Effect.succeed(sessionActive),
    listSessions: () => Effect.succeed([]),
    interruptTurn: (_id: ThreadId, _turn?: TurnId) => Effect.void,
    stopSession: (_id: ThreadId) =>
      Effect.suspend(() => {
        sessionActive = false;
        return options?.stopFails === true
          ? Effect.fail(new StopSessionTestError({ detail: "stopSession failed" }))
          : Effect.void;
      }),
    streamEvents: Stream.empty,
  };
};
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const turnId = TurnId.make("turn-1");
const now = "2026-07-20T00:00:00.000Z";

it.effect("provides the shared observable lifecycle contract used by every built-in adapter", () =>
  Effect.gen(function* () {
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
    const session = yield* Ref.make<ProviderSession | null>({
      provider,
      providerInstanceId,
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    });
    const interrupted = yield* Ref.make(false);
    const source = {
      hasSession: (_threadId: ThreadId) =>
        Ref.get(session).pipe(Effect.map((value) => value !== null)),
      listSessions: () =>
        Ref.get(session).pipe(Effect.map((value) => (value === null ? [] : [value]))),
      interruptTurn: (_threadId: ThreadId, _turnId?: TurnId) => Ref.set(interrupted, true),
      stopSession: (_threadId: ThreadId) => Ref.set(session, null),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };
    const lifecycle = makeObservableLifecycle(source);

    const inspection = yield* lifecycle.inspectSession(threadId);
    assert.strictEqual(inspection?.state, "running");
    assert.strictEqual(inspection?.activeProviderTurnId, turnId);
    assert.isTrue(inspection?.runtimeAlive);

    const acknowledgement = yield* lifecycle.requestTurnInterrupt(threadId, turnId);
    assert.isTrue(acknowledgement.acknowledged);
    assert.isTrue(yield* Ref.get(interrupted));

    yield* PubSub.publish(runtimeEvents, {
      type: "session.started",
      eventId: EventId.make("session-started"),
      provider,
      providerInstanceId,
      threadId,
      createdAt: now,
      payload: {},
    });
    const watched = yield* lifecycle.watchSession(threadId, 7).pipe(Stream.runHead);
    assert.isTrue(Option.isSome(watched));
    assert.strictEqual(Option.getOrThrow(watched).sessionGeneration, 7);

    const termination = yield* lifecycle.terminateSession(threadId);
    assert.deepStrictEqual(termination, {
      verified: true,
      graceful: true,
      processTreeExited: true,
    });
    assert.strictEqual(yield* lifecycle.inspectSession(threadId), null);
  }),
);

it.effect("observes session liveness after stopSession completes", () =>
  Effect.gen(function* () {
    let sessionActive = true;
    const source = {
      hasSession: (_threadId: ThreadId) => Effect.succeed(sessionActive),
      listSessions: () => Effect.succeed([]),
      interruptTurn: (_threadId: ThreadId, _turnId?: TurnId) => Effect.void,
      stopSession: (_threadId: ThreadId) =>
        Effect.sync(() => {
          sessionActive = false;
        }),
      streamEvents: Stream.empty,
    };

    const termination = yield* makeObservableLifecycle(source).terminateSession(threadId);

    assert.deepStrictEqual(termination, {
      verified: true,
      graceful: true,
      processTreeExited: true,
    });
  }),
);

// The tests below cover the fork's OS-level termination verification. They are
// Linux-only by design: `/proc` is the evidence, and on other platforms the
// lifecycle deliberately falls back to adapter ownership (covered above).
it.live("reports a verified, graceful termination once the tracked process tree is gone", () =>
  Effect.gen(function* () {
    if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;
    trackRuntimeProcess(DEAD_PID);

    const termination =
      yield* makeObservableLifecycle(stoppableSource()).terminateSession(threadId);

    assert.deepStrictEqual(termination, {
      verified: true,
      graceful: true,
      processTreeExited: true,
    });
    // The registry entry is released only once the OS confirmed the exit.
    assert.deepStrictEqual(findProviderRuntimeProcessesForThread(threadId), []);
  }),
);

it.live("refuses to call a termination verified while the adapter still owns the session", () =>
  Effect.gen(function* () {
    if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;
    trackRuntimeProcess(DEAD_PID);
    const source = {
      // The runtime process is gone, but the adapter never released the
      // session — upstream would still have reported a clean termination.
      hasSession: (_id: ThreadId) => Effect.succeed(true),
      listSessions: () => Effect.succeed([]),
      interruptTurn: (_id: ThreadId, _turn?: TurnId) => Effect.void,
      stopSession: (_id: ThreadId) => Effect.void,
      streamEvents: Stream.empty,
    };

    const termination = yield* makeObservableLifecycle(source).terminateSession(threadId);

    assert.deepStrictEqual(termination, {
      verified: false,
      graceful: false,
      processTreeExited: true,
    });
  }),
);

it.live("settles a failed stopSession when the process tree is verifiably gone", () =>
  Effect.gen(function* () {
    if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;
    trackRuntimeProcess(DEAD_PID);

    const termination = yield* makeObservableLifecycle(
      stoppableSource({ stopFails: true }),
    ).terminateSession(threadId);

    assert.deepStrictEqual(termination, {
      verified: true,
      // The adapter's own stop path failed, so this was not a clean shutdown.
      graceful: false,
      processTreeExited: true,
    });
  }),
);

it.live(
  "kills a real runtime process the adapter left behind and verifies it at the OS",
  () =>
    Effect.gen(function* () {
      if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 45"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid as number;
      trackRuntimeProcess(pid);

      try {
        const termination =
          yield* makeObservableLifecycle(stoppableSource()).terminateSession(threadId);

        assert.deepStrictEqual(termination, {
          verified: true,
          graceful: true,
          processTreeExited: true,
        });
        assert.isFalse(isProcessAlive(pid));
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }),
  { timeout: 20_000 },
);
