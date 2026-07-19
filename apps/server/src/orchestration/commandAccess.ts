/**
 * commandAccess - Shared client-command authorization for team mode.
 *
 * Used by both the HTTP `dispatch` endpoint and the WebSocket `dispatchCommand`
 * method so a Clerk operator can only act on threads/projects they can access.
 * Denials are surfaced by callers as "not found" (no existence leak).
 *
 * @module commandAccess
 */
import type { OrchestrationCommand, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationAccessControlShape } from "./Services/AccessControl.ts";

/**
 * Whether `actorUserId` may dispatch `command`. A null actor is an unrestricted
 * operator (pairing/CLI/single-user) and is always allowed. `project.create` is
 * open to any operator; `project.member.*` (granting/revoking project access) is
 * restricted to Clerk org admins (`actorIsAdmin`); `thread.create` and other
 * project-scoped commands need access to the target project; thread-scoped
 * commands need access to that thread. Internal (server/provider-issued)
 * commands are always allowed — they never carry a client actor.
 */
export const checkCommandAccess = (
  accessControl: OrchestrationAccessControlShape,
  actorUserId: UserId | null,
  actorIsAdmin: boolean,
  command: OrchestrationCommand,
): Effect.Effect<boolean, ProjectionRepositoryError> => {
  if (actorUserId === null) {
    return Effect.succeed(true);
  }

  switch (command.type) {
    case "project.create":
      return Effect.succeed(true);

    // Only Clerk org admins manage project access (from the Settings panel).
    case "project.member.add":
    case "project.member.remove":
      return Effect.succeed(actorIsAdmin);

    case "project.meta.update":
    case "project.delete":
      return accessControl.canAccessProject(actorUserId, command.projectId);

    case "thread.create":
      return accessControl.canAccessProject(actorUserId, command.projectId);

    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.meta.update":
    case "thread.member.add":
    case "thread.member.remove":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.turn.start":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.session.stop":
      return accessControl.canAccessThread(actorUserId, command.threadId);

    // Internal commands are dispatched by the server/providers, never a client
    // operator; they carry no actor and are always allowed.
    default:
      return Effect.succeed(true);
  }
};
