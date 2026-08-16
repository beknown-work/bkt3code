/**
 * T3-CUSTOM(expbkt3): Sidebar-adjacent, full-workspace Plannotator review
 * surface. ChatView contains only the small activation seam.
 */
import type { PlannotatorReviewUrl } from "@t3tools/shared/plannotator";
import { XIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import {
  createPlannotatorPollingController,
  type PlannotatorDecision,
  type PlannotatorPollingController,
  type PlannotatorTerminalStatus,
  releasePlannotatorClientLease,
} from "./PlannotatorFocusSurface.polling";

export {
  plannotatorStatusUrl,
  readPlannotatorDecision,
  readPlannotatorTerminalStatus,
} from "./PlannotatorFocusSurface.polling";

interface PlannotatorFocusSurfaceProps {
  /**
   * Absolute review URL on the environment that owns the review — see
   * `resolvePlannotatorReviewUrl`. A root-relative path only reaches the right
   * server when this client is served by it, which the desktop renderer never
   * is.
   */
  url: PlannotatorReviewUrl;
  visible?: boolean;
  onClose: () => void;
  onDecision: (decision: PlannotatorDecision) => void;
  onTerminal: (status: PlannotatorTerminalStatus) => void;
}

const PLANNOTATOR_PREFERENCE_MESSAGE = "t3:plannotator-preference-cookie";
const PLANNOTATOR_PREFERENCE_COOKIE = /^plannotator-[A-Za-z0-9_-]{1,96}$/;
const MAX_PLANNOTATOR_PREFERENCE_COOKIE_BYTES = 8192;

/**
 * T3-CUSTOM(expbkt3): Normalize the only cookie namespace that the opaque
 * Plannotator iframe may ask its trusted parent to persist. The parent supplies
 * fixed attributes instead of accepting attributes authored inside a reviewed
 * plan.
 */
export function normalizePlannotatorPreferenceCookie(
  rawCookie: unknown,
  secure: boolean,
): string | null {
  if (
    typeof rawCookie !== "string" ||
    rawCookie.length === 0 ||
    new TextEncoder().encode(rawCookie).byteLength > MAX_PLANNOTATOR_PREFERENCE_COOKIE_BYTES ||
    rawCookie.includes("\r") ||
    rawCookie.includes("\n") ||
    rawCookie.includes("\u0000")
  ) {
    return null;
  }
  const pair = rawCookie.split(";", 1)[0];
  if (pair === undefined) return null;
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1);
  if (!PLANNOTATOR_PREFERENCE_COOKIE.test(name) || value.includes(";")) return null;

  const deleted = /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(rawCookie);
  return `${name}=${deleted ? "" : value}; path=/; max-age=${deleted ? 0 : 31_536_000}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function plannotatorPreferenceFragment(cookieHeader: string): string {
  const preferences: Record<string, string> = {};
  let count = 0;
  for (const segment of cookieHeader.split(";")) {
    if (count >= 64) break;
    const cookie = segment.trim();
    const separator = cookie.indexOf("=");
    if (separator <= 0) continue;
    const name = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1);
    if (!PLANNOTATOR_PREFERENCE_COOKIE.test(name) || value.length > 4096) continue;
    preferences[name] = value;
    count += 1;
  }
  return count === 0 ? "" : `#t3-preferences=${encodeURIComponent(JSON.stringify(preferences))}`;
}

export const PlannotatorFocusSurface = memo(function PlannotatorFocusSurface({
  url,
  visible = true,
  onClose,
  onDecision,
  onTerminal,
}: PlannotatorFocusSurfaceProps) {
  const clientIdRef = useRef<string | null>(null);
  if (clientIdRef.current === null) clientIdRef.current = randomUUID();
  const clientId = clientIdRef.current;
  const controllerRef = useRef<PlannotatorPollingController | null>(null);
  const onDecisionRef = useRef(onDecision);
  const onTerminalRef = useRef(onTerminal);
  onDecisionRef.current = onDecision;
  onTerminalRef.current = onTerminal;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const preferenceFragmentRef = useRef<{ readonly url: string; readonly value: string } | null>(
    null,
  );
  if (preferenceFragmentRef.current?.url !== url) {
    preferenceFragmentRef.current = {
      url,
      value: typeof document === "undefined" ? "" : plannotatorPreferenceFragment(document.cookie),
    };
  }
  const preferenceFragment = preferenceFragmentRef.current.value;

  useEffect(() => {
    const controller = createPlannotatorPollingController({
      url,
      clientId,
      visible,
      onDecision: (decision) => onDecisionRef.current(decision),
      onTerminal: (status) => onTerminalRef.current(status),
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.stop();
      releasePlannotatorClientLease({ url, clientId });
    };
  }, [clientId, url]);

  useEffect(() => {
    controllerRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    const persistPreference = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== PLANNOTATOR_PREFERENCE_MESSAGE
      ) {
        return;
      }
      const cookie = normalizePlannotatorPreferenceCookie(
        event.data.cookie,
        window.location.protocol === "https:",
      );
      if (cookie) document.cookie = cookie;
    };
    window.addEventListener("message", persistPreference);
    return () => window.removeEventListener("message", persistPreference);
  }, []);

  return (
    <div
      className={
        visible ? "relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background" : "hidden"
      }
      data-plannotator-focus-surface
      aria-hidden={visible ? undefined : true}
    >
      <iframe
        ref={iframeRef}
        key={url}
        src={`${url}?t3-reopen=1${preferenceFragment}`}
        title="Plannotator plan review"
        className="h-full min-h-0 w-full border-0 bg-background"
        sandbox="allow-downloads allow-forms allow-modals allow-scripts"
        referrerPolicy="no-referrer"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-start p-3">
        <Button
          size="sm"
          variant="outline"
          className="pointer-events-auto gap-1.5 rounded-full bg-background/92 px-3 shadow-lg backdrop-blur-md"
          aria-label="Close plan review"
          onClick={onClose}
        >
          <XIcon className="size-4" />
          Close
        </Button>
      </div>
    </div>
  );
});

export type { PlannotatorFocusSurfaceProps };
