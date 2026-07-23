/**
 * OrchestrationAccessControl - Per-user visibility & command-access service.
 *
 * Resolves the operating user from a session subject and answers per-entity
 * access questions used by the HTTP and WebSocket enforcement points. When the
 * subject is not a Clerk operator (pairing/CLI/desktop, or single-user mode)
 * `actorFor` returns `Option.none()` and callers skip all filtering — local mode
 * is unchanged.
 *
 * @module OrchestrationAccessControl
 */
import type { ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface OrchestrationAccessControlShape {
  /**
   * The Clerk user behind a session subject, or `none` for an unrestricted
   * operator (non-`clerk:` subject, i.e. pairing/CLI/desktop/single-user).
   */
  readonly actorFor: (subject: string) => Option.Option<UserId>;
  /** Whether `userId` may see/operate on the thread (owner, tag, or project). */
  readonly canAccessThread: (
    userId: UserId,
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may see/operate on the project. */
  readonly canAccessProject: (
    userId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may transfer thread ownership. */
  readonly canTransferThreadOwnership: (
    userId: UserId,
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** Whether `userId` may transfer project ownership. */
  readonly canTransferProjectOwnership: (
    userId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class OrchestrationAccessControl extends Context.Service<
  OrchestrationAccessControl,
  OrchestrationAccessControlShape
>()("t3/orchestration/Services/AccessControl/OrchestrationAccessControl") {}
