/**
 * T3-CUSTOM(expbkt3): Git facts a reclaim decision and a history digest need.
 *
 * `GitWorkflowService.localStatus` folds untracked files into
 * `hasWorkingTreeChanges`, which is enough to *block* a removal but not enough
 * to describe one honestly in an exported digest. These readers ask git the
 * narrower questions directly, through the driver's generic `execute`, and are
 * deliberately forgiving: a worktree that has already been removed, or a
 * directory that was never a repository, yields "nothing known" rather than
 * failing the surrounding scan.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { HistoryFileChange } from "./historyMarkdown.ts";
import type { ReclaimGitFacts } from "./reclaimEligibility.ts";

export interface WorktreeGitFacts extends ReclaimGitFacts {
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly headSha: string | null;
  readonly changedFiles: ReadonlyArray<HistoryFileChange>;
  /** Tracked paths relative to the worktree root, for the slim guard. */
  readonly trackedPaths: ReadonlySet<string>;
}

/**
 * What we assume when git cannot tell us anything.
 *
 * Every boolean is `true` on purpose. An unreadable worktree is one we know
 * nothing about, and the gates read these as reasons to refuse — so silence
 * blocks a removal rather than waving it through.
 */
export const UNKNOWN_GIT_FACTS: WorktreeGitFacts = {
  branch: null,
  baseRef: null,
  headSha: null,
  hasUncommittedChanges: true,
  hasUntrackedFiles: true,
  hasUnpushedCommits: true,
  changedFiles: [],
  trackedPaths: new Set(),
};

/** Split `-z` output, which is NUL-terminated rather than NUL-separated. */
function splitNulSeparated(stdout: string): ReadonlyArray<string> {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

const runGit = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.execute({
      operation: `SessionArchive.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
    });
  });

/**
 * Read every fact in one pass.
 *
 * The calls are independent, so they run concurrently — but bounded, because a
 * scan fans this out across hundreds of worktrees on a shared box.
 */
export const readWorktreeGitFacts = Effect.fn("SessionArchive.readWorktreeGitFacts")(function* (
  worktreePath: string,
) {
  const [status, head, upstream, tracked] = yield* Effect.all(
    [
      runGit(worktreePath, "status", ["status", "--porcelain=1", "-z", "--untracked-files=normal"]),
      runGit(worktreePath, "head", ["rev-parse", "--short", "HEAD"]),
      // Empty stdout means no upstream, which we treat as "nothing is pushed".
      runGit(worktreePath, "upstream", ["rev-list", "--count", "@{upstream}..HEAD"]),
      runGit(worktreePath, "lsFiles", ["ls-files", "-z"]),
    ],
    { concurrency: 2 },
  );

  if (status.exitCode !== 0) {
    return UNKNOWN_GIT_FACTS;
  }

  const entries = splitNulSeparated(status.stdout);
  const changedFiles: Array<HistoryFileChange> = [];
  let hasUncommittedChanges = false;
  let hasUntrackedFiles = false;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "??") {
      hasUntrackedFiles = true;
      changedFiles.push({ path, status: "?" });
      continue;
    }
    hasUncommittedChanges = true;
    changedFiles.push({ path, status: code.trim() });
    // A rename entry is followed by its source path as a separate record.
    if (code.startsWith("R") || code.startsWith("C")) {
      index += 1;
    }
  }

  const branchResult = yield* runGit(worktreePath, "branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch =
    branchResult.exitCode === 0 && branchResult.stdout.trim() !== "HEAD"
      ? branchResult.stdout.trim() || null
      : null;

  return {
    branch,
    baseRef: null,
    headSha: head.exitCode === 0 ? head.stdout.trim() || null : null,
    hasUncommittedChanges,
    hasUntrackedFiles,
    // No upstream (non-zero exit) means nothing is on a remote, so treat the
    // branch as unpushed rather than as "zero commits ahead".
    hasUnpushedCommits: upstream.exitCode !== 0 || Number.parseInt(upstream.stdout.trim(), 10) > 0,
    changedFiles,
    trackedPaths: new Set(tracked.exitCode === 0 ? splitNulSeparated(tracked.stdout) : []),
  } satisfies WorktreeGitFacts;
});
