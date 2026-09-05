// T3-CUSTOM(expbkt3): execution frames must survive upstream event coalescing.
import { ThreadId, type ThreadExecutionSnapshot } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeThreadLiveEventCoalescer } from "./ThreadLiveEventCoalescer.ts";

const execution: ThreadExecutionSnapshot = {
  threadId: ThreadId.make("execution-coalescer"),
  authorityEpoch: "test", revision: 1,
  observedAt: "2026-01-01T00:00:00.000Z", activity: "idle", canStop: false,
  providerSession: {
    state: "absent", generation: 0, providerInstanceId: null,
    startedAt: null, lastObservedAt: null, lastError: null,
  },
  turn: null,
};

it.effect("retains execution snapshots in order and releases their live budget on delivery", () =>
  Effect.scoped(Effect.gen(function* () {
    const coalescer = yield* makeThreadLiveEventCoalescer();
    yield* coalescer.offerAll([
      { kind: "execution", execution },
      { kind: "synchronized" },
      { kind: "execution", execution: { ...execution, revision: 2 } },
    ]);
    assert.strictEqual((yield* coalescer.usage).retainedItems, 3);
    const items = yield* Effect.scoped(coalescer.stream.pipe(Stream.take(3), Stream.runCollect));
    assert.deepEqual(items.map((item) => item.kind === "execution" ? item.execution.revision : item.kind), [1, "synchronized", 2]);
    assert.deepEqual(yield* coalescer.usage, { retainedItems: 0, retainedSerializedBytes: 0 });
  })),
);
