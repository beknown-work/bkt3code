// T3-CUSTOM(expbkt3): resolve exact durable-bootstrap bases independently of ref-list pagination.
import type { VcsListRefsInput, VcsListRefsResult, WorktreeBaseRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveExactBranch } from "./DefaultsResolver.ts";

export function resolveAvailableWorktreeBase<ListError, ResolveError>(input: {
  readonly cwd: string;
  readonly baseRef: WorktreeBaseRef;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, ListError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<{ readonly commitSha: string; readonly remoteRefName: string }, ResolveError>;
}) {
  const exactRefName =
    input.baseRef.kind === "branch"
      ? input.baseRef.source === "origin"
        ? `origin/${input.baseRef.branch}`
        : input.baseRef.branch
      : undefined;
  const resolveFromList = () =>
    input
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

  if (input.baseRef.kind !== "branch" || input.baseRef.source !== "origin") {
    return resolveFromList();
  }

  // The exact Git ref is authoritative. Fall back to the typed list so a
  // genuinely missing ref still produces the existing unavailable result.
  return input
    .resolveRemoteTrackingCommit({
      cwd: input.cwd,
      refName: `origin/${input.baseRef.branch}`,
      fallbackRemoteName: "origin",
    })
    .pipe(
      Effect.as(input.baseRef),
      Effect.catch(() => resolveFromList()),
    );
}
