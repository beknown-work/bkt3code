/**
 * T3-CUSTOM(expbkt3): Configuration surface for the permanent T3 Conductor
 * orchestration agent. This stays isolated under Experimental settings so
 * upstream settings work only has one small mounting seam to preserve.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_T3_CONDUCTOR_PERSONALITY,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveT3ConductorLinearIssue } from "../sidebar/T3Conductor.logic";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Agent decides",
  "full-access": "Full access",
};

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

export function T3ConductorSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const conductor = settings.experimental.t3Conductor;
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [linearIssueDraft, setLinearIssueDraft] = useState<string | null>(null);
  const [linearIssueError, setLinearIssueError] = useState<string | null>(null);
  const [personalityDraft, setPersonalityDraft] = useState<string | null>(null);

  const resolvedSelection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: conductor.modelSelection },
    providers,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === resolvedSelection.instanceId) ?? null;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    resolvedSelection.instanceId,
    resolvedSelection.model,
  );
  const suggestedWorkspace = useMemo(
    () =>
      projects.find((project) => project.environmentId === primaryEnvironmentId)?.workspaceRoot ??
      "",
    [primaryEnvironmentId, projects],
  );

  const patchConductor = (patch: Partial<typeof conductor>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        t3Conductor: { ...conductor, ...patch },
      },
    });
  };

  return (
    <SettingsSection title="T3 Conductor">
      <SettingsRow
        title="Permanent orchestration agent"
        description="Keep one master T3 agent in a fixed sidebar home. It restores itself if archived, resumes when T3 reconnects, and stays separate from ordinary lifecycle rows."
        status={
          conductor.enabled
            ? conductor.workspacePath
              ? "Enabled. T3 Conductor will provision or restore itself automatically."
              : "Choose a workspace path to finish enabling T3 Conductor."
            : "Disabled. Its durable conversation is preserved."
        }
        control={
          <Switch
            checked={conductor.enabled}
            onCheckedChange={(checked) => {
              const enabled = Boolean(checked);
              patchConductor({
                enabled,
                ...(enabled && !conductor.workspacePath && suggestedWorkspace
                  ? { workspacePath: suggestedWorkspace }
                  : {}),
              });
            }}
            aria-label="Enable T3 Conductor"
          />
        }
      />

      <SettingsRow
        title="Home workspace"
        description="The existing directory T3 Conductor uses as its current checkout. Changing it safely retires the old runtime and creates a new permanent Conductor conversation."
      >
        <Input
          className="mt-3 mb-3.5 font-mono text-xs"
          value={pathDraft ?? conductor.workspacePath}
          onChange={(event) => setPathDraft(event.target.value)}
          onFocus={() => setPathDraft(conductor.workspacePath)}
          onBlur={() => {
            const workspacePath = (pathDraft ?? conductor.workspacePath).trim();
            setPathDraft(null);
            if (workspacePath !== conductor.workspacePath) {
              patchConductor({ workspacePath });
            }
          }}
          placeholder={suggestedWorkspace || "/absolute/path/to/workspace"}
          spellCheck={false}
          aria-label="T3 Conductor workspace path"
        />
      </SettingsRow>

      <SettingsRow
        title="Dedicated Linear ticket"
        description="Associate one durable Linear issue with T3 Conductor. Paste an issue identifier such as TEC-123 or a complete Linear issue URL; the linked ticket is available from the chat header."
        status={linearIssueError ?? undefined}
      >
        <Input
          className="mt-3 mb-3.5 font-mono text-xs"
          value={linearIssueDraft ?? conductor.linearIssueUrl}
          onChange={(event) => {
            setLinearIssueDraft(event.target.value);
            setLinearIssueError(null);
          }}
          onFocus={() => setLinearIssueDraft(conductor.linearIssueUrl)}
          onBlur={() => {
            const candidate = (linearIssueDraft ?? conductor.linearIssueUrl).trim();
            setLinearIssueDraft(null);
            if (!candidate) {
              setLinearIssueError(null);
              if (conductor.linearIssueUrl) patchConductor({ linearIssueUrl: "" });
              return;
            }
            const issue = resolveT3ConductorLinearIssue(candidate);
            if (!issue) {
              setLinearIssueError(
                "Enter a Linear identifier such as TEC-123, or paste a Linear issue URL.",
              );
              return;
            }
            setLinearIssueError(null);
            if (issue.url !== conductor.linearIssueUrl) {
              patchConductor({ linearIssueUrl: issue.url });
            }
          }}
          placeholder="TEC-123 or https://linear.app/…"
          spellCheck={false}
          aria-label="T3 Conductor Linear issue"
        />
      </SettingsRow>

      <SettingsRow
        title="Provider and model"
        description="The provider instance and model used for Conductor turns. Provider traits below include reasoning effort, fast mode, context window, and any future model-specific controls."
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={resolvedSelection.instanceId}
              model={resolvedSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="max-w-none text-foreground/90 hover:text-foreground"
              onInstanceModelChange={(instanceId, model) => {
                const preserveOptions =
                  instanceId === conductor.modelSelection.instanceId &&
                  model === conductor.modelSelection.model;
                patchConductor({
                  modelSelection: createModelSelection(
                    instanceId,
                    model,
                    preserveOptions ? conductor.modelSelection.options : undefined,
                  ),
                });
              }}
            />
            {activeEntry ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                instanceId={activeEntry.instanceId}
                models={activeEntry.models}
                model={resolvedSelection.model}
                prompt=""
                onPromptChange={() => undefined}
                modelOptions={resolvedSelection.options}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(options) =>
                  patchConductor({
                    modelSelection: createModelSelection(
                      resolvedSelection.instanceId,
                      resolvedSelection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        }
      />

      <SettingsRow
        title="Access mode"
        description="Default filesystem and command authority for Conductor. Full access is useful for an operator agent; approval-required is the safest choice."
        control={
          <Select
            value={conductor.runtimeMode}
            onValueChange={(value) => {
              if (
                value === "approval-required" ||
                value === "auto-accept-edits" ||
                value === "auto" ||
                value === "full-access"
              ) {
                patchConductor({ runtimeMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="T3 Conductor access mode">
              <SelectValue>{RUNTIME_MODE_LABELS[conductor.runtimeMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(RUNTIME_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Starting mode"
        description="Start Conductor turns in Build mode for action-oriented help or Plan mode for a review-first operating style."
        control={
          <Select
            value={conductor.interactionMode}
            onValueChange={(value) => {
              if (value === "default" || value === "plan") {
                patchConductor({ interactionMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-36" aria-label="T3 Conductor starting mode">
              <SelectValue>{INTERACTION_MODE_LABELS[conductor.interactionMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="default">
                Build
              </SelectItem>
              <SelectItem hideIndicator value="plan">
                Plan
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Personality and standing instructions"
        description="Additional identity, priorities, and operating rules included when a new T3 Conductor is initialized."
        resetAction={
          conductor.personalityInstructions !== DEFAULT_T3_CONDUCTOR_PERSONALITY ? (
            <SettingResetButton
              label="T3 Conductor personality"
              onClick={() =>
                patchConductor({
                  personalityInstructions: DEFAULT_T3_CONDUCTOR_PERSONALITY,
                })
              }
            />
          ) : null
        }
      >
        <Textarea
          className="mt-3 mb-3.5 min-h-28 text-xs"
          value={personalityDraft ?? conductor.personalityInstructions}
          onChange={(event) => setPersonalityDraft(event.target.value)}
          onFocus={() => setPersonalityDraft(conductor.personalityInstructions)}
          onBlur={() => {
            const personalityInstructions = (
              personalityDraft ?? conductor.personalityInstructions
            ).trim();
            setPersonalityDraft(null);
            if (personalityInstructions !== conductor.personalityInstructions) {
              patchConductor({ personalityInstructions });
            }
          }}
          placeholder={DEFAULT_T3_CONDUCTOR_PERSONALITY}
          aria-label="T3 Conductor personality instructions"
        />
      </SettingsRow>
    </SettingsSection>
  );
}
