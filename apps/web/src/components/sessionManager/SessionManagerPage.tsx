/**
 * T3-CUSTOM(expbkt3): Bulk session manager — a full-screen table of every
 * session with rich filters, multi-row selection and a bulk-action toolbar.
 *
 * The sidebar is built for *navigating* a handful of sessions; this page is
 * built for *administering* 10–100+ of them at once. It therefore reuses the
 * sidebar's row derivation wholesale (phase, attention, priority, repository
 * and provider keys all come from `PhaseGroupedSidebar.logic`) and adds only
 * what a table needs: column sorting, a selection model, and fan-out actions.
 *
 * All non-visual decisions live in `SessionManagerPage.logic.ts`.
 */
import { LegendList } from "@legendapp/list/react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadLastActivityAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ScopedThreadRef, ThreadPriority } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): memorable worktree codenames.
import { resolveWorktreeCodename } from "@t3tools/shared/worktreeCodename";
import { useRouter } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArchiveIcon,
  BellIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  FilterIcon,
  FlagIcon,
  GitBranchIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  OctagonPauseIcon,
  PinIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { cn } from "../../lib/utils";
import { useSessionManagerFilterStore } from "../../sessionManagerFilterStore";
import { useSessionManagerSelectionStore } from "../../sessionManagerSelectionStore";
import {
  useProjects,
  useServerConfigs,
  useAllEnvironmentShellsBootstrapped,
  useThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { userManagementEnvironment } from "../../state/users";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { Project, ThreadShell } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import {
  buildPhaseSidebarRepositoryOptions,
  derivePhaseSidebarRepositoryKey,
  formatThreadPriority,
  phaseSidebarPriorityRank,
  resolvePhaseSidebarAttentionKind,
  resolvePhaseSidebarPhase,
  PHASE_SIDEBAR_PHASES,
  PHASE_SIDEBAR_UNPRIORITISED_RANK,
  type PhaseSidebarAttentionKind,
  type PhaseSidebarPhaseId,
} from "../sidebar/PhaseGroupedSidebar.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SESSION_MANAGER_ATTENTION_KINDS,
  SESSION_MANAGER_ATTENTION_LABELS,
  SESSION_MANAGER_LIFECYCLES,
  SESSION_MANAGER_PHASE_LABELS,
  SESSION_MANAGER_PRIORITY_CHOICES,
  SESSION_MANAGER_SAVED_VIEWS,
  SESSION_MANAGER_STAGE_LABELS,
  SESSION_MANAGER_STALE_DAY_CHOICES,
  applyFrozenRowOrder,
  buildSessionManagerCounts,
  buildSessionManagerFilterChips,
  buildSessionManagerSearchText,
  clampWorkSummaryPercent,
  filterSessionManagerRows,
  hasActiveSessionManagerFilters,
  planSessionManagerAction,
  sortSessionManagerRows,
  workSummaryPreview,
  type SessionManagerFilters,
  type SessionManagerLifecycle,
  type SessionManagerRow,
  type SessionManagerSortColumn,
} from "./SessionManagerPage.logic";

/**
 * One grid template shared by the sticky header and every row. A real
 * `<table>` cannot be virtualized without losing column sync, so the table is
 * a CSS grid and this constant is the single source of column geometry.
 */
const COLUMN_TEMPLATE =
  "34px minmax(260px,2.3fr) 140px 112px 44px 168px minmax(220px,2fr) 110px 76px 32px";

const STALE_VIEW_DAYS = 7;

/** Concurrency for the two LLM-backed bulk actions. */
const LLM_BULK_CONCURRENCY = 3;

type RowPendingKind = "title" | "summary";

interface BulkRunState {
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

/* ------------------------------- concurrency ------------------------------ */

/**
 * Run `worker` over `items` with at most `limit` in flight. The repo has no
 * shared concurrency helper (the runtime serializes per thread but not across
 * threads), and firing 100 LLM requests at once would trip provider rate
 * limits, so the two generative actions are bounded here.
 */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

type CommandOutcome =
  | { readonly status: "success" }
  | { readonly status: "interrupted" }
  | { readonly status: "failure"; readonly error: unknown };

function toOutcome(result: AtomCommandResult<unknown, unknown>): CommandOutcome {
  if (result._tag !== "Failure") return { status: "success" };
  if (isAtomCommandInterrupted(result)) return { status: "interrupted" };
  return { status: "failure", error: squashAtomCommandFailure(result) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** One aggregate toast at the end of a run, never one per row. */
function reportBulkOutcome(
  label: string,
  outcomes: ReadonlyArray<CommandOutcome>,
  attempted: number,
): void {
  const succeeded = outcomes.filter((outcome) => outcome.status === "success").length;
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "failure" ? [outcome.error] : [],
  );
  if (succeeded === 0 && failures.length === 0) return;
  if (succeeded === 0) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `${label} failed`,
        description: describeError(failures[0]),
      }),
    );
    return;
  }
  toastManager.add(
    stackedThreadToast({
      type: failures.length > 0 ? "warning" : "success",
      title:
        failures.length > 0
          ? `${label}: ${succeeded} of ${attempted} sessions`
          : `${label} — ${succeeded} session${succeeded === 1 ? "" : "s"}`,
      description:
        failures.length > 0
          ? `${failures.length} session${failures.length === 1 ? "" : "s"} failed: ${describeError(failures[0])}`
          : undefined,
      timeout: 6_000,
    }),
  );
}

/* ---------------------------------- chips --------------------------------- */

const PHASE_TONE: Record<PhaseSidebarPhaseId, string> = {
  needs_input: "text-warning-foreground bg-warning-surface",
  plan_ready: "text-info-foreground bg-info/10",
  ready: "text-muted-foreground bg-muted",
  planning: "text-info-foreground bg-info/10",
  implementing: "text-primary bg-primary/10",
};

function PhaseBadge({ phaseId }: { phaseId: PhaseSidebarPhaseId }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        PHASE_TONE[phaseId],
      )}
    >
      {SESSION_MANAGER_PHASE_LABELS[phaseId]}
    </span>
  );
}

const PRIORITY_TONE = [
  "text-error-foreground bg-error-surface",
  "text-warning-foreground bg-warning-surface",
  "text-foreground bg-muted",
  "text-muted-foreground bg-muted",
  "text-muted-foreground bg-transparent",
];

function PriorityBadge({ rank }: { rank: number }) {
  if (rank >= PHASE_SIDEBAR_UNPRIORITISED_RANK) {
    return <span className="text-muted-foreground/50 font-mono text-[10px]">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1 py-0.5 font-mono text-[10px] font-semibold",
        PRIORITY_TONE[rank],
      )}
    >
      {formatThreadPriority(rank)}
    </span>
  );
}

const STAGE_TONE: Record<string, string> = {
  planning: "bg-info",
  implementing: "bg-primary",
  blocked: "bg-error",
  "awaiting-review": "bg-warning",
  done: "bg-success",
};

function LifecycleIcon({ row }: { row: SessionManagerRow }) {
  if (row.lifecycle === "archived") {
    return <ArchiveIcon aria-label="Archived" className="text-muted-foreground size-3.5" />;
  }
  if (row.lifecycle === "snoozed") {
    return <ClockIcon aria-label="Snoozed" className="text-info size-3.5" />;
  }
  if (row.attentionKind === "error") {
    return <AlertTriangleIcon aria-label="Error" className="text-error size-3.5" />;
  }
  if (row.attentionKind === "approval") {
    return <BellIcon aria-label="Waiting for approval" className="text-warning size-3.5" />;
  }
  if (row.attentionKind === "input") {
    return <MessageSquarePlusIcon aria-label="Waiting for input" className="text-info size-3.5" />;
  }
  if (row.phaseId === "planning" || row.phaseId === "implementing") {
    return <Spinner className="text-primary size-3.5" />;
  }
  if (row.lifecycle === "settled") {
    return <CheckCircle2Icon aria-label="Settled" className="text-success size-3.5" />;
  }
  return <span className="bg-muted-foreground/30 size-1.5 shrink-0 rounded-full" />;
}

/* --------------------------------- facets --------------------------------- */

interface FacetOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
}

function FacetPopover<T extends string | number>({
  label,
  icon: Icon,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  icon: typeof FilterIcon;
  options: ReadonlyArray<FacetOption<T>>;
  selected: ReadonlyArray<T>;
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs whitespace-nowrap transition-colors",
          selected.length > 0
            ? "border-primary/40 bg-primary/10 text-foreground"
            : "border-border bg-card text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-3.5" />
        {label}
        {selected.length > 0 ? (
          <span className="bg-primary text-primary-foreground rounded px-1 font-mono text-[10px]">
            {selected.length}
          </span>
        ) : (
          <ChevronDownIcon className="size-3 opacity-50" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-64 p-0" viewportClassName="p-0">
        {options.length > 8 ? (
          <div className="border-border border-b p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Filter ${label.toLowerCase()}…`}
              className="placeholder:text-muted-foreground h-6 w-full bg-transparent px-1 text-xs outline-none"
            />
          </div>
        ) : null}
        <div className="max-h-72 overflow-y-auto py-1">
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-2 text-xs">No matches.</p>
          ) : null}
          {visible.map((option) => {
            const active = selected.includes(option.value);
            return (
              <button
                key={String(option.value)}
                type="button"
                onClick={() => onToggle(option.value)}
                className="hover:bg-accent flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
              >
                <Checkbox
                  checked={active}
                  aria-label={option.label}
                  onCheckedChange={() => onToggle(option.value)}
                  className="pointer-events-none"
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.count !== undefined ? (
                  <span className="text-muted-foreground font-mono text-[10px]">
                    {option.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {selected.length > 0 ? (
          <div className="border-border border-t p-1">
            <Button variant="ghost" size="xs" className="w-full justify-start" onClick={onClear}>
              Clear {label.toLowerCase()}
            </Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/* ---------------------------------- cells --------------------------------- */

function WorkSummaryProgressCell({ row, pending }: { row: SessionManagerRow; pending: boolean }) {
  const summary = row.workSummary;
  if (pending || summary?.status === "pending") {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        <Spinner className="size-3" /> Summarizing…
      </span>
    );
  }
  if (summary?.status === "error") {
    return <span className="text-muted-foreground/60 text-[11px]">—</span>;
  }
  if (summary == null || summary.stage === null) {
    return <span className="text-muted-foreground/60 text-[11px]">—</span>;
  }
  const percent = clampWorkSummaryPercent(summary.percent);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium whitespace-nowrap">
          {SESSION_MANAGER_STAGE_LABELS[summary.stage]}
        </span>
        {percent !== null ? (
          <span className="text-muted-foreground font-mono text-[10px]">{percent}%</span>
        ) : null}
      </div>
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full", STAGE_TONE[summary.stage])}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function WorkSummaryTextCell({
  row,
  pending,
  onToggleExpanded,
}: {
  row: SessionManagerRow;
  pending: boolean;
  onToggleExpanded: () => void;
}) {
  const summary = row.workSummary;
  if (pending || summary?.status === "pending") {
    return (
      <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <Spinner className="size-3" /> Summarizing…
      </span>
    );
  }
  if (summary?.status === "error") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="text-error-foreground bg-error-surface inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px]" />
          }
        >
          <AlertTriangleIcon className="size-3 shrink-0" />
          Summary failed
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80">
          {summary.error ?? "The server did not report a reason."}
        </TooltipPopup>
      </Tooltip>
    );
  }
  const preview = workSummaryPreview(summary?.summary);
  if (preview === null) {
    return <span className="text-muted-foreground/60 text-[11px]">no summary yet</span>;
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggleExpanded();
      }}
      className="text-muted-foreground hover:text-foreground w-full truncate text-left text-[11px]"
      aria-label={preview}
    >
      {preview}
    </button>
  );
}

/* ---------------------------------- rows ---------------------------------- */

interface RowActions {
  readonly onOpen: (row: SessionManagerRow) => void;
  readonly onToggleSelection: (row: SessionManagerRow, event: React.MouseEvent) => void;
  readonly onToggleExpanded: (key: string) => void;
  readonly onRetitle: (rows: ReadonlyArray<SessionManagerRow>) => void;
  readonly onSummarize: (rows: ReadonlyArray<SessionManagerRow>) => void;
  readonly onSettle: (rows: ReadonlyArray<SessionManagerRow>) => void;
  readonly onArchive: (rows: ReadonlyArray<SessionManagerRow>) => void;
  readonly onDelete: (rows: ReadonlyArray<SessionManagerRow>) => void;
}

const SessionManagerTableRow = memo(function SessionManagerTableRow({
  row,
  selected,
  expanded,
  dense,
  pending,
  actions,
}: {
  row: SessionManagerRow;
  selected: boolean;
  expanded: boolean;
  dense: boolean;
  pending: RowPendingKind | undefined;
  actions: RowActions;
}) {
  const summary = row.workSummary;
  const summaryFailed = summary?.status === "error";
  return (
    <div className="border-border/60 border-b">
      <div
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            actions.onToggleSelection(row, event);
            return;
          }
          actions.onOpen(row);
        }}
        className={cn(
          "group grid cursor-default items-center gap-2 px-4 transition-colors",
          dense ? "py-1.5" : "py-2",
          selected ? "bg-primary/10" : "hover:bg-accent/50",
        )}
        style={{ gridTemplateColumns: COLUMN_TEMPLATE }}
      >
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected}
            aria-label={`Select ${row.thread.title}`}
            onCheckedChange={() => undefined}
            onClick={(event) => actions.onToggleSelection(row, event)}
          />
        </span>

        <div className="flex min-w-0 items-center gap-2">
          <LifecycleIcon row={row} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {row.isUnreadCompletion ? (
                <span className="bg-primary size-1.5 shrink-0 rounded-full" />
              ) : null}
              {row.isPinned ? (
                <PinIcon className="text-muted-foreground size-3 shrink-0" aria-label="Pinned" />
              ) : null}
              <span
                className={cn(
                  "truncate text-xs",
                  row.isUnreadCompletion ? "font-semibold" : "font-medium",
                  pending === "title" && "text-muted-foreground italic",
                )}
              >
                {pending === "title" ? "Regenerating title…" : row.thread.title}
              </span>
              {pending === "title" ? <Spinner className="text-primary size-3 shrink-0" /> : null}
            </div>
            {!dense ? (
              <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-[10px]">
                {row.thread.branch !== null ? (
                  <span className="truncate font-mono">{row.thread.branch}</span>
                ) : null}
                {row.thread.linearIssueUrl ? (
                  <span className="shrink-0 truncate">{row.thread.linearIssueUrl}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <span className="text-muted-foreground truncate text-[11px]">{row.repositoryLabel}</span>
        <span>
          <PhaseBadge phaseId={row.phaseId} />
        </span>
        <span>
          <PriorityBadge rank={row.priorityRank} />
        </span>

        <div className="min-w-0">
          <WorkSummaryProgressCell row={row} pending={pending === "summary"} />
        </div>

        <div className="min-w-0">
          <WorkSummaryTextCell
            row={row}
            pending={pending === "summary"}
            onToggleExpanded={() => actions.onToggleExpanded(row.key)}
          />
        </div>

        <span className="text-muted-foreground truncate text-[11px]">{row.modelLabel}</span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {row.lastActivityAt === null ? "—" : formatRelativeTimeLabel(row.lastActivityAt)}
        </span>

        <div
          className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <Menu>
            <MenuTrigger
              aria-label={`Actions for ${row.thread.title}`}
              className="hover:bg-accent rounded p-0.5"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              <MenuItem onClick={() => actions.onOpen(row)}>
                <ExternalLinkIcon /> Open session
              </MenuItem>
              <MenuItem
                disabled={!row.capabilities.titleRegeneration}
                onClick={() => actions.onRetitle([row])}
              >
                <RefreshCwIcon /> Regenerate title
              </MenuItem>
              <MenuItem
                disabled={!row.capabilities.workSummary}
                onClick={() => actions.onSummarize([row])}
              >
                <SparklesIcon /> {summaryFailed ? "Retry summary" : "Summarize"}
              </MenuItem>
              <MenuItem
                disabled={!row.capabilities.settlement}
                onClick={() => actions.onSettle([row])}
              >
                <CheckCircle2Icon /> Settle
              </MenuItem>
              <MenuItem onClick={() => actions.onArchive([row])}>
                <ArchiveIcon /> Archive
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => actions.onDelete([row])}>
                <Trash2Icon /> Delete…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {expanded ? (
        <div className="bg-muted/40 border-border/60 grid gap-4 border-t px-4 py-3 text-[11px] md:grid-cols-[1.6fr_1fr]">
          <div>
            <p className="text-muted-foreground mb-1 flex items-center gap-1.5 font-medium">
              <SparklesIcon className="size-3" /> AI work summary
              {summary !== null ? (
                <span className="text-muted-foreground/70">
                  · {formatRelativeTimeLabel(summary.updatedAt)}
                </span>
              ) : null}
            </p>
            <p className="leading-relaxed">
              {summary?.summary ?? summary?.error ?? "No summary has been generated yet."}
            </p>
            {summary?.remaining ? (
              <p className="mt-2">
                <span className="text-muted-foreground">Remaining: </span>
                {summary.remaining}
              </p>
            ) : null}
          </div>
          <div className="text-muted-foreground space-y-1">
            <p>
              <span className="inline-block w-20">Owner</span>
              <span className="text-foreground">{row.ownerLabel}</span>
            </p>
            <p>
              <span className="inline-block w-20">Created</span>
              <span className="text-foreground">
                {formatRelativeTimeLabel(row.thread.createdAt)}
              </span>
            </p>
            {/* T3-CUSTOM(expbkt3): lead with the codename; the path is the detail. */}
            <p>
              <span className="inline-block w-20">Worktree</span>
              <span className="text-foreground">
                {row.thread.worktreePath === null
                  ? "—"
                  : resolveWorktreeCodename(row.thread.worktreePath)}
              </span>
            </p>
            {row.thread.worktreePath === null ? null : (
              <p>
                <span className="inline-block w-20" />
                <span className="text-muted-foreground font-mono text-[10px] break-all">
                  {row.thread.worktreePath}
                </span>
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
});

/* ---------------------------------- page ---------------------------------- */

export function SessionManagerPage() {
  const router = useRouter();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  // `useNowMinute` yields "YYYY-MM-DDTHH:MM", which Date.parse reads as LOCAL
  // time. Re-anchor it to UTC so the idle-for filter measures real elapsed
  // time rather than the viewer's offset.
  const nowIso = useMemo(() => `${nowMinute}:00.000Z`, [nowMinute]);

  const filters = useSessionManagerFilterStore(
    useShallow((state): SessionManagerFilters => ({
      search: state.search,
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      priorities: state.priorities,
      attentionKinds: state.attentionKinds,
      ownerUserIds: state.ownerUserIds,
      lifecycles: state.lifecycles,
      staleDays: state.staleDays,
    })),
  );
  const sort = useSessionManagerFilterStore((state) => state.sort);
  const activeViewId = useSessionManagerFilterStore((state) => state.activeViewId);
  const filterActions = useSessionManagerFilterStore(
    useShallow((state) => ({
      setSearch: state.setSearch,
      toggleRepository: state.toggleRepository,
      togglePhase: state.togglePhase,
      toggleProvider: state.toggleProvider,
      togglePriority: state.togglePriority,
      toggleAttention: state.toggleAttention,
      toggleOwner: state.toggleOwner,
      toggleLifecycle: state.toggleLifecycle,
      setStaleDays: state.setStaleDays,
      setFacet: state.setFacet,
      cycleSort: state.cycleSort,
      applyView: state.applyView,
      clearAll: state.clearAll,
      reconcile: state.reconcile,
    })),
  );

  const selectedThreadKeys = useSessionManagerSelectionStore((state) => state.selectedThreadKeys);
  const selectionActions = useSessionManagerSelectionStore(
    useShallow((state) => ({
      toggleThread: state.toggleThread,
      rangeSelectTo: state.rangeSelectTo,
      replaceSelection: state.replaceSelection,
      clearSelection: state.clearSelection,
      removeFromSelection: state.removeFromSelection,
      pruneSelection: state.pruneSelection,
    })),
  );

  const [dense, setDense] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingByKey, setPendingByKey] = useState<ReadonlyMap<string, RowPendingKind>>(
    () => new Map(),
  );
  const [bulkRun, setBulkRun] = useState<BulkRunState | null>(null);
  const [deleteDialogRows, setDeleteDialogRows] = useState<ReadonlyArray<SessionManagerRow> | null>(
    null,
  );
  const frozenOrderRef = useRef<ReadonlyArray<string> | null>(null);

  const { archiveThread, settleThread, snoozeThread, pinThread, unpinThread, deleteThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const requestWorkSummary = useAtomCommand(threadEnvironment.requestWorkSummary, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });

  /* ------------------------------ archived rows ----------------------------- */

  const includeArchived = filters.lifecycles.includes("archived");
  const archivedEnvironmentIds = useMemo<ReadonlyArray<EnvironmentId>>(() => {
    if (!includeArchived) return EMPTY_ENVIRONMENT_IDS;
    return [...new Set(projects.map((project) => project.environmentId))];
  }, [includeArchived, projects]);
  const { snapshots: archivedSnapshots } = useArchivedThreadSnapshots(archivedEnvironmentIds);
  const archivedThreads = useMemo<ReadonlyArray<ThreadShell>>(
    () =>
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.threads.map((thread) => ({ ...thread, environmentId })),
      ),
    [archivedSnapshots],
  );

  /* -------------------------------- directory ------------------------------- */

  // Owner labels are best-effort: the directory RPC only answers in team mode,
  // and a raw Clerk id is still a usable (if ugly) facet value without it.
  const directoryQuery = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : userManagementEnvironment.directory({ environmentId: primaryEnvironmentId, input: {} }),
  );
  const ownerLabelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const user of directoryQuery.data?.users ?? []) {
      const label = user.displayName ?? user.primaryEmail ?? String(user.id);
      labels.set(String(user.id), label);
      labels.set(String(user.identity.subject), label);
    }
    return labels;
  }, [directoryQuery.data]);

  /* --------------------------------- rows ---------------------------------- */

  const projectByKey = useMemo(
    () =>
      new Map<string, Project>(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [projects],
  );
  const repositoryOptions = useMemo(() => buildPhaseSidebarRepositoryOptions(projects), [projects]);
  const repositoryLabels = useMemo(
    () => new Map(repositoryOptions.map((option) => [option.key, option.label])),
    [repositoryOptions],
  );

  const allRows = useMemo<ReadonlyArray<SessionManagerRow>>(() => {
    const source = includeArchived ? [...threads, ...archivedThreads] : threads;
    const seen = new Set<string>();
    const rows: SessionManagerRow[] = [];
    for (const thread of source) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      // The archived snapshot and the live shell can both carry a thread that
      // was archived a moment ago; the live one wins.
      if (seen.has(key)) continue;
      seen.add(key);

      const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const project = projectByKey.get(projectKey);
      const repositoryKey = project ? derivePhaseSidebarRepositoryKey(project) : projectKey;
      const serverConfig = serverConfigs.get(thread.environmentId);
      const capabilitiesRaw = serverConfig?.environment.capabilities;
      // `threadWorkSummary` is newer than this page; a server that does not
      // advertise it either way is assumed capable so the action is not dead
      // on arrival, and a server that says `false` disables it explicitly.
      const workSummaryCapable =
        (capabilitiesRaw as { readonly threadWorkSummary?: boolean } | undefined)
          ?.threadWorkSummary !== false;
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const provider = serverConfig?.providers.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      const providerKind = String(provider?.driver ?? instanceId);
      const providerName =
        provider?.displayName ?? thread.session?.providerName ?? String(instanceId);
      const repositoryLabel =
        project?.title ?? repositoryLabels.get(repositoryKey) ?? "Unknown repository";
      const workSummary = thread.workSummary ?? null;
      const ownerUserId = thread.ownerUserId === null ? null : String(thread.ownerUserId);

      const snoozed =
        capabilitiesRaw?.threadSnooze === true && effectiveSnoozed(thread, { now: nowIso });
      const settled =
        capabilitiesRaw?.threadSettlement === true &&
        effectiveSettled(thread, { now: nowIso, autoSettleAfterDays });
      const lifecycle: SessionManagerLifecycle =
        thread.archivedAt !== null
          ? "archived"
          : snoozed
            ? "snoozed"
            : settled
              ? "settled"
              : "active";

      rows.push({
        key,
        thread,
        lifecycle,
        phaseId: resolvePhaseSidebarPhase(thread, null),
        attentionKind: resolvePhaseSidebarAttentionKind(thread),
        repositoryKey,
        repositoryLabel,
        providerKind,
        providerName,
        modelLabel: String(thread.modelSelection.model),
        ownerUserId,
        ownerLabel:
          ownerUserId === null ? "Unassigned" : (ownerLabelById.get(ownerUserId) ?? ownerUserId),
        priorityRank: phaseSidebarPriorityRank(thread),
        lastActivityAt: threadLastActivityAt(thread) ?? thread.updatedAt,
        isUnreadCompletion: hasUnseenCompletion({
          ...thread,
          lastVisitedAt: lastVisitedAtByThreadKey[key],
        }),
        isPinned: thread.pinnedAt != null,
        workSummary,
        capabilities: {
          settlement: capabilitiesRaw?.threadSettlement === true,
          snooze: capabilitiesRaw?.threadSnooze === true,
          pinning: capabilitiesRaw?.threadPinning === true,
          priority: capabilitiesRaw?.threadPriority === true,
          titleRegeneration: capabilitiesRaw?.threadTitleRegeneration === true,
          workSummary: workSummaryCapable,
        },
        canStop: thread.execution?.canStop === true,
        searchText: buildSessionManagerSearchText({
          title: thread.title,
          branch: thread.branch,
          repositoryLabel,
          worktreePath: thread.worktreePath,
          summary: workSummary?.summary ?? null,
          remaining: workSummary?.remaining ?? null,
          linearIssueUrl: thread.linearIssueUrl,
          providerName,
          model: String(thread.modelSelection.model),
        }),
      });
    }
    return rows;
  }, [
    archivedThreads,
    autoSettleAfterDays,
    includeArchived,
    lastVisitedAtByThreadKey,
    nowIso,
    ownerLabelById,
    projectByKey,
    repositoryLabels,
    serverConfigs,
    threads,
  ]);

  const counts = useMemo(
    () => buildSessionManagerCounts(allRows, { now: nowIso, staleDays: STALE_VIEW_DAYS }),
    [allRows, nowIso],
  );

  const sortedRows = useMemo(
    () => sortSessionManagerRows(filterSessionManagerRows(allRows, filters, { now: nowIso }), sort),
    [allRows, filters, nowIso, sort],
  );

  // Freeze order while a selection is live so a bulk run cannot move a row out
  // from under the cursor. Cleared the moment the selection empties.
  const hasSelection = selectedThreadKeys.size > 0;
  const rows = useMemo(() => {
    if (!hasSelection) {
      frozenOrderRef.current = null;
      return sortedRows;
    }
    // Snapshot the order the user selected against, then keep serving it until
    // the selection empties. Content still updates live; only position is held.
    frozenOrderRef.current ??= sortedRows.map((row) => row.key);
    return applyFrozenRowOrder(sortedRows, frozenOrderRef.current);
  }, [sortedRows, hasSelection]);

  const visibleKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedThreadKeys.has(row.key)),
    [rows, selectedThreadKeys],
  );
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selectedThreadKeys.has(key));
  const someVisibleSelected = visibleKeys.some((key) => selectedThreadKeys.has(key));

  // Everything a row renders that does not live in `rows` itself. Identity has
  // to change whenever one of these does, or the virtualized rows keep showing
  // stale checkboxes, spinners and density.
  const rowRenderExtraData = useMemo(
    () => ({ selectedThreadKeys, expandedKeys, pendingByKey, dense }),
    [selectedThreadKeys, expandedKeys, pendingByKey, dense],
  );

  // Rows are live atoms; a session deleted elsewhere must not keep inflating
  // the toolbar's count.
  const liveKeySet = useMemo(() => new Set(allRows.map((row) => row.key)), [allRows]);
  useEffect(() => {
    selectionActions.pruneSelection(liveKeySet);
  }, [liveKeySet, selectionActions]);

  // Facet options are derived from the rows themselves so a facet never offers
  // a value that matches nothing.
  const repositoryFacetOptions = useMemo(() => {
    const counted = new Map<string, { label: string; count: number }>();
    for (const row of allRows) {
      const existing = counted.get(row.repositoryKey);
      if (existing) existing.count += 1;
      else counted.set(row.repositoryKey, { label: row.repositoryLabel, count: 1 });
    }
    return [...counted]
      .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [allRows]);

  const providerFacetOptions = useMemo(() => {
    const counted = new Map<string, { label: string; count: number }>();
    for (const row of allRows) {
      const existing = counted.get(row.providerKind);
      if (existing) existing.count += 1;
      else counted.set(row.providerKind, { label: row.providerName, count: 1 });
    }
    return [...counted]
      .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [allRows]);

  const ownerFacetOptions = useMemo(() => {
    const counted = new Map<string, { label: string; count: number }>();
    for (const row of allRows) {
      if (row.ownerUserId === null) continue;
      const existing = counted.get(row.ownerUserId);
      if (existing) existing.count += 1;
      else counted.set(row.ownerUserId, { label: row.ownerLabel, count: 1 });
    }
    return [...counted]
      .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [allRows]);

  const reconcile = filterActions.reconcile;
  useEffect(() => {
    reconcile({
      repositoryKeys: new Set(repositoryFacetOptions.map((option) => option.value)),
      providerKinds: new Set(providerFacetOptions.map((option) => option.value)),
      ownerUserIds: new Set(ownerFacetOptions.map((option) => option.value)),
    });
  }, [ownerFacetOptions, providerFacetOptions, reconcile, repositoryFacetOptions]);

  const chips = useMemo(
    () =>
      buildSessionManagerFilterChips(filters, {
        repositories: repositoryLabels,
        providers: new Map(providerFacetOptions.map((option) => [option.value, option.label])),
        owners: new Map(ownerFacetOptions.map((option) => [option.value, option.label])),
      }),
    [filters, ownerFacetOptions, providerFacetOptions, repositoryLabels],
  );

  /* ------------------------------- navigation ------------------------------- */

  const openRow = useCallback(
    (row: SessionManagerRow) => {
      const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [router],
  );

  const toggleSelection = useCallback(
    (row: SessionManagerRow, event: React.MouseEvent) => {
      event.stopPropagation();
      if (event.shiftKey) {
        selectionActions.rangeSelectTo(row.key, visibleKeys);
        return;
      }
      selectionActions.toggleThread(row.key);
    },
    [selectionActions, visibleKeys],
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ------------------------------ bulk actions ------------------------------ */

  const setRowPending = useCallback((keys: ReadonlyArray<string>, kind: RowPendingKind | null) => {
    setPendingByKey((current) => {
      const next = new Map(current);
      for (const key of keys) {
        if (kind === null) next.delete(key);
        else next.set(key, kind);
      }
      return next;
    });
  }, []);

  const runBulk = useCallback(
    async (options: {
      label: string;
      rows: ReadonlyArray<SessionManagerRow>;
      pendingKind?: RowPendingKind;
      concurrency?: number;
      clearSelectionWhenDone?: boolean;
      run: (row: SessionManagerRow) => Promise<CommandOutcome>;
    }): Promise<ReadonlyArray<CommandOutcome>> => {
      const targets = options.rows;
      if (targets.length === 0) return [];
      setBulkRun({ label: options.label, done: 0, total: targets.length });
      if (options.pendingKind !== undefined) {
        setRowPending(
          targets.map((row) => row.key),
          options.pendingKind,
        );
      }
      const outcomes = await mapWithConcurrency(
        targets,
        options.concurrency ?? targets.length,
        async (row) => {
          const outcome = await options.run(row);
          if (options.pendingKind !== undefined) setRowPending([row.key], null);
          setBulkRun((current) =>
            current === null
              ? current
              : { ...current, done: Math.min(current.done + 1, current.total) },
          );
          return outcome;
        },
      );
      setBulkRun(null);
      reportBulkOutcome(options.label, outcomes, targets.length);
      if (options.clearSelectionWhenDone !== false) selectionActions.clearSelection();
      return outcomes;
    },
    [selectionActions, setRowPending],
  );

  const handleRetitle = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      const eligible = targets.filter((row) => row.capabilities.titleRegeneration);
      void runBulk({
        label: "Regenerated titles",
        rows: eligible,
        pendingKind: "title",
        concurrency: LLM_BULK_CONCURRENCY,
        // The retitle lands as a live shell update; keeping the selection lets
        // the user follow it with another action on the same set.
        clearSelectionWhenDone: false,
        run: async (row) =>
          toOutcome(
            await updateThreadMetadata({
              environmentId: row.thread.environmentId,
              input: { threadId: row.thread.id, regenerateTitle: true },
            }),
          ),
      });
    },
    [runBulk, updateThreadMetadata],
  );

  const handleSummarize = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      const eligible = targets.filter((row) => row.capabilities.workSummary);
      void runBulk({
        label: "Summarized",
        rows: eligible,
        pendingKind: "summary",
        concurrency: LLM_BULK_CONCURRENCY,
        clearSelectionWhenDone: false,
        run: async (row) =>
          toOutcome(
            await requestWorkSummary({
              environmentId: row.thread.environmentId,
              input: { threadId: row.thread.id },
            }),
          ),
      });
    },
    [requestWorkSummary, runBulk],
  );

  const handleSetPriority = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>, priority: ThreadPriority) => {
      void runBulk({
        label: `Set ${formatThreadPriority(priority)}`,
        rows: targets.filter((row) => row.capabilities.priority),
        run: async (row) =>
          toOutcome(
            await updateThreadMetadata({
              environmentId: row.thread.environmentId,
              input: { threadId: row.thread.id, priority },
            }),
          ),
      });
    },
    [runBulk, updateThreadMetadata],
  );

  const handleSnooze = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>, snoozedUntil: string, label: string) => {
      void runBulk({
        label: `Snoozed until ${label}`,
        rows: targets.filter(
          (row) => row.capabilities.snooze && canSnooze(row.thread, { now: nowIso }),
        ),
        run: async (row) =>
          toOutcome(
            await snoozeThread(
              scopeThreadRef(row.thread.environmentId, row.thread.id),
              snoozedUntil,
            ),
          ),
      });
    },
    [nowIso, runBulk, snoozeThread],
  );

  const handleSettle = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      void runBulk({
        label: "Settled",
        rows: targets.filter((row) => row.capabilities.settlement),
        run: async (row) =>
          toOutcome(await settleThread(scopeThreadRef(row.thread.environmentId, row.thread.id))),
      });
    },
    [runBulk, settleThread],
  );

  const handleArchive = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      void runBulk({
        label: "Archived",
        rows: targets,
        run: async (row) =>
          toOutcome(await archiveThread(scopeThreadRef(row.thread.environmentId, row.thread.id))),
      });
    },
    [archiveThread, runBulk],
  );

  const handlePin = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      const eligible = targets.filter((row) => row.capabilities.pinning);
      // Mixed selections resolve toward pinning: unpinning is the destructive
      // reading of an ambiguous click.
      const shouldPin = eligible.some((row) => !row.isPinned);
      void runBulk({
        label: shouldPin ? "Pinned" : "Unpinned",
        rows: eligible.filter((row) => row.isPinned !== shouldPin),
        run: async (row) => {
          const threadRef: ScopedThreadRef = scopeThreadRef(
            row.thread.environmentId,
            row.thread.id,
          );
          return toOutcome(await (shouldPin ? pinThread(threadRef) : unpinThread(threadRef)));
        },
      });
    },
    [pinThread, runBulk, unpinThread],
  );

  const handleMarkRead = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      const visitedAt = new Date().toISOString();
      for (const row of targets) markThreadVisited(row.key, visitedAt);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Marked ${targets.length} session${targets.length === 1 ? "" : "s"} read`,
          timeout: 4_000,
        }),
      );
      selectionActions.clearSelection();
    },
    [markThreadVisited, selectionActions],
  );

  const handleStopAgent = useCallback(
    (targets: ReadonlyArray<SessionManagerRow>) => {
      void runBulk({
        label: "Stopped agents",
        rows: targets.filter((row) => row.canStop),
        run: async (row) =>
          toOutcome(
            await stopThreadSession({
              environmentId: row.thread.environmentId,
              input: { threadId: row.thread.id },
            }),
          ),
      });
    },
    [runBulk, stopThreadSession],
  );

  const confirmDelete = useCallback(async () => {
    const targets = deleteDialogRows ?? [];
    setDeleteDialogRows(null);
    if (targets.length === 0) return;
    setBulkRun({ label: "Deleting", done: 0, total: targets.length });
    // Deletion stays sequential and grows `deletedThreadKeys` as it goes:
    // orphaned-worktree detection must only discount threads that are really
    // gone, or the first delete removes a worktree its batch mates still use.
    const deletedThreadKeys = new Set<string>();
    const outcomes: CommandOutcome[] = [];
    for (const row of targets) {
      const outcome = toOutcome(
        await deleteThread(scopeThreadRef(row.thread.environmentId, row.thread.id), {
          deletedThreadKeys,
        }),
      );
      outcomes.push(outcome);
      setBulkRun((current) =>
        current === null ? current : { ...current, done: current.done + 1 },
      );
      if (outcome.status !== "success") break;
      deletedThreadKeys.add(row.key);
    }
    setBulkRun(null);
    reportBulkOutcome("Deleted", outcomes, targets.length);
    selectionActions.removeFromSelection([...deletedThreadKeys]);
  }, [deleteDialogRows, deleteThread, selectionActions]);

  /* -------------------------------- keyboard -------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const inField =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable === true);

      if (event.key === "Escape") {
        // Escape clears the selection first, and only leaves the page once
        // nothing is selected — losing a 60-row selection to a stray Escape
        // would be the single most expensive misfire on this page.
        if (selectedThreadKeys.size > 0) {
          event.preventDefault();
          selectionActions.clearSelection();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        if (inField) return;
        event.preventDefault();
        selectionActions.replaceSelection(visibleKeys);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedThreadKeys.size, selectionActions, visibleKeys]);

  /* --------------------------------- render --------------------------------- */

  const rowActions = useMemo<RowActions>(
    () => ({
      onOpen: openRow,
      onToggleSelection: toggleSelection,
      onToggleExpanded: toggleExpanded,
      onRetitle: handleRetitle,
      onSummarize: handleSummarize,
      onSettle: handleSettle,
      onArchive: handleArchive,
      onDelete: (targets) => setDeleteDialogRows(targets),
    }),
    [
      handleArchive,
      handleRetitle,
      handleSettle,
      handleSummarize,
      openRow,
      toggleExpanded,
      toggleSelection,
    ],
  );

  const headerCell = (column: SessionManagerSortColumn, label: string) => (
    <button
      type="button"
      onClick={() => filterActions.cycleSort(column)}
      className={cn(
        "hover:text-foreground flex items-center gap-1 truncate text-left transition-colors",
        sort.column === column ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      {sort.column === column ? (
        <ChevronDownIcon
          className={cn("size-3 shrink-0", sort.direction === "desc" && "rotate-180")}
        />
      ) : null}
    </button>
  );

  const snoozePresets = useMemo(() => {
    // Re-resolve each minute so "This evening" does not go stale on a page
    // left open all afternoon; the tick is the dependency, not the clock read.
    void nowMinute;
    return resolveSnoozePresets(new Date(), timestampFormat);
  }, [nowMinute, timestampFormat]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <Rows3Icon className="text-muted-foreground size-4" />
          <h1 className="text-sm font-semibold">Sessions</h1>
          <span className="text-muted-foreground text-xs">
            {rows.length} of {counts.total}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          {SESSION_MANAGER_SAVED_VIEWS.map((view) => {
            const active = activeViewId === view.id;
            const badge = view.countKey === undefined ? undefined : counts[view.countKey];
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => {
                  if (active) {
                    filterActions.clearAll();
                    return;
                  }
                  filterActions.applyView(view.id, view.filters, view.sort);
                }}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {view.label}
                {badge !== undefined && badge > 0 ? (
                  <span
                    className={cn(
                      "rounded px-1 font-mono text-[10px]",
                      active ? "bg-primary-foreground/20" : "bg-muted",
                    )}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setDense((value) => !value)}
            aria-label="Toggle row density"
          >
            <Rows3Icon className="size-3.5" />
            {dense ? "Compact" : "Comfortable"}
          </Button>
        </div>
      </div>

      <div className="border-border flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <div className="border-border bg-card focus-within:border-ring flex h-7 w-56 shrink-0 items-center gap-1.5 rounded-md border px-2">
          <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
          <input
            value={filters.search}
            onChange={(event) => filterActions.setSearch(event.target.value)}
            placeholder="Search title, branch, summary…"
            aria-label="Search sessions"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
          {filters.search.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => filterActions.setSearch("")}
            >
              <XIcon className="text-muted-foreground hover:text-foreground size-3" />
            </button>
          ) : null}
        </div>

        <FacetPopover
          label="Repo"
          icon={GitBranchIcon}
          options={repositoryFacetOptions}
          selected={filters.repositoryKeys}
          onToggle={filterActions.toggleRepository}
          onClear={() => filterActions.setFacet("repositoryKeys", [])}
        />
        <FacetPopover
          label="Phase"
          icon={FilterIcon}
          options={PHASE_SIDEBAR_PHASES.map((phase) => ({ value: phase.id, label: phase.label }))}
          selected={filters.phaseIds}
          onToggle={filterActions.togglePhase}
          onClear={() => filterActions.setFacet("phaseIds", [])}
        />
        <FacetPopover
          label="Needs"
          icon={BellIcon}
          options={SESSION_MANAGER_ATTENTION_KINDS.map((kind) => ({
            value: kind,
            label: SESSION_MANAGER_ATTENTION_LABELS[kind],
          }))}
          selected={filters.attentionKinds}
          onToggle={filterActions.toggleAttention}
          onClear={() => filterActions.setFacet("attentionKinds", [])}
        />
        <FacetPopover
          label="Priority"
          icon={FlagIcon}
          options={[
            ...SESSION_MANAGER_PRIORITY_CHOICES,
            { value: PHASE_SIDEBAR_UNPRIORITISED_RANK, label: "No priority" },
          ]}
          selected={filters.priorities}
          onToggle={filterActions.togglePriority}
          onClear={() => filterActions.setFacet("priorities", [])}
        />
        <FacetPopover
          label="Agent"
          icon={BotIcon}
          options={providerFacetOptions}
          selected={filters.providerKinds}
          onToggle={filterActions.toggleProvider}
          onClear={() => filterActions.setFacet("providerKinds", [])}
        />
        {ownerFacetOptions.length > 1 ? (
          <FacetPopover
            label="Owner"
            icon={UserRoundIcon}
            options={ownerFacetOptions}
            selected={filters.ownerUserIds}
            onToggle={filterActions.toggleOwner}
            onClear={() => filterActions.setFacet("ownerUserIds", [])}
          />
        ) : null}

        <Menu>
          <MenuTrigger
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs whitespace-nowrap",
              filters.staleDays !== null
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            <ClockIcon className="size-3.5" />
            {filters.staleDays === null ? "Idle for" : `Idle ${filters.staleDays}d+`}
            <ChevronDownIcon className="size-3 opacity-50" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-40">
            {SESSION_MANAGER_STALE_DAY_CHOICES.map((days) => (
              <MenuItem key={String(days)} onClick={() => filterActions.setStaleDays(days)}>
                {days === null ? "Any" : `${days}d or longer`}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>

        <div className="border-border bg-card flex h-7 shrink-0 items-center overflow-hidden rounded-md border">
          {SESSION_MANAGER_LIFECYCLES.map((lifecycle) => {
            const active = filters.lifecycles.includes(lifecycle);
            return (
              <button
                key={lifecycle}
                type="button"
                aria-pressed={active}
                onClick={() => filterActions.toggleLifecycle(lifecycle)}
                className={cn(
                  "h-full px-2 text-[11px] capitalize transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {lifecycle}
              </button>
            );
          })}
        </div>

        {chips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => {
                  switch (chip.facet) {
                    case "search":
                      filterActions.setSearch("");
                      return;
                    case "stale":
                      filterActions.setStaleDays(null);
                      return;
                    case "repository":
                      filterActions.toggleRepository(chip.value ?? "");
                      return;
                    case "phase":
                      filterActions.togglePhase(chip.value as PhaseSidebarPhaseId);
                      return;
                    case "provider":
                      filterActions.toggleProvider(chip.value ?? "");
                      return;
                    case "priority":
                      filterActions.togglePriority(Number(chip.value));
                      return;
                    case "attention":
                      filterActions.toggleAttention(chip.value as PhaseSidebarAttentionKind);
                      return;
                    case "owner":
                      filterActions.toggleOwner(chip.value ?? "");
                      return;
                    case "lifecycle":
                      filterActions.toggleLifecycle(chip.value as SessionManagerLifecycle);
                      return;
                  }
                }}
                className="bg-muted text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
              >
                {chip.label}
                <XIcon className="size-2.5" />
              </button>
            ))}
            <Button variant="ghost" size="xs" onClick={filterActions.clearAll}>
              Clear all
            </Button>
          </div>
        ) : null}
      </div>

      <div
        className="border-border text-muted-foreground bg-background z-10 grid shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11px] font-medium"
        style={{ gridTemplateColumns: COLUMN_TEMPLATE }}
      >
        <Checkbox
          checked={allVisibleSelected}
          indeterminate={!allVisibleSelected && someVisibleSelected}
          aria-label="Select all filtered sessions"
          onCheckedChange={() =>
            allVisibleSelected
              ? selectionActions.clearSelection()
              : selectionActions.replaceSelection(visibleKeys)
          }
        />
        {headerCell("title", "Session")}
        {headerCell("repository", "Repo")}
        {headerCell("phase", "Phase")}
        {headerCell("priority", "P")}
        {headerCell("progress", "Progress")}
        <span className="flex items-center gap-1">
          <SparklesIcon className="size-3" /> AI work summary
        </span>
        <span>Model</span>
        {headerCell("activity", "Activity")}
        <span />
      </div>

      <div className="relative min-h-0 flex-1">
        {!bootstrapped && allRows.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle className="text-sm">
                {allRows.length === 0 ? "No sessions yet" : "No sessions match these filters"}
              </EmptyTitle>
              <EmptyDescription className="text-xs">
                {allRows.length === 0
                  ? "Start a thread and it will show up here."
                  : "Try widening a facet, or clear the filter set."}
              </EmptyDescription>
            </EmptyHeader>
            {hasActiveSessionManagerFilters(filters) ? (
              <Button size="sm" variant="outline" onClick={filterActions.clearAll}>
                Clear filters
              </Button>
            ) : null}
          </Empty>
        ) : (
          <LegendList<SessionManagerRow>
            data={rows as SessionManagerRow[]}
            keyExtractor={legendKeyExtractor}
            // The list only re-invokes renderItem when `data` or `extraData`
            // changes. Selection, expansion, pending state and density all live
            // outside `rows`, so without this the header updates ("4 selected")
            // while the rows keep rendering their stale checkboxes.
            extraData={rowRenderExtraData}
            estimatedItemSize={dense ? 34 : 52}
            renderItem={({ item }) => (
              <SessionManagerTableRow
                row={item}
                selected={selectedThreadKeys.has(item.key)}
                expanded={expandedKeys.has(item.key)}
                dense={dense}
                pending={pendingByKey.get(item.key)}
                actions={rowActions}
              />
            )}
            className="h-full min-h-0 overflow-x-hidden"
          />
        )}
      </div>

      {selectedRows.length > 0 ? (
        <BulkToolbar
          rows={selectedRows}
          bulkRun={bulkRun}
          snoozePresets={snoozePresets}
          onRetitle={handleRetitle}
          onSummarize={handleSummarize}
          onSetPriority={handleSetPriority}
          onSnooze={handleSnooze}
          onSettle={handleSettle}
          onArchive={handleArchive}
          onPin={handlePin}
          onMarkRead={handleMarkRead}
          onStopAgent={handleStopAgent}
          onDelete={() => setDeleteDialogRows(selectedRows)}
          onClear={selectionActions.clearSelection}
        />
      ) : null}

      <AlertDialog
        open={deleteDialogRows !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteDialogRows(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteDialogRows?.length ?? 0} session
              {(deleteDialogRows?.length ?? 0) === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently clears conversation history for these sessions. Worktrees left
              orphaned by the deletion are confirmed separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];

function legendKeyExtractor(item: SessionManagerRow): string {
  return item.key;
}

/* ------------------------------- bulk toolbar ------------------------------ */

function BulkToolbar({
  rows,
  bulkRun,
  snoozePresets,
  onRetitle,
  onSummarize,
  onSetPriority,
  onSnooze,
  onSettle,
  onArchive,
  onPin,
  onMarkRead,
  onStopAgent,
  onDelete,
  onClear,
}: {
  rows: ReadonlyArray<SessionManagerRow>;
  bulkRun: BulkRunState | null;
  snoozePresets: ReadonlyArray<{
    id: string;
    label: string;
    whenLabel: string;
    snoozedUntil: string;
  }>;
  onRetitle: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onSummarize: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onSetPriority: (rows: ReadonlyArray<SessionManagerRow>, priority: ThreadPriority) => void;
  onSnooze: (rows: ReadonlyArray<SessionManagerRow>, snoozedUntil: string, label: string) => void;
  onSettle: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onArchive: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onPin: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onMarkRead: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onStopAgent: (rows: ReadonlyArray<SessionManagerRow>) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const busy = bulkRun !== null;
  const retitlePlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.titleRegeneration,
    "No selected session's server supports title regeneration.",
  );
  const summarizePlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.workSummary,
    "No selected session's server supports work summaries.",
  );
  const priorityPlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.priority,
    "No selected session's server supports priority.",
  );
  const snoozePlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.snooze,
    "No selected session's server supports snooze.",
  );
  const settlePlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.settlement,
    "No selected session's server supports settling.",
  );
  const pinPlan = planSessionManagerAction(
    rows,
    (row) => row.capabilities.pinning,
    "No selected session's server supports pinning.",
  );
  const stopPlan = planSessionManagerAction(
    rows,
    (row) => row.canStop,
    "No selected session has a running agent to stop.",
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="pointer-events-auto bg-popover border-border flex max-w-[calc(100vw-2rem)] items-center gap-1.5 overflow-x-auto rounded-xl border px-2.5 py-2 shadow-2xl">
        <span className="flex shrink-0 items-center gap-2 pr-1 text-xs font-medium">
          <span className="bg-primary text-primary-foreground rounded px-1.5 py-0.5 font-mono">
            {rows.length}
          </span>
          selected
        </span>
        {bulkRun !== null ? (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11px]">
            <Spinner className="size-3" />
            {bulkRun.label} {bulkRun.done}/{bulkRun.total}
          </span>
        ) : null}
        <div className="bg-border mx-1 h-5 w-px shrink-0" />

        <GatedButton
          disabled={busy}
          reason={retitlePlan.disabledReason}
          onClick={() => onRetitle(retitlePlan.eligible)}
        >
          <RefreshCwIcon className="size-3.5" /> Retitle
        </GatedButton>
        <GatedButton
          disabled={busy}
          reason={summarizePlan.disabledReason}
          onClick={() => onSummarize(summarizePlan.eligible)}
        >
          <SparklesIcon className="size-3.5" /> Summarize
        </GatedButton>

        <Menu>
          <MenuTrigger
            disabled={busy || priorityPlan.disabledReason !== null}
            render={<Button size="xs" variant="outline" />}
          >
            <FlagIcon className="size-3.5" /> Priority
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-44">
            {SESSION_MANAGER_PRIORITY_CHOICES.map((choice) => (
              <MenuItem
                key={choice.value}
                onClick={() => onSetPriority(priorityPlan.eligible, choice.value as ThreadPriority)}
              >
                <PriorityBadge rank={choice.value} /> Set {choice.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>

        <Menu>
          <MenuTrigger
            disabled={busy || snoozePlan.disabledReason !== null}
            render={<Button size="xs" variant="outline" />}
          >
            <ClockIcon className="size-3.5" /> Snooze
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-52">
            {snoozePresets.map((preset) => (
              <MenuItem
                key={preset.id}
                onClick={() => onSnooze(snoozePlan.eligible, preset.snoozedUntil, preset.label)}
              >
                <span className="flex-1">{preset.label}</span>
                <span className="text-muted-foreground text-[10px]">{preset.whenLabel}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>

        <GatedButton
          disabled={busy}
          reason={settlePlan.disabledReason}
          onClick={() => onSettle(settlePlan.eligible)}
        >
          <CheckCircle2Icon className="size-3.5" /> Settle
        </GatedButton>
        <GatedButton disabled={busy} reason={null} onClick={() => onArchive(rows)}>
          <ArchiveIcon className="size-3.5" /> Archive
        </GatedButton>

        <Menu>
          <MenuTrigger disabled={busy} render={<Button size="xs" variant="outline" />}>
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            <MenuItem
              disabled={pinPlan.disabledReason !== null}
              onClick={() => onPin(pinPlan.eligible)}
            >
              <PinIcon /> Pin / unpin
            </MenuItem>
            <MenuItem onClick={() => onMarkRead(rows)}>
              <CheckCircle2Icon /> Mark read
            </MenuItem>
            <MenuItem
              disabled={stopPlan.disabledReason !== null}
              onClick={() => onStopAgent(stopPlan.eligible)}
            >
              <OctagonPauseIcon /> Stop agent
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon /> Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>

        <div className="bg-border mx-1 h-5 w-px shrink-0" />
        <Button size="xs" variant="ghost" onClick={onClear}>
          <XIcon className="size-3.5" /> Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * A toolbar button that explains *why* it is disabled. A silently dead button
 * on a bulk toolbar reads as a bug; a tooltip naming the missing capability
 * reads as a version-skew message.
 */
function GatedButton({
  children,
  disabled,
  reason,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  reason: string | null;
  onClick: () => void;
}) {
  const button = (
    <Button size="xs" variant="outline" disabled={disabled || reason !== null} onClick={onClick}>
      {children}
    </Button>
  );
  if (reason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {reason}
      </TooltipPopup>
    </Tooltip>
  );
}
