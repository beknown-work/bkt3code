/**
 * BootstrapStepper - live checklist shown while a new thread bootstraps.
 *
 * Renders the ordered stages (create → worktree → setup → start) with a per-step
 * status glyph so the ~15s bootstrap reads as progress instead of a frozen
 * "Working…". Pure presentation — see BootstrapStepper.logic for derivation.
 *
 * @module components/chat/BootstrapStepper
 */
import { CheckIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import type { BootstrapStep } from "./BootstrapStepper.logic";

function StepGlyph({ status }: { status: BootstrapStep["status"] }) {
  switch (status) {
    case "done":
      return <CheckIcon className="size-3 text-muted-foreground/70" aria-hidden />;
    case "active":
      return <Spinner className="size-3 text-foreground/70" />;
    case "error":
      return <TriangleAlertIcon className="size-3 text-destructive" aria-hidden />;
    case "pending":
      return (
        <span className="inline-block size-1 rounded-full bg-muted-foreground/30" aria-hidden />
      );
  }
}

export function BootstrapStepper({ steps }: { steps: ReadonlyArray<BootstrapStep> }) {
  if (steps.length === 0) {
    return null;
  }
  return (
    <div className="py-0.5 pl-1.5">
      <ul className="flex flex-col gap-1.5 pt-1 text-[11px] tabular-nums">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            <span className="inline-flex size-3 items-center justify-center">
              <StepGlyph status={step.status} />
            </span>
            <span
              className={cn(
                step.status === "done" && "text-muted-foreground/60",
                step.status === "active" && "text-foreground/80",
                step.status === "pending" && "text-muted-foreground/40",
                step.status === "error" && "text-destructive",
              )}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
