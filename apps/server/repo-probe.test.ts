import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it, expect } from "@effect/vitest";
import { SqlitePersistenceMemory } from "./src/persistence/Layers/Sqlite.ts";
import { SessionRecoveryStateRepository, layer } from "./src/persistence/SessionRecoveryState.ts";

const L = layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(L)("probe", (it) => {
  it.effect("lists recoverable", () =>
    Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      const threadId = ThreadId.make("t1");
      yield* repo.markRunning({
        threadId,
        executionId: "e1",
        reason: "turn-admitted",
        at: "2026-01-01T00:00:00.000Z",
      });
      const rows = yield* repo.listRecoverable({
        now: "2026-01-02T00:00:00.000Z",
        maxAttempts: 10,
      });
      console.log("ROWS:", JSON.stringify(rows));
      expect(rows.length).toBe(1);
    }),
  );
});
