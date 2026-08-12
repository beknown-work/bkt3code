/**
 * T3-CUSTOM(expbkt3): Session title maintenance controls.
 *
 * Server settings, because the regeneration runs on the server with the
 * configured text-generation model. Rendered inside the Experiments tab.
 */
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULTS = DEFAULT_UNIFIED_SETTINGS.experimental.threadTitleMaintenance;
const MAX_REFRESH_EVERY_USER_PROMPTS = 20;

export function ThreadTitleMaintenanceSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const maintenance = settings.experimental.threadTitleMaintenance;

  // `updateSettings` takes a whole-value patch, so merge onto current values.
  const patch = (next: Partial<typeof maintenance>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        threadTitleMaintenance: { ...maintenance, ...next },
      },
    });
  };

  const cadenceLabel =
    maintenance.refreshEveryUserPrompts === 0
      ? "Off — the title is set once, from the first prompt."
      : maintenance.refreshEveryUserPrompts === 1
        ? "Re-reads the session and retitles it after every prompt."
        : `Re-reads the session and retitles it after every ${maintenance.refreshEveryUserPrompts} prompts.`;

  return (
    <SettingsSection title="Session titles">
      <SettingsRow
        title="Keep titles current"
        description="Sessions are titled from their first prompt. Long sessions drift away from that opening line, so this re-reads the conversation and retitles it as the work changes, using the text-generation model above."
        resetAction={
          maintenance.enabled !== DEFAULTS.enabled ? (
            <SettingResetButton
              label="title maintenance"
              onClick={() => patch({ enabled: DEFAULTS.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Keep session titles current"
            checked={maintenance.enabled}
            onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Retitle every"
        description="How many of your prompts pass between retitles. Sessions you have renamed yourself are left alone — use “Regenerate title” on a session to hand its name back to the model."
        status={cadenceLabel}
        resetAction={
          maintenance.refreshEveryUserPrompts !== DEFAULTS.refreshEveryUserPrompts ? (
            <SettingResetButton
              label="retitle cadence"
              onClick={() => patch({ refreshEveryUserPrompts: DEFAULTS.refreshEveryUserPrompts })}
            />
          ) : null
        }
        control={
          <NumberField
            aria-label="Retitle every N prompts"
            className="w-32 gap-0"
            disabled={!maintenance.enabled}
            max={MAX_REFRESH_EVERY_USER_PROMPTS}
            min={0}
            onValueChange={(next) => {
              if (typeof next === "number" && Number.isFinite(next)) {
                patch({ refreshEveryUserPrompts: Math.round(next) });
              }
            }}
            size="sm"
            step={1}
            value={maintenance.refreshEveryUserPrompts}
          >
            <NumberFieldGroup className="h-7 rounded-md">
              <NumberFieldDecrement
                aria-label="Decrease retitle cadence"
                className="px-2 [&_svg]:size-3.5"
              />
              <NumberFieldInput
                aria-label="Retitle every N prompts"
                className="h-7 w-14 grow-0 px-0 text-xs leading-7"
                inputMode="numeric"
              />
              <NumberFieldIncrement
                aria-label="Increase retitle cadence"
                className="px-2 [&_svg]:size-3.5"
              />
            </NumberFieldGroup>
          </NumberField>
        }
      />
    </SettingsSection>
  );
}
