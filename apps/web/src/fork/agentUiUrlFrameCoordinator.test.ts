/**
 * T3-CUSTOM(expbkt3): same-origin URL-frame ownership.
 *
 * A switch is deliberately two-phase: first no slot is active, then the next
 * slot mounts. That committed empty phase is what proves two same-origin apps
 * cannot overlap while React moves ownership between timeline and overlay.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useAgentUiUrlFrameCoordinator } from "./agentUiUrlFrameCoordinator";

const first = {
  slotId: "inline:aui_first",
  renderId: "aui_first",
  origin: "https://fixture.example.test",
  createdAt: "2026-08-29T08:00:00.000Z",
  priority: "inline" as const,
};
const second = {
  slotId: "inline:aui_second",
  renderId: "aui_second",
  origin: first.origin,
  createdAt: "2026-08-29T09:00:00.000Z",
  priority: "inline" as const,
};

describe("useAgentUiUrlFrameCoordinator", () => {
  beforeEach(() => useAgentUiUrlFrameCoordinator.getState().reset());

  it("activates the newest same-origin render through an empty phase", () => {
    const store = useAgentUiUrlFrameCoordinator.getState();
    store.register(first);
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      first.slotId,
    );

    store.register(second);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBeNull();
    expect(useAgentUiUrlFrameCoordinator.getState().pendingSlotByOrigin[first.origin]).toBe(
      second.slotId,
    );

    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      second.slotId,
    );
  });

  it("remounts an older render only after releasing the current slot", () => {
    const store = useAgentUiUrlFrameCoordinator.getState();
    store.register(first);
    store.settle(first.origin);
    store.register(second);
    store.settle(first.origin);

    store.activate(first.slotId);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBeNull();
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      first.slotId,
    );
  });

  it("gives an expanded slot priority and restores the newest inline slot", () => {
    const store = useAgentUiUrlFrameCoordinator.getState();
    store.register(first);
    store.settle(first.origin);
    store.register(second);
    store.settle(first.origin);

    const expanded = { ...first, slotId: "expanded:thread-1", priority: "expanded" as const };
    store.register(expanded);
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      expanded.slotId,
    );

    store.unregister(expanded.slotId);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBeNull();
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      second.slotId,
    );
  });

  it("reactivates the newest inline slot after virtualization remounts it", () => {
    const store = useAgentUiUrlFrameCoordinator.getState();
    store.register(first);
    store.settle(first.origin);
    store.register(second);
    store.settle(first.origin);

    store.unregister(second.slotId);
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      first.slotId,
    );

    store.register(second);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBeNull();
    store.settle(first.origin);
    expect(useAgentUiUrlFrameCoordinator.getState().activeSlotByOrigin[first.origin]).toBe(
      second.slotId,
    );
  });
});
