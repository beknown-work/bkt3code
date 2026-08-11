import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { hidePlannotatorReview, removePlannotatorReview } from "./PersistentPlannotatorReviewHost";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const reviewUrl = "/plannotator/review_token/";

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("hidePlannotatorReview", () => {
  it("keeps the review surface mounted when the panel closes immediately", () => {
    useRightPanelStore.getState().openPlannotator(threadRef, reviewUrl);

    hidePlannotatorReview(threadRef);

    const hiddenState = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    expect(hiddenState).toEqual({
      isOpen: false,
      activeSurfaceId: `plannotator:${reviewUrl}`,
      surfaces: [{ id: `plannotator:${reviewUrl}`, kind: "plannotator", url: reviewUrl }],
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toBe(null);

    useRightPanelStore.getState().openPlannotator(threadRef, reviewUrl);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toHaveLength(1);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ id: `plannotator:${reviewUrl}`, kind: "plannotator", url: reviewUrl });
  });

  it("removes a terminal surface and recreates it on an intentional reopen", () => {
    useRightPanelStore.getState().open(threadRef, "diff");
    useRightPanelStore.getState().openPlannotator(threadRef, reviewUrl);

    removePlannotatorReview(threadRef, `plannotator:${reviewUrl}`);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });

    useRightPanelStore.getState().openPlannotator(threadRef, reviewUrl);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([
      { id: "diff", kind: "diff" },
      { id: `plannotator:${reviewUrl}`, kind: "plannotator", url: reviewUrl },
    ]);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({ id: `plannotator:${reviewUrl}`, kind: "plannotator", url: reviewUrl });
  });
});
