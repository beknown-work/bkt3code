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
  PlannotatorPlanFormat,
  PlannotatorSession,
} from "./PlannotatorManager.ts";

type NativePlanManager = Pick<
  PlannotatorManager["Service"],
  "start" | "discard" | "list" | "reopen"
>;
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
  | { readonly status: "reopened"; readonly session: PlannotatorSession }
  | { readonly status: "attached"; readonly session: PlannotatorSession };

/**
 * T3-CUSTOM(expbkt3): Native providers expose one `planMarkdown` field even
 * when the agent produced HTML. Treat only a complete HTML document as HTML so
 * Markdown plans containing snippets or fenced HTML keep their normal renderer.
 */
export function nativePlannotatorPlanFormat(content: string): PlannotatorPlanFormat {
  const document = content.trimStart();
  return /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/i.test(
    document,
  )
    ? "html"
    : "md";
}

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
        (session) => session.proxyPath === markerPath && session.planId === proposedPlan.id,
      )
    : undefined;

  const content = withoutPlannotatorPlanMarker(proposedPlan.planMarkdown);
  if (!content.trim()) {
    return { status: "skipped" } as const;
  }
  const format = nativePlannotatorPlanFormat(content);
  if (attachedSession) {
    if (attachedSession.format === format) {
      return { status: "already-attached", session: attachedSession } as const;
    }
    // Upgrade reviews created before native HTML detection without changing
    // their opaque URL, captured annotations, or proposed-plan identity.
    const migrated = yield* dependencies.manager.reopen({
      tokenOrId: attachedSession.id,
      planId: proposedPlan.id,
      format,
      content,
    });
    return { status: "reopened", session: migrated } as const;
  }

  // Native provider revisions normally arrive as a new turn-scoped plan id.
  // Reuse the latest feedback lineage (or the same plan's live review) so the
  // token, plan path, and accumulated annotations stay durable across rounds.
  const reusableSession = sessions
    .filter(
      (session) =>
        session.planId === proposedPlan.id ||
        (session.feedback.trim().length > 0 &&
          session.status !== "approved" &&
          session.status !== "denied"),
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.createdAt.localeCompare(left.createdAt),
    )
    .at(0);
  const session = reusableSession
    ? yield* dependencies.manager.reopen({
        tokenOrId: reusableSession.id,
        planId: proposedPlan.id,
        format,
        content,
      })
    : yield* dependencies.manager.start({
        threadId,
        planId: proposedPlan.id,
        format,
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
    .pipe(
      EffectRuntime.tapError(() =>
        reusableSession ? EffectRuntime.void : dependencies.manager.discard(session.id),
      ),
    );

  return {
    status: reusableSession ? ("reopened" as const) : ("attached" as const),
    session,
  };
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
