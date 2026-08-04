/**
 * T3-CUSTOM(expbkt3): Browser-owned Plannotator status polling. This module is
 * React-independent so cadence, terminal handling, and request serialization
 * remain deterministic under fake time.
 */
export type PlannotatorDecision = "approved" | "feedback" | "denied";
export type PlannotatorTerminalStatus = "exited" | "error";

export const PLANNOTATOR_CLIENT_ID_HEADER = "x-t3-plannotator-client-id";
export const PLANNOTATOR_VISIBLE_POLL_MS = 500;
export const PLANNOTATOR_HIDDEN_POLL_MS = 30_000;
export const PLANNOTATOR_REOPEN_GRACE_MS = 750;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface PlannotatorPollingControllerOptions {
  readonly url: `/plannotator/${string}/`;
  readonly clientId: string;
  readonly visible: boolean;
  readonly fetch?: Fetch;
  readonly onDecision: (decision: PlannotatorDecision) => void;
  readonly onTerminal: (status: PlannotatorTerminalStatus) => void;
}

export interface PlannotatorPollingController {
  readonly start: () => void;
  readonly setVisible: (visible: boolean) => void;
  readonly stop: () => void;
}

export function plannotatorStatusUrl(url: `/plannotator/${string}/`): string {
  return `${url}__t3/status`;
}

export function readPlannotatorDecision(value: unknown): PlannotatorDecision | null {
  if (!value || typeof value !== "object" || !("decision" in value)) return null;
  const decision = value.decision;
  return decision === "approved" || decision === "feedback" || decision === "denied"
    ? decision
    : null;
}

export function readPlannotatorTerminalStatus(value: unknown): PlannotatorTerminalStatus | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  return value.status === "exited" || value.status === "error" ? value.status : null;
}

export function createPlannotatorPollingController({
  url,
  clientId,
  visible: initiallyVisible,
  fetch: fetchStatus = globalThis.fetch.bind(globalThis),
  onDecision,
  onTerminal,
}: PlannotatorPollingControllerOptions): PlannotatorPollingController {
  let visible = initiallyVisible;
  let active = false;
  let inFlight = false;
  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  const clearScheduledPoll = () => {
    if (timeout === null) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const stop = () => {
    if (!active && timeout === null && abortController === null) return;
    active = false;
    generation += 1;
    clearScheduledPoll();
    abortController?.abort();
    abortController = null;
    inFlight = false;
  };

  const schedule = (delay: number, currentGeneration: number) => {
    if (!active || generation !== currentGeneration) return;
    clearScheduledPoll();
    timeout = setTimeout(() => {
      timeout = null;
      void poll(currentGeneration);
    }, delay);
  };

  const poll = async (currentGeneration: number) => {
    if (!active || inFlight || generation !== currentGeneration) return;
    inFlight = true;
    const requestAbortController = new AbortController();
    abortController = requestAbortController;
    let completed = false;
    try {
      const response = await fetchStatus(plannotatorStatusUrl(url), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { [PLANNOTATOR_CLIENT_ID_HEADER]: clientId },
        signal: requestAbortController.signal,
      });
      if (!active || generation !== currentGeneration || !response.ok) return;
      const payload: unknown = await response.json();
      if (!active || generation !== currentGeneration) return;

      const decision = readPlannotatorDecision(payload);
      if (decision !== null) {
        completed = true;
        active = false;
        generation += 1;
        clearScheduledPoll();
        onDecision(decision);
        return;
      }

      const terminal = readPlannotatorTerminalStatus(payload);
      if (terminal !== null) {
        completed = true;
        active = false;
        generation += 1;
        clearScheduledPoll();
        onTerminal(terminal);
      }
    } catch {
      // A review process can briefly restart while its proxy remains mounted.
    } finally {
      if (abortController === requestAbortController) abortController = null;
      if (generation === currentGeneration) inFlight = false;
      if (!completed && active && generation === currentGeneration) {
        schedule(
          visible ? PLANNOTATOR_VISIBLE_POLL_MS : PLANNOTATOR_HIDDEN_POLL_MS,
          currentGeneration,
        );
      }
    }
  };

  return {
    start: () => {
      if (active) return;
      active = true;
      generation += 1;
      const currentGeneration = generation;
      schedule(
        visible ? PLANNOTATOR_REOPEN_GRACE_MS : PLANNOTATOR_HIDDEN_POLL_MS,
        currentGeneration,
      );
    },
    setVisible: (nextVisible) => {
      if (visible === nextVisible) return;
      visible = nextVisible;
      if (!active || inFlight) return;
      clearScheduledPoll();
      if (visible) {
        void poll(generation);
      } else {
        schedule(PLANNOTATOR_HIDDEN_POLL_MS, generation);
      }
    },
    stop,
  };
}

export function releasePlannotatorClientLease({
  url,
  clientId,
  fetch: release = globalThis.fetch.bind(globalThis),
}: {
  readonly url: `/plannotator/${string}/`;
  readonly clientId: string;
  readonly fetch?: Fetch;
}): void {
  void release(plannotatorStatusUrl(url), {
    method: "DELETE",
    cache: "no-store",
    credentials: "same-origin",
    headers: { [PLANNOTATOR_CLIENT_ID_HEADER]: clientId },
    keepalive: true,
  }).catch(() => undefined);
}
