/**
 * T3-CUSTOM(expbkt3): WorkSummaryReactor - bulk session manager summaries.
 *
 * Owns the background worker that answers `thread.work-summary-requested` by
 * asking the configured model what a session has achieved and how far along it
 * is, then writing that back as the thread's durable work summary.
 *
 * It exists next to `CatchupSummaryReactor` rather than inside it because the
 * two answer different questions for different readers, and the operator
 * configures them independently: disabling catch-up notes must not silence the
 * session manager's columns, and vice versa.
 *
 * The worker is deliberately serial. A bulk selection of fifty sessions arrives
 * as fifty commands within a second; fanning those out concurrently would
 * launch fifty provider CLIs at once on the same host.
 *
 * @module WorkSummaryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * WorkSummaryReactorShape - Service API for work summary reactor lifecycle.
 */
export interface WorkSummaryReactorShape {
  /**
   * Start the work summary reactor.
   *
   * The returned effect must be run in a scope so the subscription and worker
   * fibers are finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * WorkSummaryReactor - Service tag for work summary reactor workers.
 */
export class WorkSummaryReactor extends Context.Service<
  WorkSummaryReactor,
  WorkSummaryReactorShape
>()("t3/orchestration/Services/WorkSummaryReactor") {}
