/**
 * T3-CUSTOM(expbkt3): fork-owned registry of spawned provider runtime processes.
 *
 * Provider runtimes are OS processes owned by *this* server process, so the
 * bookkeeping is deliberately module-level rather than an Effect service: an
 * `/proc` sweep has to reason about every runtime this OS process ever
 * spawned, not about whichever layer happens to be in scope. Two consumers
 * read it:
 *
 *   - `observableLifecycle.terminateSession` — to verify at the OS that the
 *     runtime a thread owned actually exited (rather than merely disappearing
 *     from an in-memory map);
 *   - `ProviderSessionReaper` — to know which live PIDs are legitimately busy,
 *     and which are leftovers whose owning session is gone.
 *
 * The pattern table is the per-adapter contract: an adapter that spawns a
 * long-lived runtime registers its PID here and declares how its command line
 * is recognised, so the sweep never needs adapter-specific strings inline.
 */

export type ProviderRuntimeProcessOwnership = "thread" | "shared";

export interface ProviderRuntimeProcessOwner {
  readonly provider: string;
  /** `null` for runtimes shared across threads (e.g. text-generation servers). */
  readonly threadId: string | null;
}

export interface ProviderRuntimeProcessRecord extends ProviderRuntimeProcessOwner {
  readonly pid: number;
  readonly command: string;
  readonly registeredAtMillis: number;
}

export interface ProviderRuntimePattern {
  readonly provider: string;
  readonly label: string;
  readonly matches: (command: string) => boolean;
}

/**
 * Command lines that identify a provider runtime we are allowed to reap.
 * Keep this list narrow: everything here is a process the sweep may SIGKILL.
 */
export const PROVIDER_RUNTIME_PROCESS_PATTERNS: ReadonlyArray<ProviderRuntimePattern> = [
  {
    provider: "opencode",
    label: "opencode serve",
    // Matches both a bare `opencode serve` and an absolute binary path.
    matches: (command) => /(?:^|\/)opencode(?:\.exe)?\s+serve(?:\s|$)/.test(command),
  },
];

export function matchProviderRuntimeCommand(command: string): ProviderRuntimePattern | null {
  if (command.trim().length === 0) return null;
  return PROVIDER_RUNTIME_PROCESS_PATTERNS.find((pattern) => pattern.matches(command)) ?? null;
}

const records = new Map<number, ProviderRuntimeProcessRecord>();

export function registerProviderRuntimeProcess(record: ProviderRuntimeProcessRecord): void {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return;
  records.set(record.pid, record);
}

export function unregisterProviderRuntimeProcess(pid: number): void {
  records.delete(pid);
}

export function listProviderRuntimeProcesses(): ReadonlyArray<ProviderRuntimeProcessRecord> {
  return [...records.values()];
}

export function findProviderRuntimeProcessesForThread(
  threadId: string,
): ReadonlyArray<ProviderRuntimeProcessRecord> {
  return [...records.values()].filter((record) => record.threadId === threadId);
}

/** Test-only: the registry is module state, so suites must be able to reset it. */
export function clearProviderRuntimeProcesses(): void {
  records.clear();
}

export type OrphanProviderProcessReason =
  /** Reparented to init: whatever spawned it is gone, so nothing can ever reap it. */
  | "reparented-to-init"
  /** We spawned it and tracked it, but the session that owned it no longer exists. */
  | "tracked-session-gone";

export interface OrphanProviderProcessCandidate {
  readonly pid: number;
  readonly provider: string;
  readonly command: string;
  readonly rssKb: number | null;
  readonly reason: OrphanProviderProcessReason;
}

export interface OrphanProviderProcessScanInput {
  readonly entries: ReadonlyArray<{
    readonly pid: number;
    readonly ppid: number;
    readonly command: string;
    readonly rssKb: number | null;
  }>;
  /** PIDs proven to share this server's cgroup. Nothing outside it is ever a candidate. */
  readonly cgroupPids: ReadonlySet<number>;
  readonly selfPid: number;
  /** PIDs of this process' ancestors — never candidates, whatever they look like. */
  readonly ancestorPids: ReadonlySet<number>;
  /** Threads with a live provider session; their runtimes are in use. */
  readonly liveThreadIds: ReadonlySet<string>;
  readonly trackedRecords: ReadonlyArray<ProviderRuntimeProcessRecord>;
  readonly nowMillis: number;
  /**
   * How long a tracked runtime may exist without a live session before it
   * counts as abandoned. Covers session startup, during which the PID is
   * already registered but the adapter has not yet published the session.
   */
  readonly trackedGraceMillis: number;
}

/**
 * Decide which provider runtime processes are safe to kill.
 *
 * Pure, so the guard rails are testable without touching the host: the caller
 * supplies the `/proc` snapshot, the cgroup membership set, and the live
 * session bindings.
 */
export function selectOrphanProviderProcesses(
  input: OrphanProviderProcessScanInput,
): ReadonlyArray<OrphanProviderProcessCandidate> {
  const trackedByPid = new Map(input.trackedRecords.map((record) => [record.pid, record] as const));
  const candidates: Array<OrphanProviderProcessCandidate> = [];

  for (const entry of input.entries) {
    if (entry.pid <= 1) continue;
    if (entry.pid === input.selfPid) continue;
    if (input.ancestorPids.has(entry.pid)) continue;
    if (!input.cgroupPids.has(entry.pid)) continue;

    const tracked = trackedByPid.get(entry.pid);
    const pattern = matchProviderRuntimeCommand(entry.command);
    // The command must still look like a provider runtime even for tracked
    // PIDs — otherwise a recycled PID could be mistaken for our own child.
    if (pattern === null) continue;

    if (tracked !== undefined) {
      if (tracked.threadId === null) continue;
      if (input.liveThreadIds.has(tracked.threadId)) continue;
      if (input.nowMillis - tracked.registeredAtMillis < input.trackedGraceMillis) continue;
      candidates.push({
        pid: entry.pid,
        provider: tracked.provider,
        command: entry.command,
        rssKb: entry.rssKb,
        reason: "tracked-session-gone",
      });
      continue;
    }

    // Untracked: only reap once the kernel has reparented it to init, which
    // proves no live owner is left to shut it down.
    if (entry.ppid !== 1) continue;
    candidates.push({
      pid: entry.pid,
      provider: pattern.provider,
      command: entry.command,
      rssKb: entry.rssKb,
      reason: "reparented-to-init",
    });
  }

  return candidates;
}
