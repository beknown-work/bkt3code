/**
 * ProviderSessionRestartSweep - Boot-time recovery for sessions that were
 * mid-turn when the server process died.
 *
 * Agent provider processes (Claude Agent SDK, codex app-server) are children
 * of the server and do not survive a restart, but the orchestration
 * projection that the UI reads keeps `status: "running" | "starting"` with a
 * non-null `activeTurnId`. Nothing else re-derives that state at boot:
 * provider recovery is lazy (see `ProviderService.resolveRoutableSession`)
 * and only runs when the next operation is routed to the thread, and the
 * session reaper explicitly skips threads with an active turn. A deploy
 * therefore leaves every in-flight thread pinned to "Working" forever.
 *
 * This sweep runs once per boot and, for every thread whose persisted
 * session still claims to be live:
 *   1. marks the session `interrupted` with `activeTurnId: null`, which lets
 *      the projectors settle the running turn and drop pending turn-start
 *      rows,
 *   2. records a user-visible activity explaining what happened,
 *   3. releases approval / user-input requests whose provider callbacks died
 *      with the process, so the thread can settle again, and
 *   4. optionally restarts the interrupted turn so work continues without
 *      human intervention (see AUTO_RESTART_INTERRUPTED_TURNS).
 *
 * Fork-owned module: kept out of the upstream reactor files so upstream
 * t3-code merges stay conflict-free. The only wiring into upstream code is a
 * single construction + call site in ProviderCommandReactor.start().
 *
 * @module ProviderSessionRestartSweep
 */
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationSession,
  type OrchestrationThread,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * Restart the turn that was interrupted, instead of only marking the thread
 * recoverable and waiting for the user's next message.
 *
 * Kill switch: setting this to `false` keeps every other part of the sweep
 * (clean session state, activity, released requests) and simply leaves the
 * thread idle until someone sends a message, which lazy recovery already
 * handles transparently.
 */
export const AUTO_RESTART_INTERRUPTED_TURNS = true;

/**
 * Provider session starts are serialized through one command worker, and a
 * deploy can strand many threads at once. Restart a couple at a time so a
 * boot sweep cannot spawn a fleet of agent processes simultaneously.
 */
const RESTART_CONCURRENCY = 2;

/** Cap the quoted prompt so a huge original message cannot blow the context. */
const MAX_QUOTED_PROMPT_CHARS = 4_000;

const RESTART_ACTIVITY_KIND = "provider.session.restart-interrupted";

type StaleSessionCandidate = {
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession;
  readonly activeTurnId: TurnId | null;
  readonly sessionUpdatedAt: string;
};

type OpenBlockingRequest = {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
};

/**
 * Mirror of the stale-request detail produced by ProviderCommandReactor.
 *
 * Both the decider's settle guard and the projection's pending-request
 * accounting pattern-match on this wording to decide that a request can
 * never be answered. Reproduced here rather than exported from upstream code
 * so this module stays additive; `ProviderSessionRestartSweep.test.ts` pins
 * the string against the matchers that consume it.
 */
export function stalePendingRequestDetailForRestart(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

/**
 * Approval / user-input requests with no later resolution, in the same shape
 * the decider's `hasOpenBlockingRequest` derives its boolean from.
 *
 * Deliberately a local mirror of that scan (upstream `decider.ts` is left
 * untouched); the accompanying test asserts both agree on shared fixtures so
 * the duplication cannot drift silently.
 */
export function collectOpenBlockingRequests(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): ReadonlyArray<OpenBlockingRequest> {
  const open = new Map<string, OpenBlockingRequest["kind"]>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested") {
      open.set(requestId, "approval");
    } else if (activity.kind === "user-input.requested") {
      open.set(requestId, "user-input");
    } else if (
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.resolved" ||
      activity.kind === "provider.approval.respond.failed" ||
      activity.kind === "provider.user-input.respond.failed"
    ) {
      open.delete(requestId);
    }
  }
  return [...open].map(([requestId, kind]) => ({ requestId, kind }));
}

/** A session the projection still believes is live after a restart. */
export function isStaleProviderSession(thread: OrchestrationThread): boolean {
  if (thread.deletedAt !== null) return false;
  const session = thread.session;
  if (!session) return false;
  return (
    session.status === "running" || session.status === "starting" || session.activeTurnId !== null
  );
}

/**
 * Whether the interrupted thread had work in flight worth restarting.
 *
 * `activeTurnId` covers a turn the provider had already picked up; a
 * `starting` session or a `running` latest turn covers a turn that was
 * requested but never reached (or never returned from) the provider.
 */
export function shouldRestartInterruptedTurn(candidate: {
  readonly session: OrchestrationSession;
  readonly activeTurnId: TurnId | null;
  readonly latestTurnState: string | null;
}): boolean {
  return (
    candidate.activeTurnId !== null ||
    candidate.session.status === "starting" ||
    candidate.latestTurnState === "running"
  );
}

function truncateQuotedPrompt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_QUOTED_PROMPT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_QUOTED_PROMPT_CHARS)}\n[...truncated]`;
}

/**
 * The prompt used to resume an interrupted turn.
 *
 * The provider session itself resumes from its own transcript (Claude
 * `--resume`, codex `thread/resume`), so the agent can already see whatever
 * it managed to do before the restart. The instruction therefore asks it to
 * check for partially completed work first — the turn may have edited files
 * or run commands before dying, and blindly redoing that is the main risk of
 * restarting automatically.
 */
export function buildRestartPrompt(originalPrompt: string | null): string {
  const preamble = "A server restart interrupted this session.";
  const guidance =
    "If work on it already started, continue from where it left off — check for partially completed work before redoing anything; otherwise begin now.";
  if (originalPrompt === null || originalPrompt.trim().length === 0) {
    return `${preamble} Continue the work that was in progress. ${guidance}`;
  }
  return `${preamble} The last user request was:\n\n${truncateQuotedPrompt(originalPrompt)}\n\n${guidance}`;
}

/** Text of the newest user message, used to restate an interrupted request. */
export function findLatestUserPrompt(thread: OrchestrationThread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message && message.role === "user" && message.text.trim().length > 0) {
      return message.text;
    }
  }
  return null;
}

export interface ProviderSessionRestartSweepShape {
  /** Candidate threads whose persisted session outlived its process. */
  readonly findStaleProviderSessions: () => Effect.Effect<
    ReadonlyArray<StaleSessionCandidate>,
    never
  >;
  /** Clean up (and optionally restart) the supplied candidates. */
  readonly sweepStaleProviderSessions: (
    candidates: ReadonlyArray<StaleSessionCandidate>,
  ) => Effect.Effect<void, never>;
}

/**
 * Build the sweep against the services the provider command reactor already
 * has in scope. Returns effects that never fail: a boot-time cleanup must not
 * be able to abort server startup.
 */
export const makeProviderSessionRestartSweep = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const eventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const findStaleProviderSessions: ProviderSessionRestartSweepShape["findStaleProviderSessions"] =
    Effect.fn("findStaleProviderSessions")(
      function* () {
        const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
        const candidates: Array<StaleSessionCandidate> = [];
        for (const thread of readModel.threads) {
          if (!isStaleProviderSession(thread)) continue;
          const session = thread.session;
          if (!session) continue;
          candidates.push({
            threadId: thread.id,
            session,
            activeTurnId: session.activeTurnId,
            sessionUpdatedAt: session.updatedAt,
          });
        }
        return candidates;
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("provider session restart sweep failed to read stale sessions", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<StaleSessionCandidate>)),
      ),
    );

  const appendSweepActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly tone: "info" | "error";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: commandId("provider-session-restart-sweep"),
      activityId: eventId(),
    }).pipe(
      Effect.flatMap(({ commandId: id, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: id,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const markSessionInterrupted = (input: {
    readonly candidate: StaleSessionCandidate;
    readonly createdAt: string;
  }) =>
    commandId("provider-session-restart-interrupted").pipe(
      Effect.flatMap((id) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: id,
          threadId: input.candidate.threadId,
          session: {
            ...input.candidate.session,
            status: "interrupted",
            activeTurnId: null,
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const restartInterruptedTurn = (input: {
    readonly thread: OrchestrationThread;
    readonly createdAt: string;
  }) =>
    Effect.all({
      id: commandId("provider-session-restart-turn"),
      messageUuid: crypto.randomUUIDv4,
    }).pipe(
      Effect.flatMap(({ id, messageUuid }) =>
        orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: id,
          threadId: input.thread.id,
          message: {
            messageId: MessageId.make(`restart:${messageUuid}`),
            role: "user",
            text: buildRestartPrompt(findLatestUserPrompt(input.thread)),
            attachments: [],
          },
          modelSelection: input.thread.modelSelection,
          runtimeMode: input.thread.runtimeMode,
          interactionMode: input.thread.interactionMode,
          createdAt: input.createdAt,
        }),
      ),
    );

  const sweepThread = Effect.fn("sweepStaleProviderSession")(function* (
    candidate: StaleSessionCandidate,
  ) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(candidate.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.deletedAt !== null) {
      return;
    }
    // A session started after the sweep captured its snapshot is live work,
    // not restart debris. Session writes always stamp updatedAt, so an
    // unchanged timestamp means nothing has touched this thread since boot.
    if (thread.session?.updatedAt !== candidate.sessionUpdatedAt) {
      yield* Effect.logDebug("provider session restart sweep skipped a refreshed session", {
        threadId: candidate.threadId,
      });
      return;
    }

    const createdAt = yield* nowIso;
    const restartTurn =
      AUTO_RESTART_INTERRUPTED_TURNS &&
      thread.archivedAt === null &&
      shouldRestartInterruptedTurn({
        session: candidate.session,
        activeTurnId: candidate.activeTurnId,
        latestTurnState: thread.latestTurn?.state ?? null,
      });

    yield* markSessionInterrupted({ candidate, createdAt });
    yield* appendSweepActivity({
      threadId: candidate.threadId,
      kind: RESTART_ACTIVITY_KIND,
      tone: "info",
      summary: restartTurn
        ? "Turn interrupted by server restart — restarting automatically."
        : "Turn interrupted by server restart — send a message to continue.",
      detail:
        "The provider session did not survive a server restart. Its agent process was replaced, so the interrupted turn was closed.",
      turnId: candidate.activeTurnId,
      createdAt,
    });

    // Approval and user-input callbacks live in process memory, so requests
    // outstanding at restart can never be answered. Releasing them with the
    // detail wording the decider and projection already recognise clears the
    // pending counts and unblocks settling.
    for (const request of collectOpenBlockingRequests(thread)) {
      yield* appendSweepActivity({
        threadId: candidate.threadId,
        kind:
          request.kind === "approval"
            ? "provider.approval.respond.failed"
            : "provider.user-input.respond.failed",
        tone: "error",
        summary:
          request.kind === "approval"
            ? "Provider approval response failed"
            : "Provider user input response failed",
        detail: stalePendingRequestDetailForRestart(request.kind, request.requestId),
        turnId: null,
        createdAt,
        requestId: request.requestId,
      });
    }

    if (restartTurn) {
      yield* restartInterruptedTurn({ thread, createdAt });
    }
  });

  const sweepStaleProviderSessions: ProviderSessionRestartSweepShape["sweepStaleProviderSessions"] =
    Effect.fn("sweepStaleProviderSessions")(function* (
      candidates: ReadonlyArray<StaleSessionCandidate>,
    ) {
      if (candidates.length === 0) {
        return;
      }
      yield* Effect.logInfo("provider session restart sweep started", {
        threadCount: candidates.length,
        autoRestart: AUTO_RESTART_INTERRUPTED_TURNS,
      });
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          sweepThread(candidate).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              // One unrecoverable thread must not strand the rest.
              return Effect.logWarning("provider session restart sweep failed for a thread", {
                threadId: candidate.threadId,
                cause: Cause.pretty(cause),
              });
            }),
          ),
        { concurrency: RESTART_CONCURRENCY, discard: true },
      );
    });

  return {
    findStaleProviderSessions,
    sweepStaleProviderSessions,
  } satisfies ProviderSessionRestartSweepShape;
});
