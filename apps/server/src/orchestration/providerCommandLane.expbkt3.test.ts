/** T3-CUSTOM(expbkt3): regression for the 2026-08-20 global prompt-queue outage. */
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { runProviderCommandWithinLaneDeadline } from "./providerCommandLane.expbkt3.ts";

it.effect("lets the next worker item run when a provider command is uninterruptible", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondRan = yield* Ref.make(false);
    const worker = yield* makeDrainableWorker((item: "wedged" | "next") =>
      runProviderCommandWithinLaneDeadline(
        item === "wedged"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Effect.uninterruptible(Effect.never)),
            )
          : Ref.set(secondRan, true),
        {
          eventType: `test.${item}`,
          threadId: item,
          commandId: item,
          timeout: "50 millis",
        },
      ),
    );

    yield* worker.enqueue("wedged");
    yield* Deferred.await(firstStarted);
    yield* worker.enqueue("next");
    yield* TestClock.adjust("60 millis");
    yield* worker.drain;

    assert.isTrue(yield* Ref.get(secondRan));
  }).pipe(Effect.scoped),
);
