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
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind, type ScopedThreadRef, type VcsStatusResult } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  FilterIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LaptopIcon,
  PlusIcon,
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
import { useClientSettings, usePrimarySettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
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
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import {
  PHASE_SIDEBAR_PHASES,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  buildPhaseSidebarRepositoryOptions,
  derivePhaseSidebarRepositoryKey,
  flattenPhaseSidebarGroups,
  isThreadAssignedToUser,
  resolvePhaseSidebarAttentionPriority,
  resolvePhaseSidebarCheckoutMetadata,
  resolvePhaseSidebarDisplayPhase,
  resolvePhaseSidebarPhase,
  resolvePhaseSidebarLinearIssue,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarTraversalTarget,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./sidebar/PhaseGroupedSidebar.logic";
import { useCurrentUserId } from "../state/identity";
import {
  SidebarChromeFooter,
  SidebarChromeHeader,
  SidebarEnvironmentNotices,
} from "./sidebar/SidebarChrome";
import { SidebarSearchAction } from "./sidebar/SidebarSearchAction";
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

function phaseRowClassName(
  isActive: boolean,
  isSelected: boolean,
  needsUserInput: boolean,
): string {
  return cn(
    "group/phase-row relative flex min-h-11 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    isActive && isSelected
      ? "bg-primary/22 text-foreground dark:bg-primary/30"
      : isSelected
        ? "bg-primary/15 text-foreground dark:bg-primary/22"
        : isActive
          ? "bg-accent/85 text-foreground dark:bg-accent/55"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
    // T3-CUSTOM(expbkt3): Flash only structured-question rows in the experimental sidebar.
    needsUserInput &&
      "animate-[pulse_1.25s_ease-in-out_infinite] bg-red-500/20 text-foreground ring-1 ring-inset ring-red-500/60 shadow-[inset_3px_0_0_0_var(--color-red-500),0_0_14px_rgba(239,68,68,0.22)] hover:bg-red-500/30 motion-reduce:animate-none",
  );
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

interface PhaseThreadRowProps {
  readonly row: PhaseSidebarRow;
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
}

const PhaseThreadRow = memo(function PhaseThreadRow(props: PhaseThreadRowProps) {
  const {
    row,
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
    const action = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename" },
        { id: "mark-unread", label: "Mark unread" },
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
        className={phaseRowClassName(active, selected, needsUserInput)}
        data-attention={needsUserInput ? "user-input" : undefined}
        data-testid={`phase-thread-row-${row.thread.id}`}
        onClick={handleClick}
        onDoubleClick={() => onStartRename(row)}
        onContextMenu={(event) => void handleContextMenu(event)}
      >
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
          {needsUserInput ? (
            <span className="rounded-sm bg-red-500 px-1 py-0.5 text-[8px] font-black tracking-wide text-white shadow-sm">
              INPUT
            </span>
          ) : null}
          {jumpLabel ? (
            <Kbd className="h-4 min-w-0 rounded-sm px-1 text-[9px]">{jumpLabel}</Kbd>
          ) : null}
          <span className="text-[9px] tabular-nums text-muted-foreground/50">
            {formatRelativeTimeLabel(row.thread.updatedAt).replace(" ago", "")}
          </span>
        </span>
        {/* T3-CUSTOM(expbkt3): BEGIN — hover action overlays the row instead of reflowing metadata. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="button"
                tabIndex={0}
                aria-label={`Archive ${row.thread.title}`}
                className="absolute top-1/2 right-1 z-10 hidden size-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground group-hover/phase-row:inline-flex group-focus-within/phase-row:inline-flex"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onArchive(row);
                }}
              />
            }
          >
            <ArchiveIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Archive</TooltipPopup>
        </Tooltip>
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
}: {
  readonly open: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly activeProject: Project | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (project: Project) => void;
  readonly onAddProject: () => void;
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
  const { archiveThread, confirmAndDeleteThread } = useThreadActions();
  const reconnectThreadSession = useReconnectThreadSession();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const currentUserId = useCurrentUserId();
  // T3-CUSTOM(expbkt3): Reserve one permanent row outside normal lifecycle groups.
  const t3Conductor = usePrimarySettings((settings) => settings.experimental.t3Conductor);
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
        .filter((thread) => !isT3ConductorThread(t3Conductor, primaryEnvironmentId, thread))
        .map((thread) => {
          const project = projectByKey.get(
            scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
          );
          const repositoryKey = project
            ? derivePhaseSidebarRepositoryKey(project)
            : scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
          const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
          const provider = serverConfigs
            .get(thread.environmentId)
            ?.providers.find((candidate) => candidate.instanceId === instanceId);
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
  const groups = useMemo(
    () => buildPhaseSidebarGroups(allRows, filters, sortOrder),
    [allRows, filters, sortOrder],
  );
  const visibleRows = useMemo(() => flattenPhaseSidebarGroups(groups), [groups]);

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
        <T3ConductorCard
          shellReady={allEnvironmentShellsLive && networkStatus === "online"}
          activeThreadKey={routeThreadKey}
          onNavigate={navigateToRow}
        />
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
                {group.rows.map((row) => {
                  const threadRef = scopeThreadRef(row.thread.environmentId, row.thread.id);
                  const key = scopedThreadKey(threadRef);
                  const project =
                    projectByKey.get(
                      scopedProjectKey(
                        scopeProjectRef(row.thread.environmentId, row.thread.projectId),
                      ),
                    ) ?? null;
                  return (
                    <PhaseThreadRow
                      key={key}
                      row={row}
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
                      onArchive={(target) => void requestArchive(target)}
                      onDelete={requestDelete}
                    />
                  );
                })}
              </ul>
            </section>
          ))}
          {groups.length === 0 ? (
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
      {visibleRows.slice(0, 10).map((row) => (
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
      />
    </>
  );
}

export default PhaseGroupedSidebar;
