import type { OrchestrationCommand, SourceControlProfileId } from "@t3tools/contracts";

export function creationSourceControlProfileId(
  command: OrchestrationCommand,
): SourceControlProfileId | null | undefined {
  if (command.type === "thread.create") {
    return command.sourceControlProfileId;
  }
  if (command.type !== "thread.turn.start") {
    return undefined;
  }
  if (command.bootstrap?.createThread) {
    return command.bootstrap.createThread.sourceControlProfileId;
  }
  if (command.bootstrap?.request?.createThread) {
    return command.bootstrap.request.sourceControlProfileId;
  }
  return undefined;
}

export function applyAssignedSourceControlProfile(
  command: OrchestrationCommand,
  assignedProfileId: SourceControlProfileId | null,
): OrchestrationCommand {
  if (command.type === "thread.create") {
    return { ...command, sourceControlProfileId: assignedProfileId };
  }
  if (command.type === "thread.turn.start" && command.bootstrap?.createThread) {
    return {
      ...command,
      bootstrap: {
        ...command.bootstrap,
        createThread: {
          ...command.bootstrap.createThread,
          sourceControlProfileId: assignedProfileId,
        },
      },
    };
  }
  if (command.type === "thread.turn.start" && command.bootstrap?.request?.createThread) {
    return {
      ...command,
      bootstrap: {
        ...command.bootstrap,
        request: {
          ...command.bootstrap.request,
          sourceControlProfileId: assignedProfileId,
        },
      },
    };
  }
  return command;
}
