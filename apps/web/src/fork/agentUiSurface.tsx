/**
 * T3-CUSTOM(expbkt3): single entry point for agent-rendered UI surfaces.
 *
 * Everything the chat timeline needs lives here, so `MessagesTimeline` takes one
 * import and one early return rather than growing surface logic inline. That
 * keeps the next upstream merge cheap.
 *
 * A surface is one `t3_show_ui` tool call: the agent stored a document
 * server-side and the work-log row carries only a short render handle. The card
 * fetches the body on demand and mounts it in a sandboxed iframe, the way MCP
 * Apps hosts render a `ui://` resource.
 */
import {
  AGENT_UI_DEFAULT_HEIGHT,
  AGENT_UI_MAX_HEIGHT,
  AGENT_UI_MIN_HEIGHT,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { memo, useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { agentUiEnvironment } from "../state/agentUi";
import { useEnvironmentQuery } from "../state/query";
import { cn } from "../lib/utils";

/** The handle `ActivityPayloadProjection` keeps on an MCP tool-call payload. */
export interface AgentUiSurfaceHandle {
  readonly renderId: string;
  readonly kind: "html" | "url";
  readonly height: number;
}

function clampHeight(height: unknown): number {
  if (typeof height !== "number" || !Number.isFinite(height)) return AGENT_UI_DEFAULT_HEIGHT;
  return Math.max(AGENT_UI_MIN_HEIGHT, Math.min(Math.round(height), AGENT_UI_MAX_HEIGHT));
}

/**
 * Reads the render handle off a work-log entry, or null when the row is an
 * ordinary tool call. Pure, so the timeline can call it before any hooks.
 */
export function resolveAgentUiSurface(entry: {
  readonly agentUi?: unknown;
}): AgentUiSurfaceHandle | null {
  const handle = entry.agentUi;
  if (typeof handle !== "object" || handle === null) return null;
  const record = handle as Record<string, unknown>;
  const renderId = record.renderId;
  if (typeof renderId !== "string" || renderId.length === 0) return null;
  return {
    renderId,
    kind: record.kind === "url" ? "url" : "html",
    height: clampHeight(record.height),
  };
}

/** Wraps a bare fragment so an agent can pass markup without a document shell. */
function toSrcDoc(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>body{margin:0;padding:12px;font-family:system-ui,sans-serif}</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

interface AgentUiSurfaceCardProps {
  readonly threadRef: ScopedThreadRef;
  readonly surface: AgentUiSurfaceHandle;
}

function AgentUiSurfaceCardImpl({ threadRef, surface }: AgentUiSurfaceCardProps) {
  const { environmentId, threadId } = threadRef;
  const [collapsed, setCollapsed] = useState(false);
  const query = useEnvironmentQuery(
    agentUiEnvironment.render({
      environmentId,
      input: { threadId, renderId: surface.renderId },
    }),
  );
  const render = query.data?.render ?? null;

  // An unmodified sandbox gives the document an opaque origin: its scripts run,
  // so charts and interactions work, but it cannot reach this page, our cookies,
  // or the network as the signed-in user.
  const srcDoc = useMemo(
    () => (render?.kind === "html" && render.html ? toSrcDoc(render.html) : null),
    [render?.kind, render?.html],
  );

  const height = render ? clampHeight(render.height) : surface.height;
  const title = render?.title ?? "Agent view";

  return (
    <div className="mt-1 ms-7 overflow-hidden rounded-lg border border-border/60 bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-accent/20"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-secondary-label text-xs">
          {title}
        </span>
        <span className="shrink-0 text-[0.6875rem] text-secondary-label/70">
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>
      {collapsed ? null : (
        <div className="border-border/60 border-t" style={{ height }}>
          {query.isPending && render === null ? (
            <div className="flex h-full items-center justify-center text-secondary-label text-xs">
              Loading view…
            </div>
          ) : render === null ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-secondary-label text-xs">
              {query.error ?? "This view is no longer available."}
            </div>
          ) : srcDoc !== null ? (
            <iframe
              // Keying on the render makes the browser build a fresh document;
              // an iframe does not re-run scripts on a srcDoc mutation alone.
              key={render.renderId}
              title={title}
              srcDoc={srcDoc}
              className={cn("size-full border-0 bg-white")}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : render.url ? (
            <iframe
              key={render.renderId}
              title={title}
              src={render.url}
              className="size-full border-0 bg-white"
              sandbox="allow-scripts allow-forms allow-popups"
              referrerPolicy="no-referrer"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

const AgentUiSurfaceCard = memo(AgentUiSurfaceCardImpl);

/**
 * Wraps the timeline's ordinary tool row with the surface it produced.
 *
 * Composition rather than modification: the upstream row renders unchanged as
 * `children`, and turning the setting off leaves exactly that row behind.
 */
export const AgentUiSurfaceRow = memo(function AgentUiSurfaceRow(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly surface: AgentUiSurfaceHandle;
  readonly children: ReactNode;
}) {
  const enabled = useClientSettings((settings) => settings.agentUiSurfacesEnabled);
  if (!enabled || props.threadRef === null) {
    return props.children;
  }
  return (
    <div className="flex flex-col">
      {props.children}
      <AgentUiSurfaceCard threadRef={props.threadRef} surface={props.surface} />
    </div>
  );
});
