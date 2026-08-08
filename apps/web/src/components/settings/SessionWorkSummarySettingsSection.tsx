/**
 * T3-CUSTOM(expbkt3): AI work summary + progress assessment controls.
 *
 * These power the "Work summary" and "Progress" columns of the bulk sessions
 * manager. Generation runs on the server, so every knob is a server setting and
 * the section lives in the Experiments tab beside the catch-up summary.
 */
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import * as Equal from "effect/Equal";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SESSION_SUMMARY_DATA_LIMIT_CHARS,
  MIN_SESSION_SUMMARY_DATA_LIMIT_CHARS,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

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
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULT_WORK_SUMMARY = DEFAULT_UNIFIED_SETTINGS.experimental.sessionWorkSummary;

/** Compact numeric control, matching the catch-up summary section. */
function SettingsNumberField({
  ariaLabel,
  value,
  min,
  max,
  step,
  disabled,
  onValueChange,
}: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onValueChange: (value: number) => void;
}) {
  return (
    <NumberField
      aria-label={ariaLabel}
      className="w-32 gap-0"
      disabled={disabled}
      max={max}
      min={min}
      onValueChange={(next) => {
        if (typeof next === "number" && Number.isFinite(next)) {
          onValueChange(next);
        }
      }}
      size="sm"
      step={step}
      value={value}
    >
      <NumberFieldGroup className="h-7 rounded-md">
        <NumberFieldDecrement
          aria-label={`Decrease ${ariaLabel}`}
          className="px-2 [&_svg]:size-3.5"
        />
        <NumberFieldInput
          aria-label={ariaLabel}
          className="h-7 w-14 grow-0 px-0 text-xs leading-7"
          inputMode="numeric"
        />
        <NumberFieldIncrement
          aria-label={`Increase ${ariaLabel}`}
          className="px-2 [&_svg]:size-3.5"
        />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * Work summary controls, rendered inside the Experiments settings tab.
 * These are server settings because the assessment runs on the server.
 */
export function SessionWorkSummarySettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const workSummary = settings.experimental.sessionWorkSummary;
  const enabled = workSummary.enabled;

  // Reuse the text-generation resolver by pointing it at this feature's own
  // selection, so fallback behavior for disabled/unavailable instances matches.
  const workSummaryModelSelection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: workSummary.modelSelection },
    serverProviders,
  );
  const workSummaryInstanceId = workSummaryModelSelection.instanceId;
  const workSummaryModel = workSummaryModelSelection.model;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    workSummaryInstanceId,
    workSummaryModel,
  );

  const isEnabledDirty = enabled !== DEFAULT_WORK_SUMMARY.enabled;
  const isModelDirty = !Equal.equals(
    workSummary.modelSelection ?? null,
    DEFAULT_WORK_SUMMARY.modelSelection ?? null,
  );
  const isDataLimitDirty = workSummary.dataLimitChars !== DEFAULT_WORK_SUMMARY.dataLimitChars;
  const isPromptDirty = workSummary.promptInstructions !== DEFAULT_WORK_SUMMARY.promptInstructions;

  // `updateSettings` takes a whole-value patch, so merge onto current values.
  const patchWorkSummary = (patch: Partial<typeof workSummary>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        sessionWorkSummary: { ...workSummary, ...patch },
      },
    });
  };

  // Buffer keystrokes so each character does not round-trip to the server.
  // Commits on blur only — Enter must insert a newline in a prompt field.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  return (
    <SettingsSection title="Session work summary">
      <SettingsRow
        title="Generate work summaries"
        description="Fill the AI work summary and progress columns in the sessions manager: what each session actually did, and how far along it looks. Generated on the server, so the columns are the same for everyone."
        resetAction={
          isEnabledDirty ? (
            <SettingResetButton
              label="work summaries"
              onClick={() => patchWorkSummary({ enabled: DEFAULT_WORK_SUMMARY.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => patchWorkSummary({ enabled: Boolean(checked) })}
            aria-label="Generate work summaries"
          />
        }
      />

      <SettingsRow
        title="Work summary model"
        description="Model used to write the work summary and judge progress. Codex instances use your ChatGPT subscription; OpenCode instances can reach OpenRouter models."
        resetAction={
          isModelDirty ? (
            <SettingResetButton
              label="work summary model"
              onClick={() =>
                patchWorkSummary({ modelSelection: DEFAULT_WORK_SUMMARY.modelSelection })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={workSummaryInstanceId}
              model={workSummaryModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              disabled={!enabled}
              onInstanceModelChange={(instanceId, model) => {
                patchWorkSummary({
                  modelSelection: createModelSelection(instanceId, model),
                });
              }}
            />
          </div>
        }
      />

      <SettingsRow
        title="Session data limit"
        description="Maximum characters of transcript read per session when writing its work summary. Lower values cost fewer tokens across a full table; higher values give the model more context."
        resetAction={
          isDataLimitDirty ? (
            <SettingResetButton
              label="session data limit"
              onClick={() =>
                patchWorkSummary({ dataLimitChars: DEFAULT_WORK_SUMMARY.dataLimitChars })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <SettingsNumberField
              ariaLabel="Work summary session data limit in characters"
              disabled={!enabled}
              max={MAX_SESSION_SUMMARY_DATA_LIMIT_CHARS}
              min={MIN_SESSION_SUMMARY_DATA_LIMIT_CHARS}
              onValueChange={(value) => patchWorkSummary({ dataLimitChars: value })}
              step={1_000}
              value={workSummary.dataLimitChars}
            />
            <span className="text-muted-foreground text-xs">characters</span>
          </div>
        }
      />

      <SettingsRow
        title="Extra prompt instructions"
        description="Appended to the work summary prompt. Use it to steer what the columns emphasize — for example: always name the ticket, or judge progress against the PR being merged."
        resetAction={
          isPromptDirty ? (
            <SettingResetButton
              label="prompt instructions"
              onClick={() =>
                patchWorkSummary({
                  promptInstructions: DEFAULT_WORK_SUMMARY.promptInstructions,
                })
              }
            />
          ) : null
        }
      >
        <Textarea
          value={promptDraft ?? workSummary.promptInstructions}
          onChange={(event) => setPromptDraft(event.target.value)}
          onFocus={() => setPromptDraft(workSummary.promptInstructions)}
          onBlur={() => {
            const next = promptDraft ?? workSummary.promptInstructions;
            setPromptDraft(null);
            if (next !== workSummary.promptInstructions) {
              patchWorkSummary({ promptInstructions: next });
            }
          }}
          className="mb-3.5 min-h-20 w-full text-[13px]"
          disabled={!enabled}
          placeholder="Optional. Leave empty to use the default prompt."
          spellCheck={false}
          aria-label="Extra work summary prompt instructions"
        />
      </SettingsRow>
    </SettingsSection>
  );
}
