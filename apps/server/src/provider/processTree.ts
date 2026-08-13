/**
 * T3-CUSTOM(expbkt3): fork-owned OS-level process-tree inspection.
 *
 * Provider runtimes (`opencode serve`, …) are spawned as detached children.
 * Every "did it actually die?" answer in this fork is derived from `/proc`
 * rather than from an in-memory session map, because a detached child that
 * escapes its owning Effect scope stays alive — and stays inside the service
 * cgroup — long after the adapter has forgotten it.
 *
 * Everything here is fail-soft: an unreadable or racing `/proc` entry yields
 * `null`/`false` instead of throwing, since the caller is always a background
 * sweep or a termination path that must not be able to crash the server.
 */
// @effect-diagnostics nodeBuiltinImport:off - /proc inspection has no Effect platform equivalent.
import * as NodeFS from "node:fs";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const DEFAULT_PROC_ROOT = "/proc";
export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Full argv joined by spaces, falling back to the kernel `Name:` for kernel threads. */
  readonly command: string;
  readonly rssKb: number | null;
}

export interface ProcessTreeTerminationOutcome {
  /** Every process in the tree is gone, confirmed by signal-0 probes. */
  readonly exited: boolean;
  /** SIGKILL was required — the tree did not honour SIGTERM within the grace period. */
  readonly forced: boolean;
  readonly survivingPids: ReadonlyArray<number>;
}

const DEFAULT_GRACE_PERIOD_MILLIS = 2_500;
const DEFAULT_POLL_INTERVAL_MILLIS = 100;
const DEFAULT_KILL_TIMEOUT_MILLIS = 1_500;

function readTextFileSafely(path: string): string | null {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `true` on platforms where `/proc`-based verification is meaningful. */
export function supportsProcessTreeInspection(platform: NodeJS.Platform): boolean {
  return platform === "linux";
}

export function listProcessIds(procRoot: string = DEFAULT_PROC_ROOT): ReadonlyArray<number> {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(procRoot);
  } catch {
    return [];
  }
  const pids: Array<number> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

export function readProcessEntry(
  pid: number,
  procRoot: string = DEFAULT_PROC_ROOT,
): ProcessEntry | null {
  const status = readTextFileSafely(`${procRoot}/${String(pid)}/status`);
  if (status === null) return null;

  let ppid: number | null = null;
  let rssKb: number | null = null;
  let name = "";
  for (const line of status.split("\n")) {
    if (line.startsWith("PPid:")) {
      const parsed = Number.parseInt(line.slice("PPid:".length).trim(), 10);
      if (Number.isInteger(parsed)) ppid = parsed;
    } else if (line.startsWith("Name:")) {
      name = line.slice("Name:".length).trim();
    } else if (line.startsWith("VmRSS:")) {
      const parsed = Number.parseInt(line.slice("VmRSS:".length).trim(), 10);
      if (Number.isInteger(parsed)) rssKb = parsed;
    }
  }
  if (ppid === null) return null;

  const rawCmdline = readTextFileSafely(`${procRoot}/${String(pid)}/cmdline`);
  const command =
    rawCmdline === null
      ? ""
      : rawCmdline
          .split("\0")
          .filter((part) => part.length > 0)
          .join(" ")
          .trim();

  return { pid, ppid, command: command.length > 0 ? command : name, rssKb };
}

export function snapshotProcesses(
  procRoot: string = DEFAULT_PROC_ROOT,
): ReadonlyArray<ProcessEntry> {
  const entries: Array<ProcessEntry> = [];
  for (const pid of listProcessIds(procRoot)) {
    // A process can exit between readdir and read — skip it rather than fail.
    const entry = readProcessEntry(pid, procRoot);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * Transitive children of `rootPid` within `entries`, breadth-first.
 *
 * Pure over an already-taken snapshot so the traversal is testable without
 * `/proc`. The `seen` guard makes a malformed snapshot (a PPid cycle, or a
 * process that reports itself as its own parent) terminate rather than spin.
 */
export function collectDescendantPids(
  rootPid: number,
  entries: Iterable<ProcessEntry>,
): ReadonlyArray<number> {
  const childrenByParent = new Map<number, Array<number>>();
  for (const entry of entries) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else childrenByParent.set(entry.ppid, [entry.pid]);
  }

  const collected: Array<number> = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<number> = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      collected.push(child);
      queue.push(child);
    }
  }
  return collected;
}

/** Ancestors of `pid`, nearest first. Used to guarantee a sweep can never signal its own parents. */
export function collectAncestorPids(
  pid: number,
  entries: Iterable<ProcessEntry>,
): ReadonlyArray<number> {
  const parentByPid = new Map<number, number>();
  for (const entry of entries) parentByPid.set(entry.pid, entry.ppid);

  const ancestors: Array<number> = [];
  const seen = new Set<number>([pid]);
  let current = parentByPid.get(pid);
  while (current !== undefined && current > 0 && !seen.has(current)) {
    seen.add(current);
    ancestors.push(current);
    current = parentByPid.get(current);
  }
  return ancestors;
}

export function collectProcessTreePids(
  rootPid: number,
  procRoot: string = DEFAULT_PROC_ROOT,
): ReadonlyArray<number> {
  return [rootPid, ...collectDescendantPids(rootPid, snapshotProcesses(procRoot))];
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user; only ESRCH
    // proves it is gone.
    return (cause as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * PIDs sharing this process' cgroup. `null` when the cgroup cannot be
 * determined, which callers must treat as "cannot prove ownership" and skip
 * every destructive action.
 */
export function readOwnCgroupProcessIds(options?: {
  readonly procRoot?: string;
  readonly cgroupRoot?: string;
}): ReadonlySet<number> | null {
  const procRoot = options?.procRoot ?? DEFAULT_PROC_ROOT;
  const cgroupRoot = options?.cgroupRoot ?? DEFAULT_CGROUP_ROOT;

  const raw = readTextFileSafely(`${procRoot}/self/cgroup`);
  if (raw === null) return null;

  // cgroup v2 emits a single `0::<relative-path>` line.
  let relative: string | null = null;
  for (const line of raw.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    if (parts[0] === "0" && parts[1] === "") {
      relative = parts.slice(2).join(":").trim();
      break;
    }
  }
  if (relative === null || !relative.startsWith("/")) return null;

  const contents = readTextFileSafely(
    `${cgroupRoot}${relative === "/" ? "" : relative}/cgroup.procs`,
  );
  if (contents === null) return null;

  const pids = new Set<number>();
  for (const line of contents.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

/**
 * SIGTERM → wait → SIGKILL → re-verify, over the whole descendant tree.
 *
 * The returned `exited` is only ever `true` after a signal-0 probe confirmed
 * every collected PID is gone, so callers can report process-tree termination
 * as verified against the OS.
 */
export const terminateProcessTree = (input: {
  readonly rootPid: number;
  readonly gracePeriodMillis?: number;
  readonly pollIntervalMillis?: number;
  readonly killTimeoutMillis?: number;
  readonly procRoot?: string;
}): Effect.Effect<ProcessTreeTerminationOutcome> =>
  Effect.gen(function* () {
    const procRoot = input.procRoot ?? DEFAULT_PROC_ROOT;
    const gracePeriodMillis = input.gracePeriodMillis ?? DEFAULT_GRACE_PERIOD_MILLIS;
    const pollIntervalMillis = Math.max(
      10,
      input.pollIntervalMillis ?? DEFAULT_POLL_INTERVAL_MILLIS,
    );
    const killTimeoutMillis = input.killTimeoutMillis ?? DEFAULT_KILL_TIMEOUT_MILLIS;

    const aliveIn = (pids: ReadonlyArray<number>) => pids.filter(isProcessAlive);

    // Signal children before parents: a supervising parent that is already
    // dying cannot then fork a replacement we would never see.
    const signalTree = (signal: NodeJS.Signals) => {
      const pids = aliveIn(collectProcessTreePids(input.rootPid, procRoot));
      for (const pid of pids.toReversed()) signalProcess(pid, signal);
      return pids;
    };

    const awaitExit = (pids: ReadonlyArray<number>, budgetMillis: number) =>
      Effect.gen(function* () {
        let waited = 0;
        let surviving = aliveIn(pids);
        while (surviving.length > 0 && waited < budgetMillis) {
          yield* Effect.sleep(Duration.millis(pollIntervalMillis));
          waited += pollIntervalMillis;
          surviving = aliveIn(pids);
        }
        return surviving;
      });

    const initial = aliveIn(collectProcessTreePids(input.rootPid, procRoot));
    if (initial.length === 0) {
      return {
        exited: true,
        forced: false,
        survivingPids: [],
      } satisfies ProcessTreeTerminationOutcome;
    }

    const terminated = signalTree("SIGTERM");
    if ((yield* awaitExit(terminated, gracePeriodMillis)).length === 0) {
      // Re-snapshot: a descendant may have been forked after the first sweep.
      const stragglers = aliveIn(collectProcessTreePids(input.rootPid, procRoot));
      if (stragglers.length === 0) {
        return {
          exited: true,
          forced: false,
          survivingPids: [],
        } satisfies ProcessTreeTerminationOutcome;
      }
    }

    const killed = signalTree("SIGKILL");
    const survivingPids = yield* awaitExit(killed, killTimeoutMillis);
    return {
      exited: survivingPids.length === 0,
      forced: true,
      survivingPids,
    } satisfies ProcessTreeTerminationOutcome;
  });
