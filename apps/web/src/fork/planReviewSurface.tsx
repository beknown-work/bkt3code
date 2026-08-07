/**
 * T3-CUSTOM(expbkt3): single entry point for the native plan review surface.
 *
 * Everything upstream files need lives here, so `ChatView`, `RightPanelTabs`
 * and `ProposedPlanCard` each take one import and one line rather than growing
 * plan-review logic inline. That keeps the next upstream merge cheap.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { lazy } from "react";

import { planReviewEnvironment } from "../state/planReview";
import { useEnvironmentQuery } from "../state/query";

/** Plate is ~200 kB gzip — it must only load when a review is actually opened. */
export const PlanReviewPanel = lazy(() => import("../components/planreview/PlanReviewPanel"));

/**
 * The thread's reviewable plan, or null when there is none.
 *
 * At most one plan document per thread is `open` at a time: an agent revision
 * appends a version to the existing lineage rather than starting a new one, so
 * this resolves to a single id without ambiguity.
 */
export function useOpenPlanReviewDocumentId(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): string | null {
  const { data } = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : planReviewEnvironment.list({ environmentId, input: { threadId } }),
  );

  return data?.documents.find((document) => document.status === "open")?.documentId ?? null;
}
