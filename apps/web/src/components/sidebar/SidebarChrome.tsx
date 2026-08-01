import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../../experimentalFeatures";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarProviderRateLimits } from "./SidebarProviderRateLimits";
import { SidebarResourceMonitorPill } from "./SidebarResourceMonitorPill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { summarizeSidebarSessions } from "./sidebarSessionCounters";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-auto min-h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-0 px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const { environments } = useEnvironments();
  // T3-CUSTOM(expbkt3): BEGIN — derive experimental global attention/running counters.
  const threads = useThreadShells();
  const stageLabel = useEnvironmentStageLabel();
  const counts = useMemo(() => summarizeSidebarSessions(threads), [threads]);
  const providerRateLimitsEnabled = useClientSettings(
    (settings) => settings.providerRateLimitsEnabled,
  );
  const showProviderRateLimits = EXPERIMENTAL_CONTROL_CENTER_ENABLED && providerRateLimitsEnabled;
  // T3-CUSTOM(expbkt3): END
  const syncing = environments.some(
    (environment) =>
      environment.connection.phase === "connecting" ||
      environment.connection.phase === "reconnecting",
  );

  return (
    <div
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden"
      data-testid="sidebar-brand-layout"
    >
      <Link
        aria-label="Go to threads"
        className={cn(
          "sidebar-brand h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
          onBackdrop ? "text-white" : "text-foreground",
        )}
        to="/"
      >
        <T3Wordmark />
        <span
          className={cn(
            "truncate text-sm font-medium tracking-tight",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        >
          Code
        </span>
        <span
          className={cn(
            "sidebar-brand-stage shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em]",
            onBackdrop ? "bg-white/10 text-white/60" : "bg-muted/50 text-muted-foreground/60",
          )}
        >
          {stageLabel}
        </span>
      </Link>
      {/* T3-CUSTOM(expbkt3): BEGIN — compact lifecycle counters beside the wordmark. */}
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? (
        <div className="flex shrink-0 items-center gap-1" aria-label="Session status summary">
          <span
            className={cn(
              "inline-flex h-7 min-w-8 items-center justify-center rounded-lg border px-1.5 text-base font-black tabular-nums",
              counts.attention > 0
                ? onBackdrop
                  ? "animate-pulse border-white/70 bg-white text-red-600 shadow-[0_0_18px_rgba(255,255,255,0.9)]"
                  : "animate-pulse border-red-500 bg-red-500 text-white shadow-[0_0_18px_rgba(239,68,68,0.75)]"
                : onBackdrop
                  ? "border-white/20 bg-white/10 text-white/55"
                  : "border-border bg-muted text-muted-foreground",
            )}
            data-attention-state={counts.attention > 0 ? "urgent" : "clear"}
            role="status"
            title={`${counts.attention} session${counts.attention === 1 ? "" : "s"} need human attention`}
          >
            {counts.attention}
          </span>
          <span
            className={cn(
              "inline-flex h-7 min-w-8 items-center justify-center rounded-lg border px-1.5 text-base font-black tabular-nums",
              onBackdrop
                ? "border-white/25 bg-white/12 text-white"
                : "border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
            )}
            title={`${counts.running} session${counts.running === 1 ? "" : "s"} running`}
          >
            {counts.running}
          </span>
        </div>
      ) : null}
      {/* T3-CUSTOM(expbkt3): END */}
      {showProviderRateLimits || syncing ? (
        <div
          className="flex h-7 max-w-full shrink-0 items-center gap-1.5 overflow-hidden"
          data-testid="sidebar-provider-rate-limits-slot"
        >
          {showProviderRateLimits ? <SidebarProviderRateLimits onBackdrop={onBackdrop} /> : null}
          {syncing ? (
            <span
              aria-label="Connection interrupted; syncing"
              className="inline-flex shrink-0"
              role="status"
              title="Connection interrupted. Syncing…"
            >
              <LoaderIcon
                className={cn(
                  "size-3 animate-spin",
                  onBackdrop ? "text-white/70" : "text-muted-foreground/70",
                )}
              />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarResourceMonitorPill />
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

export function SidebarEnvironmentNotices() {
  const { environments } = useEnvironments();
  const secondaries = useDesktopLocalBootstraps();
  const localEnvByUrl = useMemo(() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  }, [environments]);

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const environment = bootstrap.httpBaseUrl
      ? localEnvByUrl.get(bootstrap.httpBaseUrl)
      : undefined;
    if (environment?.phase === "connected") continue;
    if (environment?.phase === "error") {
      failed.push({ label: bootstrap.label, error: environment.error });
    } else {
      connecting.push(bootstrap.label);
    }
  }

  if (connecting.length === 0 && failed.length === 0) return null;

  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      {connecting.length > 0 ? (
        <Alert
          variant="default"
          className="rounded-2xl border-border/40 bg-accent/40 text-muted-foreground"
        >
          <LoaderIcon className="animate-spin" />
          <AlertTitle className="text-xs font-medium text-foreground">
            Connecting {connecting.join(", ")}
          </AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}
