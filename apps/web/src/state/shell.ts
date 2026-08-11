import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

export const allEnvironmentShellsLiveAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady || catalog.entries.size === 0) return false;
  for (const environmentId of catalog.entries.keys()) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") return false;
  }
  return true;
}).pipe(Atom.withLabel("all-environment-shells-live"));

// T3-CUSTOM(expbkt3): BEGIN — per-environment visibility for notification alerts.
/** Which environments exist, and which of them this client can actually see. */
export interface EnvironmentShellReadiness {
  readonly known: ReadonlySet<string>;
  readonly ready: ReadonlySet<string>;
}

function readinessSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

let previousShellReadiness: EnvironmentShellReadiness = {
  known: new Set<string>(),
  ready: new Set<string>(),
};

/**
 * Readiness is read off `environmentSnapshotAtom` — the very atom the thread
 * list is derived from — so "this environment is ready" and "these are its
 * threads" can never disagree by a frame. Anything watching for new rows needs
 * that: a ready flag that arrived a tick before its rows would make the whole
 * list look like new arrivals.
 */
export const environmentShellReadinessAtom = Atom.make((get): EnvironmentShellReadiness => {
  const known = new Set<string>();
  const ready = new Set<string>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    known.add(environmentId);
    if (get(environmentSnapshotAtom(environmentId)) !== null) {
      ready.add(environmentId);
    }
  }
  if (
    readinessSetsEqual(previousShellReadiness.known, known) &&
    readinessSetsEqual(previousShellReadiness.ready, ready)
  ) {
    return previousShellReadiness;
  }
  previousShellReadiness = { known, ready };
  return previousShellReadiness;
}).pipe(Atom.withLabel("web-environment-shell-readiness"));
// T3-CUSTOM(expbkt3): END

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));
