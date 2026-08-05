// T3-CUSTOM(expbkt3): configured worktree bases must survive ref-list pagination.
import type { VcsListRefsInput, VcsListRefsResult } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { resolveAvailableWorktreeBase } from "./WorktreeBaseResolver.ts";

it.effect("uses exact Git proof when the ref list misses the configured origin base", () =>
  Effect.gen(function* () {
    const listRefs = (_input: VcsListRefsInput): Effect.Effect<VcsListRefsResult> =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 111,
      });

    const resolved = yield* resolveAvailableWorktreeBase({
      cwd: "/repo",
      baseRef: { kind: "branch", source: "origin", branch: "bkmain" },
      listRefs,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({
          commitSha: "0123456789abcdef",
          remoteRefName: "origin/bkmain",
        }),
    });

    expect(resolved).toEqual({ kind: "branch", source: "origin", branch: "bkmain" });
  }),
);

it.effect("keeps a genuinely missing origin base unavailable", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveAvailableWorktreeBase({
      cwd: "/repo",
      baseRef: { kind: "branch", source: "origin", branch: "missing" },
      listRefs: () =>
        Effect.succeed({
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        }),
      resolveRemoteTrackingCommit: () => Effect.fail("missing"),
    });

    expect(resolved).toBeNull();
  }),
);
