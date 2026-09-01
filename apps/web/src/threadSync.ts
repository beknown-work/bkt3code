import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

// T3-CUSTOM(expbkt3): "offline" exists because the other two phases both promise
// something is in flight. When the host is unreachable nothing is syncing and
// nothing is going to load, and a spinner that never resolves is worse than no
// spinner: it reads as a hang rather than as a machine being down.
export type ThreadSyncPhase = "loading" | "syncing" | "offline";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
  // T3-CUSTOM(expbkt3): defaults to true so callers that cannot know keep the
  // pre-existing behaviour.
  readonly hostReachable?: boolean;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      // T3-CUSTOM(expbkt3): an unreachable host is a settled state, not a wait.
      if (input.hostReachable === false) {
        return "offline";
      }
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  switch (phase) {
    case "loading":
      return "Loading messages...";
    case "syncing":
      return "Syncing messages...";
    // T3-CUSTOM(expbkt3): says what is on screen, not what is happening.
    case "offline":
      return "Cached copy — host offline";
  }
}
