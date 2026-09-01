import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadHostReachable } from "./threadHostReachability";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function connectionState(phase: SupervisorConnectionState["phase"]): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, phase };
}

describe("resolveThreadHostReachable", () => {
  it("does not require a placeholder id when the route has no environment", () => {
    expect(resolveThreadHostReachable(null, null)).toBe(true);
  });

  it("treats a not-yet-projected connection as reachable", () => {
    expect(resolveThreadHostReachable(ENVIRONMENT_ID, null)).toBe(true);
  });

  it.each(["available", "offline", "backoff", "blocked"] as const)(
    "treats the %s connection phase as unreachable",
    (phase) => {
      expect(resolveThreadHostReachable(ENVIRONMENT_ID, connectionState(phase))).toBe(false);
    },
  );

  it.each(["connecting", "connected"] as const)(
    "treats the %s connection phase as reachable",
    (phase) => {
      expect(resolveThreadHostReachable(ENVIRONMENT_ID, connectionState(phase))).toBe(true);
    },
  );
});
