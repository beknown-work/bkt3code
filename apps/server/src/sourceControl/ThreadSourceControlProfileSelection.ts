import type { OrchestrationCommand, SourceControlProfileId } from "@t3tools/contracts";

export function applyAssignedSourceControlProfile(
  command: OrchestrationCommand,
  assignedProfileId: SourceControlProfileId | null,
): OrchestrationCommand {
  if (assignedProfileId === null) {
    return command;
  }
  if (command.type === "thread.create" && command.sourceControlProfileId === null) {
    return { ...command, sourceControlProfileId: assignedProfileId };
  }
  if (
    command.type === "thread.turn.start" &&
    command.bootstrap?.createThread?.sourceControlProfileId === null
  ) {
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
