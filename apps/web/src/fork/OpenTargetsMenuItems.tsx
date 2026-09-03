/**
 * T3-CUSTOM(expbkt3): the user's own "Open in…" entries, appended to upstream's
 * editor list in {@link OpenInPicker}.
 *
 * Rendered as a separate component so the upstream picker keeps a single call
 * site and the whole feature stays greppable at one path. Resolution is pure
 * (`fork/openTargets`); this file only decides what to render and how to fire
 * the URL on each surface.
 *
 * @module fork/OpenTargetsMenuItems
 */
import { ExternalLinkIcon } from "lucide-react";
import { useCallback } from "react";

import { MenuItem, MenuSeparator } from "../components/ui/menu";
import { useClientSettings } from "../hooks/useSettings";
import type { RemoteOpenState } from "../remoteOpen";
import { resolveOpenTargetUrl, type OpenTargetUnavailableReason } from "./openTargets";

function unavailableLabel(
  reason: OpenTargetUnavailableReason,
  environmentLabel: string,
): string | null {
  switch (reason) {
    case "no-path-mapping":
      return `No path mapping for ${environmentLabel}`;
    case "no-remote-route":
      return `No SSH route to ${environmentLabel}`;
    // A malformed template is the user's own typo, visible in settings where
    // they can fix it; a disabled row here would just be noise.
    case "invalid-template":
      return null;
  }
}

/**
 * Fires a target URL. The desktop app needs the main process to hand the URL
 * to the OS (a renderer navigation to a custom scheme is blocked), while a
 * browser assigns the location, which leaves no blank tab behind.
 */
async function openTargetUrl(url: string): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    if (bridge.openForkTarget === undefined) {
      return false;
    }
    try {
      return await bridge.openForkTarget(url);
    } catch {
      return false;
    }
  }
  window.location.assign(url);
  return true;
}

export function OpenTargetsMenuItems({
  remote,
  openInCwd,
  environmentLabel,
}: {
  readonly remote: RemoteOpenState;
  readonly openInCwd: string | null;
  readonly environmentLabel: string;
}) {
  const openTargets = useClientSettings((settings) => settings.openTargets);
  const fire = useCallback((url: string) => {
    void openTargetUrl(url);
  }, []);

  if (openTargets.length === 0 || openInCwd === null || openInCwd.length === 0) {
    return null;
  }

  // A browser cannot hand a `file:` URL to the OS, so those rows would do
  // nothing there. Everything else works on both surfaces.
  const isDesktop = window.desktopBridge !== undefined;

  const rows = openTargets.flatMap((target) => {
    const resolution = resolveOpenTargetUrl({ target, absolutePath: openInCwd, remote });

    if (!resolution.ok) {
      const label = unavailableLabel(resolution.reason, environmentLabel);
      return label === null
        ? []
        : [
            <MenuItem disabled key={target.id}>
              <ExternalLinkIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              {target.label}
              <span className="ml-auto text-muted-foreground text-xs">{label}</span>
            </MenuItem>,
          ];
    }

    if (resolution.scheme === "file" && !isDesktop) {
      return [];
    }

    return [
      <MenuItem key={target.id} onClick={() => fire(resolution.url)}>
        <ExternalLinkIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        {target.label}
      </MenuItem>,
    ];
  });

  if (rows.length === 0) {
    return null;
  }

  return (
    <>
      <MenuSeparator />
      {rows}
    </>
  );
}
