import {
  ApprovalRequestId,
  type ChatAttachment,
  // T3-CUSTOM(expbkt3): BEGIN — work summary supersede support.
  type CommandId,
  // T3-CUSTOM(expbkt3): END
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ThreadId,
  // T3-CUSTOM(expbkt3): BEGIN — durable bulk-session-manager work summary.
  ThreadWorkSummary,
  // T3-CUSTOM(expbkt3): END
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
// T3-CUSTOM(expbkt3): BEGIN — encodes the durable work-summary blob.
import * as Schema from "effect/Schema";
// T3-CUSTOM(expbkt3): END
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
// T3-CUSTOM(expbkt3): persist durable bootstrap progress independently from thread shells.
import { ProjectionThreadBootstrapRepository } from "../../persistence/Services/ProjectionThreadBootstraps.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionMembershipRepository } from "../../persistence/Services/ProjectionMemberships.ts";
import { ProjectionMembershipRepositoryLive } from "../../persistence/Layers/ProjectionMemberships.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
// T3-CUSTOM(expbkt3): persist durable bootstrap progress independently from thread shells.
import { ProjectionThreadBootstrapRepositoryLive } from "../../persistence/Layers/ProjectionThreadBootstraps.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
// T3-CUSTOM(expbkt3): additive durable intent projector/repository seam.
import {
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryLive,
} from "../../execution/DurableExecutionIntentRepository.ts";
// T3-CUSTOM(expbkt3): keep routine activity and streaming deltas off the full-history summary path.
import { shouldRefreshThreadShellSummary } from "../threadShellSummaryRefresh.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  // T3-CUSTOM(expbkt3): durable worktree/setup/agent progress.
  threadBootstraps: "projection.thread-bootstraps",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  // T3-CUSTOM(expbkt3): accepted work is projected in the command transaction.
  durableExecutionIntents: "projection.durable-execution-intents",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * T3-CUSTOM(expbkt3): BEGIN — work summary supersede support.
 *
 * Reads just the `requestId` out of a stored work-summary blob. A row written
 * by an older build, or corrupted by hand, must not wedge the feature: an
 * unreadable value reports "no owning request", which lets the next result
 * through instead of rejecting every one of them forever.
 */
const encodeWorkSummary = Schema.encodeSync(Schema.fromJsonString(ThreadWorkSummary));

function parseWorkSummaryRequestId(raw: string | null | undefined): CommandId | null {
  if (raw === null || raw === undefined || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const requestId = (parsed as { readonly requestId?: unknown }).requestId;
    return typeof requestId === "string" ? (requestId as CommandId) : null;
  } catch {
    return null;
  }
}
// T3-CUSTOM(expbkt3): END

/**
 * Turn state to settle still-running turns with when their session leaves the
 * "running" status, or null while the session is (re)starting or running and
 * turns must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

// T3-CUSTOM(expbkt3): the fork relocated this predicate to
// ../threadShellSummaryRefresh.ts (imported above); upstream later added an
// equivalent inline copy, which is dropped here to keep one implementation.

function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  terminalTurnIds: ReadonlySet<string>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      if (activity.turnId !== null && terminalTurnIds.has(activity.turnId)) {
        continue;
      }
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );

  let latestForTurn: ProjectionThreadProposedPlan | null = null;
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        latestForTurn = plan;
        break;
      }
    }
  }
  if (latestForTurn !== null) {
    return latestForTurn.implementedAt === null;
  }

  const latestPlan = sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    // T3-CUSTOM(expbkt3): durable worktree/setup/agent progress.
    const projectionThreadBootstrapRepository = yield* ProjectionThreadBootstrapRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const projectionMembershipRepository = yield* ProjectionMembershipRepository;
    // T3-CUSTOM(expbkt3): durable intent is a peer projection in the same SQL transaction.
    const durableExecutionIntentRepository = yield* DurableExecutionIntentRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            threadCreationDefaults: event.payload.threadCreationDefaults ?? {
              environmentMode: null,
              worktreeBaseRef: null,
              runtimeMode: null,
              interactionMode: null,
            },
            defaultThreadEnvMode: null,
            faviconPath: event.payload.faviconPath ?? null,
            scripts: event.payload.scripts,
            ownerUserId: event.payload.createdByUserId ?? null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.member-added":
          yield* projectionMembershipRepository.upsertProjectMember({
            projectId: event.payload.projectId,
            userId: event.payload.userId,
            addedByUserId: event.payload.addedByUserId,
            addedAt: event.payload.addedAt,
          });
          return;

        case "project.member-removed":
          yield* projectionMembershipRepository.removeProjectMember({
            projectId: event.payload.projectId,
            userId: event.payload.userId,
          });
          return;

        case "project.owner-transferred": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ownerUserId: event.payload.ownerUserId,
            updatedAt: event.payload.transferredAt,
          });
          yield* projectionMembershipRepository.removeProjectMember({
            projectId: event.payload.projectId,
            userId: event.payload.ownerUserId,
          });
          if (
            event.payload.previousOwnerUserId !== null &&
            event.payload.previousOwnerUserId !== event.payload.ownerUserId
          ) {
            yield* projectionMembershipRepository.upsertProjectMember({
              projectId: event.payload.projectId,
              userId: event.payload.previousOwnerUserId,
              addedByUserId: event.payload.transferredByUserId,
              addedAt: event.payload.transferredAt,
            });
          }
          return;
        }

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.threadCreationDefaults !== undefined
              ? { threadCreationDefaults: event.payload.threadCreationDefaults }
              : {}),
            ...(event.payload.defaultThreadEnvMode !== undefined
              ? { defaultThreadEnvMode: event.payload.defaultThreadEnvMode }
              : {}),
            ...(event.payload.faviconPath !== undefined
              ? { faviconPath: event.payload.faviconPath }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [messages, proposedPlans, activities, pendingApprovals, turns] = yield* Effect.all([
        projectionThreadMessageRepository.listByThreadId({ threadId }),
        projectionThreadProposedPlanRepository.listByThreadId({ threadId }),
        projectionThreadActivityRepository.listByThreadId({ threadId }),
        projectionPendingApprovalRepository.listByThreadId({ threadId }),
        projectionTurnRepository.listByThreadId({ threadId }),
      ]);

      let latestUserMessageAt: string | null = null;
      for (const message of messages) {
        if (
          message.role === "user" &&
          (latestUserMessageAt === null || message.createdAt > latestUserMessageAt)
        ) {
          latestUserMessageAt = message.createdAt;
        }
      }

      const pendingApprovalCount = pendingApprovals.filter(
        (approval) => approval.status === "pending",
      ).length;
      const terminalTurnIds = new Set<string>();
      for (const turn of turns) {
        if (
          turn.turnId !== null &&
          (turn.state === "completed" || turn.state === "interrupted" || turn.state === "error")
        ) {
          terminalTurnIds.add(turn.turnId);
        }
      }
      const pendingUserInputCount = derivePendingUserInputCountFromActivities(
        activities,
        terminalTurnIds,
      );
      const hasActionableProposedPlan = deriveHasActionableProposedPlan({
        latestTurnId: existingRow.value.latestTurnId,
        proposedPlans,
      });

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            sourceControlProfileId: event.payload.sourceControlProfileId,
            linkedPullRequest: null,
            latestTurnId: null,
            ownerUserId: event.payload.createdByUserId ?? null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            // T3-CUSTOM(expbkt3): session priority.
            priority: event.payload.priority ?? null,
            // T3-CUSTOM(expbkt3): no manual Linear tag at thread creation.
            linearIssueUrl: null,
            // T3-CUSTOM(expbkt3): the Mattermost link is bound after creation.
            mattermostThreadUrl: null,
            // T3-CUSTOM(expbkt3): session lineage stamped at creation.
            parentThreadId: event.payload.parentThreadId ?? null,
            // T3-CUSTOM(expbkt3): BEGIN — no work summary until one is requested.
            workSummary: null,
            // T3-CUSTOM(expbkt3): END
            pinnedAt: null,
            // T3-CUSTOM(expbkt3): a thread is created with a placeholder or a
            // seeded title, never a chosen one.
            titleManuallySet: 0,
            pinOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            rollingSummary: null,
            deletedAt: null,
          });
          // T3-CUSTOM(expbkt3): BEGIN — keep creator tagging atomic with the owner
          // projection so a first shell snapshot can never observe half of it.
          if (
            event.payload.createdByUserId !== null &&
            event.payload.createdByUserId !== undefined
          ) {
            yield* projectionMembershipRepository.upsertThreadMember({
              threadId: event.payload.threadId,
              userId: event.payload.createdByUserId,
              addedByUserId: event.payload.createdByUserId,
              addedAt: event.payload.createdAt,
            });
          }
          // Tags the session was born with (a child session inheriting its
          // parent's audience) land in the same transaction as the creator tag.
          for (const memberUserId of new Set(event.payload.memberUserIds ?? [])) {
            if (memberUserId === event.payload.createdByUserId) continue;
            yield* projectionMembershipRepository.upsertThreadMember({
              threadId: event.payload.threadId,
              userId: memberUserId,
              addedByUserId: event.payload.createdByUserId ?? null,
              addedAt: event.payload.createdAt,
            });
          }
          // T3-CUSTOM(expbkt3): END
          return;

        case "thread.member-added":
          yield* projectionMembershipRepository.upsertThreadMember({
            threadId: event.payload.threadId,
            userId: event.payload.userId,
            addedByUserId: event.payload.addedByUserId,
            addedAt: event.payload.addedAt,
          });
          return;

        case "thread.member-removed":
          yield* projectionMembershipRepository.removeThreadMember({
            threadId: event.payload.threadId,
            userId: event.payload.userId,
          });
          return;

        case "thread.owner-transferred": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ownerUserId: event.payload.ownerUserId,
            updatedAt: event.payload.transferredAt,
          });
          yield* projectionMembershipRepository.removeThreadMember({
            threadId: event.payload.threadId,
            userId: event.payload.ownerUserId,
          });
          if (
            event.payload.previousOwnerUserId !== null &&
            event.payload.previousOwnerUserId !== event.payload.ownerUserId
          ) {
            yield* projectionMembershipRepository.upsertThreadMember({
              threadId: event.payload.threadId,
              userId: event.payload.previousOwnerUserId,
              addedByUserId: event.payload.transferredByUserId,
              addedAt: event.payload.transferredAt,
            });
          }
          return;
        }

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            unsettledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            // Re-entry stamp for active-list ordering. A thread already pinned
            // active keeps its stamp: the activity reset that clears the pin
            // is not a re-entry and must not reorder the list.
            unsettledAt:
              existingRow.value.settledOverride === "active"
                ? existingRow.value.unsettledAt
                : event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            // T3-CUSTOM(expbkt3): manual-title ownership.
            ...(event.payload.titleManuallySet !== undefined
              ? { titleManuallySet: event.payload.titleManuallySet ? 1 : 0 }
              : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            // T3-CUSTOM(expbkt3): session priority.
            ...(event.payload.priority !== undefined ? { priority: event.payload.priority } : {}),
            // T3-CUSTOM(expbkt3): durable manual Linear tag.
            ...(event.payload.linearIssueUrl !== undefined
              ? { linearIssueUrl: event.payload.linearIssueUrl }
              : {}),
            // T3-CUSTOM(expbkt3): durable Mattermost conversation link.
            ...(event.payload.mattermostThreadUrl !== undefined
              ? { mattermostThreadUrl: event.payload.mattermostThreadUrl }
              : {}),
            // T3-CUSTOM(expbkt3): session lineage re-parent / detach.
            ...(event.payload.parentThreadId !== undefined
              ? { parentThreadId: event.payload.parentThreadId }
              : {}),
            ...(event.payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: event.payload.linkedPullRequest }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.source-control-profile-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            sourceControlProfileId: event.payload.sourceControlProfileId,
            updatedAt: event.payload.changedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          // T3-CUSTOM(expbkt3): only summary-relevant events hydrate historical bodies.
          if (shouldRefreshThreadShellSummary(event)) {
            yield* refreshThreadShellSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // "Latest turn" is the most recent turn, not the currently-active
            // one. A settling session carries activeTurnId: null, so assigning
            // it directly wiped the reference as soon as a turn finished —
            // leaving completed threads indistinguishable from a half-finished
            // bootstrap (which then got wrongly "resumed"), and dropping the
            // turn's duration/state from the UI. Only advance on a real turn.
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.catchup-summary-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          if (event.payload.rollingSummary === null) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            rollingSummary: event.payload.rollingSummary,
          });
          return;
        }

        // T3-CUSTOM(expbkt3): BEGIN — durable bulk-session-manager work summary.
        //
        // The request event installs the pending record so a reconnecting table
        // still shows the spinner; the update event replaces it with the
        // result. Both are stored as one JSON blob in `work_summary` rather
        // than a column per field, because the whole record is written and read
        // atomically and never queried field-wise.
        case "thread.work-summary-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            workSummary: encodeWorkSummary({
              status: "pending",
              summary: null,
              stage: null,
              remaining: null,
              percent: null,
              error: null,
              requestId: event.payload.requestId,
              updatedAt: event.payload.requestedAt,
            }),
          });
          return;
        }

        case "thread.work-summary-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          // Supersede rule: only the request that currently owns the row may
          // write its result. A re-request installs a new pending requestId, so
          // the older generation's late answer is dropped here.
          const currentRequestId = parseWorkSummaryRequestId(existingRow.value.workSummary);
          if (currentRequestId !== null && currentRequestId !== event.payload.requestId) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            workSummary: encodeWorkSummary(event.payload.workSummary),
          });
          return;
        }
        // T3-CUSTOM(expbkt3): END

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.message-sent": {
          // T3-CUSTOM(expbkt3): BEGIN atomic streaming-delta hot path.
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : undefined;
          if (event.payload.streaming) {
            yield* projectionThreadMessageRepository.appendTextDelta({
              messageId: event.payload.messageId,
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              role: event.payload.role,
              delta: event.payload.text,
              ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
              isStreaming: true,
              sentByUserId: event.payload.sentByUserId ?? null,
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) =>
              event.payload.text.length === 0 ? message.text : event.payload.text,
          });
          const persistedAttachments = nextAttachments ?? previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(persistedAttachments !== undefined
              ? { attachments: [...persistedAttachments] }
              : {}),
            isStreaming: event.payload.streaming,
            sentByUserId: event.payload.sentByUserId ?? previousMessage?.sentByUserId ?? null,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          // T3-CUSTOM(expbkt3): END atomic streaming-delta hot path.
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        providerThreadId: event.payload.session.providerThreadId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            if (
              event.payload.session.status === "error" ||
              event.payload.session.status === "stopped" ||
              event.payload.session.status === "interrupted"
            ) {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            // Leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
            if (settledTurnState === null) {
              return;
            }
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
            return;
          }

          // A new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            otherRunningTurns.filter(
              (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
            ),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: "completed",
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          );

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: turnStillRunning ? existingTurn.value.state : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.catchup-summary-updated": {
          // "error" is persisted like ready/pending so reconnecting clients do
          // not lose the failure explanation and retry affordance.
          if (event.payload.progress === "cleared") {
            yield* projectionTurnRepository.clearCatchupSummary({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
            });
            return;
          }
          yield* projectionTurnRepository.upsertCatchupSummary({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            summary: event.payload.displaySummary,
            status: event.payload.progress,
            createdAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "acceptAlways" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    // T3-CUSTOM(expbkt3): the coordinator stores its resolved request and public
    // progress here so setup state survives client reconnects and server restarts.
    const applyThreadBootstrapsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadBootstrapsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.bootstrap-requested":
          yield* projectionThreadBootstrapRepository.upsert({
            threadId: event.payload.threadId,
            bootstrapId: event.payload.request.bootstrapId,
            status: event.payload.progress.status,
            progress: event.payload.progress,
            request: event.payload.request,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          });
          return;

        case "thread.bootstrap-step-updated": {
          const existing = yield* projectionThreadBootstrapRepository.getByThreadId(
            event.payload.threadId,
          );
          if (Option.isNone(existing) || existing.value.bootstrapId !== event.payload.bootstrapId) {
            return;
          }

          const currentStep = existing.value.progress[event.payload.step];
          const nextStep = {
            ...currentStep,
            status: event.payload.status,
            attempt: event.payload.attempt,
            ...(event.payload.terminalId !== undefined
              ? { terminalId: event.payload.terminalId }
              : {}),
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
            ...(event.payload.error !== undefined ? { error: event.payload.error } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
          };
          const progress = {
            ...existing.value.progress,
            status:
              event.payload.status === "failed"
                ? ("failed" as const)
                : event.payload.status === "running" || event.payload.status === "pending"
                  ? ("running" as const)
                  : existing.value.progress.status === "failed"
                    ? ("running" as const)
                    : existing.value.progress.status,
            [event.payload.step]: nextStep,
            updatedAt: event.payload.updatedAt,
          };
          yield* projectionThreadBootstrapRepository.upsert({
            ...existing.value,
            status: progress.status,
            progress,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.bootstrap-completed": {
          const existing = yield* projectionThreadBootstrapRepository.getByThreadId(
            event.payload.threadId,
          );
          if (Option.isNone(existing) || existing.value.bootstrapId !== event.payload.bootstrapId) {
            return;
          }
          yield* projectionThreadBootstrapRepository.upsert({
            ...existing.value,
            status: "ready",
            progress: {
              ...existing.value.progress,
              status: "ready",
              updatedAt: event.payload.completedAt,
            },
            updatedAt: event.payload.completedAt,
          });
          return;
        }

        case "thread.bootstrap-retry-requested": {
          if (!event.payload.baseRef) return;
          const existing = yield* projectionThreadBootstrapRepository.getByThreadId(
            event.payload.threadId,
          );
          if (
            Option.isNone(existing) ||
            existing.value.bootstrapId !== event.payload.bootstrapId ||
            existing.value.request.workspace.mode !== "new-worktree"
          ) {
            return;
          }
          yield* projectionThreadBootstrapRepository.upsert({
            ...existing.value,
            request: {
              ...existing.value.request,
              workspace: {
                ...existing.value.request.workspace,
                baseRef: event.payload.baseRef,
              },
            },
            updatedAt: event.payload.requestedAt,
          });
          return;
        }

        case "thread.deleted":
          yield* projectionThreadBootstrapRepository.deleteByThreadId(event.payload.threadId);
          return;

        default:
          return;
      }
    });

    // T3-CUSTOM(expbkt3): BEGIN — one marked delegation keeps fork recovery
    // behavior out of the upstream-owned projection machinery.
    const applyDurableExecutionIntentsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyDurableExecutionIntentsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          const message = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          yield* durableExecutionIntentRepository.acceptFromEvent({
            event,
            message: Option.getOrNull(message),
          });
          return;
        }
        case "thread.turn-interrupt-requested":
        case "thread.archived":
        case "thread.deleted":
          yield* durableExecutionIntentRepository.stopThread({
            threadId: event.payload.threadId,
            reason: event.type,
            at: event.occurredAt,
          });
          return;
        case "thread.session-stop-requested": {
          // T3-CUSTOM(expbkt3): Stop doubles as Dismiss for exhausted attention.
          const items = yield* durableExecutionIntentRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const exhausted = items.findLast(
            (item) => item.phase === "recovery-exhausted" && item.dismissedAt === null,
          );
          if (exhausted !== undefined) {
            yield* durableExecutionIntentRepository.dismissExhausted({
              threadId: event.payload.threadId,
              at: event.occurredAt,
            });
          } else {
            yield* durableExecutionIntentRepository.stopThread({
              threadId: event.payload.threadId,
              reason: event.type,
              at: event.occurredAt,
            });
          }
          return;
        }
        case "thread.session-restart-requested":
          yield* durableExecutionIntentRepository.retryExhausted({
            threadId: event.payload.threadId,
            at: event.occurredAt,
          });
          return;
        case "thread.session-set":
          yield* durableExecutionIntentRepository.observeSession({
            threadId: event.payload.threadId,
            status: event.payload.session.status,
            providerTurnId: event.payload.session.activeTurnId,
            error: event.payload.session.lastError,
            at: event.payload.session.updatedAt,
          });
          return;
        case "thread.activity-appended":
          if (
            event.payload.activity.kind === "approval.requested" ||
            event.payload.activity.kind === "approval.resolved" ||
            event.payload.activity.kind === "user-input.requested" ||
            event.payload.activity.kind === "user-input.resolved"
          ) {
            yield* durableExecutionIntentRepository.observeBlockingActivity({
              threadId: event.payload.threadId,
              kind: event.payload.activity.kind,
              at: event.payload.activity.createdAt,
            });
          }
          return;
        default:
          return;
      }
    });
    // T3-CUSTOM(expbkt3): END

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadBootstraps,
        apply: applyThreadBootstrapsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        // T3-CUSTOM(expbkt3): atomic accepted-work projection.
        name: ORCHESTRATION_PROJECTOR_NAMES.durableExecutionIntents,
        apply: applyDurableExecutionIntentsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  // T3-CUSTOM(expbkt3): durable worktree/setup/agent progress.
  Layer.provideMerge(ProjectionThreadBootstrapRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionMembershipRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  // T3-CUSTOM(expbkt3): fork-owned durable execution repository.
  Layer.provideMerge(DurableExecutionIntentRepositoryLive),
);
