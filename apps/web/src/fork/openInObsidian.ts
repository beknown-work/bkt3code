/**
 * T3-CUSTOM(expbkt3): Open a thread's worktree in the local Obsidian vault.
 *
 * dev-server-1 mirrors every live worktree to the user's machine via Syncthing
 * (see the bkt3-obsidian-mirror reconciler on that host). Mirrors live inside a
 * single Obsidian vault whose layout this module mirrors:
 *
 *   <mirror root>/bk-docs/<codename>   — bk-docs worktrees, labelled by the same
 *                                        codename the T3 UI shows for the thread
 *   <mirror root>/<repo>/<dirname>     — any other mirrored worktree (e.g. the
 *                                        manually-shared pilot folders)
 *
 * The mirror root is machine-local (a path on the user's Mac), so it is stored
 * in localStorage rather than in client settings that roam across devices.
 */

import { resolveWorktreeCodename } from "@t3tools/shared/worktreeCodename";

const MIRROR_ROOT_STORAGE_KEY = "bkt3:obsidian-mirror-root";
const MIRROR_ROOT_SUGGESTION = "/Users/yourname/BKT3 Sessions";

/** Repos whose mirrors are named by codename instead of directory name. */
const CODENAME_LABELLED_REPOS = new Set(["bk-docs"]);

const WORKTREE_PATH_PATTERN = /\/worktrees\/([^/]+)\/([^/]+)\/?$/;

/**
 * Vault-relative path of the mirror for a server worktree path, or null when
 * the path is not a T3-managed worktree (e.g. a project's shared checkout).
 */
export function obsidianMirrorRelativePath(worktreePath: string | null): string | null {
  if (worktreePath === null) return null;
  const match = WORKTREE_PATH_PATTERN.exec(worktreePath.trim());
  if (match === null) return null;
  const [, repo, directoryName] = match;
  if (repo === undefined || directoryName === undefined) return null;
  if (CODENAME_LABELLED_REPOS.has(repo)) {
    return `${repo}/${resolveWorktreeCodename(worktreePath)}`;
  }
  return `${repo}/${directoryName}`;
}

export function buildObsidianOpenUri(mirrorRoot: string, relativePath: string): string {
  const root = mirrorRoot.trim().replace(/\/+$/, "");
  return `obsidian://open?path=${encodeURIComponent(`${root}/${relativePath}`)}`;
}

export function readObsidianMirrorRoot(): string | null {
  try {
    const value = window.localStorage.getItem(MIRROR_ROOT_STORAGE_KEY);
    return value !== null && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeObsidianMirrorRoot(root: string): void {
  try {
    window.localStorage.setItem(MIRROR_ROOT_STORAGE_KEY, root);
  } catch {
    // localStorage unavailable — the prompt will simply reappear next time.
  }
}

/**
 * Ask the user where their synced "BKT3 Sessions" vault lives. Returns the
 * stored or newly-entered absolute path, or null when the user cancels.
 */
export function ensureObsidianMirrorRoot(forcePrompt = false): string | null {
  const existing = readObsidianMirrorRoot();
  if (existing !== null && !forcePrompt) return existing;
  const entered = window.prompt(
    "Absolute path of your synced Obsidian vault (the folder you opened as the vault):",
    existing ?? MIRROR_ROOT_SUGGESTION,
  );
  if (entered === null) return null;
  const trimmed = entered.trim();
  if (trimmed.length === 0 || trimmed === MIRROR_ROOT_SUGGESTION) return null;
  writeObsidianMirrorRoot(trimmed);
  return trimmed;
}

/**
 * Open the worktree's mirror in Obsidian. Desktop goes through the Electron
 * shell (requires a BK desktop build that allows the obsidian: protocol); the
 * browser navigates the current tab, which triggers the OS protocol handler
 * without unloading the page.
 */
export async function openWorktreeInObsidian(worktreePath: string | null): Promise<boolean> {
  const relativePath = obsidianMirrorRelativePath(worktreePath);
  if (relativePath === null) return false;
  const mirrorRoot = ensureObsidianMirrorRoot();
  if (mirrorRoot === null) return false;
  const uri = buildObsidianOpenUri(mirrorRoot, relativePath);
  if (window.desktopBridge !== undefined) {
    const opened = await window.desktopBridge.openExternal(uri);
    if (!opened) {
      // Older desktop shells reject non-http(s) protocols; leave the URI on
      // the clipboard so the click still has a usable result.
      await navigator.clipboard.writeText(uri).catch(() => {});
      window.alert(
        "This desktop build cannot launch Obsidian yet — the obsidian:// link was copied to your clipboard. Update the BK desktop app to enable one-click open.",
      );
      return false;
    }
    return true;
  }
  window.location.assign(uri);
  return true;
}
