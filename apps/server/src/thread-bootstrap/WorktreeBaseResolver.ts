// T3-CUSTOM(expbkt3): resolve exact durable-bootstrap bases independently of ref-list pagination.
import type { VcsListRefsInput, VcsListRefsResult, WorktreeBaseRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveExactBranch } from "./DefaultsResolver.ts";

export function resolveAvailableWorktreeBase<E>(input: {
  readonly cwd: string;
  readonly baseRef: WorktreeBaseRef;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, E>;
}) {
  const exactRefName =
    input.baseRef.kind === "branch"
      ? input.baseRef.source === "origin"
        ? `origin/${input.baseRef.branch}`
        : input.baseRef.branch
      : undefined;
  return input
    .listRefs({
      cwd: input.cwd,
      refresh: true,
      includeMatchingRemoteRefs: true,
      ...(exactRefName === undefined ? {} : { query: exactRefName }),
      ...(input.baseRef.kind === "branch"
        ? { refKind: input.baseRef.source === "origin" ? "remote" : "local" }
        : {}),
    })
    .pipe(Effect.map((refs) => resolveExactBranch(refs.refs, input.baseRef)));
}
