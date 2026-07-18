import { userIdFromSubject } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { isOwnerOrMember } from "../accessRules.ts";
import {
  OrchestrationAccessControl,
  type OrchestrationAccessControlShape,
} from "../Services/AccessControl.ts";

const makeAccessControl = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const actorFor: OrchestrationAccessControlShape["actorFor"] = (subject) => {
    const userId = userIdFromSubject(subject);
    return userId === null ? Option.none() : Option.some(userId);
  };

  const canAccessThread: OrchestrationAccessControlShape["canAccessThread"] = (userId, threadId) =>
    Effect.gen(function* () {
      const threadOption = yield* snapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOption)) {
        return false;
      }
      const thread = threadOption.value;
      if (isOwnerOrMember(thread, userId)) {
        return true;
      }
      const projectOption = yield* snapshotQuery.getProjectShellById(thread.projectId);
      return Option.isSome(projectOption) && isOwnerOrMember(projectOption.value, userId);
    });

  const canAccessProject: OrchestrationAccessControlShape["canAccessProject"] = (
    userId,
    projectId,
  ) =>
    Effect.gen(function* () {
      const projectOption = yield* snapshotQuery.getProjectShellById(projectId);
      if (Option.isNone(projectOption)) {
        return false;
      }
      if (isOwnerOrMember(projectOption.value, userId)) {
        return true;
      }
      // Project also "appears" (and is manageable) when it contains a thread
      // the user can see directly.
      const threads = yield* snapshotQuery.listThreadShellsByProjectId(projectId);
      return threads.some((thread) => isOwnerOrMember(thread, userId));
    });

  return {
    actorFor,
    canAccessThread,
    canAccessProject,
  } satisfies OrchestrationAccessControlShape;
});

export const OrchestrationAccessControlLive = Layer.effect(
  OrchestrationAccessControl,
  makeAccessControl,
);
