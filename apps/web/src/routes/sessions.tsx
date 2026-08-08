/**
 * T3-CUSTOM(expbkt3): Route shell for the bulk session manager.
 *
 * Structurally a copy of `routes/settings.tsx` — same auth `beforeLoad`, same
 * `SidebarInset` + workspace-topbar chrome (with the Electron drag-region
 * variant), same Escape-to-go-back. Keeping the two shells identical is
 * deliberate: they are the app's only two full-screen non-chat surfaces, and a
 * divergent titlebar inset here would be visible the moment the sidebar
 * collapses.
 */
import { createFileRoute, redirect, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { SessionManagerPage } from "../components/sessionManager/SessionManagerPage";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function SessionsRouteLayout() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The page itself consumes Escape while rows are selected (it calls
      // preventDefault), so leaving the page is only ever the *second*
      // Escape — a stray keypress can never discard a large selection AND
      // navigate away in one go.
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      navigateBackWithinApp();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-medium text-foreground">Manage sessions</span>
            </div>
          </header>
        )}

        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Manage sessions
            </span>
          </div>
        )}

        <div className="min-h-0 flex flex-1 flex-col">
          <SessionManagerPage />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/sessions")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SessionsRouteLayout,
});
