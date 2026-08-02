import type { OrchestrationCommand, SourceControlProfileId } from "@t3tools/contracts";

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
  return command;
}
