/**
 * T3-CUSTOM(expbkt3): Guarded route seam for experimental notification settings.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

import { NotificationsSettingsPanel } from "../components/settings/NotificationsSettingsPanel";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../experimentalFeatures";

export const Route = createFileRoute("/settings/notifications")({
  beforeLoad: () => {
    if (!EXPERIMENTAL_CONTROL_CENTER_ENABLED) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: NotificationsSettingsPanel,
});
