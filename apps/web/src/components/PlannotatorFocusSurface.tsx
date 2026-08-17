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
const MAX_PLANNOTATOR_PREFERENCES = 64;
const MAX_PLANNOTATOR_PREFERENCE_VALUE_LENGTH = 4096;
/**
 * T3-CUSTOM(expbkt3): `document.cookie` is inert on any origin whose scheme is
 * not cookieable, and the desktop renderer is served from `t3code://app`. A
 * preference written there silently succeeds and reads back empty, so every
 * reopened review replayed Plannotator's first-run onboarding — including the
 * permission-mode dialog. `localStorage` is available on every T3 client, so it
 * is the store of record; the cookie is still written so that a same-origin
 * browser keeps seeding the server-injected shim across an in-iframe reload.
 */
const PLANNOTATOR_PREFERENCE_STORAGE_KEY = "t3code:plannotator-preferences:v1";

export interface PlannotatorPreferenceWrite {
  readonly name: string;
  readonly value: string;
  readonly deleted: boolean;
}

/**
 * T3-CUSTOM(expbkt3): Parse the only cookie namespace that the opaque
 * Plannotator iframe may ask its trusted parent to persist. Attributes authored
 * inside a reviewed plan are discarded; the parent decides how to store the
 * pair.
 */
export function parsePlannotatorPreferenceCookie(
  rawCookie: unknown,
): PlannotatorPreferenceWrite | null {
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

  return { name, value, deleted: /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(rawCookie) };
}

/**
 * The parent supplies fixed cookie attributes instead of accepting attributes
 * authored inside a reviewed plan.
 */
export function normalizePlannotatorPreferenceCookie(
  rawCookie: unknown,
  secure: boolean,
): string | null {
  const write = parsePlannotatorPreferenceCookie(rawCookie);
  if (!write) return null;
  return `${write.name}=${write.deleted ? "" : write.value}; path=/; max-age=${write.deleted ? 0 : 31_536_000}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function isStorablePlannotatorPreference(name: string, value: unknown): value is string {
  return (
    PLANNOTATOR_PREFERENCE_COOKIE.test(name) &&
    typeof value === "string" &&
    value.length <= MAX_PLANNOTATOR_PREFERENCE_VALUE_LENGTH
  );
}

export function plannotatorPreferencesFromCookieHeader(
  cookieHeader: string,
): Record<string, string> {
  const preferences: Record<string, string> = {};
  for (const segment of cookieHeader.split(";")) {
    if (Object.keys(preferences).length >= MAX_PLANNOTATOR_PREFERENCES) break;
    const cookie = segment.trim();
    const separator = cookie.indexOf("=");
    if (separator <= 0) continue;
    const name = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1);
    if (!isStorablePlannotatorPreference(name, value)) continue;
    preferences[name] = value;
  }
  return preferences;
}

export function parseStoredPlannotatorPreferences(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
  const preferences: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded)) {
    if (Object.keys(preferences).length >= MAX_PLANNOTATOR_PREFERENCES) break;
    if (!isStorablePlannotatorPreference(name, value)) continue;
    preferences[name] = value;
  }
  return preferences;
}

/**
 * The store of record wins over the cookie jar, which is only still read so
 * preferences chosen before that store shipped survive.
 */
export function mergePlannotatorPreferences(
  cookiePreferences: Readonly<Record<string, string>>,
  storedPreferences: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...cookiePreferences, ...storedPreferences }).slice(
      0,
      MAX_PLANNOTATOR_PREFERENCES,
    ),
  );
}

export function plannotatorPreferenceFragment(
  preferences: Readonly<Record<string, string>>,
): string {
  return Object.keys(preferences).length === 0
    ? ""
    : `#t3-preferences=${encodeURIComponent(JSON.stringify(preferences))}`;
}

function plannotatorPreferenceStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readPlannotatorPreferences(): Record<string, string> {
  let stored: string | null = null;
  try {
    stored = plannotatorPreferenceStorage()?.getItem(PLANNOTATOR_PREFERENCE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return mergePlannotatorPreferences(
    plannotatorPreferencesFromCookieHeader(typeof document === "undefined" ? "" : document.cookie),
    parseStoredPlannotatorPreferences(stored),
  );
}

function persistPlannotatorPreference(write: PlannotatorPreferenceWrite): void {
  const storage = plannotatorPreferenceStorage();
  if (storage) {
    try {
      const preferences = readPlannotatorPreferences();
      if (write.deleted) delete preferences[write.name];
      else if (isStorablePlannotatorPreference(write.name, write.value))
        preferences[write.name] = write.value;
      storage.setItem(PLANNOTATOR_PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // A full or unavailable store must not break the review it belongs to.
    }
  }
  const cookie = normalizePlannotatorPreferenceCookie(
    `${write.name}=${write.value}${write.deleted ? "; max-age=0" : ""}`,
    typeof window !== "undefined" && window.location.protocol === "https:",
  );
  if (cookie && typeof document !== "undefined") document.cookie = cookie;
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
      value: plannotatorPreferenceFragment(readPlannotatorPreferences()),
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
      const write = parsePlannotatorPreferenceCookie(event.data.cookie);
      if (write) persistPlannotatorPreference(write);
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
