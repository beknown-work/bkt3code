import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentQuery } from "../state/query";

export function resolveThreadHostReachable(
  environmentId: EnvironmentId | null,
  connectionState: SupervisorConnectionState | null,
): boolean {
  return (
    environmentId === null ||
    connectionState === null ||
    connectionProjectionPhase(connectionState) !== "disconnected"
  );
}

export function useThreadHostReachable(environmentId: EnvironmentId | null): boolean {
  const connectionState = useEnvironmentQuery(
    environmentId === null ? null : environmentCatalog.stateAtom(environmentId),
  );
  return resolveThreadHostReachable(environmentId, connectionState.data);
}
