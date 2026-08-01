// T3-CUSTOM(expbkt3): automatic reconnection of sessions that stopped without
// anyone asking (server restart, provider crash).
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SessionRecoveryShape {
  /**
   * Start the desired-state tracker and the periodic reconnect sweep within
   * the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SessionRecovery extends Context.Service<SessionRecovery, SessionRecoveryShape>()(
  "t3/recovery/SessionRecovery",
) {}
