import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
// T3-CUSTOM(expbkt3): per-environment nickname, icon and colour.
import { useEnvironmentAppearanceStore } from "../environmentAppearanceStore";
import {
  resolveEnvironmentAppearance,
  type ResolvedEnvironmentAppearance,
} from "./environmentAppearance";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
    [presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation),
    [environmentId, presentation],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}

// T3-CUSTOM(expbkt3): BEGIN — per-environment identity for multi-environment clients.

/**
 * The resolved nickname, icon and colour for one environment. Falls back to the
 * connection label and a value derived from the environment id, so an environment
 * is always distinguishable even before anyone customises it.
 */
export function useEnvironmentAppearance(
  environmentId: EnvironmentId | null,
): ResolvedEnvironmentAppearance | null {
  const environment = useEnvironment(environmentId);
  const stored = useEnvironmentAppearanceStore((state) =>
    environmentId === null ? undefined : state.appearanceByEnvironmentId[environmentId],
  );
  return useMemo(
    () =>
      environmentId === null
        ? null
        : resolveEnvironmentAppearance({
            environmentId,
            label: environment?.label ?? "Environment",
            appearance: stored,
          }),
    [environmentId, environment?.label, stored],
  );
}

/**
 * Appearance for every known environment, keyed by id. For lists that render rows
 * from several environments and would otherwise call the single hook in a loop.
 */
export function useEnvironmentAppearances(): ReadonlyMap<string, ResolvedEnvironmentAppearance> {
  const { environments } = useEnvironments();
  const stored = useEnvironmentAppearanceStore((state) => state.appearanceByEnvironmentId);
  return useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          resolveEnvironmentAppearance({
            environmentId: environment.environmentId,
            label: environment.label,
            appearance: stored[environment.environmentId],
          }),
        ]),
      ),
    [environments, stored],
  );
}

/**
 * Whether this client knows about more than one environment at all.
 *
 * Surfaces that always show everything (settings lists) use this. Surfaces that
 * show a filtered set — the sidebar above all — must instead ask whether *the rows
 * they are about to render* span more than one environment, because a second
 * environment with nothing in view is not a reason to add a column of badges to
 * every row. See `hasMultipleEnvironments` for that case.
 */
export function useHasMultipleEnvironments(): boolean {
  const { environments } = useEnvironments();
  return environments.length > 1;
}

/** True when the supplied rows come from more than one environment. */
export function hasMultipleEnvironments(
  rows: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]?.environmentId;
  return rows.some((row) => row.environmentId !== first);
}
// T3-CUSTOM(expbkt3): END
