/** A deliberately quiet boundary between idle lifecycle groups and live work. */
export function RunningSessionDivider() {
  return (
    <div
      role="separator"
      aria-label="Running agents"
      className="mb-2 flex items-center gap-2 px-2 pt-0.5"
      data-testid="phase-sidebar-running-divider"
    >
      <span className="h-px flex-1 bg-sidebar-border/45" />
      <span className="text-[8px] font-medium uppercase tracking-[0.14em] text-muted-foreground/35">
        Running
      </span>
      <span className="h-px flex-1 bg-sidebar-border/45" />
    </div>
  );
}
