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
// T3-CUSTOM(expbkt3): BEGIN — per-environment nickname, icon and colour.
import { useEnvironmentAppearanceStore } from "../environmentAppearanceStore";
import {
  resolveEnvironmentAppearance,
  type EnvironmentAppearance,
  type ResolvedEnvironmentAppearance,
} from "./environmentAppearance";
// T3-CUSTOM(expbkt3): END
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

// T3-CUSTOM(expbkt3): BEGIN — resolved appearance travels with every environment view.
export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  /**
   * What to show the operator. T3-CUSTOM(expbkt3): this is the nickname when one
   * is set, so every existing consumer displays it without being touched. Use
   * `connectionLabel` when you need the underlying connection's own name.
   */
  readonly label: string;
  // T3-CUSTOM(expbkt3): BEGIN — the connection's own label, before any nickname.
  readonly connectionLabel: string;
  readonly appearance: ResolvedEnvironmentAppearance;
  // T3-CUSTOM(expbkt3): END
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — project the stored appearance into the environment view.
function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  // T3-CUSTOM(expbkt3): resolved so `label` carries the nickname everywhere.
  appearance: EnvironmentAppearance | undefined,
): EnvironmentPresentation {
  const connectionLabel = presentation.entry.target.label;
  const resolved = resolveEnvironmentAppearance({
    environmentId,
    label: connectionLabel,
    appearance,
  });
  return {
    ...presentation,
    environmentId,
    label: resolved.name,
    connectionLabel,
    appearance: resolved,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
  };
}
// T3-CUSTOM(expbkt3): END

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  // T3-CUSTOM(expbkt3): BEGIN — subscribe so renaming an environment re-renders every
  // surface that shows it, without each of them knowing the store exists.
  const storedAppearances = useEnvironmentAppearanceStore(
    (state) => state.appearanceByEnvironmentId,
  );

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(
          environmentId,
          presentation,
          storedAppearances[environmentId],
        ),
      ),
    [presentationById, storedAppearances],
  );
  // T3-CUSTOM(expbkt3): END

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
  // T3-CUSTOM(expbkt3): BEGIN — same nickname resolution as the list hook.
  const stored = useEnvironmentAppearanceStore((state) =>
    environmentId === null ? undefined : state.appearanceByEnvironmentId[environmentId],
  );
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, stored),
    [environmentId, presentation, stored],
  );
  // T3-CUSTOM(expbkt3): END
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
  return environment?.appearance ?? null;
}

/**
 * Appearance for every known environment, keyed by id. For lists that render rows
 * from several environments and would otherwise call the single hook in a loop.
 */
export function useEnvironmentAppearances(): ReadonlyMap<string, ResolvedEnvironmentAppearance> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.appearance]),
      ),
    [environments],
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
