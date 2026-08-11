/**
 * T3-CUSTOM(expbkt3): Name worktree directories after their codename.
 *
 * A worktree directory used to be the temporary branch with its slashes swapped
 * (`t3code/2d633e64` -> `t3code-2d633e64`), which is unreadable in a shell
 * prompt, a terminal tab, or a `pwd`. It now carries the same codename the UI
 * shows, so the name a user learned in the sidebar is the name they see on disk.
 *
 * The filesystem is the registry: a directory that exists is a name that is
 * taken. That is why there is no table, no migration, and no new contract field.
 *
 * Deliberately name-only — this never creates the directory. The durable
 * bootstrap reconciler treats an existing path as proof that the worktree was
 * already built, and fails with `bootstrap-worktree-conflict` when that path is
 * not a git repository on the target branch. Reserving a name by pre-creating an
 * empty directory would therefore break every bootstrap that used it.
 */
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import {
  WORKTREE_CODENAMES,
  worktreeCodenameFromDirectoryName,
  worktreeCodenameHash,
} from "@t3tools/shared/worktreeCodename";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * First free codename in a probe order seeded by `seed`, which is the worktree's
 * temporary branch. Seeding on the branch (8 random hex) rather than scanning
 * from index 0 keeps two projects from marching down the pool in lockstep, and
 * makes two concurrent allocations pick different names without coordinating.
 */
export function chooseWorktreeDirectoryName(input: {
  readonly seed: string;
  readonly taken: ReadonlySet<string>;
  readonly legacyName: string;
}): string {
  const start = worktreeCodenameHash(input.seed) % WORKTREE_CODENAMES.length;

  for (let offset = 0; offset < WORKTREE_CODENAMES.length; offset += 1) {
    const candidate = WORKTREE_CODENAMES[(start + offset) % WORKTREE_CODENAMES.length]!;
    if (!input.taken.has(candidate)) {
      return candidate;
    }
  }

  // Every name in the pool is taken in this one project. Suffix the seeded name
  // rather than reaching back for the branch: by this point the codename is the
  // identity people have learned, and `lisbon-2` still reads as a name.
  const base = WORKTREE_CODENAMES[start]!;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!input.taken.has(candidate)) {
      return candidate;
    }
  }

  // Beyond implausible (1000+ worktrees sharing one codename). Fall back to the
  // legacy branch-derived name so allocation degrades instead of failing.
  return input.legacyName;
}

/**
 * Resolve a free directory name inside a project's worktrees directory. A
 * missing directory means nothing is taken yet — the first worktree for a
 * project creates it.
 */
export const allocateWorktreeDirectoryName = Effect.fn("allocateWorktreeDirectoryName")(
  function* (input: {
    readonly projectWorktreesDir: string;
    readonly seed: string;
    readonly legacyName: string;
    /**
     * Names that are unavailable for a reason the directory listing cannot show
     * — chiefly a lingering `t3code/<codename>` branch whose worktree was already
     * reclaimed. `git worktree add -b` fails outright on those, so a caller that
     * can see refs passes them here.
     */
    readonly reservedNames?: ReadonlySet<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem
      .readDirectory(input.projectWorktreesDir)
      .pipe(Effect.orElseSucceed(() => []));

    return chooseWorktreeDirectoryName({
      seed: input.seed,
      legacyName: input.legacyName,
      taken: new Set([...entries, ...(input.reservedNames ?? [])]),
    });
  },
);

/**
 * Codenames already claimed by a `t3code/<codename>` branch. Best effort by
 * design: the ref listing is paginated, and a name this misses simply behaves
 * the way it did before reserved names existed.
 */
export function reservedCodenamesFromRefNames(refNames: Iterable<string>): ReadonlySet<string> {
  const reserved = new Set<string>();
  const prefix = `${WORKTREE_BRANCH_PREFIX}/`;
  for (const refName of refNames) {
    const normalized = refName.trim().toLowerCase();
    if (!normalized.startsWith(prefix)) continue;
    const codename = worktreeCodenameFromDirectoryName(normalized.slice(prefix.length));
    if (codename !== null) reserved.add(codename);
  }
  return reserved;
}

/** The pre-codename directory name: the branch with its slashes swapped. */
export function legacyWorktreeDirectoryName(branch: string): string {
  return branch.replace(/\//g, "-");
}
