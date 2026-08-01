import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type GitHubSourceControlProfile,
  type SourceControlIdentityMode,
  type SourceControlProfileId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ThreadMembersControl } from "../members/ThreadMembersControl";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";
import { T3_CONDUCTOR_ENABLED } from "../../experimentalFeatures";
// T3-CUSTOM(expbkt3): BEGIN — isolated Conductor header action.
import { T3ConductorLinearIssueControl } from "./T3ConductorLinearIssueControl";
// T3-CUSTOM(expbkt3): END

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  sourceControlIdentityMode: SourceControlIdentityMode;
  sourceControlProfiles: ReadonlyArray<GitHubSourceControlProfile>;
  sourceControlProfileId: SourceControlProfileId | null;
  onSourceControlProfileChange: (profileId: SourceControlProfileId) => void;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  sourceControlIdentityMode,
  sourceControlProfiles,
  sourceControlProfileId,
  onSourceControlProfileChange,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const selectedSourceControlProfile =
    sourceControlProfiles.find((profile) => profile.id === sourceControlProfileId) ?? null;
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${activeProjectName}`}
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {/* T3-CUSTOM(expbkt3): BEGIN — Conductor-only Linear action. */}
        {T3_CONDUCTOR_ENABLED ? (
          <T3ConductorLinearIssueControl
            activeThreadEnvironmentId={activeThreadEnvironmentId}
            activeThreadId={activeThreadId}
          />
        ) : null}
        {/* T3-CUSTOM(expbkt3): END */}
        <ThreadMembersControl environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
        {sourceControlIdentityMode === "thread-profile" ? (
          <div className="flex items-center gap-1.5">
            {selectedSourceControlProfile?.avatarUrl ? (
              <img
                src={selectedSourceControlProfile.avatarUrl}
                alt=""
                className="size-5 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <select
              aria-label="GitHub thread owner"
              className="h-7 max-w-40 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={sourceControlProfileId ?? ""}
              onChange={(event) => {
                const profile = sourceControlProfiles.find(
                  (candidate) => candidate.id === event.currentTarget.value,
                );
                if (profile) onSourceControlProfileChange(profile.id);
              }}
            >
              <option value="" disabled>
                Select GitHub owner
              </option>
              {sourceControlProfiles
                .filter((profile) => !profile.archived)
                .map((profile) => (
                  <option
                    key={profile.id}
                    value={profile.id}
                    disabled={profile.credentialStatus !== "connected"}
                  >
                    @{profile.login}
                    {profile.credentialStatus !== "connected" ? " — reconnect" : ""}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
            actingProfileLogin={selectedSourceControlProfile?.login ?? null}
            sourceControlProfileId={sourceControlProfileId}
          />
        )}
      </div>
    </div>
  );
});
