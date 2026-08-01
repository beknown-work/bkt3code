import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
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
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { ProviderDriverKind, type ScopedThreadRef, type VcsStatusResult } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  FilterIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  Link2Icon,
  LaptopIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../env";
import { useOpenAddProjectCommandPalette } from "../commandPaletteContext";
import { usePersonalMcpProfile } from "../hooks/usePersonalMcpProfile";
import { useClientSettings, usePrimarySettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { useReconnectThreadSession } from "../hooks/useReconnectThreadSession";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { usePhaseSidebarFilterStore } from "../phaseSidebarFilterStore";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { allEnvironmentShellsLiveAtom } from "../state/shell";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { LinearIcon } from "./Icons";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  canReconnectThreadSession,
  isTrailingDoubleClick,
  resolveSettledTimestamp,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import {
  PHASE_SIDEBAR_PHASES,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  buildPhaseSidebarRepositoryOptions,
  derivePhaseSidebarRepositoryKey,
  filterVisiblePhaseSidebarRows,
  flattenPhaseSidebarGroups,
  isThreadAssignedToUser,
  partitionPhaseSidebarRows,
  resolvePhaseSidebarAttentionPriority,
  resolvePhaseSidebarCheckoutMetadata,
  resolvePhaseSidebarDisplayPhase,
  resolvePhaseSidebarPhase,
  resolvePhaseSidebarLinearIssue,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarTraversalTarget,
  phaseSidebarRowClassName,
  formatThreadPriority,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
  type PhaseSidebarSection,
} from "./sidebar/PhaseGroupedSidebar.logic";
import { useCurrentUserId } from "../state/identity";
import { T3_CONDUCTOR_ENABLED } from "../experimentalFeatures";
import {
  SidebarChromeFooter,
  SidebarChromeHeader,
  SidebarEnvironmentNotices,
} from "./sidebar/SidebarChrome";
import { SidebarSearchAction } from "./sidebar/SidebarSearchAction";
// T3-CUSTOM(expbkt3): attach-to-external-session.
import { AttachExternalSessionDialog } from "./sidebar/AttachExternalSessionDialog";
import { T3ConductorCard } from "./sidebar/T3ConductorCard";
import { isT3ConductorThread } from "./sidebar/T3Conductor.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";

const PHASE_ACCENT_CLASS: Record<PhaseSidebarPhaseId, string> = {
  // T3-CUSTOM(expbkt3): Urgent question phase is visually distinct from lifecycle work.
  needs_input: "animate-pulse bg-red-500",
  plan_ready: "bg-primary",
  ready_for_review: "bg-emerald-500",
  ready_to_merge: "bg-violet-500",
  planning: "bg-info",
  implementing: "bg-success",
  in_review: "bg-amber-500",
  merging: "bg-violet-500",
  merged: "bg-purple-500",
  checking: "bg-muted-foreground/45",
  ready: "bg-muted-foreground/45",
};

// T3-CUSTOM(expbkt3): Settled-tail paging — recent history is the common
// lookup; the deep tail stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

// The failed branch of a settle/snooze command — the four of them share one
// error reporter, so it takes the widened failure shape.
type ParkingCommandFailure = Extract<
  AtomCommandResult<unknown, unknown>,
  { readonly _tag: "Failure" }
>;

// Row hover affordances live in a shared overlay pill, so they need one
// shared button shape.
const ROW_ACTION_CLASS =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type RepositoryOption = ReturnType<typeof buildPhaseSidebarRepositoryOptions>[number];

interface ProviderOption {
  readonly kind: string;
  readonly code: string;
  readonly name: string;
}

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function ThreadWorkflowProbe({
  thread,
  project,
  onStatus,
}: {
  readonly thread: PhaseSidebarRow["thread"];
  readonly project: Project | null;
  readonly onStatus: (threadKey: string, status: VcsStatusResult | null) => void;
}) {
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
  const result = useEnvironmentQuery(
    thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({ environmentId: thread.environmentId, input: { cwd } })
      : null,
  );

  useEffect(() => onStatus(threadKey, result.data), [onStatus, result.data, threadKey]);
  return null;
}

function PhaseFilterPopover({
  repositories,
  providers,
}: {
  readonly repositories: ReadonlyArray<RepositoryOption>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const [search, setSearch] = useState("");
  const currentUserId = useCurrentUserId();
  const assignmentAvailable = currentUserId !== null;
  const {
    repositoryKeys,
    phaseIds,
    providerKinds,
    assignedToMe,
    toggleRepository,
    togglePhase,
    toggleProvider,
    toggleAssignedToMe,
  } = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      assignedToMe: state.assignedToMe,
      toggleRepository: state.toggleRepository,
      togglePhase: state.togglePhase,
      toggleProvider: state.toggleProvider,
      toggleAssignedToMe: state.toggleAssignedToMe,
    })),
  );
  const selectionCount =
    repositoryKeys.length +
    phaseIds.length +
    providerKinds.length +
    (assignmentAvailable && assignedToMe ? 1 : 0);
  const needle = search.trim().toLowerCase();
  const visibleRepositories = repositories.filter((option) =>
    option.searchText.toLowerCase().includes(needle),
  );
  const visiblePhases = PHASE_SIDEBAR_PHASES.filter((phase) =>
    phase.label.toLowerCase().includes(needle),
  );
  const visibleProviders = providers.filter((option) =>
    `${option.code} ${option.name} ${option.kind}`.toLowerCase().includes(needle),
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label="Filter phase sidebar"
          />
        }
      >
        <FilterIcon className="size-3" />
        Filter
        {selectionCount > 0 ? (
          <Badge size="sm" className="ml-0.5 h-4 min-w-4 rounded-full px-1 text-[9px]">
            {selectionCount}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72" viewportClassName="p-0!">
        <div className="sticky top-0 z-10 border-b bg-popover p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search facets"
              aria-label="Search filter options"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-[min(28rem,var(--available-height))] space-y-3 overflow-y-auto p-2">
          <FacetSection label="Repository">
            {visibleRepositories.map((option) => (
              <FacetOption
                key={option.key}
                checked={repositoryKeys.includes(option.key)}
                label={option.label}
                onCheckedChange={() => toggleRepository(option.key)}
                leading={
                  <ProjectFavicon
                    environmentId={option.project.environmentId}
                    cwd={option.project.workspaceRoot}
                    className="size-3"
                  />
                }
              />
            ))}
          </FacetSection>
          <FacetSection label="Lifecycle phase">
            {visiblePhases.map((phase) => (
              <FacetOption
                key={phase.id}
                checked={phaseIds.includes(phase.id)}
                label={phase.label}
                onCheckedChange={() => togglePhase(phase.id)}
                leading={
                  <span className={cn("size-1.5 rounded-full", PHASE_ACCENT_CLASS[phase.id])} />
                }
              />
            ))}
          </FacetSection>
          <FacetSection label="Provider">
            {visibleProviders.map((provider) => (
              <FacetOption
                key={provider.kind}
                checked={providerKinds.includes(provider.kind)}
                label={provider.name}
                onCheckedChange={() => toggleProvider(provider.kind)}
                leading={
                  <ProviderInstanceIcon
                    driverKind={ProviderDriverKind.make(provider.kind)}
                    displayName={provider.name}
                    className="size-3"
                    iconClassName="size-3"
                  />
                }
              />
            ))}
          </FacetSection>
          {assignmentAvailable && "assigned to me".includes(needle) ? (
            <FacetSection label="Assignment">
              <FacetOption
                checked={assignedToMe}
                label="Assigned to me"
                onCheckedChange={() => toggleAssignedToMe()}
              />
            </FacetSection>
          ) : null}
          {visibleRepositories.length + visiblePhases.length + visibleProviders.length === 0 &&
          !(assignmentAvailable && "assigned to me".includes(needle)) ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No filter options match.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function FacetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {label}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function FacetOption({
  checked,
  label,
  leading,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly leading?: React.ReactNode;
  readonly onCheckedChange: () => void;
}) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-accent">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  );
}

function ActiveFilterChips({
  repositoryLabels,
  providerLabels,
}: {
  readonly repositoryLabels: ReadonlyMap<string, string>;
  readonly providerLabels: ReadonlyMap<string, string>;
}) {
  const {
    repositoryKeys,
    phaseIds,
    providerKinds,
    assignedToMe,
    toggleRepository,
    togglePhase,
    toggleProvider,
    toggleAssignedToMe,
    clearAll,
  } = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      assignedToMe: state.assignedToMe,
      toggleRepository: state.toggleRepository,
      togglePhase: state.togglePhase,
      toggleProvider: state.toggleProvider,
      toggleAssignedToMe: state.toggleAssignedToMe,
      clearAll: state.clearAll,
    })),
  );
  const chips = buildPhaseSidebarFilterChips(
    { repositoryKeys, phaseIds, providerKinds, assignedToMe },
    { repositories: repositoryLabels, providers: providerLabels },
  );
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5" data-testid="phase-filter-chips">
      {chips.map((chip) => (
        <FilterChip
          key={`${chip.facet}:${chip.value}`}
          label={chip.label}
          onRemove={() => {
            if (chip.facet === "repository") toggleRepository(chip.value);
            if (chip.facet === "phase") togglePhase(chip.value as PhaseSidebarPhaseId);
            if (chip.facet === "provider") toggleProvider(chip.value);
            if (chip.facet === "assignment") toggleAssignedToMe();
          }}
        />
      ))}
      <button
        type="button"
        className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={clearAll}
      >
        Clear all
      </button>
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" size="sm" className="max-w-full gap-0.5 pr-0.5">
      <span className="max-w-32 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label} filter`}
        className="rounded-sm p-0.5 hover:bg-foreground/10"
        onClick={onRemove}
      >
        <XIcon className="size-2.5" />
      </button>
    </Badge>
  );
}

/**
 * T3-CUSTOM(expbkt3): Hover entry point for snooze — a clock button opening
 * the preset menu. The row owns the open state so it can pin its hover
 * actions visible while the menu is up (opening the popup moves the pointer
 * off the row).
 *
 * The trigger renders as a role="button" span, not a <button>: the whole
 * sidebar row is itself a <button> and nesting one inside it is invalid.
 */
function PhaseSnoozePopoverButton({
  open,
  label,
  testId,
  onOpenChange,
  onSnooze,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly testId?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSnooze: (preset: SnoozePreset) => void;
}) {
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Plain title instead of a Tooltip wrapper: composing a tooltip
          trigger around a popover trigger would give this one span two
          owners of the same `render` slot. */}
      <PopoverTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            title="Snooze"
            data-testid={testId}
            className={ROW_ACTION_CLASS}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        }
      >
        <ClockIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * T3-CUSTOM(expbkt3): One hover action in the row overlay. Same
 * nested-button constraint as the snooze trigger above.
 */
function PhaseRowAction({
  label,
  tooltip,
  testId,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly testId?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid={testId}
            className={ROW_ACTION_CLASS}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface PhaseThreadRowProps {
  readonly row: PhaseSidebarRow;
  readonly section: PhaseSidebarSection;
  readonly project: Project | null;
  readonly vcsStatus: VcsStatusResult | null;
  readonly active: boolean;
  readonly orderedThreadKeys: ReadonlyArray<string>;
  readonly jumpLabel: string | null;
  readonly renaming: boolean;
  readonly renameTitle: string;
  readonly onRenameTitleChange: (title: string) => void;
  readonly onStartRename: (row: PhaseSidebarRow) => void;
  readonly onCommitRename: (row: PhaseSidebarRow) => void;
  readonly onCancelRename: () => void;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
  readonly onReconnect: (threadRef: ScopedThreadRef) => Promise<void>;
  readonly onArchive: (row: PhaseSidebarRow) => void;
  readonly onDelete: (row: PhaseSidebarRow) => void;
  readonly onSettle: (row: PhaseSidebarRow) => void;
  readonly onUnsettle: (row: PhaseSidebarRow) => void;
  readonly onSnooze: (row: PhaseSidebarRow, preset: SnoozePreset) => void;
  readonly onUnsnooze: (row: PhaseSidebarRow) => void;
  // T3-CUSTOM(expbkt3): null clears the priority.
  readonly onSetPriority: (row: PhaseSidebarRow, priority: 0 | 1 | 2 | 3 | 4 | null) => void;
}

const PhaseThreadRow = memo(function PhaseThreadRow(props: PhaseThreadRowProps) {
  const {
    row,
    section,
    project,
    vcsStatus,
    active,
    orderedThreadKeys,
    jumpLabel,
    renaming,
    renameTitle,
    onRenameTitleChange,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onNavigate,
    onReconnect,
    onArchive,
    onDelete,
    onSettle,
    onSnooze,
    onUnsettle,
    onUnsnooze,
    onSetPriority,
  } = props;
  const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const selected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const toggleThread = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const status = resolveThreadStatusPill({ thread: { ...row.thread, lastVisitedAt } });
  const linearIssue = resolvePhaseSidebarLinearIssue(row.thread.branch);
  const checkoutMetadata = resolvePhaseSidebarCheckoutMetadata(row.thread, vcsStatus);
  const workspacePath = row.thread.worktreePath ?? project?.workspaceRoot ?? null;
  const needsUserInput = row.phaseId === "needs_input";
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze affordances.
  // While the preset popover is open the pointer sits over the popup, not
  // the row, so the hover cluster has to stay pinned.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated, and never
  // on a thread that is blocked on the user (hiding a pending request would
  // defeat it).
  const canSnoozeRow =
    row.snoozeSupported && canSnooze(row.thread, { now: new Date().toISOString() });
  const snoozeMenuOpen = snoozeMenuOpenRaw && canSnoozeRow;
  useEffect(() => {
    if (!canSnoozeRow) setSnoozeMenuOpen(false);
  }, [canSnoozeRow]);
  const wokeAt = threadWokeAt(row.thread, { now: new Date().toISOString() });
  // A wake the user has not looked at yet: same "visiting clears it" rule
  // the unread indicator uses.
  const showWokePill =
    section === "active" &&
    wokeAt !== null &&
    (lastVisitedAt === undefined || Date.parse(wokeAt) > Date.parse(lastVisitedAt));
  // Snoozed rows read "when does this come BACK"; settled rows read "when
  // did this wrap up" — the same timestamp they sort by.
  const timeLabel =
    section === "snoozed" && row.thread.snoozedUntil != null
      ? snoozeWakeLabel(row.thread.snoozedUntil, { now: new Date().toISOString() })
      : formatRelativeTimeLabel(
          (section === "settled" ? resolveSettledTimestamp(row.thread) : null) ??
            row.thread.updatedAt,
        ).replace(" ago", "");
  // T3-CUSTOM(expbkt3): END

  const openLinearIssue = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    if (!linearIssue) return;
    const api = readLocalApi();
    if (!api) return;
    void api.shell.openExternal(linearIssue.url).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to open ${linearIssue.identifier}`,
          description:
            error instanceof Error ? error.message : "The Linear issue could not be opened.",
        }),
      );
    });
  };

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const modifierClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (modifierClick) {
      event.preventDefault();
      toggleThread(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeys);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) return;
    if (useThreadSelectionStore.getState().hasSelection()) clearSelection();
    setAnchor(threadKey);
    onNavigate(threadRef);
  };

  const handleContextMenu = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    // T3-CUSTOM(expbkt3): BEGIN — lifecycle parking items, capability-gated
    // so an old server shows none of them rather than failing on click.
    const snoozePresets = resolveSnoozePresets(new Date());
    const settlementItems = row.settlementSupported
      ? [
          section === "settled"
            ? { id: "unsettle", label: "Un-settle thread" }
            : { id: "settle", label: "Settle thread" },
        ]
      : [];
    const snoozeItems = row.snoozeSupported
      ? [
          section === "snoozed"
            ? { id: "unsnooze", label: "Wake thread" }
            : {
                id: "snooze",
                label: "Snooze",
                disabled: !canSnoozeRow,
                children: snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}`,
                  label: `${preset.label} — ${preset.whenLabel}`,
                })),
              },
        ]
      : [];
    const priorityItems = row.prioritySupported
      ? [
          {
            id: "priority",
            label: "Priority",
            children: [
              ...PHASE_SIDEBAR_PRIORITY_CHOICES.map((choice) => ({
                id: `priority:${choice.value}`,
                label: row.thread.priority === choice.value ? `${choice.label} ✓` : choice.label,
              })),
              {
                id: "priority:clear",
                label: "Clear priority",
                disabled: row.thread.priority == null,
              },
            ],
          },
        ]
      : [];
    // T3-CUSTOM(expbkt3): END
    const action = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename" },
        { id: "mark-unread", label: "Mark unread" },
        ...priorityItems,
        ...settlementItems,
        ...snoozeItems,
        {
          id: "reconnect-session",
          label: "Reconnect session",
          disabled: !canReconnectThreadSession(row.thread),
        },
        { id: "copy-path", label: "Copy Path", disabled: workspacePath === null },
        {
          id: "copy-session-id",
          label: "Copy session ID",
          disabled: !row.thread.session?.providerThreadId,
        },
        { id: "copy-id", label: "Copy thread ID" },
        { id: "archive", label: "Archive" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (action === "rename") onStartRename(row);
    if (action === "mark-unread") markThreadUnread(threadKey, row.thread.latestTurn?.completedAt);
    // T3-CUSTOM(expbkt3): BEGIN
    if (action === "settle") onSettle(row);
    if (action === "unsettle") onUnsettle(row);
    if (action === "unsnooze") onUnsnooze(row);
    if (action?.startsWith("snooze:")) {
      const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
      if (preset) onSnooze(row, preset);
    }
    if (action === "priority:clear") onSetPriority(row, null);
    else if (action?.startsWith("priority:")) {
      const choice = PHASE_SIDEBAR_PRIORITY_CHOICES.find(
        (candidate) => `priority:${candidate.value}` === action,
      );
      if (choice) onSetPriority(row, choice.value);
    }
    // T3-CUSTOM(expbkt3): END
    if (action === "reconnect-session") await onReconnect(threadRef);
    if (action === "copy-path" && workspacePath) {
      await navigator.clipboard.writeText(workspacePath);
    }
    if (action === "copy-session-id" && row.thread.session?.providerThreadId) {
      await navigator.clipboard.writeText(row.thread.session.providerThreadId);
    }
    if (action === "copy-id") await navigator.clipboard.writeText(row.thread.id);
    if (action === "archive") onArchive(row);
    if (action === "delete") onDelete(row);
  };

  return (
    <li data-thread-item>
      <button
        type="button"
        className={phaseSidebarRowClassName(
          active,
          selected,
          needsUserInput,
          row.thread.priority === 0,
        )}
        aria-current={active ? "page" : undefined}
        data-attention={needsUserInput ? "user-input" : undefined}
        data-testid={`phase-thread-row-${row.thread.id}`}
        onClick={handleClick}
        onDoubleClick={() => onStartRename(row)}
        onContextMenu={(event) => void handleContextMenu(event)}
      >
        {active ? (
          <span
            aria-hidden
            data-testid={`phase-thread-active-indicator-${row.thread.id}`}
            className="pointer-events-none absolute inset-y-1 right-0 w-0.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]"
          />
        ) : null}
        {status ? (
          <ThreadStatusLabel status={status} compact />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              value={renameTitle}
              className="h-5 w-full rounded border border-ring bg-transparent px-1 text-xs text-foreground outline-none"
              onChange={(event) => onRenameTitleChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onBlur={() => onCommitRename(row)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") onCommitRename(row);
                if (event.key === "Escape") onCancelRename();
              }}
            />
          ) : (
            <span className="block truncate text-xs font-medium text-foreground">
              {row.thread.title}
            </span>
          )}
          {/* T3-CUSTOM(expbkt3): Keep checkout details left-aligned and pin the provider at right. */}
          <span className="relative mt-0.5 flex min-w-0 items-center justify-start gap-1.5 pr-5 text-[10px] leading-none text-muted-foreground/65">
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex min-w-0 max-w-20 items-center gap-1" />}
              >
                {project ? (
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.workspaceRoot}
                    className="size-2.5"
                  />
                ) : null}
                <span className="min-w-0 truncate">{row.repositoryLabel}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{row.repositoryLabel}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex min-w-0 max-w-24 items-center gap-1" />}
              >
                {checkoutMetadata.kind === "worktree" ? (
                  <FolderGit2Icon aria-hidden className="size-2.5 shrink-0" />
                ) : (
                  <LaptopIcon aria-hidden className="size-2.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{checkoutMetadata.label}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{checkoutMetadata.tooltip}</TooltipPopup>
            </Tooltip>
            {linearIssue ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="link"
                      tabIndex={0}
                      data-testid={`linear-issue-${row.thread.id}`}
                      aria-label={`Open ${linearIssue.identifier} in Linear`}
                      className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={openLinearIssue}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        openLinearIssue(event);
                      }}
                    />
                  }
                >
                  <LinearIcon aria-hidden className="size-2.5 shrink-0" />
                  <span>{linearIssue.identifier}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">Open {linearIssue.identifier} in Linear</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="absolute right-0 inline-flex size-3 items-center justify-center"
                    aria-label={row.providerName}
                  />
                }
              >
                <ProviderInstanceIcon
                  driverKind={ProviderDriverKind.make(row.providerKind)}
                  displayName={row.providerName}
                  className="size-3"
                  iconClassName="size-3 text-[8px]"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{row.providerName}</TooltipPopup>
            </Tooltip>
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* T3-CUSTOM(expbkt3): P0 is loud because it is the one level that
              claims attention across every lifecycle group; P1-P4 stay quiet
              markers so they read as metadata, not alarms. */}
          {row.thread.priority != null ? (
            <span
              aria-label={`Priority ${formatThreadPriority(row.thread.priority)}`}
              data-testid={`phase-thread-priority-${row.thread.id}`}
              className={cn(
                "rounded-sm px-1 py-0.5 text-[8px] font-black tracking-wide",
                row.thread.priority === 0
                  ? "bg-amber-500 text-white shadow-sm"
                  : "bg-muted-foreground/15 text-muted-foreground",
              )}
            >
              {formatThreadPriority(row.thread.priority)}
            </span>
          ) : null}
          {needsUserInput ? (
            <span className="rounded-sm bg-red-500 px-1 py-0.5 text-[8px] font-black tracking-wide text-white shadow-sm">
              INPUT
            </span>
          ) : null}
          {/* T3-CUSTOM(expbkt3): A woken thread returns to its original sort
              position, so the wake signal has to carry the weight itself. */}
          {showWokePill ? (
            <span
              aria-label="Woke from snooze"
              data-testid={`phase-thread-woke-${row.thread.id}`}
              className="inline-flex items-center gap-0.5 rounded-sm bg-blue-500/15 px-1 py-0.5 text-[8px] font-semibold tracking-wide text-blue-600 dark:text-blue-400"
            >
              <AlarmClockIcon aria-hidden className="size-2.5" />
              WOKE
            </span>
          ) : null}
          {jumpLabel ? (
            <Kbd className="h-4 min-w-0 rounded-sm px-1 text-[9px]">{jumpLabel}</Kbd>
          ) : null}
          <span className="text-[9px] tabular-nums text-muted-foreground/50">{timeLabel}</span>
        </span>
        {/* T3-CUSTOM(expbkt3): BEGIN — hover actions overlay the row instead of reflowing metadata. */}
        <span
          className={cn(
            "absolute top-1/2 right-1 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border/70 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm group-hover/phase-row:flex group-focus-within/phase-row:flex",
            snoozeMenuOpen && "flex",
          )}
        >
          {section === "snoozed" ? (
            row.snoozeSupported ? (
              <PhaseRowAction
                label={`Wake ${row.thread.title}`}
                tooltip="Wake now"
                testId={`phase-thread-unsnooze-${row.thread.id}`}
                onClick={() => onUnsnooze(row)}
              >
                <AlarmClockIcon className="size-3.5" />
              </PhaseRowAction>
            ) : null
          ) : section === "settled" ? (
            row.settlementSupported ? (
              <PhaseRowAction
                label={`Un-settle ${row.thread.title}`}
                tooltip="Un-settle"
                testId={`phase-thread-unsettle-${row.thread.id}`}
                onClick={() => onUnsettle(row)}
              >
                <RotateCcwIcon className="size-3.5" />
              </PhaseRowAction>
            ) : null
          ) : (
            <>
              {canSnoozeRow ? (
                <PhaseSnoozePopoverButton
                  open={snoozeMenuOpen}
                  label={`Snooze ${row.thread.title}`}
                  testId={`phase-thread-snooze-${row.thread.id}`}
                  onOpenChange={setSnoozeMenuOpen}
                  onSnooze={(preset) => onSnooze(row, preset)}
                />
              ) : null}
              {row.settlementSupported ? (
                <PhaseRowAction
                  label={`Settle ${row.thread.title}`}
                  tooltip="Settle"
                  testId={`phase-thread-settle-${row.thread.id}`}
                  onClick={() => onSettle(row)}
                >
                  <CheckIcon className="size-3.5" />
                </PhaseRowAction>
              ) : null}
            </>
          )}
          <PhaseRowAction
            label={`Archive ${row.thread.title}`}
            tooltip="Archive"
            onClick={() => onArchive(row)}
          >
            <ArchiveIcon className="size-3.5" />
          </PhaseRowAction>
        </span>
        {/* T3-CUSTOM(expbkt3): END */}
      </button>
    </li>
  );
});

function NewThreadProjectPicker({
  open,
  projects,
  activeProject,
  onOpenChange,
  onSelect,
  onAddProject,
  onAttachExternalSession,
}: {
  readonly open: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly activeProject: Project | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (project: Project) => void;
  readonly onAddProject: () => void;
  // T3-CUSTOM(expbkt3): attach-to-external-session.
  readonly onAttachExternalSession: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Choose a project</DialogTitle>
          <DialogDescription>
            Start the new thread in one of your available projects.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1">
          {projects.map((project) => (
            <button
              type="button"
              key={scopedProjectKey(scopeProjectRef(project.environmentId, project.id))}
              autoFocus={activeProject === project}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent",
                activeProject === project && "bg-accent/70",
              )}
              onClick={() => onSelect(project)}
            >
              <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
            </button>
          ))}
          <button
            type="button"
            className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onAddProject}
          >
            <FolderPlusIcon className="size-4" />
            Add project
          </button>
          {/* T3-CUSTOM(expbkt3): continue a Claude/Codex session started in a
              terminal, instead of only ever starting fresh ones. */}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onAttachExternalSession}
          >
            <Link2Icon className="size-4" />
            Attach existing session
          </button>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function PhaseGroupedSidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { networkStatus, environments } = useEnvironments();
  const allEnvironmentShellsLive = useAtomValue(allEnvironmentShellsLiveAtom);
  const router = useRouter();
  const routeParams = useParams({ strict: false });
  const { isMobile, setOpenMobile } = useSidebar();
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useOpenAddProjectCommandPalette();
  const {
    archiveThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
  } = useThreadActions();
  const reconnectThreadSession = useReconnectThreadSession();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const currentUserId = useCurrentUserId();
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze clocks. `now` is quantized to
  // the minute so the settled partition does not churn on every render
  // (auto-settle thresholds are day-granular anyway); snooze wake times are
  // second-precise, so a separate tick fires exactly at the next wake
  // boundary and the partition reads a fresh clock when it recomputes.
  const nowMinute = useNowMinute();
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): Reserve one permanent row outside normal lifecycle groups.
  const legacyT3Conductor = usePrimarySettings((settings) => settings.experimental.t3Conductor);
  const { profile: personalMcpProfile } = usePersonalMcpProfile();
  const t3Conductor = personalMcpProfile?.conductor ?? legacyT3Conductor;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const filters = usePhaseSidebarFilterStore(
    useShallow((state) => ({
      repositoryKeys: state.repositoryKeys,
      phaseIds: state.phaseIds,
      providerKinds: state.providerKinds,
      assignedToMe: state.assignedToMe,
    })),
  );
  const clearFilters = usePhaseSidebarFilterStore((state) => state.clearAll);
  const reconcileFilters = usePhaseSidebarFilterStore((state) => state.reconcile);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  // T3-CUSTOM(expbkt3): attach-to-external-session.
  const [attachSessionOpen, setAttachSessionOpen] = useState(false);
  const [vcsStatusByThreadKey, setVcsStatusByThreadKey] = useState<
    ReadonlyMap<string, VcsStatusResult | null>
  >(() => new Map());
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const renameCommitInFlightRef = useRef(false);
  const lastKnownPhaseByThreadKeyRef = useRef(new Map<string, PhaseSidebarPhaseId>());
  const shortcutModifiers = useShortcutModifierState();
  const routeRef = resolveThreadRouteRef(routeParams);
  const routeThreadKey = routeRef ? scopedThreadKey(routeRef) : null;
  const projectByKey = useMemo(
    () =>
      new Map(
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
  const providerOptions = useMemo(() => {
    const options = new Map<string, ProviderOption>();
    for (const config of serverConfigs.values()) {
      for (const provider of config.providers) {
        const kind = String(provider.driver);
        const name = provider.displayName ?? kind;
        const existing = options.get(kind);
        if (!existing || name.localeCompare(existing.name) < 0) {
          options.set(kind, {
            kind,
            name,
            code: resolvePhaseSidebarProviderCode(kind),
          });
        }
      }
    }
    for (const thread of threads) {
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const provider = serverConfigs
        .get(thread.environmentId)
        ?.providers.find((candidate) => candidate.instanceId === instanceId);
      const kind = String(provider?.driver ?? instanceId);
      if (!options.has(kind)) {
        options.set(kind, {
          kind,
          name: provider?.displayName ?? thread.session?.providerName ?? String(instanceId),
          code: resolvePhaseSidebarProviderCode(kind),
        });
      }
    }
    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [serverConfigs, threads]);
  const providerLabels = useMemo(
    () => new Map(providerOptions.map((option) => [option.kind, option.name])),
    [providerOptions],
  );
  const recordWorkflowStatus = useCallback((threadKey: string, status: VcsStatusResult | null) => {
    setVcsStatusByThreadKey((current) => {
      if (current.get(threadKey) === status) return current;
      const next = new Map(current);
      next.set(threadKey, status);
      return next;
    });
  }, []);
  const allRows = useMemo<ReadonlyArray<PhaseSidebarRow>>(
    () =>
      threads
        // T3-CUSTOM(expbkt3): Conductor owns a fixed command-deck card.
        .filter(
          (thread) =>
            !T3_CONDUCTOR_ENABLED ||
            !isT3ConductorThread(t3Conductor, primaryEnvironmentId, thread),
        )
        .map((thread) => {
          const project = projectByKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          const repositoryKey = project
            ? derivePhaseSidebarRepositoryKey(project)
            : scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
          const serverConfig = serverConfigs.get(thread.environmentId);
          const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
          const provider = serverConfig?.providers.find(
            (candidate) => candidate.instanceId === instanceId,
          );
          const providerKind = String(provider?.driver ?? instanceId);
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const vcsStatus = vcsStatusByThreadKey.get(threadKey);
          const currentPhase = resolvePhaseSidebarPhase(thread, vcsStatus);
          const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
          const lastVisitedAt = Date.parse(lastVisitedAtByThreadKey[threadKey] ?? "");
          const isUnreadCompletion =
            Number.isFinite(completedAt) &&
            (!Number.isFinite(lastVisitedAt) || completedAt > lastVisitedAt);
          return {
            thread,
            phaseId: resolvePhaseSidebarDisplayPhase(
              currentPhase,
              allEnvironmentShellsLive
                ? null
                : (lastKnownPhaseByThreadKeyRef.current.get(threadKey) ?? null),
            ),
            repositoryKey,
            repositoryLabel:
              project?.title ?? repositoryLabels.get(repositoryKey) ?? "Unknown repository",
            providerKind,
            providerName:
              provider?.displayName ?? thread.session?.providerName ?? String(instanceId),
            isAssignedToMe: currentUserId !== null && isThreadAssignedToUser(thread, currentUserId),
            attentionPriority: resolvePhaseSidebarAttentionPriority(thread, vcsStatus),
            unreadPriority: isUnreadCompletion ? 0 : 1,
            // T3-CUSTOM(expbkt3): BEGIN — lifecycle parking inputs.
            settlementSupported: serverConfig?.environment.capabilities.threadSettlement === true,
            snoozeSupported: serverConfig?.environment.capabilities.threadSnooze === true,
            prioritySupported: serverConfig?.environment.capabilities.threadPriority === true,
            changeRequestState: vcsStatus?.pr?.state ?? null,
            // T3-CUSTOM(expbkt3): END
          };
        }),
    [
      projectByKey,
      repositoryLabels,
      serverConfigs,
      threads,
      allEnvironmentShellsLive,
      currentUserId,
      lastVisitedAtByThreadKey,
      primaryEnvironmentId,
      t3Conductor,
      vcsStatusByThreadKey,
    ],
  );
  // T3-CUSTOM(expbkt3): BEGIN — split the inbox from the parked shelves.
  // Filtering happens once, before the partition, so a filter chip means the
  // same thing in the lifecycle groups and on both shelves.
  const { activeRows, snoozedRows, settledRows } = useMemo(() => {
    // Snooze classification uses a REAL clock, not the quantized minute: a
    // thread whose wake time just passed must leave the shelf immediately.
    // snoozeWakeTick re-runs this at the exact boundary.
    void snoozeWakeTick;
    return partitionPhaseSidebarRows(filterVisiblePhaseSidebarRows(allRows, filters), {
      now: nowMinute,
      preciseNow: new Date().toISOString(),
      autoSettleAfterDays,
    });
  }, [allRows, autoSettleAfterDays, filters, nowMinute, snoozeWakeTick]);

  // Wake exactly when the soonest snooze expires (the shelf is sorted, so
  // that is the first row). Clamped at 0, and capped so a far-future wake
  // does not overflow the timer into an immediate fire.
  useEffect(() => {
    const nextWakeMs = Date.parse(snoozedRows[0]?.thread.snoozedUntil ?? "");
    if (!Number.isFinite(nextWakeMs)) return;
    const delayMs = Math.min(Math.max(nextWakeMs - Date.now(), 0), 2_147_483_000);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedRows]);

  const groups = useMemo(
    () => buildPhaseSidebarGroups(activeRows, filters, sortOrder),
    [activeRows, filters, sortOrder],
  );
  const activeVisibleRows = useMemo(() => flattenPhaseSidebarGroups(groups), [groups]);

  // The settled tail renders in pages: history must not dominate the list.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  // The snoozed shelf is collapsed by default (out of the way, never gone);
  // the settled tail stays open because it is the ordinary "what did I just
  // finish" lookup.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), []);
  // A parked row reached by route (deep link, or the row you just settled)
  // always renders, even inside a collapsed or paged-out shelf: otherwise
  // the thread you are looking at has no un-settle or wake affordance.
  const pinRoutedRow = useCallback(
    (rendered: ReadonlyArray<PhaseSidebarRow>, all: ReadonlyArray<PhaseSidebarRow>) => {
      if (routeThreadKey === null) return rendered;
      if (
        rendered.some(
          (row) =>
            scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) ===
            routeThreadKey,
        )
      ) {
        return rendered;
      }
      const routedRow = all.find(
        (row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) ===
          routeThreadKey,
      );
      return routedRow ? [...rendered, routedRow] : rendered;
    },
    [routeThreadKey],
  );
  const renderedSnoozedRows = useMemo(
    () => pinRoutedRow(snoozedShelfExpanded ? snoozedRows : [], snoozedRows),
    [pinRoutedRow, snoozedRows, snoozedShelfExpanded],
  );
  const visibleSettledRows = useMemo(
    () => pinRoutedRow(settledRows.slice(0, settledVisibleCount), settledRows),
    [pinRoutedRow, settledRows, settledVisibleCount],
  );
  const hiddenSettledCount = settledRows.length - visibleSettledRows.length;
  const renderedSettledRows = useMemo(
    () => pinRoutedRow(settledShelfExpanded ? visibleSettledRows : [], visibleSettledRows),
    [pinRoutedRow, settledShelfExpanded, visibleSettledRows],
  );
  // Traversal, jump labels and shift-range selection operate on what is
  // actually on screen, shelves included.
  const visibleRows = useMemo(
    () => [...activeVisibleRows, ...renderedSnoozedRows, ...renderedSettledRows],
    [activeVisibleRows, renderedSnoozedRows, renderedSettledRows],
  );
  // T3-CUSTOM(expbkt3): END

  useEffect(() => {
    const next = new Map(lastKnownPhaseByThreadKeyRef.current);
    for (const row of allRows) {
      if (allEnvironmentShellsLive || row.phaseId !== "checking") {
        next.set(
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
          row.phaseId,
        );
      }
    }
    if (allEnvironmentShellsLive) {
      const currentKeys = new Set(
        allRows.map((row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
        ),
      );
      for (const threadKey of next.keys()) {
        if (!currentKeys.has(threadKey)) next.delete(threadKey);
      }
    }
    lastKnownPhaseByThreadKeyRef.current = next;
  }, [allEnvironmentShellsLive, allRows]);
  const visibleThreadKeys = useMemo(
    () =>
      visibleRows.map((row) =>
        scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)),
      ),
    [visibleRows],
  );
  const visibleRowByKey = useMemo(
    () => new Map(visibleThreadKeys.map((key, index) => [key, visibleRows[index]!])),
    [visibleRows, visibleThreadKeys],
  );
  const activeFiltersCount =
    filters.repositoryKeys.length +
    filters.phaseIds.length +
    filters.providerKinds.length +
    (filters.assignedToMe ? 1 : 0);
  const activeThreadHidden =
    activeFiltersCount > 0 &&
    routeThreadKey !== null &&
    allRows.some(
      (row) =>
        row.thread.archivedAt === null &&
        scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) === routeThreadKey,
    ) &&
    !visibleRowByKey.has(routeThreadKey);
  const activeThread = routeRef
    ? (threads.find(
        (thread) =>
          thread.environmentId === routeRef.environmentId && thread.id === routeRef.threadId,
      ) ?? null)
    : null;
  const activeProject = activeThread
    ? (projectByKey.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? null)
    : null;
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    {
      platform: navigator.platform,
      context: { terminalFocus: false, terminalOpen: false },
    },
  );
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new", {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen: false },
  });
  const showJumpHints = shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen: false, modelPickerOpen: false },
  });
  const jumpLabelByKey = useMemo(() => {
    if (!showJumpHints) return new Map<string, string>();
    const labels = new Map<string, string>();
    visibleThreadKeys.forEach((key, index) => {
      const command = threadJumpCommandForIndex(index);
      if (!command) return;
      const label = shortcutLabelForCommand(keybindings, command, {
        platform: navigator.platform,
        context: { terminalFocus: false, terminalOpen: false },
      });
      if (label) labels.set(key, label);
    });
    return labels;
  }, [keybindings, showJumpHints, visibleThreadKeys]);
  const animatedLists = useRef(new WeakSet<HTMLElement>());
  const attachAutoAnimate = useCallback((node: HTMLElement | null) => {
    if (!node || animatedLists.current.has(node)) return;
    autoAnimate(node, { duration: 180, easing: "ease-out" });
    animatedLists.current.add(node);
  }, []);

  useEffect(() => {
    if (
      !allEnvironmentShellsLive ||
      networkStatus !== "online" ||
      environments.length === 0 ||
      serverConfigs.size !== environments.length
    ) {
      return;
    }
    reconcileFilters({
      repositoryKeys: new Set(repositoryOptions.map((option) => option.key)),
      providerKinds: new Set(providerOptions.map((option) => option.kind)),
      assignmentAvailable: currentUserId !== null,
    });
  }, [
    allEnvironmentShellsLive,
    currentUserId,
    environments.length,
    networkStatus,
    providerOptions,
    reconcileFilters,
    repositoryOptions,
    serverConfigs.size,
  ]);

  const navigateToRow = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [isMobile, router, setOpenMobile],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      const targetKey =
        direction !== null
          ? resolvePhaseSidebarTraversalTarget({
              visibleThreadKeys,
              currentThreadKey: routeThreadKey,
              direction,
            })
          : jumpIndex !== null
            ? (visibleThreadKeys[jumpIndex] ?? null)
            : null;
      const row = targetKey ? visibleRowByKey.get(targetKey) : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToRow(scopeThreadRef(row.thread.environmentId, row.thread.id));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigateToRow, routeThreadKey, visibleRowByKey, visibleThreadKeys]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      useThreadSelectionStore.getState().clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);

  const startRename = useCallback((row: PhaseSidebarRow) => {
    renameCommitInFlightRef.current = false;
    setRenamingThreadKey(scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)));
    setRenameTitle(row.thread.title);
  }, []);
  const cancelRename = useCallback(() => {
    renameCommitInFlightRef.current = false;
    setRenamingThreadKey(null);
    setRenameTitle("");
  }, []);
  const commitRename = useCallback(
    (row: PhaseSidebarRow) => {
      if (renameCommitInFlightRef.current) return;
      renameCommitInFlightRef.current = true;
      const title = renameTitle.trim();
      setRenamingThreadKey(null);
      if (!title || title === row.thread.title) {
        renameCommitInFlightRef.current = false;
        return;
      }
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, title },
      })
        .then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to rename thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })
        .finally(() => {
          renameCommitInFlightRef.current = false;
        });
    },
    [renameTitle, updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): BEGIN — session priority.
  const setThreadPriority = useCallback(
    (row: PhaseSidebarRow, priority: 0 | 1 | 2 | 3 | 4 | null) => {
      if (row.thread.priority === priority) return;
      void updateThreadMetadata({
        environmentId: row.thread.environmentId,
        input: { threadId: row.thread.id, priority },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to set priority",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      });
    },
    [updateThreadMetadata],
  );
  // T3-CUSTOM(expbkt3): END
  const requestArchive = useCallback(
    async (row: PhaseSidebarRow) => {
      if (confirmArchive) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          `Archive thread "${row.thread.title}"?`,
        );
        if (!confirmed) return;
      }
      const result = await archiveThread(scopeThreadRef(row.thread.environmentId, row.thread.id));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread, confirmArchive],
  );
  // T3-CUSTOM(expbkt3): BEGIN — settle/snooze commands.
  // Refs keep these callbacks stable: they are handed to a memoized row, so
  // depending on the route or the row list directly would re-render every
  // row on each navigation. They also have to read the CURRENT route when a
  // command resolves, not the one captured when it started.
  const activeVisibleRowsRef = useRef(activeVisibleRows);
  activeVisibleRowsRef.current = activeVisibleRows;
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  // One parking command per thread at a time: a double click must not
  // dispatch a second settle that fails and toasts a false error.
  const parkingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you are looking at moves you forward to the next
  // lifecycle row — never into a shelf, since that is what you just left.
  const planForwardNavigation = useCallback(
    (threadKey: string) => {
      const rows = activeVisibleRowsRef.current;
      const index = rows.findIndex(
        (row) =>
          scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id)) === threadKey,
      );
      if (index === -1) return null;
      const target = rows[index + 1] ?? rows[index - 1] ?? null;
      if (!target) return null;
      return () => navigateToRow(scopeThreadRef(target.thread.environmentId, target.thread.id));
    },
    [navigateToRow],
  );
  const reportParkingFailure = useCallback((title: string, result: ParkingCommandFailure) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
  const attemptUnsnooze = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const result = await unsnoozeThread(
          scopeThreadRef(row.thread.environmentId, row.thread.id),
        );
        if (result._tag === "Failure") reportParkingFailure("Failed to wake thread", result);
      })();
    },
    [reportParkingFailure, unsnoozeThread],
  );
  const attemptUnsettle = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const result = await unsettleThread(
          scopeThreadRef(row.thread.environmentId, row.thread.id),
        );
        if (result._tag === "Failure") reportParkingFailure("Failed to un-settle thread", result);
      })();
    },
    [reportParkingFailure, unsettleThread],
  );
  const attemptSettle = useCallback(
    (row: PhaseSidebarRow) => {
      void (async () => {
        const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
        const threadKey = scopedThreadKey(threadRef);
        if (parkingThreadKeysRef.current.has(threadKey)) return;
        parkingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey);
          const result = await settleThread(threadRef);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
            reportParkingFailure("Failed to settle thread", result);
            return;
          }
          // Settle is a high-frequency action and stays silent on success.
          // Only move forward if the user is still on the settled thread — a
          // navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) navigateAfterSettle?.();
        } finally {
          parkingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, reportParkingFailure, settleThread],
  );
  const attemptSnooze = useCallback(
    (row: PhaseSidebarRow, preset: SnoozePreset) => {
      void (async () => {
        const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
        const threadKey = scopedThreadKey(threadRef);
        if (parkingThreadKeysRef.current.has(threadKey)) return;
        parkingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSnooze = planForwardNavigation(threadKey);
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            reportParkingFailure("Failed to snooze thread", result);
            return;
          }
          // Snooze moves the row to a collapsed shelf, so the toast is the
          // only confirmation — and the Undo is the escape hatch for a
          // mis-click.
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date())}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(row),
              },
            }),
          );
          if (routeThreadKeyRef.current === threadKey) navigateAfterSnooze?.();
        } finally {
          parkingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [attemptUnsnooze, planForwardNavigation, reportParkingFailure, snoozeThread],
  );
  // T3-CUSTOM(expbkt3): END
  const requestDelete = useCallback(
    (row: PhaseSidebarRow) => {
      void confirmAndDeleteThread(scopeThreadRef(row.thread.environmentId, row.thread.id)).then(
        (result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        },
      );
    },
    [confirmAndDeleteThread],
  );
  // Stable identity for the memoized row (an inline arrow defeated it).
  const handleArchive = useCallback(
    (row: PhaseSidebarRow) => void requestArchive(row),
    [requestArchive],
  );
  const startGlobalNewThread = useCallback(() => {
    if (projects.length === 1 && projects[0]) {
      void handleNewThread(scopeProjectRef(projects[0].environmentId, projects[0].id));
      return;
    }
    setProjectPickerOpen(true);
  }, [handleNewThread, projects]);
  const selectNewThreadProject = useCallback(
    (project: Project) => {
      setProjectPickerOpen(false);
      void handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [handleNewThread],
  );

  // T3-CUSTOM(expbkt3): One row shape for the lifecycle groups and both
  // parked shelves — only `section` differs.
  const renderThreadRow = (row: PhaseSidebarRow, section: PhaseSidebarSection) => {
    const key = scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
    const project =
      projectByKey.get(
        scopedProjectKey(scopeProjectRef(row.thread.environmentId, row.thread.projectId)),
      ) ?? null;
    return (
      <PhaseThreadRow
        key={key}
        row={row}
        section={section}
        project={project}
        vcsStatus={vcsStatusByThreadKey.get(key) ?? null}
        active={routeThreadKey === key}
        orderedThreadKeys={visibleThreadKeys}
        jumpLabel={jumpLabelByKey.get(key) ?? null}
        renaming={renamingThreadKey === key}
        renameTitle={renameTitle}
        onRenameTitleChange={setRenameTitle}
        onStartRename={startRename}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onNavigate={navigateToRow}
        onReconnect={reconnectThreadSession}
        onArchive={handleArchive}
        onDelete={requestDelete}
        onSettle={attemptSettle}
        onUnsettle={attemptUnsettle}
        onSnooze={attemptSnooze}
        onUnsnooze={attemptUnsnooze}
        onSetPriority={setThreadPriority}
      />
    );
  };

  return (
    <>
      {threads.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const project =
          projectByKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          ) ?? null;
        return (
          <ThreadWorkflowProbe
            key={`workflow:${key}`}
            thread={thread}
            project={project}
            onStatus={recordWorkflowStatus}
          />
        );
      })}
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-2 pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarSearchAction shortcutLabel={commandPaletteShortcutLabel} />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5"
                onClick={startGlobalNewThread}
              >
                <PlusIcon className="size-3.5" />
                <span className="flex-1 text-left text-xs">New thread</span>
                {newThreadShortcutLabel ? (
                  <Kbd className="h-4 px-1.5 text-[10px]">{newThreadShortcutLabel}</Kbd>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarEnvironmentNotices />
        {/* T3-CUSTOM(expbkt3): Permanent orchestration home above lifecycle rows. */}
        {T3_CONDUCTOR_ENABLED ? (
          <T3ConductorCard
            shellReady={allEnvironmentShellsLive && networkStatus === "online"}
            activeThreadKey={routeThreadKey}
            onNavigate={navigateToRow}
          />
        ) : null}
        <SidebarGroup className="px-2 pt-1 pb-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Lifecycle
            </span>
            <PhaseFilterPopover repositories={repositoryOptions} providers={providerOptions} />
          </div>
          <ActiveFilterChips repositoryLabels={repositoryLabels} providerLabels={providerLabels} />
        </SidebarGroup>
        {activeThreadHidden ? (
          <div className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
            <span>Current thread is hidden by filters</span>
            <button
              type="button"
              className="shrink-0 text-foreground hover:underline"
              onClick={clearFilters}
            >
              Clear
            </button>
          </div>
        ) : null}
        <div
          ref={attachAutoAnimate}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          data-testid="phase-sidebar-groups"
        >
          {groups.map((group) => (
            <section key={group.id} className="mb-3" data-phase-id={group.id}>
              <header className="mb-1 flex items-center gap-2 px-2">
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", PHASE_ACCENT_CLASS[group.id])}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
                  {group.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground/50">
                  {group.helperText}
                </span>
                <span className="text-[9px] tabular-nums text-muted-foreground/55">
                  {group.rows.length}
                </span>
              </header>
              <ul ref={attachAutoAnimate} className="space-y-0.5">
                {group.rows.map((row) => renderThreadRow(row, "active"))}
              </ul>
            </section>
          ))}
          {/* T3-CUSTOM(expbkt3): BEGIN — parked shelves below the lifecycle
              groups: out of the way, never gone, always undoable. */}
          {snoozedRows.length > 0 ? (
            <section className="mb-3" data-testid="phase-sidebar-snoozed-shelf">
              <button
                type="button"
                onClick={toggleSnoozedShelf}
                aria-expanded={snoozedShelfExpanded}
                data-testid="phase-sidebar-snoozed-shelf-toggle"
                className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left"
              >
                <AlarmClockIcon
                  aria-hidden
                  className="size-2.5 shrink-0 text-blue-600 dark:text-blue-400"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  Snoozed
                </span>
                <span className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
                <span className="text-[9px] tabular-nums text-muted-foreground/55">
                  {snoozedRows.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-blue-600 transition-transform dark:text-blue-400",
                    snoozedShelfExpanded && "rotate-180",
                  )}
                />
              </button>
              <ul ref={attachAutoAnimate} className="space-y-0.5">
                {renderedSnoozedRows.map((row) => renderThreadRow(row, "snoozed"))}
              </ul>
            </section>
          ) : null}
          {settledRows.length > 0 ? (
            <section className="mb-3" data-testid="phase-sidebar-settled-shelf">
              <button
                type="button"
                onClick={toggleSettledShelf}
                aria-expanded={settledShelfExpanded}
                data-testid="phase-sidebar-settled-shelf-toggle"
                className="mb-1 flex w-full cursor-pointer items-center gap-2 px-2 text-left"
              >
                <CheckIcon aria-hidden className="size-2.5 shrink-0 text-muted-foreground/50" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Settled
                </span>
                <span className="h-px flex-1 bg-sidebar-border/60" />
                <span className="text-[9px] tabular-nums text-muted-foreground/55">
                  {settledRows.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-muted-foreground/50 transition-transform",
                    settledShelfExpanded && "rotate-180",
                  )}
                />
              </button>
              <ul ref={attachAutoAnimate} className="space-y-0.5">
                {renderedSettledRows.map((row) => renderThreadRow(row, "settled"))}
              </ul>
              {settledShelfExpanded && hiddenSettledCount > 0 ? (
                <button
                  type="button"
                  onClick={showMoreSettled}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:text-foreground"
                >
                  Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                  <span className="text-muted-foreground/50">({hiddenSettledCount} hidden)</span>
                </button>
              ) : null}
            </section>
          ) : null}
          {/* T3-CUSTOM(expbkt3): END */}
          {groups.length + snoozedRows.length + settledRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <FilterIcon className="size-5 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No threads match these filters</p>
              {activeFiltersCount > 0 ? (
                <Button size="xs" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarChromeFooter />
      {activeVisibleRows.slice(0, 10).map((row) => (
        <SidebarThreadDetailPrewarmer
          key={`prewarm:${row.thread.environmentId}:${row.thread.id}`}
          threadRef={scopeThreadRef(row.thread.environmentId, row.thread.id)}
        />
      ))}
      <NewThreadProjectPicker
        open={projectPickerOpen}
        projects={projects}
        activeProject={activeProject}
        onOpenChange={setProjectPickerOpen}
        onSelect={selectNewThreadProject}
        onAddProject={() => {
          setProjectPickerOpen(false);
          openAddProject();
        }}
        onAttachExternalSession={() => {
          setProjectPickerOpen(false);
          setAttachSessionOpen(true);
        }}
      />
      {/* T3-CUSTOM(expbkt3): attach-to-external-session. */}
      <AttachExternalSessionDialog open={attachSessionOpen} onOpenChange={setAttachSessionOpen} />
    </>
  );
}

export default PhaseGroupedSidebar;
