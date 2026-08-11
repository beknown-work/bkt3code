// T3-CUSTOM(expbkt3): durable state for worktree/setup/agent bootstrap.
import {
  IsoDateTime,
  ResolvedThreadBootstrapRequest,
  ThreadBootstrapProgress,
  ThreadBootstrapStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadBootstrap = Schema.Struct({
  threadId: ThreadId,
  bootstrapId: Schema.String,
  status: ThreadBootstrapStatus,
  progress: ThreadBootstrapProgress,
  request: ResolvedThreadBootstrapRequest,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadBootstrap = typeof ProjectionThreadBootstrap.Type;

export interface ProjectionThreadBootstrapRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadBootstrap,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadBootstrap>, ProjectionRepositoryError>;
  readonly listIncomplete: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadBootstrap>,
    ProjectionRepositoryError
  >;
  readonly deleteByThreadId: (threadId: ThreadId) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadBootstrapRepository extends Context.Service<
  ProjectionThreadBootstrapRepository,
  ProjectionThreadBootstrapRepositoryShape
>()("t3/persistence/Services/ProjectionThreadBootstraps/ProjectionThreadBootstrapRepository") {}
