// T3-CUSTOM(expbkt3): BEGIN — environment-qualified project picker types.
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
// T3-CUSTOM(expbkt3): END
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
// T3-CUSTOM(expbkt3): BEGIN — environment-qualified project picker dependencies.
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  // T3-CUSTOM(expbkt3): per-environment rows in the project picker.
  type SidebarProjectGroupMember,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import {
  // T3-CUSTOM(expbkt3): environment identity in the new-thread picker.
  useEnvironmentAppearances,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
// T3-CUSTOM(expbkt3): environment glyph.
import { EnvironmentBadgeView } from "../environment/EnvironmentBadge";
// T3-CUSTOM(expbkt3): END
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

// T3-CUSTOM(expbkt3): BEGIN — one row in the project picker. `project` is set only when the
// row names a specific environment, which happens when the logical project exists
// on more than one.
interface ProjectPickerItem {
  readonly value: string;
  readonly displayName: string;
  readonly environmentId: EnvironmentId | null;
  readonly project: SidebarProjectGroupMember | null;
}

// T3-CUSTOM(expbkt3): END
export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  // T3-CUSTOM(expbkt3): BEGIN — a logical project can exist on more than one
  // machine, and the picker previously collapsed those into one row that silently
  // chose an environment for you. Offer each environment explicitly, so starting a
  // session says where it will run. Groups that live on a single environment are
  // untouched, which is every group on a single-environment client.
  const appearances = useEnvironmentAppearances();
  const pickerItems = useMemo<ReadonlyArray<ProjectPickerItem>>(
    () =>
      projectPickerEntries.flatMap(({ group }): ProjectPickerItem[] => {
        const byEnvironment = new Map<string, SidebarProjectGroupMember>();
        for (const member of group.memberProjects) {
          if (!byEnvironment.has(member.environmentId)) {
            byEnvironment.set(member.environmentId, member);
          }
        }
        if (byEnvironment.size < 2) {
          return [
            {
              value: group.projectKey,
              displayName: group.displayName,
              environmentId: null,
              project: null,
            },
          ];
        }
        return [...byEnvironment.values()].map((member) => ({
          value: `${group.projectKey}::${member.environmentId}`,
          displayName: group.displayName,
          environmentId: member.environmentId,
          project: member,
        }));
      }),
    [projectPickerEntries],
  );
  const activeGroupSpansEnvironments = useMemo(() => {
    if (!activeProjectGroup) return false;
    return (
      new Set(activeProjectGroup.memberProjects.map((member) => member.environmentId)).size > 1
    );
  }, [activeProjectGroup]);
  const activeProjectKey =
    activeProjectGroup === null
      ? ""
      : activeGroupSpansEnvironments && activeProjectRef !== null
        ? `${activeProjectGroup.projectKey}::${activeProjectRef.environmentId}`
        : activeProjectGroup.projectKey;
  // T3-CUSTOM(expbkt3): END
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <MenuTrigger
        aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-bottom text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        title={activeProjectDisplayName ?? undefined}
      >
        {activeProjectDisplayName ?? "Choose a project"}
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            // T3-CUSTOM(expbkt3): BEGIN — resolve an explicit environment selection.
            if (value === activeProjectKey) return;
            // An environment-qualified value names the
            // exact project to start in; a bare key keeps the previous behaviour of
            // letting the group choose its representative.
            const selected = pickerItems.find((item) => item.value === value);
            const explicit = selected?.project ?? null;
            if (explicit) {
              void handleNewThread(scopeProjectRef(explicit.environmentId, explicit.id), {
                replace: true,
              });
              return;
            }
            const entry = projectEntryByKey.get(value as string);
            if (!entry) {
              return;
            }
            const project = entry.targetProject;
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
            });
            // T3-CUSTOM(expbkt3): END
          }}
        >
          {/* T3-CUSTOM(expbkt3): BEGIN — distinguish duplicate projects by environment. */}
          {pickerItems.map((item) => {
            // T3-CUSTOM(expbkt3): the environment is named only when this project
            // exists on more than one, which is the only time it is ambiguous.
            const appearance =
              item.environmentId === null ? null : (appearances.get(item.environmentId) ?? null);
            return (
              <MenuRadioItem key={item.value} value={item.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5" title={item.displayName}>
                  <span className="min-w-0 truncate">{item.displayName}</span>
                  {appearance ? (
                    <>
                      <EnvironmentBadgeView appearance={appearance} variant="glyph" />
                      <span
                        className="min-w-0 shrink-0 truncate text-xs"
                        style={{ color: appearance.color }}
                      >
                        {appearance.name}
                      </span>
                    </>
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
          {/* T3-CUSTOM(expbkt3): END */}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  // T3-CUSTOM(expbkt3): BEGIN — name the machine the session will start on, but only when
  // this project exists on more than one — otherwise it is noise on every draft.
  const activeEnvironmentAppearance =
    activeGroupSpansEnvironments && activeProjectRef !== null
      ? (appearances.get(activeProjectRef.environmentId) ?? null)
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-2">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {hasResolvedProject ? (
          <>What should we build in {projectSelector}?</>
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {/* T3-CUSTOM(expbkt3): which machine this draft will run on. */}
      {activeEnvironmentAppearance ? (
        <span className="pointer-events-none inline-flex items-center gap-1.5 text-muted-foreground text-xs">
          <EnvironmentBadgeView appearance={activeEnvironmentAppearance} variant="glyph" />
          <span>on {activeEnvironmentAppearance.name}</span>
        </span>
      ) : null}
    </div>
  );
  // T3-CUSTOM(expbkt3): END
}
