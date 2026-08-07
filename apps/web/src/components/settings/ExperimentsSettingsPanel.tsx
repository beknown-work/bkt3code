import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SessionSummarySettingsSection } from "./SessionSummarySettingsSection";
import { ExternalMcpSettingsSection } from "./ExternalMcpSettingsSection";
import { T3ConductorSettingsSection } from "./T3ConductorSettingsSection";
// T3-CUSTOM(expbkt3): session title maintenance.
import { ThreadTitleMaintenanceSettingsSection } from "./ThreadTitleMaintenanceSettingsSection";
import {
  EXPERIMENTAL_CONTROL_CENTER_ENABLED,
  T3_CONDUCTOR_ENABLED,
} from "../../experimentalFeatures";
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
  const providerRateLimitsEnabled = useClientSettings(
    (settings) => settings.providerRateLimitsEnabled,
  );
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
        {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? (
          <SettingsRow
            title="Provider usage limits"
            description="Show compact Codex and Claude subscription-limit bars in the sidebar header. The indicator wraps below the T3 Code brand when the sidebar is too narrow."
            resetAction={
              providerRateLimitsEnabled !== DEFAULT_UNIFIED_SETTINGS.providerRateLimitsEnabled ? (
                <SettingResetButton
                  label="provider usage limits"
                  onClick={() =>
                    updateSettings({
                      providerRateLimitsEnabled: DEFAULT_UNIFIED_SETTINGS.providerRateLimitsEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={providerRateLimitsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ providerRateLimitsEnabled: Boolean(checked) })
                }
                aria-label="Show provider usage limits"
              />
            }
          />
        ) : null}
      </SettingsSection>
      {/* T3-CUSTOM(expbkt3): BEGIN — experimental operator MCP settings seam. */}
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? (
        <>
          {T3_CONDUCTOR_ENABLED ? <T3ConductorSettingsSection /> : null}
          <ExternalMcpSettingsSection />
        </>
      ) : null}
      {/* T3-CUSTOM(expbkt3): END */}
      <SessionSummarySettingsSection />
      {/* T3-CUSTOM(expbkt3): BEGIN — session title maintenance. */}
      <ThreadTitleMaintenanceSettingsSection />
      {/* T3-CUSTOM(expbkt3): END */}
    </SettingsPageContainer>
  );
}
