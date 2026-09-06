import type { ThreadExecutionIntentBootstrap } from "@t3tools/contracts";

export function DurableBootstrapStatus({
  bootstrap,
}: {
  readonly bootstrap: ThreadExecutionIntentBootstrap;
}) {
  const preparing = bootstrap.worktreePhase === "pending" || bootstrap.worktreePhase === "running";
  const setupRunning = bootstrap.setupPhase === "pending" || bootstrap.setupPhase === "running";
  const failed = bootstrap.worktreePhase === "failed" || bootstrap.setupPhase === "failed";
  const worktreeUncertain = bootstrap.worktreePhase === "uncertain";
  const setupUncertain = bootstrap.setupPhase === "uncertain";
  if (!preparing && !setupRunning && !failed && !worktreeUncertain && !setupUncertain) return null;

  return (
    <div className="border-b border-border/60 bg-muted/30 px-4 py-2 text-muted-foreground text-sm">
      <span className="font-medium text-foreground">New worktree</span>
      {failed
        ? ` setup failed${bootstrap.failureDetail ? `: ${bootstrap.failureDetail}` : "."}`
        : worktreeUncertain
          ? " preparation status is uncertain."
          : setupUncertain
            ? " setup status is uncertain."
            : preparing
              ? " is being prepared."
              : " setup is running."}
    </div>
  );
}
