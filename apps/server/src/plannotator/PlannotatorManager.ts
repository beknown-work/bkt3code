import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ThreadId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { plannotatorProxyPath } from "@t3tools/shared/plannotator";
import * as NodeOS from "node:os";
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
import type { PlannotatorDecision } from "./model.ts";

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

interface PlannotatorManagerShape {
  readonly start: (
    input: StartPlannotatorInput,
  ) => Effect.Effect<PlannotatorSession, PlannotatorManagerError>;
  readonly discard: (tokenOrId: string) => Effect.Effect<void>;
  readonly getByToken: (token: string) => Effect.Effect<PlannotatorSession | null>;
  readonly getById: (id: string) => Effect.Effect<PlannotatorSession | null>;
  readonly list: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<PlannotatorSession>>;
  readonly applyDecision: (
    token: string,
    decision: PlannotatorDecision,
  ) => Effect.Effect<PlannotatorSession, PlannotatorManagerError>;
}

export class PlannotatorManager extends Context.Service<
  PlannotatorManager,
  PlannotatorManagerShape
>()("t3/plannotator/PlannotatorManager") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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
      const command = ChildProcess.make(
        "plannotator",
        ["--browser", "none", "annotate", planPath, "--gate", "--json"],
        {
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
        },
      );
      const handle = yield* spawner
        .spawn(command)
        .pipe(
          Effect.provideService(Scope.Scope, childScope),
          Effect.mapError(managerError("start", "Could not launch Plannotator")),
        );
      handles.set(token, handle);
      yield* Stream.run(handle.all, fileSystem.sink(logPath, { flag: "a", mode: 0o600 })).pipe(
        Effect.ignore,
        Effect.forkIn(childScope),
      );

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
        pid: handle.pid,
        port: null,
        directUrl: null,
        status: "starting",
        feedback: "",
        error: null,
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(token, starting);
      yield* persist(starting).pipe(
        Effect.tapError(() =>
          stopHandle(token).pipe(
            Effect.andThen(fileSystem.remove(planPath).pipe(Effect.ignore)),
            Effect.ignore,
          ),
        ),
      );

      yield* handle.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            handles.delete(token);
            const current = sessions.get(token);
            if (
              !current ||
              (current.status !== "starting" &&
                current.status !== "running" &&
                current.status !== "applying")
            ) {
              return;
            }
            yield* update(current, {
              status: code === 0 ? "exited" : "error",
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
            Effect.andThen(stopHandle(token)),
            Effect.ignore,
          ),
        ),
      );
      const running = yield* update(starting, {
        port: discovered.port,
        directUrl: discovered.url,
        status: "running",
      });
      yield* appendActivity(running, "Plan opened for review in Plannotator.", "approval", {
        plannotatorSessionId: running.id,
        proxyPath: running.proxyPath,
        format: running.format,
      }).pipe(Effect.ignore);
      return publicSession(running);
    });

  const discard: PlannotatorManagerShape["discard"] = (tokenOrId) =>
    Effect.gen(function* () {
      const current =
        sessions.get(tokenOrId) ??
        [...sessions.values()].find((session) => session.id === tokenOrId);
      if (!current) return;
      yield* stopHandle(current.token);
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

  const applyDecision: PlannotatorManagerShape["applyDecision"] = (token, decision) =>
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
      const applying = yield* update(current, {
        status: "applying",
        feedback: decision.feedback,
        error: null,
      });
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
        const [commandUuid, messageUuid, createdAt] = yield* Effect.all([
          crypto.randomUUIDv4,
          crypto.randomUUIDv4,
          nowIso,
        ]);
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

  yield* Effect.addFinalizer(() => Scope.close(childScope, Exit.void));

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
    applyDecision,
  });

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
