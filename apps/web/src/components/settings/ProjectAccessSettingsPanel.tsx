/**
 * ProjectAccessSettingsPanel - admin-only project access management (team mode).
 *
 * Clerk org admins grant workspace access to a project here. A member can open
 * the project and create their own threads in it (they own them); they do NOT
 * see other people's threads — sharing a thread is done per-thread. Renders an
 * access-denied notice for non-admins (the nav item is also hidden for them).
 *
 * @module components/settings/ProjectAccessSettingsPanel
 */
import type { EnvironmentId, OrchestrationUser, ProjectId, UserId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { useIsTeamAdmin, useOrgMembers } from "../../state/orgMembers";
import { ProjectMembersDialog } from "../members/ProjectMembersDialog";
import { AvatarStack } from "../ui/avatar";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface ProjectMembersTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function ProjectAccessSettingsPanel() {
  const isAdmin = useIsTeamAdmin();
  const projects = useProjects();
  const { resolveUser } = useOrgMembers();
  const [target, setTarget] = useState<ProjectMembersTarget | null>(null);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.title.localeCompare(b.title)),
    [projects],
  );

  if (!isAdmin) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Project access">
          <p className="px-1 py-4 text-sm text-muted-foreground">
            Only workspace admins can manage project access.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Project access">
        <p className="px-3.5 pt-3.5 text-xs text-muted-foreground">
          Grant workspace access to a project. Members can open the project and create their own
          threads in it — they don&apos;t see other people&apos;s threads. Share a specific thread
          from its members menu.
        </p>
        {sortedProjects.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          sortedProjects.map((project) => {
            const memberUsers: ReadonlyArray<OrchestrationUser> = [
              ...(project.ownerUserId !== null ? [project.ownerUserId] : []),
              ...project.memberUserIds.filter((id): id is UserId => id !== project.ownerUserId),
            ].map((id) => resolveUser(id));
            return (
              <SettingsRow
                key={`${project.environmentId}:${project.id}`}
                title={project.title}
                description={project.workspaceRoot}
                control={
                  <div className="flex items-center gap-2">
                    {memberUsers.length > 0 ? <AvatarStack users={memberUsers} size="sm" /> : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setTarget({ environmentId: project.environmentId, projectId: project.id })
                      }
                    >
                      Manage
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      {target !== null ? (
        <ProjectMembersDialog
          environmentId={target.environmentId}
          projectId={target.projectId}
          open={target !== null}
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
