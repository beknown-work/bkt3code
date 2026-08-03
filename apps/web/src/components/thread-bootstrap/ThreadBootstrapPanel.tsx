// T3-CUSTOM(expbkt3): durable new-thread readiness checklist.
import type { EnvironmentId, ThreadBootstrapProgress, WorktreeBaseRef } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { WorktreeBaseRefSelect } from "./WorktreeBaseRefSelect";

const DEFAULT_REPLACEMENT_BASE_REF: WorktreeBaseRef = {
  kind: "repository-default",
  source: "origin",
};

export interface ThreadBootstrapPanelProps {
  readonly bootstrap: ThreadBootstrapProgress;
  readonly onShowOutput: (terminalId: string) => void;
  readonly onRetry: (step: "worktree" | "setup", baseRef?: WorktreeBaseRef) => void;
  readonly onStop: () => void;
  readonly onContinue: () => void;
  readonly baseRefTarget?: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly initialValue: WorktreeBaseRef;
  };
}

function statusIcon(status: ThreadBootstrapProgress["setup"]["status"]) {
  if (status === "succeeded" || status === "skipped" || status === "bypassed") {
    return <CheckIcon className="size-4 text-success-foreground" aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlertIcon className="size-4 text-destructive" aria-hidden />;
  }
  if (status === "running") {
    return <CircleIcon className="size-3.5 fill-current text-primary" aria-hidden />;
  }
  return <CircleIcon className="size-3.5 text-muted-foreground" aria-hidden />;
}

function statusLabel(
  step: "worktree" | "setup" | "agent",
  status: ThreadBootstrapProgress["setup"]["status"],
) {
  if (step === "worktree" && status === "skipped") return "Using project directory";
  if (step === "setup" && status === "skipped") return "No setup script configured";
  if (step === "setup" && status === "bypassed") return "Setup bypassed";
  if (step === "agent" && status === "skipped") return "Workspace ready";
  if (status === "succeeded") {
    return step === "worktree"
      ? "Worktree created"
      : step === "setup"
        ? "Setup script completed"
        : "Agent started";
  }
  const action =
    step === "worktree"
      ? "Creating worktree"
      : step === "setup"
        ? "Running setup script"
        : "Starting agent";
  if (status === "failed") {
    return step === "worktree"
      ? "Worktree creation failed"
      : step === "setup"
        ? "Setup script failed"
        : "Agent startup failed";
  }
  if (status === "running") return `${action}…`;
  return action;
}

export function ThreadBootstrapPanel({
  bootstrap,
  onShowOutput,
  onRetry,
  onStop,
  onContinue,
  baseRefTarget,
}: ThreadBootstrapPanelProps) {
  const [expanded, setExpanded] = useState(bootstrap.status !== "ready");
  const [changingBaseRef, setChangingBaseRef] = useState(false);
  const [replacementBaseRef, setReplacementBaseRef] = useState<WorktreeBaseRef>(
    baseRefTarget?.initialValue ?? DEFAULT_REPLACEMENT_BASE_REF,
  );
  useEffect(() => {
    if (bootstrap.status !== "ready") setExpanded(true);
  }, [bootstrap.status]);
  useEffect(() => {
    setChangingBaseRef(false);
    setReplacementBaseRef(baseRefTarget?.initialValue ?? DEFAULT_REPLACEMENT_BASE_REF);
  }, [baseRefTarget?.initialValue, bootstrap.id]);

  const terminalId = bootstrap.setup.terminalId;
  return (
    <section
      aria-label="Workspace preparation"
      className="chat-composer-horizontal-inset relative z-10 mx-auto w-full max-w-3xl pt-3"
    >
      <div className="rounded-xl border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-sm font-medium"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
          {bootstrap.status === "ready" ? "Workspace ready" : "Preparing workspace"}
        </button>

        {expanded ? (
          <div className="mt-2 space-y-2 border-t pt-2">
            {(["worktree", "setup", "agent"] as const).map((step) => {
              const value = bootstrap[step];
              return (
                <div key={step}>
                  <div className="flex min-h-7 items-center gap-2 text-sm">
                    {statusIcon(value.status)}
                    <span className="min-w-0 flex-1">{statusLabel(step, value.status)}</span>
                    {step === "setup" && terminalId ? (
                      <Button size="xs" variant="ghost" onClick={() => onShowOutput(terminalId)}>
                        <TerminalIcon className="size-3.5" />
                        Show output
                      </Button>
                    ) : null}
                  </div>
                  {value.status === "failed" && value.error ? (
                    <p className="pl-6 text-xs text-destructive">{value.error}</p>
                  ) : null}
                </div>
              );
            })}

            {bootstrap.setup.status === "running" ? (
              <div className="flex items-center justify-between gap-2 pl-6 text-xs text-muted-foreground">
                <span>Interactive prompts can be answered in the terminal.</span>
                <Button size="xs" variant="outline" onClick={onStop}>
                  <SquareIcon className="size-3" />
                  Stop setup
                </Button>
              </div>
            ) : null}
            {bootstrap.setup.status === "failed" ? (
              <div className="flex flex-wrap justify-end gap-1.5 pl-6">
                <Button size="xs" variant="outline" onClick={() => onRetry("setup")}>
                  Retry
                </Button>
                <Button size="xs" onClick={onContinue}>
                  Continue anyway
                </Button>
              </div>
            ) : null}
            {bootstrap.worktree.status === "failed" ? (
              <div className="space-y-2 pl-6">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => onRetry("worktree")}>
                    Retry
                  </Button>
                  {baseRefTarget ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setChangingBaseRef((value) => !value)}
                    >
                      Change base ref
                    </Button>
                  ) : null}
                </div>
                {changingBaseRef && baseRefTarget ? (
                  <div className="ml-auto grid max-w-sm gap-1.5 rounded-md border bg-background p-2">
                    <WorktreeBaseRefSelect
                      environmentId={baseRefTarget.environmentId}
                      workspaceRoot={baseRefTarget.workspaceRoot}
                      value={replacementBaseRef}
                      includeInherit={false}
                      ariaLabel="Replacement worktree base ref"
                      onValueChange={(value) => {
                        if (value) setReplacementBaseRef(value);
                      }}
                    />
                    <Button
                      size="xs"
                      onClick={() => {
                        setChangingBaseRef(false);
                        onRetry("worktree", replacementBaseRef);
                      }}
                    >
                      Retry with selected ref
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
