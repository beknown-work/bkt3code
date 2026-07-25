import { useAtomValue } from "@effect/atom-react";
import * as Equal from "effect/Equal";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SESSION_SUMMARY_DATA_LIMIT_CHARS,
  MAX_SESSION_SUMMARY_TURN_DURATION_MINUTES,
  MIN_SESSION_SUMMARY_DATA_LIMIT_CHARS,
  MIN_SESSION_SUMMARY_TURN_DURATION_MINUTES,
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
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULT_SESSION_SUMMARY = DEFAULT_UNIFIED_SETTINGS.experimental.sessionSummary;

/** Compact numeric control shared by the two bounded settings below. */
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
 * Catch-up summary controls, rendered inside the Experiments settings tab.
 * These are server settings because summarization runs on the server.
 */
export function SessionSummarySettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const sessionSummary = settings.experimental.sessionSummary;
  const enabled = sessionSummary.enabled;

  // Reuse the text-generation resolver by pointing it at the summarizer's own
  // selection, so fallback behavior for disabled/unavailable instances matches.
  const summaryModelSelection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: sessionSummary.modelSelection },
    serverProviders,
  );
  const summaryInstanceId = summaryModelSelection.instanceId;
  const summaryModel = summaryModelSelection.model;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    summaryInstanceId,
    summaryModel,
  );

  const isEnabledDirty = enabled !== DEFAULT_SESSION_SUMMARY.enabled;
  const isModelDirty = !Equal.equals(
    sessionSummary.modelSelection ?? null,
    DEFAULT_SESSION_SUMMARY.modelSelection ?? null,
  );
  const isDataLimitDirty = sessionSummary.dataLimitChars !== DEFAULT_SESSION_SUMMARY.dataLimitChars;
  const isCutoffDirty =
    sessionSummary.minTurnDurationMinutes !== DEFAULT_SESSION_SUMMARY.minTurnDurationMinutes;

  // `updateSettings` takes a whole-value patch, so merge onto current values.
  const patchSessionSummary = (patch: Partial<typeof sessionSummary>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        sessionSummary: { ...sessionSummary, ...patch },
      },
    });
  };

  return (
    <SettingsSection title="Session catch-up summary">
      <SettingsRow
        title="Show catch-up summaries"
        description="After a turn runs longer than the cutoff, show a short note under its final output summarizing where the session got to and what's left."
        resetAction={
          isEnabledDirty ? (
            <SettingResetButton
              label="catch-up summaries"
              onClick={() => patchSessionSummary({ enabled: DEFAULT_SESSION_SUMMARY.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => patchSessionSummary({ enabled: Boolean(checked) })}
            aria-label="Show catch-up summaries"
          />
        }
      />

      <SettingsRow
        title="Summarizer model"
        description="Model used to write catch-up summaries. Codex instances use your ChatGPT subscription; OpenCode instances can reach OpenRouter models."
        resetAction={
          isModelDirty ? (
            <SettingResetButton
              label="summarizer model"
              onClick={() =>
                patchSessionSummary({ modelSelection: DEFAULT_SESSION_SUMMARY.modelSelection })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={summaryInstanceId}
              model={summaryModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              disabled={!enabled}
              onInstanceModelChange={(instanceId, model) => {
                patchSessionSummary({
                  modelSelection: createModelSelection(instanceId, model),
                });
              }}
            />
          </div>
        }
      />

      <SettingsRow
        title="Minimum turn length"
        description="Only turns that worked at least this many minutes get a catch-up summary. Set to 0 to summarize every turn."
        resetAction={
          isCutoffDirty ? (
            <SettingResetButton
              label="minimum turn length"
              onClick={() =>
                patchSessionSummary({
                  minTurnDurationMinutes: DEFAULT_SESSION_SUMMARY.minTurnDurationMinutes,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <SettingsNumberField
              ariaLabel="Minimum turn length in minutes"
              disabled={!enabled}
              max={MAX_SESSION_SUMMARY_TURN_DURATION_MINUTES}
              min={MIN_SESSION_SUMMARY_TURN_DURATION_MINUTES}
              onValueChange={(value) => patchSessionSummary({ minTurnDurationMinutes: value })}
              step={1}
              value={sessionSummary.minTurnDurationMinutes}
            />
            <span className="text-muted-foreground text-xs">minutes</span>
          </div>
        }
      />

      <SettingsRow
        title="Session data limit"
        description="Maximum characters of transcript sent per summarization request. Lower values cost fewer tokens; higher values give the model more context."
        resetAction={
          isDataLimitDirty ? (
            <SettingResetButton
              label="session data limit"
              onClick={() =>
                patchSessionSummary({ dataLimitChars: DEFAULT_SESSION_SUMMARY.dataLimitChars })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <SettingsNumberField
              ariaLabel="Session data limit in characters"
              disabled={!enabled}
              max={MAX_SESSION_SUMMARY_DATA_LIMIT_CHARS}
              min={MIN_SESSION_SUMMARY_DATA_LIMIT_CHARS}
              onValueChange={(value) => patchSessionSummary({ dataLimitChars: value })}
              step={1_000}
              value={sessionSummary.dataLimitChars}
            />
            <span className="text-muted-foreground text-xs">characters</span>
          </div>
        }
      />
    </SettingsSection>
  );
}
