/**
 * ProjectMembersDialog - manage members of a project (team mode).
 *
 * A project tag grants visibility to ALL of the project's threads (current and
 * future). Owner is permanent. Renders null outside team mode.
 *
 * @module components/members/ProjectMembersDialog
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, UserId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useProject } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MemberPicker } from "./MemberPicker";

export function ProjectMembersDialog({
  environmentId,
  projectId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const currentUserId = useCurrentUserId();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const { users, resolveUser } = useOrgMembers();
  const addMember = useAtomCommand(projectEnvironment.addMember, { reportFailure: false });
  const removeMember = useAtomCommand(projectEnvironment.removeMember, { reportFailure: false });
  const [pending, setPending] = useState<ReadonlySet<UserId>>(() => new Set());

  const onToggle = useCallback(
    (userId: UserId, nextChecked: boolean) => {
      setPending((prev) => new Set(prev).add(userId));
      const run = nextChecked
        ? addMember({ environmentId, input: { projectId, userId } })
        : removeMember({ environmentId, input: { projectId, userId } });
      void run.finally(() => {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      });
    },
    [addMember, removeMember, environmentId, projectId],
  );

  if (currentUserId === null) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Project members</DialogTitle>
          <DialogDescription>
            Members see every thread in this project — current and future.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="p-0">
          <MemberPicker
            users={users}
            ownerUserId={project?.ownerUserId ?? null}
            memberUserIds={project?.memberUserIds ?? []}
            pendingUserIds={pending}
            onToggle={onToggle}
            resolveUser={resolveUser}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
