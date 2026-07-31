/**
 * T3-CUSTOM(expbkt3): Sidebar-adjacent, full-workspace Plannotator review
 * surface. ChatView contains only the small activation seam.
 */
import { XIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { Button } from "./ui/button";

type PlannotatorDecision = "approved" | "feedback" | "denied";

interface PlannotatorFocusSurfaceProps {
  url: `/plannotator/${string}/`;
  visible?: boolean;
  onClose: () => void;
  onDecision: (decision: PlannotatorDecision) => void;
}

const PLANNOTATOR_STATUS_POLL_MS = 500;
const PLANNOTATOR_REOPEN_GRACE_MS = 750;
const PLANNOTATOR_PREFERENCE_MESSAGE = "t3:plannotator-preference-cookie";
const PLANNOTATOR_PREFERENCE_COOKIE = /^plannotator-[A-Za-z0-9_-]{1,96}$/;
const MAX_PLANNOTATOR_PREFERENCE_COOKIE_BYTES = 8192;

export function plannotatorStatusUrl(url: `/plannotator/${string}/`): string {
  return `${url}__t3/status`;
}

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

export function readPlannotatorDecision(value: unknown): PlannotatorDecision | null {
  if (!value || typeof value !== "object" || !("decision" in value)) return null;
  const decision = value.decision;
  return decision === "approved" || decision === "feedback" || decision === "denied"
    ? decision
    : null;
}

export const PlannotatorFocusSurface = memo(function PlannotatorFocusSurface({
  url,
  visible = true,
  onClose,
  onDecision,
}: PlannotatorFocusSurfaceProps) {
  const handledDecisionRef = useRef<PlannotatorDecision | null>(null);
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
    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        const response = await fetch(plannotatorStatusUrl(url), {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) {
          const decision = readPlannotatorDecision(await response.json());
          if (decision !== null) {
            if (!cancelled && handledDecisionRef.current !== decision) {
              handledDecisionRef.current = decision;
              onDecision(decision);
            }
            return;
          }
        }
      } catch {
        // A review process can briefly restart while its proxy remains mounted.
      }
      if (!cancelled) {
        timeoutId = window.setTimeout(() => void poll(), PLANNOTATOR_STATUS_POLL_MS);
      }
    };

    handledDecisionRef.current = null;
    // Let the iframe's explicit reopen navigation reset a completed durable
    // review to "starting" before reading its previous terminal decision.
    timeoutId = window.setTimeout(() => void poll(), PLANNOTATOR_REOPEN_GRACE_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [onDecision, url]);

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
