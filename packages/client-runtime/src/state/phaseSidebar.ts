// T3-CUSTOM(expbkt3): Phase-grouped session list logic, shared by web and mobile.
//
// This is the pure half of the fork's experimental "control center" sidebar:
// which lifecycle phase a thread is in, how rows partition into active,
// snoozed and settled shelves, what the priority / Linear / pull-request /
// worktree badges say, how filters and sorting behave, and the lifecycle
// counters.
//
// It lives in client-runtime rather than apps/web because the mobile app needs
// exactly the same answers and cannot import from apps/web. The web sidebar
// keeps a re-export shim at
// apps/web/src/components/sidebar/PhaseGroupedSidebar.logic.ts, which also
// holds the Tailwind class-name helpers — those must stay under apps/web,
// where Tailwind scans for literal class names.
//
// HERMES. Everything here also runs on React Native, whose Hermes engine does
// not ship the ES2023 change-array-by-copy methods. Sort a copy with `.sort()`;
// never reach for `.toSorted()`. phaseSidebar.test.ts asserts this by deleting
// the method from Array.prototype.
import type { ServerConfig, UserId, VcsStatusResult } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { resolveChangeRequestPresentation } from "@t3tools/shared/sourceControl";
// T3-CUSTOM(expbkt3): memorable worktree codenames.
import {
  disambiguateWorktreeCodenames,
  resolveWorktreeCodename,
  worktreeCodenameToneIndex,
} from "@t3tools/shared/worktreeCodename";

import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "../environment/scoped.ts";
import { deriveLogicalProjectKey } from "./projectGrouping.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./shell.ts";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "./threadSettled.ts";
import { getThreadSortTimestamp } from "./threadSort.ts";

/**
 * The two shapes every helper here works with. Aliased rather than imported
 * under these names so the moved code reads exactly as it did under apps/web,
 * where `../../types` aliases the same two client-runtime types.
 */
type Project = EnvironmentProject;
type ThreadShell = EnvironmentThreadShell;

/**
 * Copied from upstream's apps/web/src/components/Sidebar.logic.ts rather than
 * imported: that file is upstream-owned, and re-exporting from it would put a
 * fork edit inside it for no functional gain. Both are small, pure and stable
 * — but if upstream changes the settled-sort rule, change it here too.
 */
function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/**
 * The timestamp a settled row sorts and labels by: settledAt when stamped,
 * otherwise last activity, with updatedAt as the final net. See the note on
 * firstValidTimestamp above for why this is a copy.
 */
function resolveSettledTimestamp(
  thread: Pick<ThreadShell, "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt">,
): string | null {
  const settledAt = firstValidTimestamp(thread.settledAt);
  if (settledAt !== null) return settledAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? firstValidTimestamp(thread.updatedAt);
}

export const PHASE_SIDEBAR_PHASE_IDS = [
  "needs_input",
  "plan_ready",
  "ready",
  "planning",
  "implementing",
] as const;

export type PhaseSidebarPhaseId = (typeof PHASE_SIDEBAR_PHASE_IDS)[number];

export interface PhaseSidebarCheckoutMetadata {
  readonly kind: "current" | "worktree";
  readonly label: string;
  readonly tooltip: string;
  /**
   * Color bucket for the codename, or `null` for a current checkout. Consumers
   * map this through a static class table — see `PHASE_SIDEBAR_CHECKOUT_TONES`.
   */
  readonly toneIndex: number | null;
}

/**
 * T3-CUSTOM(expbkt3): Other threads sharing this thread's worktree. Two agents
 * editing one directory at the same time is a real hazard, and without this it
 * is invisible.
 */
export interface PhaseSidebarWorktreeSharing {
  /** Threads occupying the worktree. Always >= 2 when present. */
  readonly count: number;
  /**
   * Pre-joined thread titles for the tooltip. A string rather than an array so
   * it can cross the memo'd row boundary as a prop without defeating the memo.
   */
  readonly summary: string;
}

/**
 * T3-CUSTOM(expbkt3): Keep checkout semantics explicit in the experimental
 * sidebar. Current checkouts show their live branch; dedicated worktrees show
 * their codename — a short, memorable name derived from the worktree path, so
 * that two rows in the same worktree read identically and two rows in different
 * worktrees read differently at a glance. The ref the worktree was created from
 * moves into the tooltip, which is where it was actually being read anyway.
 */
export function resolvePhaseSidebarCheckoutMetadata(
  thread: Pick<ThreadShell, "branch" | "worktreePath">,
  vcsStatus: Pick<VcsStatusResult, "refName" | "baseRef" | "pr"> | null | undefined,
  options?: {
    /** Label from `disambiguateWorktreeCodenames`, when the view resolved one. */
    readonly codename?: string | null;
    readonly sharing?: PhaseSidebarWorktreeSharing | null;
  },
): PhaseSidebarCheckoutMetadata {
  if (thread.worktreePath) {
    const baseRef = vcsStatus?.pr?.baseRef ?? vcsStatus?.baseRef ?? null;
    const codename = options?.codename ?? resolveWorktreeCodename(thread.worktreePath);
    const sharing = options?.sharing ?? null;

    const tooltipParts = [`Worktree ${codename}`];
    if (baseRef) tooltipParts.push(`from ${baseRef}`);
    tooltipParts.push(thread.worktreePath);
    if (sharing) {
      tooltipParts.push(`Shared by ${sharing.count} threads: ${sharing.summary}`);
    }

    return {
      kind: "worktree",
      label: sharing ? `${codename} ×${sharing.count}` : codename,
      tooltip: tooltipParts.join(" · "),
      toneIndex: worktreeCodenameToneIndex(codename),
    };
  }

  const branch = vcsStatus?.refName ?? thread.branch;
  return {
    kind: "current",
    label: branch ?? "Current checkout",
    tooltip: branch ? `Current checkout on ${branch}` : "Current checkout",
    toneIndex: null,
  };
}

/**
 * T3-CUSTOM(expbkt3): Codename label and shared-worktree state for every thread
 * on screen, resolved together because both answers depend on the whole visible
 * set: codenames disambiguate against each other, and sharing is a count across
 * rows. Archived threads do not participate — the rest of the UI hides them, so
 * they must not inflate a worktree's occupancy.
 */
export interface PhaseSidebarWorktreeView {
  readonly codenameByPath: ReadonlyMap<string, string>;
  readonly sharingByPath: ReadonlyMap<string, PhaseSidebarWorktreeSharing>;
}

export function resolvePhaseSidebarWorktreeView(
  threads: ReadonlyArray<Pick<ThreadShell, "title" | "worktreePath" | "archivedAt">>,
): PhaseSidebarWorktreeView {
  const titlesByPath = new Map<string, string[]>();
  for (const thread of threads) {
    const worktreePath = thread.worktreePath?.trim();
    if (!worktreePath || thread.archivedAt != null) continue;
    titlesByPath.set(worktreePath, [...(titlesByPath.get(worktreePath) ?? []), thread.title]);
  }

  const sharingByPath = new Map<string, PhaseSidebarWorktreeSharing>();
  for (const [worktreePath, titles] of titlesByPath) {
    if (titles.length < 2) continue;
    sharingByPath.set(worktreePath, { count: titles.length, summary: titles.join(", ") });
  }

  return {
    codenameByPath: disambiguateWorktreeCodenames([...titlesByPath.keys()]),
    sharingByPath,
  };
}

/**
 * T3-CUSTOM(expbkt3): Flatten one thread's worktree state into primitives. The
 * row is memo'd and the sidebar re-renders on every shell event, so the props
 * crossing that boundary have to compare by value.
 */
export interface PhaseSidebarWorktreeRowProps {
  readonly worktreeCodename: string | null;
  /** 0 when the worktree is not shared. */
  readonly worktreeSharedCount: number;
  readonly worktreeSharedSummary: string | null;
}

export function phaseSidebarWorktreeRowProps(
  view: PhaseSidebarWorktreeView,
  worktreePath: string | null,
): PhaseSidebarWorktreeRowProps {
  const path = worktreePath?.trim();
  if (!path) {
    return { worktreeCodename: null, worktreeSharedCount: 0, worktreeSharedSummary: null };
  }
  const sharing = view.sharingByPath.get(path) ?? null;
  return {
    // An archived thread is absent from the view but still renders on the
    // shelf, so fall back to deriving its codename directly.
    worktreeCodename: view.codenameByPath.get(path) ?? resolveWorktreeCodename(path),
    worktreeSharedCount: sharing?.count ?? 0,
    worktreeSharedSummary: sharing?.summary ?? null,
  };
}

export interface PhaseSidebarPhaseDefinition {
  readonly id: PhaseSidebarPhaseId;
  readonly label: string;
  readonly helperText: string;
}

export const PHASE_SIDEBAR_PHASES: ReadonlyArray<PhaseSidebarPhaseDefinition> = [
  {
    id: "needs_input",
    label: "Needs Input",
    helperText: "Agent is waiting for your answer",
  },
  { id: "plan_ready", label: "Plan Ready", helperText: "Planning session is stopped" },
  { id: "ready", label: "Ready", helperText: "No active agent work" },
  { id: "planning", label: "Planning", helperText: "Agent is preparing a plan" },
  { id: "implementing", label: "Implementing", helperText: "Agent is changing code" },
];

export interface PhaseSidebarWorkBadge {
  readonly label: string;
  readonly monitoring: boolean;
}

/**
 * Mirror Sidebar V2's execution precedence in the experimental sidebar.
 * Foreground execution keeps its provider label (for example, Running),
 * background agent fleets read as Working, and only watch loops read as
 * Monitoring. Monitoring is steady and therefore does not trigger row
 * shimmer. Plan Ready remains actionable and outranks lingering background
 * liveness.
 */
export function resolvePhaseSidebarWorkBadge(input: {
  readonly phaseId: PhaseSidebarPhaseId;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly executionPresentation: {
    readonly active: boolean;
    readonly label: string | null;
  };
}): PhaseSidebarWorkBadge | null {
  if (input.executionPresentation.active && input.executionPresentation.label !== null) {
    return { label: input.executionPresentation.label, monitoring: false };
  }

  if (input.phaseId === "plan_ready") return null;

  if (input.backgroundLiveness === "working") {
    return { label: "Working", monitoring: false };
  }

  if (input.backgroundLiveness === "monitoring") {
    return { label: "Monitoring", monitoring: true };
  }

  return null;
}

const PHASE_ID_SET = new Set<string>(PHASE_SIDEBAR_PHASE_IDS);
const LINEAR_BRANCH_PATTERN = /^linear\/([a-z][a-z0-9]*-\d+)(?:-|$)/i;
const LINEAR_ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;

export interface PhaseSidebarLinearIssue {
  readonly identifier: string;
  readonly url: string;
}

export function resolvePhaseSidebarLinearIssue(
  branch: string | null,
  manualUrl?: string | null,
): PhaseSidebarLinearIssue | null {
  const trimmedManualUrl = manualUrl?.trim();
  if (trimmedManualUrl) {
    const match = LINEAR_ISSUE_URL_PATTERN.exec(trimmedManualUrl);
    const workspace = match?.[1];
    const identifier = match?.[2]?.toUpperCase();
    if (workspace && identifier) {
      return {
        identifier,
        url: `https://linear.app/${workspace}/issue/${identifier}`,
      };
    }
  }
  if (branch === null) return null;
  const identifier = LINEAR_BRANCH_PATTERN.exec(branch)?.[1]?.toUpperCase();
  if (!identifier) return null;
  return {
    identifier,
    url: `https://linear.app/beknown/issue/${identifier}`,
  };
}

/**
 * T3-CUSTOM(expbkt3): the Mattermost conversation a session is bound to.
 *
 * Mattermost is self-hosted, so there is no canonical domain to validate
 * against — anything that parses as an http(s) URL is accepted, and the label
 * is derived only as far as the path reliably allows. Mattermost permalinks
 * are `/<team>/pl/<postId>`, channels `/<team>/channels/<name>`, and DMs
 * `/<team>/messages/@user`; anything else degrades to the host, which is still
 * more useful in a tooltip than the raw URL.
 */
export interface PhaseSidebarMattermostLink {
  /** Tooltip text, e.g. "Mattermost · #co-x-tech". */
  readonly label: string;
  readonly url: string;
}

export function resolvePhaseSidebarMattermostLink(
  manualUrl?: string | null,
): PhaseSidebarMattermostLink | null {
  const trimmed = manualUrl?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const kind = segments[1];
  const name = segments[2];
  const detail =
    kind === "channels" && name
      ? `#${decodeURIComponent(name)}`
      : kind === "messages" && name
        ? decodeURIComponent(name)
        : parsed.host;
  return { label: `Mattermost · ${detail}`, url: parsed.toString() };
}

/**
 * T3-CUSTOM(expbkt3): The row's change request, rendered beside the Linear tag
 * so the two trackers a session answers to read as one line: ticket, then PR.
 *
 * The number is the whole label. State is carried by COLOR ALONE — the row's
 * metadata lane is already the densest text in the app, and "#1234 (merged)"
 * spends a third of the lane restating what the hue says. Hues match
 * `prStatusIndicator` so a PR never reads one colour here and another in the
 * thread header: green open, violet merged, red closed. Draft, checks, and
 * review state stay in the tooltip — they are modifiers on "open", not states,
 * and giving each its own hue would make the lane unreadable.
 */
export interface PhaseSidebarChangeRequestBadge {
  /** "#1234" — the visible label. */
  readonly label: string;
  readonly url: string;
  readonly state: ChangeRequestStateLike;
  /** Static Tailwind classes; Tailwind cannot scan interpolated hues. */
  readonly colorClassName: string;
  /** Full state in words, for the tooltip and the accessible name. */
  readonly statusText: string;
  readonly tooltip: string;
}

const PHASE_SIDEBAR_CHANGE_REQUEST_TONES = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
  closed: "text-red-600 dark:text-red-300/90",
} satisfies Record<ChangeRequestStateLike, string>;

export function resolvePhaseSidebarChangeRequestBadge(
  vcsStatus: Pick<VcsStatusResult, "pr" | "sourceControlProvider"> | null | undefined,
): PhaseSidebarChangeRequestBadge | null {
  const pr = vcsStatus?.pr;
  if (!pr) return null;
  const shortName = resolveChangeRequestPresentation(vcsStatus?.sourceControlProvider).shortName;

  const modifiers: string[] = [];
  if (pr.state === "open") {
    if (pr.isDraft === true) modifiers.push("draft");
    if (pr.mergeability === "conflicting") modifiers.push("conflicting");
    if (pr.reviewDecision === "approved") modifiers.push("approved");
    if (pr.reviewDecision === "changes-requested") modifiers.push("changes requested");
    if (pr.checksStatus === "fail") modifiers.push("checks failing");
    if (pr.checksStatus === "pending") modifiers.push("checks running");
  }
  const statusText = modifiers.length === 0 ? pr.state : `${pr.state} · ${modifiers.join(" · ")}`;

  return {
    label: `#${pr.number}`,
    url: pr.url,
    state: pr.state,
    colorClassName: PHASE_SIDEBAR_CHANGE_REQUEST_TONES[pr.state],
    statusText,
    tooltip: `${shortName} #${pr.number} — ${statusText} · ${pr.title}`,
  };
}

/** T3-CUSTOM(expbkt3): compact sidebar timestamps, including zero minutes. */
export function compactPhaseSidebarTimeLabel(label: string): string {
  return label === "just now" ? "0m" : label.replace(" ago", "");
}

export interface PhaseSidebarFilters {
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly phaseIds: ReadonlyArray<PhaseSidebarPhaseId>;
  readonly providerKinds: ReadonlyArray<string>;
  /**
   * T3-CUSTOM(expbkt3): sessions this operator started.
   *
   * NOT "owner or tagged": that is the server's own visibility rule, so every
   * thread you can see already satisfies it and the filter selected everything.
   * Ownership is the distinction that means something — my sessions versus the
   * ones I was pulled into.
   */
  readonly ownedByMe: boolean;
  /**
   * T3-CUSTOM(expbkt3): show only sessions ALL of these people are on. Anyone
   * listed here is a co-participant on threads you can already see, since
   * visibility never widens — the filter narrows to shared work.
   */
  readonly participantUserIds: ReadonlyArray<string>;
}

export const EMPTY_PHASE_SIDEBAR_FILTERS: PhaseSidebarFilters = {
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
  ownedByMe: false,
  participantUserIds: [],
};

/** T3-CUSTOM(expbkt3): everyone on a thread, owner included. */
export function phaseSidebarThreadParticipantIds(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
): ReadonlyArray<string> {
  return thread.ownerUserId === null
    ? thread.memberUserIds
    : [thread.ownerUserId, ...thread.memberUserIds.filter((id) => id !== thread.ownerUserId)];
}

/**
 * "Assigned to me" = owned by, or directly tagged on, the thread. A thread made
 * visible only by a project tag is not "assigned" (matches the server rule).
 */
export function isThreadAssignedToUser(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
  userId: UserId,
): boolean {
  return thread.ownerUserId === userId || thread.memberUserIds.includes(userId);
}

/**
 * T3-CUSTOM(expbkt3): whose face, if anyone's, belongs on a sidebar row.
 *
 * A row only earns an owner avatar when the thread was started by *somebody
 * else*: my own sessions are the default case and a wall of my own face would
 * carry no information. Returns the owner to show, or `null` to show nothing.
 *
 * `null` when the thread is unowned (single-user mode, or awaiting backfill),
 * when we cannot identify the operator (no team identity — every row would
 * light up), or when the operator *is* the owner.
 */
export function phaseSidebarRowOwnerAvatarUserId(input: {
  readonly ownerUserId: UserId | null;
  readonly currentUserId: UserId | null;
}): UserId | null {
  if (input.ownerUserId === null || input.currentUserId === null) return null;
  return input.ownerUserId === input.currentUserId ? null : input.ownerUserId;
}

export interface PhaseSidebarRow {
  readonly thread: ThreadShell;
  readonly phaseId: PhaseSidebarPhaseId;
  readonly repositoryKey: string;
  readonly repositoryLabel: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly isAssignedToMe: boolean;
  // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
  readonly isOwnedByMe: boolean;
  readonly participantUserIds: ReadonlyArray<string>;
  // T3-CUSTOM(expbkt3): END
  readonly attentionPriority: number;
  readonly isUnreadCompletion: boolean;
  /** False on environments whose server predates thread.settle/unsettle:
      the row can never be classified settled (the user could not undo it)
      and its lifecycle affordances stay hidden. */
  readonly settlementSupported: boolean;
  /** Same version-skew contract for thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** Same version-skew contract for priority on thread.meta.update. */
  readonly prioritySupported: boolean;
  /** Same version-skew contract for manual Linear tags on thread.meta.update. */
  readonly linearIssueSupported?: boolean;
  /** Same version-skew contract for the Mattermost link on thread.meta.update. */
  readonly mattermostLinkSupported?: boolean;
  /** Same version-skew contract for regenerateTitle on thread.meta.update,
      which backs "Regenerate title" on the row's context menu. */
  readonly titleRegenerationSupported?: boolean;
  /** Same version-skew contract for thread.bootstrap.request, which backs
      "Create new thread" on the row's context menu. */
  readonly threadBootstrapSupported?: boolean;
  /** The row's pull-request state, when its VCS probe has reported one: a
      closed (abandoned) change request auto-settles the thread, an open one
      holds it active, and a merge settles only when the user allows it. */
  readonly changeRequestState: ChangeRequestStateLike | null;
  /** When the change request last changed, so a merge older than the thread's
      own activity does not settle a thread the user has since worked on. */
  readonly changeRequestUpdatedAt?: string | null;
}

/**
 * T3-CUSTOM(expbkt3): Where a row renders in the experimental sidebar —
 * inside its lifecycle group, or parked on one of the two shelves below
 * them.
 */
export type PhaseSidebarSection = "active" | "snoozed" | "settled";

export interface PhaseSidebarPartition {
  readonly activeRows: ReadonlyArray<PhaseSidebarRow>;
  readonly snoozedRows: ReadonlyArray<PhaseSidebarRow>;
  readonly settledRows: ReadonlyArray<PhaseSidebarRow>;
}

function snoozeWakeMs(row: PhaseSidebarRow): number {
  const parsed = Date.parse(row.thread.snoozedUntil ?? "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Soonest wake first: the shelf reads as a queue of what comes back next. */
export function sortSnoozedPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  return rows
    .slice()
    .sort(
      (left, right) =>
        snoozeWakeMs(left) - snoozeWakeMs(right) ||
        String(left.thread.id).localeCompare(String(right.thread.id)),
    );
}

/**
 * Settled rows are history, so they order by when the work ENDED — the same
 * timestamp their label reads, so order and label can never disagree.
 */
export function sortSettledPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  const timestampMs = (row: PhaseSidebarRow) => {
    const timestamp = resolveSettledTimestamp(row.thread);
    return timestamp === null ? 0 : Date.parse(timestamp);
  };
  return rows
    .slice()
    .sort(
      (left, right) =>
        timestampMs(right) - timestampMs(left) ||
        String(left.thread.id).localeCompare(String(right.thread.id)),
    );
}

/**
 * T3-CUSTOM(expbkt3): Split visible rows into the lifecycle inbox and the
 * two parked shelves. Snooze deliberately outranks settled classification:
 * an explicitly snoozed thread belongs on the snoozed shelf even when it
 * would also auto-settle, because the shelf carries its wake time.
 *
 * Both classifications are capability-gated per row — auto-settling a
 * thread on a server that cannot un-settle it would strand the row.
 *
 * `preciseNow` classifies snooze (wake times are second-precise) while
 * `now` may be quantized for the day-granular auto-settle window.
 */
export function partitionPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  options: {
    readonly now: string;
    readonly preciseNow: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean;
  },
): PhaseSidebarPartition {
  const activeRows: PhaseSidebarRow[] = [];
  const snoozedRows: PhaseSidebarRow[] = [];
  const settledRows: PhaseSidebarRow[] = [];

  for (const row of rows) {
    if (row.snoozeSupported && effectiveSnoozed(row.thread, { now: options.preciseNow })) {
      snoozedRows.push(row);
      continue;
    }
    if (
      row.settlementSupported &&
      effectiveSettled(row.thread, {
        now: options.now,
        autoSettleAfterDays: options.autoSettleAfterDays,
        ...(options.autoSettleOnMerge !== undefined
          ? { autoSettleOnMerge: options.autoSettleOnMerge }
          : {}),
        changeRequest:
          row.changeRequestState === null
            ? null
            : {
                state: row.changeRequestState,
                ...(row.changeRequestUpdatedAt !== undefined
                  ? { updatedAt: row.changeRequestUpdatedAt }
                  : {}),
              },
      })
    ) {
      settledRows.push(row);
      continue;
    }
    activeRows.push(row);
  }

  return {
    activeRows,
    snoozedRows: sortSnoozedPhaseSidebarRows(snoozedRows),
    settledRows: sortSettledPhaseSidebarRows(settledRows),
  };
}

/** A stopped projection can still hide a live provider, so any recorded session remains stoppable. */
export function phaseSidebarCanForceStopAgent(session: ThreadShell["session"]): boolean {
  return session !== null;
}

export interface PhaseSidebarRepositoryOption {
  readonly key: string;
  readonly label: string;
  readonly searchText: string;
  readonly project: Project;
}

export interface PhaseSidebarGroup extends PhaseSidebarPhaseDefinition {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
}

export interface PhaseSidebarFilterChip {
  // T3-CUSTOM(expbkt3): "person" is the co-participant facet.
  readonly facet: "repository" | "phase" | "provider" | "assignment" | "person";
  readonly value: string;
  readonly label: string;
}

export function isStrictlyMergeReady(status: VcsStatusResult | null | undefined): boolean {
  const pr = status?.pr;
  if (!pr || pr.state !== "open" || status?.sourceControlProvider?.kind !== "github") return false;
  if (pr.isDraft !== false || pr.mergeability !== "mergeable") return false;
  if (pr.mergeStateStatus?.toUpperCase() !== "CLEAN") return false;
  if (pr.reviewDecision === "changes-requested" || pr.reviewDecision === "review-required") {
    return false;
  }
  return pr.checksStatus === "pass";
}

export function resolvePhaseSidebarAttentionPriority(
  thread: ThreadShell,
  status?: VcsStatusResult | null,
): number {
  if (phaseSidebarNeedsUserInput(thread)) return 0;
  if (thread.execution?.turn?.state === "waiting-for-approval") return 1;
  if (thread.execution?.activity === "failed") return 2;
  if (
    status?.pr?.state === "open" &&
    (status.pr.mergeability === "conflicting" ||
      status.pr.checksStatus === "fail" ||
      status.pr.reviewDecision === "changes-requested")
  ) {
    return 3;
  }
  if (thread.execution === null || thread.execution === undefined) return 4;
  return 5;
}

/**
 * T3-CUSTOM(expbkt3): Treat both the durable pending-input bit and the live
 * execution state as authority. This keeps urgent questions promoted even
 * during short execution-snapshot reconnects.
 */
export function phaseSidebarNeedsUserInput(
  thread: Pick<ThreadShell, "hasPendingUserInput" | "execution">,
): boolean {
  return thread.hasPendingUserInput || thread.execution?.turn?.state === "waiting-for-input";
}

export type PhaseSidebarAttentionKind = "input" | "approval" | "error";

export function resolvePhaseSidebarAttentionKind(
  thread: Pick<ThreadShell, "execution" | "hasPendingApprovals" | "hasPendingUserInput">,
): PhaseSidebarAttentionKind | null {
  if (phaseSidebarNeedsUserInput(thread)) return "input";
  if (thread.hasPendingApprovals || thread.execution?.turn?.state === "waiting-for-approval") {
    return "approval";
  }
  if (thread.execution?.activity === "failed") return "error";
  return null;
}

export function resolvePhaseSidebarPhase(
  thread: ThreadShell,
  _status?: VcsStatusResult | null,
): PhaseSidebarPhaseId {
  if (phaseSidebarNeedsUserInput(thread)) return "needs_input";

  // A failed provider is actionable even if a stale durable intent or
  // background-liveness projection has not cleared yet.
  const hasFailure = thread.execution?.activity === "failed" || thread.session?.status === "error";
  if (hasFailure) {
    return thread.interactionMode === "plan" ? "plan_ready" : "ready";
  }

  // T3-CUSTOM(expbkt3): BEGIN — group from the same durable intent as the badge.
  const isActive =
    (thread.execution?.intent !== undefined &&
      thread.execution.intent.phase !== "recovery-exhausted") ||
    thread.execution?.activity === "active" ||
    thread.execution?.activity === "blocked" ||
    thread.execution?.activity === "stopping" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running";
  // T3-CUSTOM(expbkt3): END
  if (isActive) {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  // Sidebar V2's reliability ordering: a failure or an actionable plan must
  // not be hidden by liveness that can linger while background work winds
  // down. Those states keep their ordinary group and attention treatment.
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) {
    return "plan_ready";
  }

  // A settled foreground turn can still own native subagents, workflows, or
  // watch scripts. Keep it among agent-work rows until the authoritative
  // server projection clears instead of prematurely dropping it into Ready.
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  return thread.interactionMode === "plan" ? "plan_ready" : "ready";
}

/**
 * Keep a thread in its last rendered lifecycle group while live execution
 * authority is temporarily unavailable. The underlying execution snapshot is
 * still cleared on disconnect; this only stabilizes sidebar presentation until
 * a fresh execution frame arrives.
 */
export function resolvePhaseSidebarDisplayPhase(
  currentPhase: PhaseSidebarPhaseId,
  _previousPhase: PhaseSidebarPhaseId | null,
): PhaseSidebarPhaseId {
  return currentPhase;
}

export function derivePhaseSidebarRepositoryKey(project: Project): string {
  return deriveLogicalProjectKey(project, { groupingMode: "repository" });
}

export function buildPhaseSidebarRepositoryOptions(
  projects: ReadonlyArray<Project>,
): ReadonlyArray<PhaseSidebarRepositoryOption> {
  const grouped = new Map<string, Project[]>();
  for (const project of projects) {
    const key = derivePhaseSidebarRepositoryKey(project);
    const members = grouped.get(key);
    if (members) members.push(project);
    else grouped.set(key, [project]);
  }

  return [...grouped.entries()]
    .map(([key, members]) => {
      const sortedMembers = members
        .slice()
        .sort((left, right) =>
          `${left.environmentId}:${left.id}`.localeCompare(`${right.environmentId}:${right.id}`),
        );
      const nicknames = [...new Set(sortedMembers.map((project) => project.title))].sort(
        (left, right) => left.localeCompare(right),
      );
      const canonicalLabels = [
        ...new Set(
          sortedMembers.flatMap((project) => {
            const identity = project.repositoryIdentity;
            if (!identity) return [];
            return [identity.displayName, identity.name].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
          }),
        ),
      ].sort((left, right) => left.localeCompare(right));
      const label =
        nicknames.length === 1
          ? nicknames[0]!
          : (canonicalLabels[0] ?? nicknames[0] ?? "Unknown repository");
      const searchText = [
        ...nicknames,
        ...canonicalLabels,
        ...sortedMembers.flatMap((project) => {
          const identity = project.repositoryIdentity;
          return identity ? [identity.canonicalKey, identity.owner ?? ""] : [];
        }),
      ].join(" ");
      return { key, label, searchText, project: sortedMembers[0]! };
    })
    .sort(
      (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
    );
}

const KNOWN_PROVIDER_CODES: Readonly<Record<string, string>> = {
  claudeAgent: "cc",
  codex: "cx",
  cursor: "cu",
  grok: "gr",
  opencode: "oc",
};

export function resolvePhaseSidebarProviderCode(providerKind: string): string {
  const known = KNOWN_PROVIDER_CODES[providerKind];
  if (known) return known;

  const normalized = providerKind
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!normalized) return "uk";
  const words = normalized.split(/\s+/);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? "?"}${words[1]?.[0] ?? "?"}`;
  }
  return normalized.length === 1 ? normalized.repeat(2) : normalized.slice(0, 2);
}

export function matchesPhaseSidebarFilters(
  row: PhaseSidebarRow,
  filters: PhaseSidebarFilters,
): boolean {
  return (
    (filters.repositoryKeys.length === 0 || filters.repositoryKeys.includes(row.repositoryKey)) &&
    (filters.phaseIds.length === 0 || filters.phaseIds.includes(row.phaseId)) &&
    (filters.providerKinds.length === 0 || filters.providerKinds.includes(row.providerKind)) &&
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
    (!filters.ownedByMe || row.isOwnedByMe) &&
    // Every selected person must be on the thread: selecting two people asks
    // for their shared sessions, not the union of their work.
    (filters.participantUserIds.length === 0 ||
      filters.participantUserIds.every((userId) => row.participantUserIds.includes(userId)))
    // T3-CUSTOM(expbkt3): END
  );
}

/**
 * The rows this sidebar may render at all. Shared by the lifecycle groups and
 * the parked shelves so a filter chip means the same thing everywhere.
 */
export function filterVisiblePhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
): ReadonlyArray<PhaseSidebarRow> {
  return rows.filter(
    (row) => row.thread.archivedAt === null && matchesPhaseSidebarFilters(row, filters),
  );
}

/**
 * T3-CUSTOM(expbkt3): sort rank for a thread's priority. Unprioritised rows
 * rank after P4 so an explicit P4 still outranks "no opinion".
 */
export function phaseSidebarPriorityRank(thread: ThreadShell): number {
  return thread.priority ?? PHASE_SIDEBAR_UNPRIORITISED_RANK;
}

export const PHASE_SIDEBAR_UNPRIORITISED_RANK = 5;

/** T3-CUSTOM(expbkt3): render label for a priority value ("P0".."P4"). */
export function formatThreadPriority(priority: number): string {
  return `P${priority}`;
}

/** T3-CUSTOM(expbkt3): the priority values offered in the row context menu. */
export const PHASE_SIDEBAR_PRIORITY_CHOICES = [
  { value: 0, label: "P0 — Urgent" },
  { value: 1, label: "P1 — High" },
  { value: 2, label: "P2 — Medium" },
  { value: 3, label: "P3 — Low" },
  { value: 4, label: "P4 — Lowest" },
] as const satisfies ReadonlyArray<{ readonly value: 0 | 1 | 2 | 3 | 4; readonly label: string }>;

/** T3-CUSTOM(expbkt3): Which end of the time axis leads inside a lifecycle group. */
export type PhaseSidebarSortDirection = "newest_first" | "oldest_first";

export interface PhaseSidebarSortPreferences {
  readonly direction: PhaseSidebarSortDirection;
  /** When true, P0 outranks every lower priority; ties fall through to time. */
  readonly priorityFirst: boolean;
}

export const DEFAULT_PHASE_SIDEBAR_SORT: PhaseSidebarSortPreferences = {
  direction: "newest_first",
  priorityFirst: true,
};

export const PHASE_SIDEBAR_SORT_DIRECTION_LABELS: Record<PhaseSidebarSortDirection, string> = {
  newest_first: "Most recent on top",
  oldest_first: "Oldest on top",
};

export function sanitizePhaseSidebarSort(value: unknown): PhaseSidebarSortPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PHASE_SIDEBAR_SORT;
  const candidate = value as Partial<Record<keyof PhaseSidebarSortPreferences, unknown>>;
  return {
    direction:
      candidate.direction === "oldest_first" || candidate.direction === "newest_first"
        ? candidate.direction
        : DEFAULT_PHASE_SIDEBAR_SORT.direction,
    priorityFirst:
      typeof candidate.priorityFirst === "boolean"
        ? candidate.priorityFirst
        : DEFAULT_PHASE_SIDEBAR_SORT.priorityFirst,
  };
}

/**
 * T3-CUSTOM(expbkt3): Ordering inside a lifecycle group is deliberately STRICT —
 * it reads only the thread's priority, its sort timestamp, and stable tiebreaks.
 *
 * It used to also fold in `attentionPriority` and `isUnreadCompletion`. Both flip
 * the moment you open a row, so simply reading a thread reordered the group under
 * the pointer. Those states are already visible on the row (glint, unread dot) and
 * hoisted into their own groups upstream, so ordering does not need to repeat them
 * at the cost of a list that moves while you use it.
 */
export function comparePhaseSidebarRows(
  left: PhaseSidebarRow,
  right: PhaseSidebarRow,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences,
): number {
  const priorityDelta = sort.priorityFirst
    ? phaseSidebarPriorityRank(left.thread) - phaseSidebarPriorityRank(right.thread)
    : 0;
  const leftTime = getThreadSortTimestamp(left.thread, sortOrder);
  const rightTime = getThreadSortTimestamp(right.thread, sortOrder);
  const timeDelta = sort.direction === "oldest_first" ? leftTime - rightTime : rightTime - leftTime;
  return (
    priorityDelta ||
    timeDelta ||
    left.thread.title.localeCompare(right.thread.title) ||
    String(left.thread.id).localeCompare(String(right.thread.id))
  );
}

export function buildPhaseSidebarGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences = DEFAULT_PHASE_SIDEBAR_SORT,
): ReadonlyArray<PhaseSidebarGroup> {
  const visibleRows = filterVisiblePhaseSidebarRows(rows, filters);

  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const phaseRows = visibleRows
      .filter((row) => row.phaseId === phase.id)
      .sort((left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort));
    return phaseRows.length > 0 ? [{ ...phase, rows: phaseRows }] : [];
  });
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ),
    ),
  ];
}

export function sanitizePhaseSidebarFilters(value: unknown): PhaseSidebarFilters {
  if (!value || typeof value !== "object") return EMPTY_PHASE_SIDEBAR_FILTERS;
  const candidate = value as Partial<Record<keyof PhaseSidebarFilters, unknown>>;
  return {
    repositoryKeys: sanitizeStringArray(candidate.repositoryKeys),
    phaseIds: sanitizeStringArray(candidate.phaseIds).filter(
      (phaseId): phaseId is PhaseSidebarPhaseId => PHASE_ID_SET.has(phaseId),
    ),
    providerKinds: sanitizeStringArray(candidate.providerKinds),
    // T3-CUSTOM(expbkt3): missing on blobs written before these facets existed,
    // so both default off; storage stays v1.
    ownedByMe: candidate.ownedByMe === true,
    participantUserIds: sanitizeStringArray(candidate.participantUserIds),
  };
}

export function reconcilePhaseSidebarFilters(
  filters: PhaseSidebarFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    // False on single-user builds (no operator identity): a persisted
    // ownership filter would otherwise hide every thread.
    readonly assignmentAvailable: boolean;
    // T3-CUSTOM(expbkt3): people still present in the directory. A teammate who
    // leaves must not keep an invisible filter pinned over the sidebar.
    readonly participantUserIds?: ReadonlySet<string>;
  },
): PhaseSidebarFilters {
  const knownParticipants = options.participantUserIds;
  return {
    repositoryKeys: filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key)),
    phaseIds: filters.phaseIds.filter((phaseId) => PHASE_ID_SET.has(phaseId)),
    providerKinds: filters.providerKinds.filter((kind) => options.providerKinds.has(kind)),
    ownedByMe: options.assignmentAvailable ? filters.ownedByMe : false,
    participantUserIds: !options.assignmentAvailable
      ? []
      : knownParticipants === undefined
        ? filters.participantUserIds
        : filters.participantUserIds.filter((userId) => knownParticipants.has(userId)),
  };
}

export function buildPhaseSidebarFilterChips(
  filters: PhaseSidebarFilters,
  labels: {
    readonly repositories: ReadonlyMap<string, string>;
    readonly providers: ReadonlyMap<string, string>;
    // T3-CUSTOM(expbkt3): display names for the co-participant facet.
    readonly people?: ReadonlyMap<string, string>;
  },
): ReadonlyArray<PhaseSidebarFilterChip> {
  const phaseLabels = new Map(PHASE_SIDEBAR_PHASES.map((phase) => [phase.id, phase.label]));
  return [
    ...filters.repositoryKeys.map((value) => ({
      facet: "repository" as const,
      value,
      label: labels.repositories.get(value) ?? value,
    })),
    ...filters.phaseIds.map((value) => ({
      facet: "phase" as const,
      value,
      label: phaseLabels.get(value) ?? value,
    })),
    ...filters.providerKinds.map((value) => ({
      facet: "provider" as const,
      value,
      label: labels.providers.get(value) ?? value,
    })),
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant chips.
    ...(filters.ownedByMe
      ? [{ facet: "assignment" as const, value: "owned-by-me", label: "Started by me" }]
      : []),
    ...filters.participantUserIds.map((value) => ({
      facet: "person" as const,
      value,
      label: labels.people?.get(value) ?? "Teammate",
    })),
    // T3-CUSTOM(expbkt3): END
  ];
}

export function flattenPhaseSidebarGroups(
  groups: ReadonlyArray<PhaseSidebarGroup>,
): ReadonlyArray<PhaseSidebarRow> {
  return groups.flatMap((group) => group.rows);
}

export function resolvePhaseSidebarTraversalTarget(input: {
  readonly visibleThreadKeys: ReadonlyArray<string>;
  readonly currentThreadKey: string | null;
  readonly direction: "previous" | "next";
}): string | null {
  if (input.visibleThreadKeys.length === 0) return null;
  const currentIndex = input.currentThreadKey
    ? input.visibleThreadKeys.indexOf(input.currentThreadKey)
    : -1;
  if (currentIndex === -1) {
    return input.direction === "previous"
      ? (input.visibleThreadKeys.at(-1) ?? null)
      : (input.visibleThreadKeys[0] ?? null);
  }
  if (input.direction === "previous") {
    return currentIndex > 0 ? (input.visibleThreadKeys[currentIndex - 1] ?? null) : null;
  }
  return currentIndex < input.visibleThreadKeys.length - 1
    ? (input.visibleThreadKeys[currentIndex + 1] ?? null)
    : null;
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Lifecycle counters.
//
// Moved here from apps/web/src/components/sidebar/sidebarSessionCounters.ts so
// the mobile home list can show the same running/idle summary the web sidebar
// chrome does.
// ---------------------------------------------------------------------------

export interface SidebarSessionCounts {
  readonly nonRunning: number;
  readonly running: number;
  readonly nextSnoozeWakeAt: string | null;
}

export interface SidebarSessionCountOptions {
  readonly now: string;
  readonly snoozeSupported: (thread: ThreadShell) => boolean;
}

export function threadNeedsHumanAttention(thread: ThreadShell): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.execution?.turn?.state === "waiting-for-approval" ||
    thread.execution?.turn?.state === "waiting-for-input" ||
    thread.execution?.activity === "failed" ||
    thread.session?.status === "error"
  );
}

export function threadIsRunning(thread: ThreadShell): boolean {
  return (
    thread.execution?.activity === "active" ||
    thread.execution?.activity === "blocked" ||
    thread.execution?.activity === "stopping" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  );
}

export function summarizeSidebarSessions(
  threads: ReadonlyArray<ThreadShell>,
  options: SidebarSessionCountOptions,
): SidebarSessionCounts {
  let nonRunning = 0;
  let running = 0;
  let nextSnoozeWakeAt: string | null = null;
  let nextSnoozeWakeAtMs = Number.POSITIVE_INFINITY;

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledAt !== null) continue;
    if (threadIsRunning(thread)) {
      running += 1;
      continue;
    }
    if (options.snoozeSupported(thread) && effectiveSnoozed(thread, { now: options.now })) {
      const wakeAtMs = Date.parse(thread.snoozedUntil ?? "");
      if (wakeAtMs < nextSnoozeWakeAtMs) {
        nextSnoozeWakeAt = thread.snoozedUntil ?? null;
        nextSnoozeWakeAtMs = wakeAtMs;
      }
      continue;
    }
    nonRunning += 1;
  }

  return { nonRunning, running, nextSnoozeWakeAt };
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Running-session emphasis.
//
// Moved from apps/web/src/components/sidebar/RunningSessionGlint.logic.ts. Web
// renders the emphasis as an animated glint; mobile renders it statically, so
// only the decision is shared, never the presentation.
// ---------------------------------------------------------------------------

export function isRunningSessionPhase(phaseId: PhaseSidebarPhaseId): boolean {
  return phaseId === "planning" || phaseId === "implementing";
}

/** Running emphasis belongs only to live lifecycle rows, never parked history. */
export function shouldShowRunningSessionGlint(
  phaseId: PhaseSidebarPhaseId,
  section: PhaseSidebarSection,
): boolean {
  return section === "active" && isRunningSessionPhase(phaseId);
}

/** Place one quiet boundary before running work when idle groups are also visible. */
export function runningSessionDividerPhase(
  phaseIds: ReadonlyArray<PhaseSidebarPhaseId>,
): PhaseSidebarPhaseId | null {
  if (!phaseIds.some((phaseId) => !isRunningSessionPhase(phaseId))) return null;
  return phaseIds.find(isRunningSessionPhase) ?? null;
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): "Move under session" candidates.
//
// Moved from apps/web/src/components/sidebar/MoveUnderSessionDialog.logic.ts.
// This is the client-side mirror of the server's cycle guard, and the two must
// not drift — so both clients run the same copy.
// ---------------------------------------------------------------------------

export interface MoveUnderCandidate {
  readonly thread: ThreadShell;
  readonly label: string;
  readonly repositoryLabel: string;
}

/**
 * Every thread reachable downwards from `threadId`, excluding itself. Bounded
 * by the thread count: each id is enqueued at most once, so a corrupt cycle in
 * the projection cannot make this loop forever.
 */
export function collectDescendantThreadIds(
  threads: ReadonlyArray<ThreadShell>,
  threadId: string,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const queue: string[] = [threadId];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const thread of threads) {
      if ((thread.parentThreadId ?? null) !== current) continue;
      if (thread.id === threadId || descendants.has(thread.id)) continue;
      descendants.add(thread.id);
      queue.push(thread.id);
    }
  }
  return descendants;
}

/**
 * Candidate parents for `subject`, newest first, filtered by `query`.
 *
 * Excluded: the thread itself, its descendants (the server would reject those
 * as cycles, so offering them would only produce a confusing failure toast),
 * archived threads, its current parent (already there), and — because lineage
 * is a bare thread id resolved within one environment — anything from a
 * different environment.
 */
export function resolveMoveUnderCandidates(input: {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly subject: ThreadShell;
  readonly query: string;
  readonly repositoryLabelFor: (thread: ThreadShell) => string;
  readonly limit?: number;
}): ReadonlyArray<MoveUnderCandidate> {
  const sameEnvironment = input.threads.filter(
    (thread) => thread.environmentId === input.subject.environmentId,
  );
  const blocked = collectDescendantThreadIds(sameEnvironment, input.subject.id);
  const needle = input.query.trim().toLowerCase();

  return sameEnvironment
    .filter(
      (thread) =>
        thread.id !== input.subject.id &&
        !blocked.has(thread.id) &&
        thread.archivedAt === null &&
        thread.id !== (input.subject.parentThreadId ?? null) &&
        (needle.length === 0 || thread.title.toLowerCase().includes(needle)),
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, input.limit ?? 50)
    .map((thread) => ({
      thread,
      label: thread.title,
      repositoryLabel: input.repositoryLabelFor(thread),
    }));
}

// ---------------------------------------------------------------------------
// T3-CUSTOM(expbkt3): Unread tracking.
//
// Moved from apps/web/src/threadVisitTimestamp.ts. Both clients compare a
// thread's newest activity against the last time this device opened it; where
// that "last visited" map is stored is platform-specific, but the rule that
// decides what counts as newer is not.
// ---------------------------------------------------------------------------

export interface ThreadVisitTimestampInput {
  readonly threadUpdatedAt: string;
  readonly latestTurnCompletedAt: string | null | undefined;
}

export function resolveThreadVisitTimestamp(input: ThreadVisitTimestampInput): string {
  const threadUpdatedAtMs = Date.parse(input.threadUpdatedAt);
  const latestTurnCompletedAt = input.latestTurnCompletedAt;
  const latestTurnCompletedAtMs = latestTurnCompletedAt
    ? Date.parse(latestTurnCompletedAt)
    : Number.NaN;
  if (
    latestTurnCompletedAt != null &&
    Number.isFinite(latestTurnCompletedAtMs) &&
    (!Number.isFinite(threadUpdatedAtMs) || latestTurnCompletedAtMs > threadUpdatedAtMs)
  ) {
    return latestTurnCompletedAt;
  }
  return input.threadUpdatedAt;
}

/**
 * Whether a row should show the unread dot: the thread has newer activity than
 * the last visit this device recorded. An unvisited thread is NOT unread —
 * otherwise a fresh install marks the entire list.
 */
/**
 * T3-CUSTOM(expbkt3): Whether a finished turn has not been looked at yet.
 *
 * Moved here from apps/web/src/components/Sidebar.logic.ts (which re-exports it)
 * so `buildPhaseSidebarRows` can run on both clients. Deliberately NOT unified
 * with `isThreadUnread` below: this one treats an unparseable visit timestamp as
 * unread, and that difference is load-bearing for the row's dot.
 */
export function hasUnseenCompletion(
  thread: Pick<ThreadShell, "latestTurn"> & {
    readonly lastVisitedAt?: string | null | undefined;
    /** Callers pass whole thread shells; extra facts are simply unread here. */
    readonly [extra: string]: unknown;
  },
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function isThreadUnread(input: {
  readonly threadUpdatedAt: string;
  readonly latestTurnCompletedAt: string | null | undefined;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.lastVisitedAt == null) return false;
  const lastVisitedAtMs = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return false;
  const activityAtMs = Date.parse(resolveThreadVisitTimestamp(input));
  if (Number.isNaN(activityAtMs)) return false;
  return activityAtMs > lastVisitedAtMs;
}

/**
 * T3-CUSTOM(expbkt3): Everything needed to turn raw thread shells into rows.
 *
 * `projects` and `serverConfigs` are the caller's own maps rather than derived
 * state, because both clients already hold them; the repository key and label
 * tables are derived here so neither client has to reproduce that stitching.
 */
export interface BuildPhaseSidebarRowsInput {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly projects: ReadonlyArray<Project>;
  readonly serverConfigs: ReadonlyMap<string, ServerConfig>;
  /** Keyed by `scopedThreadKey`. Absent entries simply have no VCS facts yet. */
  readonly vcsStatusByThreadKey: ReadonlyMap<string, VcsStatusResult | null>;
  /** Keyed by `scopedThreadKey`. */
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string | undefined>>;
  readonly currentUserId: UserId | null;
  /**
   * When false, a row falls back to its last known phase rather than flapping
   * to a wrong one while an environment's shells are still arriving.
   */
  readonly allEnvironmentShellsLive: boolean;
  /** Keyed by `scopedThreadKey`. Null when the caller keeps no history. */
  readonly lastKnownPhaseByThreadKey: ReadonlyMap<string, PhaseSidebarPhaseId> | null;
}

/**
 * Builds the sidebar's row model. Pure, so both the web sidebar and the mobile
 * phase sidebar render the same lifecycle, badges and ownership facts.
 */
export function buildPhaseSidebarRows(
  input: BuildPhaseSidebarRowsInput,
): ReadonlyArray<PhaseSidebarRow> {
  const projectByKey = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const repositoryLabels = new Map(
    buildPhaseSidebarRepositoryOptions(input.projects).map((option) => [option.key, option.label]),
  );

  return input.threads.map((thread) => {
    const project = projectByKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    const repositoryKey = project
      ? derivePhaseSidebarRepositoryKey(project)
      : scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const serverConfig = input.serverConfigs.get(thread.environmentId);
    const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const provider = serverConfig?.providers.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    const providerKind = String(provider?.driver ?? instanceId);
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const vcsStatus = input.vcsStatusByThreadKey.get(threadKey);
    const currentPhase = resolvePhaseSidebarPhase(thread, vcsStatus);
    const capabilities = serverConfig?.environment.capabilities;

    return {
      thread,
      phaseId: resolvePhaseSidebarDisplayPhase(
        currentPhase,
        input.allEnvironmentShellsLive
          ? null
          : (input.lastKnownPhaseByThreadKey?.get(threadKey) ?? null),
      ),
      repositoryKey,
      repositoryLabel:
        project?.title ?? repositoryLabels.get(repositoryKey) ?? "Unknown repository",
      providerKind,
      providerName: provider?.displayName ?? thread.session?.providerName ?? String(instanceId),
      isAssignedToMe:
        input.currentUserId !== null && isThreadAssignedToUser(thread, input.currentUserId),
      isOwnedByMe: input.currentUserId !== null && thread.ownerUserId === input.currentUserId,
      participantUserIds: phaseSidebarThreadParticipantIds(thread),
      attentionPriority: resolvePhaseSidebarAttentionPriority(thread, vcsStatus),
      isUnreadCompletion: hasUnseenCompletion({
        ...thread,
        lastVisitedAt: input.lastVisitedAtByThreadKey[threadKey],
      }),
      settlementSupported: capabilities?.threadSettlement === true,
      snoozeSupported: capabilities?.threadSnooze === true,
      prioritySupported: capabilities?.threadPriority === true,
      linearIssueSupported: capabilities?.threadLinearIssue === true,
      mattermostLinkSupported: capabilities?.threadMattermostLink === true,
      titleRegenerationSupported: capabilities?.threadTitleRegeneration === true,
      threadBootstrapSupported: capabilities?.durableThreadBootstrap === true,
      changeRequestState: vcsStatus?.pr?.state ?? null,
      changeRequestUpdatedAt: vcsStatus?.pr?.updatedAt ?? null,
    };
  });
}
