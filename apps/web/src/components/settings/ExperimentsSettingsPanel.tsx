import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SessionSummarySettingsSection } from "./SessionSummarySettingsSection";
import { ExternalMcpSettingsSection } from "./ExternalMcpSettingsSection";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../../experimentalFeatures";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function ExperimentsSettingsPanel() {
  const phaseGroupedSidebarEnabled = useClientSettings(
    (settings) => settings.phaseGroupedSidebarEnabled,
  );
  const resourceMonitorEnabled = useClientSettings((settings) => settings.resourceMonitorEnabled);
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Experimental features">
        <SettingsRow
          title="Phase-grouped sidebar"
          description="Group threads by lifecycle phase instead of repository. Repository, branch, and provider stay visible as row labels, and the original sidebar remains available when this is off."
          resetAction={
            phaseGroupedSidebarEnabled !== DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled ? (
              <SettingResetButton
                label="phase-grouped sidebar"
                onClick={() =>
                  updateSettings({
                    phaseGroupedSidebarEnabled: DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={phaseGroupedSidebarEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ phaseGroupedSidebarEnabled: Boolean(checked) })
              }
              aria-label="Enable the phase-grouped sidebar"
            />
          }
        />
        <SettingsRow
          title="Live resource monitor"
          description="Show live CPU, memory, and disk usage of the T3 Code server."
          resetAction={
            resourceMonitorEnabled !== DEFAULT_UNIFIED_SETTINGS.resourceMonitorEnabled ? (
              <SettingResetButton
                label="live resource monitor"
                onClick={() =>
                  updateSettings({
                    resourceMonitorEnabled: DEFAULT_UNIFIED_SETTINGS.resourceMonitorEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={resourceMonitorEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ resourceMonitorEnabled: Boolean(checked) })
              }
              aria-label="Enable the live resource monitor"
            />
          }
        />
      </SettingsSection>
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? <ExternalMcpSettingsSection /> : null}
      <SessionSummarySettingsSection />
    </SettingsPageContainer>
  );
}
