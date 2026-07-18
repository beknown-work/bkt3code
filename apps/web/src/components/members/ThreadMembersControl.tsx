/**
 * ThreadMembersControl - avatar-stack trigger + member picker for a thread.
 *
 * Mounted in the chat header (team mode only — renders null otherwise). Reads
 * its own atoms; no prop threading from ChatView. Shows the owner + tagged
 * members as an avatar stack; clicking opens a picker to tag/untag people, plus
 * a footer to manage project-level members. Self-removal asks for confirmation
 * and navigates home.
 *
 * @module components/members/ThreadMembersControl
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationUser, ThreadId, UserId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useProject, useThreadShell } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AvatarStack } from "../ui/avatar";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { MemberPicker } from "./MemberPicker";
import { ProjectMembersDialog } from "./ProjectMembersDialog";

export function ThreadMembersControl({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const currentUserId = useCurrentUserId();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const { users, resolveUser } = useOrgMembers();
  const navigate = useNavigate();
  const addMember = useAtomCommand(threadEnvironment.addMember, { reportFailure: false });
  const removeMember = useAtomCommand(threadEnvironment.removeMember, { reportFailure: false });
  const [pending, setPending] = useState<ReadonlySet<UserId>>(() => new Set());
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const settlePending = useCallback((userId: UserId) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  const onToggle = useCallback(
    (userId: UserId, nextChecked: boolean) => {
      // Self-removal: confirm, then leave and navigate home.
      if (!nextChecked && userId === currentUserId) {
        const confirmed = window.confirm(
          "Remove yourself from this thread? You will lose access to it.",
        );
        if (!confirmed) return;
        setPending((prev) => new Set(prev).add(userId));
        void removeMember({ environmentId, input: { threadId, userId } })
          .then(() => navigate({ to: "/", replace: true }))
          .finally(() => settlePending(userId));
        return;
      }
      setPending((prev) => new Set(prev).add(userId));
      const run = nextChecked
        ? addMember({ environmentId, input: { threadId, userId } })
        : removeMember({ environmentId, input: { threadId, userId } });
      void run.finally(() => settlePending(userId));
    },
    [addMember, removeMember, environmentId, threadId, currentUserId, navigate, settlePending],
  );

  const stackUsers = useMemo<ReadonlyArray<OrchestrationUser>>(() => {
    if (!thread) return [];
    const ids: UserId[] = [];
    if (thread.ownerUserId !== null) ids.push(thread.ownerUserId);
    for (const id of thread.memberUserIds) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => resolveUser(id));
  }, [thread, resolveUser]);

  // Team mode only.
  if (currentUserId === null || thread === null) {
    return null;
  }

  return (
    <>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" aria-label="Members" />
          }
        >
          {stackUsers.length > 0 ? (
            <AvatarStack users={stackUsers} size="sm" />
          ) : (
            <UsersIcon className="size-4" />
          )}
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-72" viewportClassName="p-0!">
          <MemberPicker
            users={users}
            ownerUserId={thread.ownerUserId}
            memberUserIds={thread.memberUserIds}
            viaProjectUserIds={project?.memberUserIds ?? []}
            pendingUserIds={pending}
            onToggle={onToggle}
            resolveUser={resolveUser}
          />
          <div className="border-t border-border p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => setProjectDialogOpen(true)}
            >
              Manage project members…
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
      <ProjectMembersDialog
        environmentId={environmentId}
        projectId={thread.projectId}
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
      />
    </>
  );
}
