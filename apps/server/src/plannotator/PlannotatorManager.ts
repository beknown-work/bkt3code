/**
 * T3-CUSTOM(expbkt3): Dedicated Plannotator process/session lifecycle. See
 * docs/operations/expbkt3-customizations.md for the upstream merge boundary.
 */
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { plannotatorProxyPath } from "@t3tools/shared/plannotator";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandDispatcher } from "../orchestration/dispatchCommand.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  attachNativePlanReview,
  latestPlansForNativeReview,
  type NativePlanBridgeInput,
} from "./NativePlanBridge.ts";
import { PLANNOTATOR_CLIENT_REAPER_MS, PlannotatorClientLease } from "./PlannotatorClientLease.ts";
import {
  mergePlannotatorAnnotationHistory,
  type PlannotatorDecision,
  type PlannotatorReviewAnnotation,
} from "./model.ts";
import { resolveStoredPlannotatorPlanFormat } from "./planFormat.ts";

type InteractionModeSetCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.interaction-mode.set" }
>;

/**
 * T3-CUSTOM(expbkt3): T3 resolves turn interaction mode from persisted thread
 * state. Only approval may leave Plan mode; feedback and denial must preserve
 * the user's current mode.
 */
export function approvedPlanInteractionModeCommand({
  decision,
  threadId,
  commandId,
  createdAt,
}: {
  readonly decision: PlannotatorDecision;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly createdAt: string;
}): InteractionModeSetCommand | null {
  if (decision.kind !== "approved") return null;
  return {
    type: "thread.interaction-mode.set",
    commandId,
    threadId,
    interactionMode: "default",
    createdAt,
  };
}

type PlannotatorLaunchThread = {
  readonly id: string;
  readonly projectId: string;
  readonly worktreePath: string | null;
};

type PlannotatorLaunchProject = {
  readonly id: string;
  readonly workspaceRoot: string;
};

export type PlannotatorLaunchLocation =
  | { readonly kind: "found"; readonly workingDirectory: string }
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "project-not-found"; readonly projectId: string };

/**
 * T3-CUSTOM(expbkt3): Durable reviews may be revisited after their T3 thread
 * has been archived. Prefer the active detail, then fall back to the archived
 * shell so reopening keeps the same review URL and annotation history.
 */
export function resolvePlannotatorLaunchLocation({
  threadId,
  activeThread,
  activeProjects,
  archivedThreads,
  archivedProjects,
}: {
  readonly threadId: string;
  readonly activeThread: PlannotatorLaunchThread | null;
  readonly activeProjects: ReadonlyArray<PlannotatorLaunchProject>;
  readonly archivedThreads: ReadonlyArray<PlannotatorLaunchThread>;
  readonly archivedProjects: ReadonlyArray<PlannotatorLaunchProject>;
}): PlannotatorLaunchLocation {
  const thread = activeThread ?? archivedThreads.find((candidate) => candidate.id === threadId);
  if (!thread) return { kind: "thread-not-found" };
  const project = [...activeProjects, ...archivedProjects].find(
    (candidate) => candidate.id === thread.projectId,
  );
  if (!project) return { kind: "project-not-found", projectId: thread.projectId };
  return {
    kind: "found",
    workingDirectory: thread.worktreePath ?? project.workspaceRoot,
  };
}

/**
 * T3-CUSTOM(expbkt3): Plannotator converts `.html` input to Markdown unless
 * `--render-html` is explicit. Markdown reviews intentionally receive neither
 * that flag nor the legacy `--markdown` override.
 */
export function plannotatorAnnotateArguments({
  planPath,
  format,
}: {
  readonly planPath: string;
  readonly format: "md" | "html";
}): ReadonlyArray<string> {
  return [
    "--browser",
    "none",
    "annotate",
    planPath,
    ...(format === "html" ? ["--render-html"] : []),
    "--gate",
    "--json",
  ];
}

export const PlannotatorPlanFormat = Schema.Literals(["md", "html"]);
export type PlannotatorPlanFormat = typeof PlannotatorPlanFormat.Type;

export const PlannotatorSessionStatus = Schema.Literals([
  "starting",
  "running",
  "applying",
  "approved",
  "feedback",
  "denied",
  "exited",
  "error",
]);
export type PlannotatorSessionStatus = typeof PlannotatorSessionStatus.Type;

const PersistedPlannotatorReviewAnnotation = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["COMMENT", "DELETION", "GLOBAL_COMMENT"]),
  text: Schema.String,
  originalText: Schema.String,
  author: Schema.String,
  submittedAt: Schema.String,
});
type PersistedPlannotatorReviewAnnotation = typeof PersistedPlannotatorReviewAnnotation.Type;

const PersistedPlannotatorSession = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  token: Schema.String,
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
  format: PlannotatorPlanFormat,
  planPath: Schema.String,
  logPath: Schema.String,
  proxyPath: Schema.String,
  pid: Schema.Int,
  port: Schema.NullOr(Schema.Int),
  directUrl: Schema.NullOr(Schema.String),
  status: PlannotatorSessionStatus,
  feedback: Schema.String,
  annotationHistory: Schema.Array(PersistedPlannotatorReviewAnnotation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type PersistedPlannotatorSession = typeof PersistedPlannotatorSession.Type;

const PlannotatorRegistryEntry = Schema.Struct({
  port: Schema.Int,
  url: Schema.optional(Schema.String),
});

const decodePersistedSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedPlannotatorSession),
);
const encodePersistedSession = Schema.encodeEffect(
  Schema.fromJsonString(PersistedPlannotatorSession),
);
const decodeRegistryEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlannotatorRegistryEntry),
);

export interface PlannotatorSession {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly planId: OrchestrationProposedPlanId;
  readonly format: PlannotatorPlanFormat;
  readonly planPath: string;
  readonly logPath: string;
  readonly proxyPath: string;
  readonly pid: number;
  readonly port: number | null;
  readonly directUrl: string | null;
  readonly status: PlannotatorSessionStatus;
  readonly feedback: string;
  readonly annotationHistory: ReadonlyArray<
    PlannotatorReviewAnnotation & { readonly submittedAt: string }
  >;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class PlannotatorManagerError extends Schema.TaggedErrorClass<PlannotatorManagerError>()(
  "PlannotatorManagerError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface StartPlannotatorInput {
  readonly threadId: ThreadId;
  readonly planId: OrchestrationProposedPlanId;
  readonly format: PlannotatorPlanFormat;
  readonly content: string;
}

export interface ReopenPlannotatorInput {
  readonly tokenOrId: string;
  readonly planId?: OrchestrationProposedPlanId;
  readonly format?: PlannotatorPlanFormat;
  readonly content?: string;
}

interface PlannotatorManagerShape {
  readonly start: (
    input: StartPlannotatorInput,
  ) => Effect.Effect<PlannotatorSession, PlannotatorManagerError>;
  readonly discard: (tokenOrId: string) => Effect.Effect<void>;
  readonly getByToken: (token: string) => Effect.Effect<PlannotatorSession | null>;
  readonly getById: (id: string) => Effect.Effect<PlannotatorSession | null>;
  readonly list: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<PlannotatorSession>>;
  readonly renewClientLease: (token: string, clientId: string | null) => Effect.Effect<void>;
  readonly releaseClientLease: (
    token: string,
    clientId: string,
  ) => Effect.Effect<void, PlannotatorManagerError>;
  readonly reopen: (
    input: ReopenPlannotatorInput,
  ) => Effect.Effect<PlannotatorSession, PlannotatorManagerError>;
  readonly applyDecision: (
    token: string,
    decision: PlannotatorDecision,
    annotations?: ReadonlyArray<PlannotatorReviewAnnotation>,
  ) => Effect.Effect<PlannotatorSession, PlannotatorManagerError>;
}

export class PlannotatorManager extends Context.Service<
  PlannotatorManager,
  PlannotatorManagerShape
>()("t3/plannotator/PlannotatorManager") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function hasLivePlannotatorProcess(status: PlannotatorSessionStatus): boolean {
  return status === "starting" || status === "running" || status === "applying";
}

function publicSession(session: PersistedPlannotatorSession): PlannotatorSession {
  const { token: _token, version: _version, ...visible } = session;
  return visible;
}

function errorMessage(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim()
  ) {
    return cause.message;
  }
  return String(cause);
}

const managerError = (operation: string, prefix: string) => (cause: unknown) =>
  new PlannotatorManagerError({
    operation,
    detail: `${prefix}: ${errorMessage(cause)}`,
    cause,
  });

const randomToken = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(24).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.mapError(managerError("start", "Could not create a secure review token")),
  );

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const query = yield* ProjectionSnapshotQuery;
  const dispatcher = yield* OrchestrationCommandDispatcher;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const childScope = yield* Scope.make("sequential");
  const rootDir = path.join(config.stateDir, "plannotator");
  const plansDir = path.join(rootDir, "plans");
  const sessionsDir = path.join(rootDir, "sessions");
  const logsDir = path.join(config.logsDir, "plannotator");
  const registryDir = path.join(NodeOS.homedir(), ".plannotator", "sessions");
  const sessions = new Map<string, PersistedPlannotatorSession>();
  const handles = new Map<string, ChildProcessSpawner.ChildProcessHandle>();
  const reopenLocks = new Map<string, Semaphore.Semaphore>();
  const clientLeases = new PlannotatorClientLease();

  const manifestPath = (session: PersistedPlannotatorSession) =>
    path.join(sessionsDir, `${session.id}.json`);

  const persist = Effect.fn("PlannotatorManager.persist")(function* (
    session: PersistedPlannotatorSession,
  ) {
    const encoded = yield* encodePersistedSession(session).pipe(
      Effect.mapError(managerError("persist", "Could not encode Plannotator state")),
    );
    const target = manifestPath(session);
    const temporary = `${target}.${process.pid}.tmp`;
    yield* fileSystem
      .writeFileString(temporary, `${encoded}\n`, { mode: 0o600 })
      .pipe(
        Effect.andThen(fileSystem.rename(temporary, target)),
        Effect.mapError(managerError("persist", "Could not persist Plannotator state")),
      );
  });

  const update = Effect.fn("PlannotatorManager.update")(function* (
    current: PersistedPlannotatorSession,
    patch: Partial<PersistedPlannotatorSession>,
  ) {
    const updatedAt = yield* nowIso;
    const next: PersistedPlannotatorSession = { ...current, ...patch, updatedAt };
    sessions.set(next.token, next);
    if (!hasLivePlannotatorProcess(next.status)) clientLeases.removeReview(next.token);
    yield* persist(next);
    return next;
  });

  const stopHandle = (token: string) =>
    Effect.gen(function* () {
      const handle = handles.get(token);
      if (!handle) return;
      handles.delete(token);
      yield* handle.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
    });

  const suspendIfUnowned = (token: string) => {
    let lock = reopenLocks.get(token);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      reopenLocks.set(token, lock);
    }
    return lock.withPermit(
      Effect.gen(function* () {
        const current = sessions.get(token);
        if (!current) {
          clientLeases.removeReview(token);
          return;
        }
        if (!hasLivePlannotatorProcess(current.status)) {
          clientLeases.removeReview(token);
          return;
        }

        const [now, updatedAt] = yield* Effect.all([Clock.currentTimeMillis, nowIso]);
        if (clientLeases.isOwned(token, now)) return;

        // T3-CUSTOM(expbkt3): Publish terminal state synchronously before the
        // captured child is stopped. A concurrent heartbeat then sees a
        // terminal review and cannot resurrect ownership during persistence.
        const suspended: PersistedPlannotatorSession = {
          ...current,
          status: "exited",
          port: null,
          directUrl: null,
          error: null,
          updatedAt,
        };
        sessions.set(token, suspended);
        clientLeases.removeReview(token);
        yield* persist(suspended).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              sessions.set(token, current);
              clientLeases.trackUnowned(token);
            }),
          ),
        );
        yield* stopHandle(token);
      }),
    );
  };

  const probePort = (port: number) =>
    httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/`)).pipe(
      Effect.scoped,
      Effect.timeout("500 millis"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const discover = (
    handle: ChildProcessSpawner.ChildProcessHandle,
  ): Effect.Effect<
    { readonly port: number; readonly url: string | null },
    PlannotatorManagerError
  > => {
    const registryPath = path.join(registryDir, `${handle.pid}.json`);
    const attempt = Effect.gen(function* () {
      const running = yield* handle.isRunning;
      if (!running) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: "Plannotator exited before its review server became ready.",
        });
      }
      const raw = yield* fileSystem.readFileString(registryPath);
      const registry = yield* decodeRegistryEntry(raw);
      if (registry.port < 1 || !(yield* probePort(registry.port))) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: "The Plannotator review port is not accepting connections yet.",
        });
      }
      return { port: registry.port, url: registry.url ?? null };
    });
    return attempt.pipe(
      Effect.retry({
        times: 149,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.mapError(managerError("start", "Plannotator did not become ready within 15 seconds")),
    );
  };

  const appendActivity = Effect.fn("PlannotatorManager.appendActivity")(function* (
    session: PersistedPlannotatorSession,
    summary: string,
    tone: "info" | "approval" | "error",
    payload: unknown,
  ) {
    const [commandUuid, eventUuid, createdAt] = yield* Effect.all([
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      nowIso,
    ]);
    return yield* dispatcher.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`plannotator:activity:${commandUuid}`),
      threadId: session.threadId,
      activity: {
        id: EventId.make(`plannotator:${eventUuid}`),
        tone,
        kind: "plannotator-review",
        summary,
        payload,
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const replayAnnotationHistory = Effect.fn("PlannotatorManager.replayAnnotationHistory")(
    function* (session: PersistedPlannotatorSession) {
      if (session.port === null || session.annotationHistory.length === 0) return;
      const request = HttpClientRequest.post(
        `http://127.0.0.1:${session.port}/api/external-annotations`,
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          annotations: session.annotationHistory.map((annotation) => ({
            source: "t3-review-history",
            type: annotation.type,
            text: annotation.text,
            ...(annotation.originalText ? { originalText: annotation.originalText } : {}),
            ...(annotation.author ? { author: annotation.author } : {}),
          })),
        }),
      );
      yield* httpClient.execute(request).pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.text.pipe(Effect.asVoid)
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new PlannotatorManagerError({
                      operation: "reopen",
                      detail: `Plannotator rejected saved annotation history (${response.status}): ${body}`,
                    }),
                  ),
                ),
              ),
        ),
        Effect.scoped,
        Effect.mapError(managerError("reopen", "Could not restore prior Plannotator annotations")),
      );
    },
  );

  const clearSubmittedDraft = (session: PersistedPlannotatorSession) =>
    session.port === null
      ? Effect.void
      : httpClient
          .execute(HttpClientRequest.delete(`http://127.0.0.1:${session.port}/api/draft`))
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.scoped,
            Effect.ignore,
          );

  const launch = Effect.fn("PlannotatorManager.launch")(function* (
    current: PersistedPlannotatorSession,
    cwd: string,
    activitySummary: string,
  ) {
    yield* stopHandle(current.token);
    // T3-CUSTOM(expbkt3): Plannotator otherwise converts HTML files to
    // Markdown. Select raw HTML rendering only for an HTML review.
    const command = ChildProcess.make("plannotator", plannotatorAnnotateArguments(current), {
      cwd,
      env: {
        BROWSER: "/usr/bin/true",
        CI: "1",
        NO_BROWSER: "1",
        OPEN_BROWSER: "0",
        LAUNCH_BROWSER: "0",
      },
      extendEnv: true,
      detached: false,
      stdin: "ignore",
    });
    const handle = yield* spawner
      .spawn(command)
      .pipe(
        Effect.provideService(Scope.Scope, childScope),
        Effect.mapError(managerError("start", "Could not launch Plannotator")),
      );
    handles.set(current.token, handle);
    clientLeases.registerReview(current.token, yield* Clock.currentTimeMillis);
    yield* Stream.run(
      handle.all,
      fileSystem.sink(current.logPath, { flag: "a", mode: 0o600 }),
    ).pipe(Effect.ignore, Effect.forkIn(childScope));

    const starting = yield* update(current, {
      pid: handle.pid,
      port: null,
      directUrl: null,
      status: "starting",
      error: null,
    });
    yield* handle.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          handles.delete(starting.token);
          const latest = sessions.get(starting.token);
          if (
            !latest ||
            (latest.status !== "starting" &&
              latest.status !== "running" &&
              latest.status !== "applying")
          ) {
            return;
          }
          yield* update(latest, {
            status: code === 0 ? "exited" : "error",
            port: null,
            directUrl: null,
            error: code === 0 ? null : `Plannotator exited with code ${code}.`,
          }).pipe(Effect.ignore);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(childScope),
    );

    const discovered = yield* discover(handle).pipe(
      Effect.tapError((cause) =>
        update(starting, { status: "error", error: cause.message }).pipe(
          Effect.andThen(stopHandle(starting.token)),
          Effect.ignore,
        ),
      ),
    );
    const running = yield* update(starting, {
      port: discovered.port,
      directUrl: discovered.url,
      status: "running",
    });
    yield* replayAnnotationHistory(running).pipe(
      Effect.tapError((cause) =>
        update(running, { status: "error", error: cause.message }).pipe(
          Effect.andThen(stopHandle(running.token)),
          Effect.ignore,
        ),
      ),
    );
    yield* appendActivity(running, activitySummary, "approval", {
      plannotatorSessionId: running.id,
      proxyPath: running.proxyPath,
      format: running.format,
      restoredAnnotations: running.annotationHistory.length,
    }).pipe(Effect.ignore);
    return running;
  });

  yield* Effect.all(
    [
      fileSystem.makeDirectory(plansDir, { recursive: true }),
      fileSystem.makeDirectory(sessionsDir, { recursive: true }),
      fileSystem.makeDirectory(logsDir, { recursive: true }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(managerError("initialize", "Could not initialize Plannotator directories")),
  );

  const manifestFiles = yield* fileSystem
    .readDirectory(sessionsDir)
    .pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    manifestFiles.filter((file) => file.endsWith(".json")),
    (file) =>
      Effect.gen(function* () {
        const decoded = yield* fileSystem
          .readFileString(path.join(sessionsDir, file))
          .pipe(Effect.flatMap(decodePersistedSession));
        const isLive =
          decoded.port !== null &&
          (decoded.status === "starting" ||
            decoded.status === "running" ||
            decoded.status === "applying") &&
          (yield* probePort(decoded.port));
        const loaded = isLive
          ? decoded
          : decoded.status === "starting" ||
              decoded.status === "running" ||
              decoded.status === "applying"
            ? {
                ...decoded,
                status: "exited" as const,
                error: "The Plannotator process is no longer reachable.",
                updatedAt: yield* nowIso,
              }
            : decoded;
        sessions.set(loaded.token, loaded);
        if (isLive) clientLeases.registerReview(loaded.token, yield* Clock.currentTimeMillis);
        if (loaded !== decoded) yield* persist(loaded);
      }).pipe(Effect.ignore),
    { concurrency: 4, discard: true },
  );

  const start: PlannotatorManagerShape["start"] = (input) =>
    Effect.gen(function* () {
      if (!input.content.trim()) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: "Plan content cannot be empty.",
        });
      }
      if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: "Plan content exceeds the 2 MiB safety limit.",
        });
      }
      const threadOption = yield* query
        .getThreadDetailById(input.threadId)
        .pipe(Effect.mapError(managerError("start", "Could not load the target T3 session")));
      if (Option.isNone(threadOption)) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: `T3 session ${input.threadId} was not found.`,
        });
      }
      const thread = threadOption.value;
      const shell = yield* query
        .getShellSnapshot()
        .pipe(Effect.mapError(managerError("start", "Could not load the target T3 project")));
      const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
      if (!project) {
        return yield* new PlannotatorManagerError({
          operation: "start",
          detail: `Project ${thread.projectId} was not found.`,
        });
      }

      const [id, token, createdAt] = yield* Effect.all([
        crypto.randomUUIDv4,
        randomToken(crypto),
        nowIso,
      ]).pipe(Effect.mapError(managerError("start", "Could not initialize the review session")));
      const extension = input.format === "html" ? "html" : "md";
      const planPath = path.join(plansDir, `${id}.${extension}`);
      const logPath = path.join(logsDir, `${id}.log`);
      const proxyPath = plannotatorProxyPath(token);
      const cwd = thread.worktreePath ?? project.workspaceRoot;

      yield* fileSystem
        .writeFileString(planPath, input.content, { mode: 0o600 })
        .pipe(Effect.mapError(managerError("start", "Could not save the submitted plan")));

      const starting: PersistedPlannotatorSession = {
        version: 1,
        id,
        token,
        threadId: input.threadId,
        planId: input.planId,
        format: input.format,
        planPath,
        logPath,
        proxyPath,
        pid: 0,
        port: null,
        directUrl: null,
        status: "starting",
        feedback: "",
        annotationHistory: [],
        error: null,
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(token, starting);
      yield* persist(starting).pipe(
        Effect.tapError(() => fileSystem.remove(planPath).pipe(Effect.ignore)),
      );
      const running = yield* launch(starting, cwd, "Plan opened for review in Plannotator.").pipe(
        Effect.tapError((cause) =>
          update(starting, { status: "error", error: cause.message }).pipe(Effect.ignore),
        ),
      );
      return publicSession(running);
    });

  const discard: PlannotatorManagerShape["discard"] = (tokenOrId) =>
    Effect.gen(function* () {
      const current =
        sessions.get(tokenOrId) ??
        [...sessions.values()].find((session) => session.id === tokenOrId);
      if (!current) return;
      yield* stopHandle(current.token);
      clientLeases.removeReview(current.token);
      sessions.delete(current.token);
      yield* Effect.all(
        [
          fileSystem.remove(manifestPath(current)),
          fileSystem.remove(current.planPath),
          fileSystem.remove(current.logPath),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ignore);
    });

  const reopen: PlannotatorManagerShape["reopen"] = (input) => {
    const current =
      sessions.get(input.tokenOrId) ??
      [...sessions.values()].find((session) => session.id === input.tokenOrId);
    if (!current) {
      return Effect.fail(
        new PlannotatorManagerError({
          operation: "reopen",
          detail: "The Plannotator review session was not found.",
        }),
      );
    }
    let lock = reopenLocks.get(current.token);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      reopenLocks.set(current.token, lock);
    }
    return lock.withPermit(
      Effect.gen(function* () {
        const latest = sessions.get(current.token) ?? current;
        if (input.content !== undefined) {
          if (!input.content.trim()) {
            return yield* new PlannotatorManagerError({
              operation: "reopen",
              detail: "Plan content cannot be empty.",
            });
          }
          if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
            return yield* new PlannotatorManagerError({
              operation: "reopen",
              detail: "Plan content exceeds the 2 MiB safety limit.",
            });
          }
        }

        // T3-CUSTOM(expbkt3): Review reopening is a final self-healing seam for
        // provider HTML that older native-plan detection persisted as .md.
        // Explicit HTML sessions stay authoritative and are never inferred from
        // their intentionally Markdown native receipt.
        const shouldInspectStoredFormat = input.format === undefined && latest.format === "md";
        const requestedFormatChanged = input.format !== undefined && input.format !== latest.format;
        const existingContent =
          input.content === undefined && !shouldInspectStoredFormat && !requestedFormatChanged
            ? null
            : yield* fileSystem
                .readFileString(latest.planPath)
                .pipe(Effect.mapError(managerError("reopen", "Could not read the reviewed plan")));
        const nextFormat =
          input.format ??
          (shouldInspectStoredFormat && existingContent !== null
            ? resolveStoredPlannotatorPlanFormat(latest.format, existingContent)
            : latest.format);
        const formatChanged = nextFormat !== latest.format;
        const contentChanged = input.content !== undefined && input.content !== existingContent;
        const nextPlanId = input.planId;
        const planIdChanged = nextPlanId !== undefined && nextPlanId !== latest.planId;
        const processIsLive =
          latest.port !== null &&
          (latest.status === "starting" ||
            latest.status === "running" ||
            latest.status === "applying") &&
          (yield* probePort(latest.port));

        if (processIsLive && !contentChanged && !formatChanged) {
          clientLeases.registerReview(current.token, yield* Clock.currentTimeMillis);
          const unchanged =
            planIdChanged && nextPlanId !== undefined
              ? yield* update(latest, { planId: nextPlanId })
              : latest;
          return publicSession(unchanged);
        }

        const [threadOption, activeShell] = yield* Effect.all([
          query
            .getThreadDetailById(latest.threadId)
            .pipe(Effect.mapError(managerError("reopen", "Could not load the target T3 session"))),
          query
            .getShellSnapshot()
            .pipe(Effect.mapError(managerError("reopen", "Could not load the target T3 project"))),
        ]);
        const archivedShell = Option.isNone(threadOption)
          ? yield* query
              .getArchivedShellSnapshot()
              .pipe(
                Effect.mapError(managerError("reopen", "Could not load the archived T3 session")),
              )
          : null;
        const launchLocation = resolvePlannotatorLaunchLocation({
          threadId: latest.threadId,
          activeThread: Option.getOrNull(threadOption),
          activeProjects: activeShell.projects,
          archivedThreads: archivedShell?.threads ?? [],
          archivedProjects: archivedShell?.projects ?? [],
        });
        if (launchLocation.kind === "thread-not-found") {
          return yield* new PlannotatorManagerError({
            operation: "reopen",
            detail: `T3 session ${latest.threadId} was not found.`,
          });
        }
        if (launchLocation.kind === "project-not-found") {
          return yield* new PlannotatorManagerError({
            operation: "reopen",
            detail: `Project ${launchLocation.projectId} was not found.`,
          });
        }
        // T3-CUSTOM(expbkt3): Keep the durable review identity and annotation
        // history while allowing a revised native plan to change renderer.
        const nextPlanPath = formatChanged
          ? path.join(plansDir, `${latest.id}.${nextFormat === "html" ? "html" : "md"}`)
          : latest.planPath;
        if (contentChanged || formatChanged) {
          const nextContent = input.content ?? existingContent;
          if (nextContent === null) {
            return yield* new PlannotatorManagerError({
              operation: "reopen",
              detail: "Could not determine the revised plan content.",
            });
          }
          yield* fileSystem
            .writeFileString(nextPlanPath, nextContent, { mode: 0o600 })
            .pipe(Effect.mapError(managerError("reopen", "Could not update the reviewed plan")));
        }
        const sessionChanged = planIdChanged || formatChanged;
        const prepared = sessionChanged
          ? yield* update(latest, {
              ...(planIdChanged && nextPlanId !== undefined ? { planId: nextPlanId } : {}),
              ...(formatChanged ? { format: nextFormat, planPath: nextPlanPath } : {}),
            }).pipe(
              Effect.tapError(() =>
                formatChanged ? fileSystem.remove(nextPlanPath).pipe(Effect.ignore) : Effect.void,
              ),
            )
          : latest;
        if (formatChanged) {
          yield* fileSystem.remove(latest.planPath).pipe(Effect.ignore);
        }
        const running = yield* launch(
          prepared,
          launchLocation.workingDirectory,
          prepared.annotationHistory.length > 0
            ? "Plan review reopened with prior annotations."
            : "Plan review reopened in Plannotator.",
        ).pipe(
          Effect.tapError((cause) =>
            update(prepared, { status: "error", error: cause.message }).pipe(Effect.ignore),
          ),
        );
        return publicSession(running);
      }),
    );
  };

  const applyDecision: PlannotatorManagerShape["applyDecision"] = (
    token,
    decision,
    annotations = [],
  ) =>
    Effect.gen(function* () {
      const current = sessions.get(token);
      if (!current) {
        return yield* new PlannotatorManagerError({
          operation: "decision",
          detail: "The Plannotator review session was not found.",
        });
      }
      if (
        current.status === "approved" ||
        current.status === "feedback" ||
        current.status === "denied"
      ) {
        return publicSession(current);
      }
      if (current.status === "applying") {
        return publicSession(current);
      }
      if (current.status !== "running") {
        return yield* new PlannotatorManagerError({
          operation: "decision",
          detail: `The Plannotator review is ${current.status}, so it cannot accept a decision.`,
        });
      }
      const submittedAt = yield* nowIso;
      const annotationHistory = mergePlannotatorAnnotationHistory(
        current.annotationHistory,
        annotations,
        submittedAt,
      );
      const applying = yield* update(current, {
        status: "applying",
        feedback: decision.feedback,
        annotationHistory,
        error: null,
      });
      // Once a review round is durably captured by T3, clear Plannotator's
      // crash-recovery draft so the next reopen does not offer a duplicate
      // restore. Drafts from genuinely interrupted, unsubmitted rounds remain.
      yield* clearSubmittedDraft(applying);
      const threadOption = yield* query.getThreadDetailById(applying.threadId).pipe(
        Effect.mapError(managerError("decision", "Could not load the plan's target T3 session")),
        Effect.tapError((cause) =>
          update(applying, { status: "error", error: cause.message }).pipe(Effect.ignore),
        ),
      );
      if (Option.isNone(threadOption)) {
        const cause = new PlannotatorManagerError({
          operation: "decision",
          detail: `T3 session ${applying.threadId} was not found.`,
        });
        yield* update(applying, { status: "error", error: cause.message }).pipe(Effect.ignore);
        return yield* cause;
      }
      const thread = threadOption.value;
      const planContent = yield* fileSystem.readFileString(applying.planPath).pipe(
        Effect.mapError(managerError("decision", "Could not read the reviewed plan")),
        Effect.tapError((cause) =>
          update(applying, { status: "error", error: cause.message }).pipe(Effect.ignore),
        ),
      );

      const apply = Effect.gen(function* () {
        if (decision.kind === "denied") {
          yield* appendActivity(applying, "Plan review was declined in Plannotator.", "error", {
            decision: decision.kind,
          }).pipe(Effect.ignore);
          return;
        }
        const prompt =
          decision.kind === "feedback"
            ? [
                "Please revise the plan based on the Plannotator review feedback.",
                "Respond with the complete revised plan. Do not modify repository files while planning.",
                "",
                "Review feedback:",
                decision.feedback || "Plan changes were requested.",
                "",
                "Current reviewed plan:",
                planContent.trim(),
              ].join("\n")
            : [
                "PLEASE IMPLEMENT THIS APPROVED PLAN:",
                planContent.trim(),
                ...(decision.feedback ? ["", "Reviewer notes:", decision.feedback] : []),
              ].join("\n");
        const [commandUuid, messageUuid, modeCommandUuid, createdAt] = yield* Effect.all([
          crypto.randomUUIDv4,
          crypto.randomUUIDv4,
          crypto.randomUUIDv4,
          nowIso,
        ]);
        const modeCommand = approvedPlanInteractionModeCommand({
          decision,
          threadId: applying.threadId,
          commandId: CommandId.make(`plannotator:mode:${modeCommandUuid}`),
          createdAt,
        });
        if (modeCommand) {
          yield* dispatcher.dispatch(modeCommand);
        }
        yield* dispatcher.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`plannotator:turn:${commandUuid}`),
          threadId: applying.threadId,
          message: {
            messageId: MessageId.make(`plannotator:${messageUuid}`),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: decision.kind === "feedback" ? "plan" : "default",
          ...(decision.kind === "approved"
            ? {
                sourceProposedPlan: {
                  threadId: applying.threadId,
                  planId: applying.planId,
                },
              }
            : {}),
          createdAt,
        });
        yield* appendActivity(
          applying,
          decision.kind === "approved"
            ? "Plan approved in Plannotator; implementation was started."
            : "Plannotator feedback was sent to the planning agent.",
          decision.kind === "approved" ? "approval" : "info",
          { decision: decision.kind, feedback: decision.feedback },
        ).pipe(Effect.ignore);
      }).pipe(
        Effect.mapError(managerError("decision", "Could not apply the Plannotator decision")),
      );

      yield* apply.pipe(
        Effect.tapError((cause) =>
          update(applying, { status: "error", error: cause.message }).pipe(Effect.ignore),
        ),
      );
      const decided = yield* update(applying, {
        status: decision.kind,
        feedback: decision.feedback,
        error: null,
      });
      yield* stopHandle(token);
      return publicSession(decided);
    });

  const renewClientLease: PlannotatorManagerShape["renewClientLease"] = (token, clientId) =>
    Effect.gen(function* () {
      const current = sessions.get(token);
      if (!current || !hasLivePlannotatorProcess(current.status)) {
        clientLeases.removeReview(token);
        return;
      }
      clientLeases.renew(token, clientId, yield* Clock.currentTimeMillis);
    });

  const releaseClientLease: PlannotatorManagerShape["releaseClientLease"] = (token, clientId) =>
    Effect.gen(function* () {
      const becameUnowned = clientLeases.release(token, clientId, yield* Clock.currentTimeMillis);
      if (becameUnowned) yield* suspendIfUnowned(token);
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => clientLeases.clear()).pipe(
      Effect.andThen(Scope.close(childScope, Exit.void)),
    ),
  );

  const manager = PlannotatorManager.of({
    start,
    discard,
    getByToken: (token) =>
      Effect.sync(() => {
        const session = sessions.get(token);
        return session ? publicSession(session) : null;
      }),
    getById: (id) =>
      Effect.sync(() => {
        const session = [...sessions.values()].find((candidate) => candidate.id === id);
        return session ? publicSession(session) : null;
      }),
    list: (threadId) =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((session) => threadId === undefined || session.threadId === threadId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(publicSession),
      ),
    renewClientLease,
    releaseClientLease,
    reopen,
    applyDecision,
  });

  const reapExpiredClientLeases = Effect.fn("PlannotatorManager.reapExpiredClientLeases")(
    function* () {
      const expiredTokens = clientLeases.collectExpired(yield* Clock.currentTimeMillis);
      yield* Effect.forEach(
        expiredTokens,
        (token) =>
          suspendIfUnowned(token).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => clientLeases.retryUnowned(token)).pipe(
                Effect.andThen(
                  Effect.logWarning("Failed to suspend browser-unowned Plannotator review", {
                    cause,
                    plannotatorSessionId: sessions.get(token)?.id,
                  }),
                ),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    },
  );
  yield* Effect.forever(
    Effect.sleep(PLANNOTATOR_CLIENT_REAPER_MS).pipe(Effect.andThen(reapExpiredClientLeases)),
  ).pipe(Effect.forkIn(childScope));

  const attachNativePlanSafely = Effect.fn("PlannotatorManager.attachNativePlanSafely")(function* (
    threadId: ThreadId,
    proposedPlan: Parameters<typeof attachNativePlanReview>[1]["proposedPlan"],
  ) {
    yield* attachNativePlanReview(
      {
        manager,
        dispatcher,
        randomUuid: crypto.randomUUIDv4.pipe(
          Effect.mapError(
            managerError("native-plan", "Could not create a native Plannotator command identifier"),
          ),
        ),
        now: nowIso,
      },
      { threadId, proposedPlan },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not attach Plannotator to native proposed plan", {
          threadId,
          planId: proposedPlan.id,
          cause: String(cause),
        }),
      ),
    );
  });

  const nativePlanAttachmentWorker = yield* makeKeyedCoalescingWorker<
    string,
    NativePlanBridgeInput,
    never,
    never
  >({
    merge: (current, next) =>
      current.proposedPlan.updatedAt.localeCompare(next.proposedPlan.updatedAt) > 0
        ? current
        : next,
    process: (_key, { threadId, proposedPlan }) => attachNativePlanSafely(threadId, proposedPlan),
  });
  const scheduleNativePlanAttachment = (
    threadId: ThreadId,
    proposedPlan: Parameters<typeof attachNativePlanReview>[1]["proposedPlan"],
  ) =>
    nativePlanAttachmentWorker.enqueue(`${threadId}:${proposedPlan.id}`, {
      threadId,
      proposedPlan,
    });

  // Subscribe before reconciling the snapshot so a plan emitted during startup
  // cannot fall into the gap between the two operations.
  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      event.type === "thread.proposed-plan-upserted"
        ? scheduleNativePlanAttachment(event.payload.threadId, event.payload.proposedPlan)
        : Effect.void,
    ),
  );

  yield* query.getSnapshot().pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        latestPlansForNativeReview(snapshot.threads),
        ({ threadId, proposedPlan }) => scheduleNativePlanAttachment(threadId, proposedPlan),
        { concurrency: 4, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not reconcile native proposed plans with Plannotator", {
        cause: String(cause),
      }),
    ),
  );

  return manager;
});

export const layer = Layer.effect(PlannotatorManager, make);
