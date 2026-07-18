/**
 * accessRules - Pure per-user visibility rules for team mode.
 *
 * These operate purely on the ownership/membership fields already carried by
 * thread/project (shells), so assembled snapshots can be post-filtered in
 * memory (fine at a handful of users) without extra queries.
 *
 * Visibility model:
 * - A thread is visible iff the user owns it, is tagged on it, OR owns/is tagged
 *   on its project (a project tag reveals ALL of the project's threads). Being
 *   tagged on a *sibling* thread does not reveal this thread.
 * - A project appears iff the user owns/is tagged on it, OR it contains at least
 *   one visible thread (so a tagged thread is shown grouped under its project).
 * - "Assigned to me" is the stricter notion: owned OR directly tagged on the
 *   thread (project-tag visibility does not count as an assignment).
 *
 * @module accessRules
 */
import type {
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  UserId,
} from "@t3tools/contracts";

interface OwnableEntity {
  readonly ownerUserId: UserId | null;
  readonly memberUserIds: ReadonlyArray<UserId>;
}

interface ThreadLike extends OwnableEntity {
  readonly projectId: string;
}

/** True when the user owns or is a tagged member of the entity. */
export const isOwnerOrMember = (entity: OwnableEntity, userId: UserId): boolean =>
  entity.ownerUserId === userId || entity.memberUserIds.includes(userId);

/** "Assigned to me" — owned or directly tagged on the thread (not via project). */
export const isThreadAssignedToUser = (thread: OwnableEntity, userId: UserId): boolean =>
  isOwnerOrMember(thread, userId);

/**
 * Filter a collection of projects + threads to what `userId` may see, returning
 * the visible subset. Generic over shells and full read-model entities since
 * both carry `ownerUserId` / `memberUserIds` / `projectId`.
 */
const filterProjectsAndThreads = <
  P extends OwnableEntity & { readonly id: string },
  T extends ThreadLike,
>(
  projects: ReadonlyArray<P>,
  threads: ReadonlyArray<T>,
  userId: UserId,
): { readonly projects: ReadonlyArray<P>; readonly threads: ReadonlyArray<T> } => {
  const directlyVisibleProjectIds = new Set(
    projects.filter((project) => isOwnerOrMember(project, userId)).map((project) => project.id),
  );
  const visibleThreads = threads.filter(
    (thread) => isOwnerOrMember(thread, userId) || directlyVisibleProjectIds.has(thread.projectId),
  );
  const projectIdsWithVisibleThread = new Set(visibleThreads.map((thread) => thread.projectId));
  const visibleProjects = projects.filter(
    (project) =>
      directlyVisibleProjectIds.has(project.id) || projectIdsWithVisibleThread.has(project.id),
  );
  return { projects: visibleProjects, threads: visibleThreads };
};

export const filterShellSnapshot = (
  snapshot: OrchestrationShellSnapshot,
  userId: UserId,
): OrchestrationShellSnapshot => {
  const filtered = filterProjectsAndThreads<OrchestrationProjectShell, OrchestrationThreadShell>(
    snapshot.projects,
    snapshot.threads,
    userId,
  );
  return { ...snapshot, projects: filtered.projects, threads: filtered.threads };
};

export const filterReadModel = (
  readModel: OrchestrationReadModel,
  userId: UserId,
): OrchestrationReadModel => {
  const filtered = filterProjectsAndThreads<OrchestrationProject, OrchestrationThread>(
    readModel.projects,
    readModel.threads,
    userId,
  );
  return { ...readModel, projects: filtered.projects, threads: filtered.threads };
};

/** True when a specific thread (with its project) is visible to the user. */
export const isThreadVisible = (
  thread: ThreadLike,
  project: OwnableEntity | null,
  userId: UserId,
): boolean =>
  isOwnerOrMember(thread, userId) || (project !== null && isOwnerOrMember(project, userId));
