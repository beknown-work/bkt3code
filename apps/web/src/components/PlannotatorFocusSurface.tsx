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
  onClose: () => void;
  onDecision: (decision: PlannotatorDecision) => void;
}

const PLANNOTATOR_STATUS_POLL_MS = 500;
const PLANNOTATOR_REOPEN_GRACE_MS = 750;

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

export const PlannotatorFocusSurface = memo(function PlannotatorFocusSurface({
  url,
  onClose,
  onDecision,
}: PlannotatorFocusSurfaceProps) {
  const handledDecisionRef = useRef<PlannotatorDecision | null>(null);

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

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-plannotator-focus-surface
    >
      <iframe
        key={url}
        src={`${url}?t3-reopen=1`}
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
