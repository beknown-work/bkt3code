import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
// T3-CUSTOM(expbkt3): BEGIN - OS-level process-tree verification for termination.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { supportsProcessTreeInspection, terminateProcessTree } from "./processTree.ts";
import {
  findProviderRuntimeProcessesForThread,
  unregisterProviderRuntimeProcess,
  type ProviderRuntimeProcessRecord,
} from "./providerRuntimeProcesses.ts";

/**
 * Fits inside the 7-second budget the execution supervisor allows for
 * `terminateSession` (`ThreadExecutionSupervisorLive`), leaving room for the
 * adapter's own `stopSession` teardown that runs before this pass.
 */
const PROCESS_TREE_GRACE_PERIOD_MILLIS = 2_000;
const PROCESS_TREE_KILL_TIMEOUT_MILLIS = 1_200;

interface ProcessTreeVerification {
  readonly exited: boolean;
  readonly forced: boolean;
}

/**
 * SIGTERM → wait → SIGKILL → re-verify every runtime process this thread owns.
 *
 * `stopSession` has usually already killed the process group by the time we get
 * here; this is the pass that turns "the adapter says so" into "the OS says
 * so", and the one that closes the gap when the adapter's scope finalizer was
 * skipped entirely.
 */
const terminateTrackedProcessTrees = (
  records: ReadonlyArray<ProviderRuntimeProcessRecord>,
): Effect.Effect<ProcessTreeVerification> =>
  Effect.gen(function* () {
    let exited = true;
    let forced = false;
    for (const record of records) {
      const outcome = yield* terminateProcessTree({
        rootPid: record.pid,
        gracePeriodMillis: PROCESS_TREE_GRACE_PERIOD_MILLIS,
        killTimeoutMillis: PROCESS_TREE_KILL_TIMEOUT_MILLIS,
      });
      if (outcome.forced) forced = true;
      if (outcome.exited) {
        // Drop the record only once the OS confirms the PID is gone, so a
        // surviving process stays visible to the reaper's orphan sweep.
        unregisterProviderRuntimeProcess(record.pid);
      } else {
        exited = false;
        yield* Effect.logWarning("provider.runtime.process-tree-survived-termination", {
          pid: record.pid,
          provider: record.provider,
          threadId: record.threadId,
          survivingPids: outcome.survivingPids,
        });
      }
    }
    return { exited, forced };
  });
// T3-CUSTOM(expbkt3): END

type LifecycleSource<TError> = Pick<
  ProviderAdapterShape<TError>,
  "hasSession" | "interruptTurn" | "listSessions" | "stopSession" | "streamEvents"
>;

type ObservableLifecycle<TError> = Required<
  Pick<
    ProviderAdapterShape<TError>,
    "inspectSession" | "requestTurnInterrupt" | "terminateSession" | "watchSession"
  >
>;

/**
 * Adds the observable lifecycle contract to a built-in adapter. Adapter map
 * ownership remains intact until `stopSession` has verified its runtime close;
 * this wrapper then verifies that ownership is no longer reported.
 */
export function makeObservableLifecycle<TError>(
  source: LifecycleSource<TError>,
): ObservableLifecycle<TError> {
  return {
    inspectSession: (threadId) =>
      Effect.gen(function* () {
        if (!(yield* source.hasSession(threadId))) return null;
        const session = (yield* source.listSessions()).find((entry) => entry.threadId === threadId);
        if (!session) return null;
        return {
          threadId,
          // ProviderService owns the externally visible generation and replaces
          // this local placeholder before returning the inspection.
          generation: 0,
          state:
            session.status === "connecting"
              ? "starting"
              : session.status === "running"
                ? "running"
                : session.status === "error"
                  ? "failed"
                  : session.status === "closed"
                    ? "stopped"
                    : "ready",
          activeProviderTurnId: session.activeTurnId ?? null,
          runtimeAlive: session.status !== "closed",
        } as const;
      }),
    requestTurnInterrupt: (threadId, turnId) =>
      source.interruptTurn(threadId, turnId).pipe(
        Effect.andThen(DateTime.now),
        Effect.map((now) => ({
          acknowledged: true,
          acknowledgedAt: DateTime.formatIso(now),
        })),
      ),
    // T3-CUSTOM(expbkt3): BEGIN - verify termination against the OS, not the map.
    //
    // Upstream reported `processTreeExited` from `hasSession`, which only
    // consults the adapter's in-memory session map: a detached provider
    // runtime that outlived its owning scope reported a clean, verified
    // termination while still holding ~500 MB inside the service cgroup. When
    // the thread owns runtime PIDs we recorded at spawn time, escalate against
    // those PIDs and their descendants and report what the OS actually says.
    terminateSession: (threadId) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const tracked = findProviderRuntimeProcessesForThread(threadId);
        // Captured before `stopSession`, which drops the session binding.
        const verifiable = supportsProcessTreeInspection(platform) && tracked.length > 0;

        const stopExit = yield* Effect.exit(source.stopSession(threadId));
        const runtimeAlive = yield* source.hasSession(threadId);

        if (!verifiable) {
          // Adapters without a tracked OS process (external servers, in-process
          // runtimes, non-Linux hosts) keep the adapter-ownership contract.
          if (Exit.isFailure(stopExit)) return yield* Effect.failCause(stopExit.cause);
          return {
            verified: !runtimeAlive,
            graceful: !runtimeAlive,
            processTreeExited: !runtimeAlive,
          };
        }

        const verification = yield* terminateTrackedProcessTrees(tracked);
        // A failed `stopSession` still leaves the process tree as the thing
        // that matters; only surface the failure when the tree also survived.
        if (Exit.isFailure(stopExit) && !verification.exited) {
          return yield* Effect.failCause(stopExit.cause);
        }
        return {
          // "Verified" here means exactly one thing: an OS probe confirmed the
          // tracked process tree is gone, and the adapter released the session.
          verified: verification.exited && !runtimeAlive,
          graceful:
            !runtimeAlive &&
            verification.exited &&
            !verification.forced &&
            Exit.isSuccess(stopExit),
          processTreeExited: verification.exited,
        };
      }),
    // T3-CUSTOM(expbkt3): END
    watchSession: (threadId, generation) =>
      source.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.map((event) => ({ ...event, sessionGeneration: generation })),
      ),
  };
}
