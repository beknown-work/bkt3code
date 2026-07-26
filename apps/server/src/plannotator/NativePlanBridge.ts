/**
 * T3-CUSTOM(expbkt3): Bridges T3's native proposed-plan lifecycle into
 * Plannotator without requiring an agent-only submission tool.
 */
import { CommandId, type OrchestrationProposedPlan, type ThreadId } from "@t3tools/contracts";
import {
  plannotatorProxyPathFromPlan,
  withPlannotatorPlanMarker,
  withoutPlannotatorPlanMarker,
} from "@t3tools/shared/plannotator";
import type * as Effect from "effect/Effect";
import * as EffectRuntime from "effect/Effect";

import type { OrchestrationCommandDispatcher } from "../orchestration/dispatchCommand.ts";
import type {
  PlannotatorManager,
  PlannotatorManagerError,
  PlannotatorSession,
} from "./PlannotatorManager.ts";

type NativePlanManager = Pick<PlannotatorManager["Service"], "start" | "discard" | "list">;
type NativePlanDispatcher = Pick<OrchestrationCommandDispatcher["Service"], "dispatch">;

export interface NativePlanBridgeDependencies {
  readonly manager: NativePlanManager;
  readonly dispatcher: NativePlanDispatcher;
  readonly randomUuid: Effect.Effect<string, PlannotatorManagerError>;
  readonly now: Effect.Effect<string>;
}

export interface NativePlanBridgeInput {
  readonly threadId: ThreadId;
  readonly proposedPlan: OrchestrationProposedPlan;
}

export type NativePlanBridgeResult =
  | { readonly status: "skipped" }
  | { readonly status: "already-attached"; readonly session: PlannotatorSession }
  | { readonly status: "attached"; readonly session: PlannotatorSession };

const ACTIVE_REVIEW_STATUSES = new Set<PlannotatorSession["status"]>([
  "starting",
  "running",
  "applying",
]);

/**
 * Attach Plannotator to the same proposed-plan record created by T3's native
 * plan lifecycle. The marker is deliberately stored on the existing record so
 * every current client receives the review URL through the normal projection
 * and WebSocket event flow.
 */
export const attachNativePlanReview = EffectRuntime.fn("attachNativePlanReview")(function* (
  dependencies: NativePlanBridgeDependencies,
  input: NativePlanBridgeInput,
) {
  const { proposedPlan, threadId } = input;
  if (proposedPlan.implementedAt !== null) {
    return { status: "skipped" } as const;
  }

  const markerPath = plannotatorProxyPathFromPlan(proposedPlan.planMarkdown);
  const sessions = yield* dependencies.manager.list(threadId);
  const attachedSession = markerPath
    ? sessions.find(
        (session) =>
          session.proxyPath === markerPath &&
          session.planId === proposedPlan.id &&
          ACTIVE_REVIEW_STATUSES.has(session.status),
      )
    : undefined;
  if (attachedSession) {
    return { status: "already-attached", session: attachedSession } as const;
  }

  // An unmarked upsert for an existing plan id means the provider revised the
  // plan. Stop the old live review so Plannotator opens the current content.
  const obsoleteActiveSessions = sessions.filter(
    (session) => session.planId === proposedPlan.id && ACTIVE_REVIEW_STATUSES.has(session.status),
  );
  yield* EffectRuntime.forEach(
    obsoleteActiveSessions,
    (session) => dependencies.manager.discard(session.id),
    { concurrency: 2, discard: true },
  );

  const content = withoutPlannotatorPlanMarker(proposedPlan.planMarkdown);
  if (!content.trim()) {
    return { status: "skipped" } as const;
  }

  const session = yield* dependencies.manager.start({
    threadId,
    planId: proposedPlan.id,
    format: "md",
    content,
  });
  const [uuid, updatedAt] = yield* EffectRuntime.all([dependencies.randomUuid, dependencies.now]);

  yield* dependencies.dispatcher
    .dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.make(`plannotator:native-plan:${uuid}`),
      threadId,
      proposedPlan: {
        ...proposedPlan,
        planMarkdown: withPlannotatorPlanMarker(content, session.proxyPath),
        updatedAt,
      },
      createdAt: updatedAt,
    })
    .pipe(EffectRuntime.tapError(() => dependencies.manager.discard(session.id)));

  return { status: "attached", session } as const;
});

/**
 * Reconcile only the newest plan per thread. Older unimplemented plans are
 * historical timeline entries, while the newest plan is T3's actionable
 * "Plan Ready" state.
 */
export function latestPlansForNativeReview(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
    readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  }>,
): ReadonlyArray<NativePlanBridgeInput> {
  return threads.flatMap((thread) => {
    if (thread.archivedAt !== null || thread.deletedAt !== null) return [];

    const proposedPlan = thread.proposedPlans
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    return proposedPlan && proposedPlan.implementedAt === null
      ? [{ threadId: thread.id, proposedPlan }]
      : [];
  });
}
