/**
 * staleSessionReconciliation - Close out turns orphaned by a server restart.
 *
 * A provider turn cannot outlive the server process that runs it, but the
 * projection only leaves the "running" status when a completion event arrives.
 * If the server stops mid-turn (deploy, OOM kill, crash) that event is never
 * written, so the thread stays "running" forever: the sidebar shows "Agent is
 * working" and the composer counts up from a turn that died hours ago, with no
 * way for the user to clear it — interrupting targets a turn whose process is
 * long gone.
 *
 * Runs once at startup, after the reactors are up and before commands are
 * accepted, so any session still marked running/starting from the previous
 * process is settled as interrupted. Emits real events (rather than patching
 * the projection) so the correction survives a projection rebuild.
 *
 * Fail-soft: a failure here must never block startup.
 *
 * @module staleSessionReconciliation
 */
import { CommandId, EventId, type OrchestrationSession, type ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Statuses that cannot legitimately survive a process boundary. */
const ORPHANABLE_STATUSES: ReadonlySet<OrchestrationSession["status"]> = new Set([
  "running",
  "starting",
]);

export const runStaleSessionReconciliation = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // Settling the projection is not enough on its own: the provider session
  // directory still holds a "running" binding for a process that is gone, and
  // upstream's reconcileProviderSessions only visits threads whose session is
  // still running/starting — which this pass has just cleared. Stop the binding
  // here so a restart cannot leave an unclaimable zombie behind.
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

  const snapshot = yield* snapshotQuery.getShellSnapshot();
  const orphaned = snapshot.threads.flatMap((thread) =>
    thread.session !== null && ORPHANABLE_STATUSES.has(thread.session.status)
      ? [{ threadId: thread.id, session: thread.session, lastActivityAt: thread.updatedAt }]
      : [],
  );

  if (orphaned.length === 0) {
    return;
  }

  const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const serverId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => `server:${tag}:${uuid}`));

  const reconcileThread = Effect.fn("reconcileStaleSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly lastActivityAt: string;
  }) {
    // The projector turns session.updatedAt into the settled turn's completedAt.
    // Stamping "now" would therefore record the whole wall-clock gap since the
    // crash as turn duration — a turn orphaned yesterday would read "Worked for
    // 17h". Use the thread's last recorded event instead, so the duration
    // reflects the work that actually happened.
    const settleAt = Number.isFinite(Date.parse(input.lastActivityAt)) ? input.lastActivityAt : now;

    yield* Effect.gen(function* () {
      const binding = yield* directory.getBinding(input.threadId);
      if (Option.isSome(binding)) {
        yield* directory.upsert({
          ...binding.value,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
      }
    }).pipe(
      // Fail-soft: a stale binding must never block startup.
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop the provider session binding of a stale session", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );

    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(yield* serverId("stale-session-interrupt")),
      threadId: input.threadId,
      session: {
        ...input.session,
        status: "interrupted",
        activeTurnId: null,
        updatedAt: settleAt,
      },
      createdAt: settleAt,
    });

    // Without this the turn just goes quiet and reads as an unexplained stop.
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* serverId("stale-session-activity")),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "error",
          kind: "session.interrupted-by-restart",
          summary: "Turn interrupted because the server restarted",
          payload: { previousStatus: input.session.status },
          turnId: input.session.activeTurnId,
          createdAt: now,
        },
        createdAt: now,
      })
      .pipe(Effect.ignoreCause({ log: true }));

    yield* Effect.logInfo("settled a session orphaned by a server restart", {
      threadId: input.threadId,
      previousStatus: input.session.status,
      activeTurnId: input.session.activeTurnId,
    });
  });

  // Sequential: these are rare (only after an unclean stop) and ordering keeps
  // the log readable.
  for (const entry of orphaned) {
    yield* reconcileThread(entry).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to settle an orphaned session", {
          threadId: entry.threadId,
          cause,
        }),
      ),
    );
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("stale session reconciliation failed (will retry next boot)", { cause }),
  ),
);
