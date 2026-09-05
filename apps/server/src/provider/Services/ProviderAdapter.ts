/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
  UserId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** T3-CUSTOM(expbkt3): explicit busy-thread delivery semantics. */
  readonly activeTurnInput: "steer" | "queue";
  /** T3-CUSTOM(expbkt3): whether a persisted resume cursor is sufficient for guarded recovery. */
  readonly durableResume: "supported" | "unsupported";
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
}

export interface ProviderSessionExecutionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** T3-CUSTOM(expbkt3): User whose delegated MCP grants back this ACP generation. */
  readonly actorUserId?: UserId | null;
  /**
   * T3-CUSTOM(expbkt3): Additive session-identity markers, folded into
   * `environment` just before the adapter spawns. Kept separate from it so
   * `environment` keeps meaning "source-control identity" everywhere else.
   */
  readonly identityEnvironment?: NodeJS.ProcessEnv;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  /** T3-CUSTOM(expbkt3): recovery must distinguish terminal proof from mere history presence. */
  readonly state: "completed" | "interrupted" | "failed" | "in-progress" | "unknown";
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderSessionInspection {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly state: "starting" | "ready" | "running" | "stopping" | "stopped" | "failed";
  readonly activeProviderTurnId: TurnId | null;
  readonly runtimeAlive: boolean;
}

export interface InterruptAcknowledgement {
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string;
}

export interface VerifiedTermination {
  readonly verified: boolean;
  readonly graceful: boolean;
  readonly processTreeExited: boolean;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
    options?: ProviderSessionExecutionOptions,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly compactThread?: (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
  ) => Effect.Effect<void, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /** Observable lifecycle API used by the execution supervisor. */
  readonly inspectSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderSessionInspection | null, TError>;
  readonly requestTurnInterrupt: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<InterruptAcknowledgement, TError>;
  readonly terminateSession: (threadId: ThreadId) => Effect.Effect<VerifiedTermination, TError>;
  readonly watchSession: (
    threadId: ThreadId,
    generation: number,
  ) => Stream.Stream<ProviderRuntimeEvent, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
