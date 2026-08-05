// T3-CUSTOM(expbkt3): configured worktree bases must survive ref-list pagination.
import type { VcsListRefsInput, VcsListRefsResult } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { resolveAvailableWorktreeBase } from "./WorktreeBaseResolver.ts";

it.effect("finds an exact origin base beyond the default ref-list page", () =>
  Effect.gen(function* () {
    const listRefs = (input: VcsListRefsInput): Effect.Effect<VcsListRefsResult> =>
      Effect.succeed({
        refs:
          input.query === "origin/bkmain"
            ? [
                {
                  name: "origin/bkmain",
                  current: false,
                  isDefault: false,
                  isRemote: true,
                  remoteName: "origin",
                  worktreePath: null,
                },
              ]
            : Array.from({ length: 100 }, (_, index) => ({
                name: `local-${index}`,
                current: false,
                isDefault: false,
                isRemote: false,
                worktreePath: null,
              })),
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 111,
      });

    const resolved = yield* resolveAvailableWorktreeBase({
      cwd: "/repo",
      baseRef: { kind: "branch", source: "origin", branch: "bkmain" },
      listRefs,
    });

    expect(resolved).toEqual({ kind: "branch", source: "origin", branch: "bkmain" });
  }),
);
