import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
type ShellThread = OrchestrationShellSnapshot["threads"][number];

/**
 * T3-CUSTOM(expbkt3): merge a projection upsert over the live execution overlay.
 *
 * Execution arrives on its own backend-authoritative stream and projection
 * upserts omit it, so a plain replacement (upstream's behaviour) would erase a
 * fresher overlay on every title or message update and send the sidebar back to
 * Checking. Carrying the overlay forward fixes that but introduces the opposite
 * failure: execution frames are live-only and are not replayed, so a client that
 * was away when a turn ended pins "Running" forever.
 *
 * The upsert itself resolves the conflict. It carries `latestTurn` straight from
 * the turn projection, so when it reports the overlay's own turn as finished,
 * the overlay is provably stale and is dropped rather than preserved.
 */
export function mergeUpsertedThread(previous: ShellThread, next: ShellThread): ShellThread {
  if (next.execution !== undefined || previous.execution === undefined) return next;

  const overlayTurnId = previous.execution?.turn?.providerTurnId;
  const latestTurn = next.latestTurn;
  const overlayContradicted =
    overlayTurnId !== undefined &&
    overlayTurnId !== null &&
    latestTurn !== null &&
    latestTurn.turnId === overlayTurnId &&
    latestTurn.state !== "running";

  return overlayContradicted ? next : { ...next, execution: previous.execution };
}

export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  // Team-mode visibility may expand one durable event into multiple derived
  // shell frames (for example, parent project then new thread) that deliberately
  // share a sequence. Applying equal-sequence frames is safe because every
  // operation below is idempotent; only genuinely older frames are stale.
  if (event.sequence < snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) =>
            t.id === event.thread.id ? mergeUpsertedThread(t, event.thread) : t,
          )
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
