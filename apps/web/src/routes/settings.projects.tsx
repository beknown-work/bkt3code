/**
 * T3-CUSTOM(expbkt3): Guarded route seam for experimental project management.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ActiveProjectsSettingsPanel } from "../components/settings/ActiveProjectsSettingsPanel";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../experimentalFeatures";

export const Route = createFileRoute("/settings/projects")({
  beforeLoad: () => {
    if (!EXPERIMENTAL_CONTROL_CENTER_ENABLED) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: ActiveProjectsSettingsPanel,
});
