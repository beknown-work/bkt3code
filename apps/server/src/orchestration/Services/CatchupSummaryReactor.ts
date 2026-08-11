/**
 * CatchupSummaryReactor - Session catch-up summary reaction service interface.
 *
 * Owns the background worker that folds completed turns into a thread's rolling
 * summary and, for turns that ran longer than the configured cutoff, produces
 * the short catch-up note rendered under the turn's final output.
 *
 * @module CatchupSummaryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * CatchupSummaryReactorShape - Service API for catch-up summary reactor lifecycle.
 */
export interface CatchupSummaryReactorShape {
  /**
   * Start the catch-up summary reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Consumes both orchestration-domain and provider-runtime events via an
   * internal queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * CatchupSummaryReactor - Service tag for catch-up summary reactor workers.
 */
export class CatchupSummaryReactor extends Context.Service<
  CatchupSummaryReactor,
  CatchupSummaryReactorShape
>()("t3/orchestration/Services/CatchupSummaryReactor") {}
