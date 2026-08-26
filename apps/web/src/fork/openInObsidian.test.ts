// T3-CUSTOM(expbkt3): tests for the Obsidian mirror path mapping.
import { describe, expect, it } from "@effect/vitest";

import { buildObsidianOpenUri, obsidianMirrorRelativePath } from "./openInObsidian";

const WORKTREES = "/home/ubuntu/.t3/bkt3-dev/worktrees";

describe("obsidianMirrorRelativePath", () => {
  it("labels bk-docs worktrees with the UI codename", () => {
    // City-named directories are already codenames and map to themselves.
    expect(obsidianMirrorRelativePath(`${WORKTREES}/bk-docs/kisumu`)).toBe("bk-docs/kisumu");
  });

  it("hashes non-codename bk-docs directories exactly like the UI", () => {
    // These fixtures match live worktrees whose UI codenames were verified on
    // dev-server-1 (jamon/vlora); the mirror reconciler uses the same function.
    expect(
      obsidianMirrorRelativePath(
        `${WORKTREES}/bk-docs/linear-tec-974-make-creator-and-reporter-mandatory-and-fd177d82`,
      ),
    ).toBe("bk-docs/jamon");
    expect(
      obsidianMirrorRelativePath(
        `${WORKTREES}/bk-docs/linear-tec-982-deliver-the-unified-linear-intake-and-cr-72a55dde`,
      ),
    ).toBe("bk-docs/vlora");
  });

  it("keeps directory names for repos mirrored without codename labels", () => {
    expect(obsidianMirrorRelativePath(`${WORKTREES}/t3code-bkmain/vinh`)).toBe(
      "t3code-bkmain/vinh",
    );
  });

  it("ignores trailing slashes", () => {
    expect(obsidianMirrorRelativePath(`${WORKTREES}/bk-docs/kisumu/`)).toBe("bk-docs/kisumu");
  });

  it("returns null for non-worktree paths", () => {
    expect(obsidianMirrorRelativePath("/home/ubuntu/repos/bk-docs")).toBeNull();
    expect(obsidianMirrorRelativePath(null)).toBeNull();
  });
});

describe("buildObsidianOpenUri", () => {
  it("URL-encodes the absolute vault path", () => {
    expect(buildObsidianOpenUri("/Users/tushar/BKT3 Sessions/", "bk-docs/jamon")).toBe(
      `obsidian://open?path=${encodeURIComponent("/Users/tushar/BKT3 Sessions/bk-docs/jamon")}`,
    );
  });
});
