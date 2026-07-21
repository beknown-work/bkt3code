import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  PHASE_SIDEBAR_FILTER_STORAGE_KEY,
  usePhaseSidebarFilterStore,
} from "./phaseSidebarFilterStore";

describe("phase sidebar filter store", () => {
  beforeEach(() => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: [],
      phaseIds: [],
      providerKinds: [],
    });
  });

  it("uses a versioned persistence key and toggles independent facets", () => {
    expect(PHASE_SIDEBAR_FILTER_STORAGE_KEY).toBe("t3code:phase-sidebar-filters:v1");
    const state = usePhaseSidebarFilterStore.getState();
    state.toggleRepository("repo-1");
    state.toggleRepository("repo-2");
    state.togglePhase("ready");
    state.toggleProvider("codex");

    expect(usePhaseSidebarFilterStore.getState()).toMatchObject({
      repositoryKeys: ["repo-1", "repo-2"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
    });
    usePhaseSidebarFilterStore.getState().toggleRepository("repo-1");
    expect(usePhaseSidebarFilterStore.getState().repositoryKeys).toEqual(["repo-2"]);
  });

  it("clears selections without changing store actions", () => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready_for_review"],
      providerKinds: ["codex"],
    });
    usePhaseSidebarFilterStore.getState().clearAll();
    const state = usePhaseSidebarFilterStore.getState();
    expect(state.repositoryKeys).toEqual([]);
    expect(state.phaseIds).toEqual([]);
    expect(state.providerKinds).toEqual([]);
    expect(state.toggleRepository).toBeTypeOf("function");
  });

  it("removes stale repository and provider values only when explicitly reconciled", () => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: ["repo-1", "stale-repo"],
      phaseIds: ["ready"],
      providerKinds: ["codex", "stale-provider"],
    });
    expect(usePhaseSidebarFilterStore.getState().repositoryKeys).toContain("stale-repo");

    usePhaseSidebarFilterStore.getState().reconcile({
      repositoryKeys: new Set(["repo-1"]),
      providerKinds: new Set(["codex"]),
      assignmentAvailable: true,
    });
    expect(usePhaseSidebarFilterStore.getState()).toMatchObject({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
    });
  });
});
