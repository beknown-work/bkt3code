// T3-CUSTOM(expbkt3): regression for projects whose local main has no origin/HEAD.
import type { VcsListRefsInput, VcsListRefsResult } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { resolveAvailableWorktreeBase } from "./WorktreeBaseResolver.ts";

it.effect(
  "uses the checked-out local branch after an inherited origin default loses its remote",
  () =>
    Effect.gen(function* () {
      const listRefs = (_input: VcsListRefsInput): Effect.Effect<VcsListRefsResult> =>
        Effect.succeed({
          // This is the shape GitVcsDriver returns for `git init` + a local main:
          // Git has no origin/HEAD, so isDefault is false while current is true.
          refs: [
            {
              name: "main",
              current: true,
              isDefault: false,
              isRemote: false,
              worktreePath: "/tmp/no-origin-project",
            },
          ],
          isRepo: true,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 1,
        });

      const base = yield* resolveAvailableWorktreeBase({
        cwd: "/tmp/no-origin-project",
        baseRef: { kind: "repository-default", source: "local" },
        listRefs,
        resolveRemoteTrackingCommit: () => Effect.fail("not called"),
      });

      expect(base).toEqual({ kind: "branch", source: "local", branch: "main" });
    }),
);
