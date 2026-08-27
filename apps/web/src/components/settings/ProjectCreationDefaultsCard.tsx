// T3-CUSTOM(expbkt3): per-project creation defaults kept outside upstream settings files.
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectScript,
  ProjectThreadCreationDefaults,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { CircleAlertIcon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { environmentServerConfigsAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { WorktreeBaseRefSelect } from "../thread-bootstrap/WorktreeBaseRefSelect";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

interface ProjectCreationDefaultsCardProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly defaults: ProjectThreadCreationDefaults;
  readonly defaultModelSelection: ModelSelection | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly disabled: boolean;
  readonly onDefaultsChange: (defaults: ProjectThreadCreationDefaults) => void;
  readonly onModelChange: (selection: ModelSelection | null) => void;
  readonly onSetupActionChange: (scriptId: string | null) => void;
  readonly onSetupCommandChange: (command: string | null) => void;
}

export function ProjectCreationDefaultsCard({
  environmentId,
  workspaceRoot,
  defaults,
  defaultModelSelection,
  scripts,
  disabled,
  onDefaultsChange,
  onModelChange,
  onSetupActionChange,
  onSetupCommandChange,
}: ProjectCreationDefaultsCardProps) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const serverConfig = serverConfigs.get(environmentId);
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const unifiedSettings = { ...settings, ...DEFAULT_CLIENT_SETTINGS };
  const providers = serverConfig?.providers ?? [];
  const effectiveModelSelection = defaultModelSelection ?? settings.defaultThreadModelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    unifiedSettings,
    providers,
    effectiveModelSelection.instanceId,
    effectiveModelSelection.model,
  );
  const effectiveInstance = instanceEntries.find(
    (entry) => entry.instanceId === effectiveModelSelection.instanceId,
  );
  const effectiveProvider = effectiveInstance?.driverKind ?? ProviderDriverKind.make("codex");
  const setupScripts = scripts.filter((script) => script.runOnWorktreeCreate);
  const setupScript = setupScripts[0] ?? null;

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/15 p-3">
      <div>
        <p className="text-xs font-medium">New thread defaults</p>
        <p className="text-xs text-muted-foreground">
          Unset values inherit this environment’s app settings.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Location</span>
          <Select
            value={defaults.environmentMode ?? "inherit"}
            disabled={disabled}
            onValueChange={(value) =>
              onDefaultsChange({
                ...defaults,
                environmentMode: value === "local" || value === "worktree" ? value : null,
              })
            }
          >
            <SelectTrigger aria-label="Project default thread location">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Use app default</SelectItem>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="worktree">New worktree</SelectItem>
            </SelectPopup>
          </Select>
        </label>

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Worktree base ref</span>
          <WorktreeBaseRefSelect
            environmentId={environmentId}
            workspaceRoot={workspaceRoot}
            value={defaults.worktreeBaseRef}
            disabled={disabled}
            ariaLabel="Project worktree base ref"
            onValueChange={(worktreeBaseRef) => onDefaultsChange({ ...defaults, worktreeBaseRef })}
          />
        </label>

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Access mode</span>
          <Select
            value={defaults.runtimeMode ?? "inherit"}
            disabled={disabled}
            onValueChange={(value) =>
              onDefaultsChange({
                ...defaults,
                runtimeMode:
                  value === "approval-required" ||
                  value === "auto-accept-edits" ||
                  value === "auto" ||
                  value === "full-access"
                    ? value
                    : null,
              })
            }
          >
            <SelectTrigger aria-label="Project default access mode">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Use app default</SelectItem>
              <SelectItem value="approval-required">Ask for approval</SelectItem>
              <SelectItem value="auto-accept-edits">Auto-accept edits</SelectItem>
              <SelectItem value="auto">Provider default</SelectItem>
              <SelectItem value="full-access">Full access</SelectItem>
            </SelectPopup>
          </Select>
        </label>

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Starting mode</span>
          <Select
            value={defaults.interactionMode ?? "inherit"}
            disabled={disabled}
            onValueChange={(value) =>
              onDefaultsChange({
                ...defaults,
                interactionMode: value === "default" || value === "plan" ? value : null,
              })
            }
          >
            <SelectTrigger aria-label="Project default starting mode">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Use app default</SelectItem>
              <SelectItem value="default">Build</SelectItem>
              <SelectItem value="plan">Plan</SelectItem>
            </SelectPopup>
          </Select>
        </label>
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <span>Model and options</span>
        <div
          className={`flex flex-wrap items-center gap-1.5 ${disabled ? "pointer-events-none opacity-50" : ""}`}
        >
          <ProviderModelPicker
            activeInstanceId={effectiveModelSelection.instanceId}
            model={effectiveModelSelection.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerVariant="outline"
            disabled={disabled}
            onInstanceModelChange={(instanceId, model) =>
              onModelChange(createModelSelection(instanceId, model))
            }
          />
          <TraitsPicker
            provider={effectiveProvider}
            models={effectiveInstance?.models ?? []}
            model={effectiveModelSelection.model}
            // T3-CUSTOM(expbkt3): the fork gates plan traits on planModeAvailable.
            planModeAvailable={unifiedSettings.planModeAvailable}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={effectiveModelSelection.options}
            allowPromptInjectedEffort={false}
            triggerVariant="outline"
            onModelOptionsChange={(options) =>
              onModelChange(
                createModelSelection(
                  effectiveModelSelection.instanceId,
                  effectiveModelSelection.model,
                  options,
                ),
              )
            }
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || defaultModelSelection === null}
            onClick={() => onModelChange(null)}
          >
            Use app default
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-background/70 px-2.5 py-2 text-xs">
        <p className="font-medium">Worktree setup action</p>
        <Select
          value={setupScript?.id ?? "__disabled__"}
          disabled={disabled}
          onValueChange={(value) => onSetupActionChange(value === "__disabled__" ? null : value)}
        >
          <SelectTrigger className="mt-1" aria-label="Project worktree setup action">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="__disabled__">Disabled</SelectItem>
            {scripts.map((script) => (
              <SelectItem key={script.id} value={script.id}>
                {script.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {setupScripts.length > 1 ? (
          <p className="mt-1 flex items-center gap-1 text-warning-foreground">
            <CircleAlertIcon className="size-3.5" /> Multiple setup actions are flagged; the first
            is used until normalized.
          </p>
        ) : null}
        <label className="mt-2 block space-y-1 text-muted-foreground">
          <span>Setup command (blank disables)</span>
          <Input
            key={setupScript?.id ?? "new-setup-action"}
            defaultValue={setupScript?.command ?? ""}
            disabled={disabled}
            placeholder="e.g. ./tools/setup.sh"
            onBlur={(event) => onSetupCommandChange(event.currentTarget.value.trim() || null)}
          />
        </label>
      </div>
    </div>
  );
}
