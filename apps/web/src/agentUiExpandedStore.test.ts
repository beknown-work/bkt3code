/**
 * T3-CUSTOM(expbkt3): expanded agent view state.
 *
 * Only one view may own the transcript at a time — expanding a second must
 * replace the first rather than stack, because the overlay is a single mount
 * point and a stack would strand the older one underneath it.
 */
import { describe, expect, it, beforeEach } from "vite-plus/test";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useAgentUiExpandedStore } from "./agentUiExpandedStore";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as unknown as ScopedThreadRef;
const otherThreadRef = {
  environmentId: "env-2",
  threadId: "thread-2",
} as unknown as ScopedThreadRef;

describe("useAgentUiExpandedStore", () => {
  beforeEach(() => {
    useAgentUiExpandedStore.getState().collapse();
  });

  it("starts with nothing expanded", () => {
    expect(useAgentUiExpandedStore.getState().expanded).toBeNull();
  });

  it("expands a view and collapses it again", () => {
    useAgentUiExpandedStore.getState().expand({ threadRef, renderId: "aui_1" });
    expect(useAgentUiExpandedStore.getState().expanded).toEqual({ threadRef, renderId: "aui_1" });

    useAgentUiExpandedStore.getState().collapse();
    expect(useAgentUiExpandedStore.getState().expanded).toBeNull();
  });

  it("replaces the expanded view rather than stacking a second one", () => {
    const store = useAgentUiExpandedStore.getState();
    store.expand({ threadRef, renderId: "aui_1" });
    store.expand({ threadRef: otherThreadRef, renderId: "aui_2" });

    expect(useAgentUiExpandedStore.getState().expanded).toEqual({
      threadRef: otherThreadRef,
      renderId: "aui_2",
    });
  });

  it("is a no-op to collapse when nothing is expanded", () => {
    useAgentUiExpandedStore.getState().collapse();
    expect(useAgentUiExpandedStore.getState().expanded).toBeNull();
  });
});
