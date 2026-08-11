import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { awaitShellProjectionSequence } from "./shellProjectionBarrier.ts";

it.effect("does not release a shell event before its projection is current", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const snapshotSequence = yield* Ref.make(40);
      const readCount = yield* Ref.make(0);
      const barrier = yield* awaitShellProjectionSequence({
        eventSequence: 41,
        eventType: "thread.created",
        readSnapshotSequence: () =>
          Ref.update(readCount, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(snapshotSequence)),
            Effect.map((current) => ({ snapshotSequence: current })),
          ),
      }).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.isUndefined(barrier.pollUnsafe());
      assert.equal(yield* Ref.get(readCount), 1);

      yield* Ref.set(snapshotSequence, 41);
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(barrier);
      assert.equal(yield* Ref.get(readCount), 2);
    }),
  ),
);
