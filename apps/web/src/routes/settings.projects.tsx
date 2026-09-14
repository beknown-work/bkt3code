/**
 * T3-CUSTOM(expbkt3): Guarded route seam for experimental project management.
 *
 * Upstream now ships its own project settings page at this path, so the flag
 * selects between the two panels instead of redirecting away.
 */
import { createFileRoute } from "@tanstack/react-router";

import { ActiveProjectsSettingsPanel } from "../components/settings/ActiveProjectsSettingsPanel";
import { ProjectsSettings } from "../components/settings/ProjectsSettings";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../experimentalFeatures";

export const Route = createFileRoute("/settings/projects")({
  component: EXPERIMENTAL_CONTROL_CENTER_ENABLED ? ActiveProjectsSettingsPanel : ProjectsSettings,
});
