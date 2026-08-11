import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRateLimitSnapshot,
  type ProviderRateLimitsStreamSnapshot,
  type ProviderRateLimitUpdate,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { applyProviderRateLimitUpdate, makeProviderRateLimits } from "./ProviderRateLimits.ts";

const at = (value: string) => DateTime.makeUnsafe(value);
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const window = (windowId: string, usedPercent: number) => ({
  windowId,
  label: windowId,
  usedPercent,
  resetsAt: at("2026-08-02T00:00:00.000Z"),
  category: "other" as const,
});

const update = (overrides: Partial<ProviderRateLimitUpdate> = {}): ProviderRateLimitUpdate => ({
  mode: "replace",
  availability: "available",
  windows: [window("primary", 25), window("secondary", 50)],
  observedAt: at("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

const snapshot = (
  overrides: Partial<ProviderRateLimitSnapshot> = {},
): ProviderRateLimitSnapshot => ({
  providerInstanceId: codexId,
  driverKind: codexDriver,
  availability: "unknown",
  windows: [],
  observedAt: null,
  lastRefreshFailed: false,
  ...overrides,
});

it("replaces, sparsely merges, and preserves the last valid reading on refresh errors", () => {
  const replaced = applyProviderRateLimitUpdate(snapshot(), update());
  assert.equal(replaced.windows.length, 2);

  const merged = applyProviderRateLimitUpdate(
    replaced,
    update({
      mode: "merge",
      windows: [window("primary", 40)],
      observedAt: at("2026-08-01T10:01:00.000Z"),
    }),
  );
  assert.deepEqual(
    merged.windows.map((entry) => [entry.windowId, entry.usedPercent]),
    [
      ["primary", 40],
      ["secondary", 50],
    ],
  );

  const failed = applyProviderRateLimitUpdate(
    merged,
    update({
      mode: "merge",
      availability: "error",
      windows: [],
      observedAt: at("2026-08-01T10:02:00.000Z"),
    }),
  );
  assert.equal(failed.availability, "available");
  assert.equal(failed.lastRefreshFailed, true);
  assert.deepEqual(failed.windows, merged.windows);
});

it("rejects out-of-order updates", () => {
  const current = snapshot({
    availability: "available",
    windows: [window("primary", 60)],
    observedAt: at("2026-08-01T10:05:00.000Z"),
  });
  const next = applyProviderRateLimitUpdate(
    current,
    update({ observedAt: at("2026-08-01T10:04:00.000Z") }),
  );
  assert.strictEqual(next, current);
});

it.effect("keeps provider instances isolated and exposes an initial stream snapshot", () =>
  Effect.gen(function* () {
    const events: ReadonlyArray<ProviderRuntimeEvent> = [
      {
        type: "account.rate-limits.updated",
        eventId: EventId.make("event-codex"),
        provider: codexDriver,
        providerInstanceId: codexId,
        threadId: ThreadId.make("thread-codex"),
        createdAt: "2026-08-01T10:00:00.000Z",
        payload: { rateLimits: update() },
      },
      {
        type: "account.rate-limits.updated",
        eventId: EventId.make("event-claude"),
        provider: claudeDriver,
        providerInstanceId: claudeId,
        threadId: ThreadId.make("thread-claude"),
        createdAt: "2026-08-01T10:01:00.000Z",
        payload: {
          rateLimits: update({
            windows: [window("five-hour", 80)],
            observedAt: at("2026-08-01T10:01:00.000Z"),
          }),
        },
      },
    ];
    const service = yield* makeProviderRateLimits(Stream.fromIterable(events));
    yield* Effect.yieldNow;

    const current = yield* service.snapshot;
    assert.equal(current.entries.length, 2);
    assert.deepEqual(current.entries.map((entry) => String(entry.providerInstanceId)).toSorted(), [
      "claudeAgent",
      "codex",
    ]);

    const streamed = yield* Stream.runHead(service.stream);
    assert.equal(streamed._tag, "Some");
    if (streamed._tag === "Some") {
      assert.equal(streamed.value.revision, current.revision);
    }
  }),
);

it.effect("streams live revisions after the initial snapshot", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const service = yield* makeProviderRateLimits(Stream.fromQueue(events));
    const received = yield* Queue.unbounded<ProviderRateLimitsStreamSnapshot>();
    const snapshotsFiber = yield* service.stream.pipe(
      Stream.runForEach((entry) => Queue.offer(received, entry)),
      Effect.forkChild,
    );
    const initial = yield* Queue.take(received);

    yield* Queue.offer(events, {
      type: "account.rate-limits.updated",
      eventId: EventId.make("event-live-codex"),
      provider: codexDriver,
      providerInstanceId: codexId,
      threadId: ThreadId.make("thread-live-codex"),
      createdAt: "2026-08-01T10:00:00.000Z",
      payload: { rateLimits: update() },
    });

    const live = yield* Queue.take(received);
    yield* Fiber.interrupt(snapshotsFiber);
    assert.deepEqual([initial.revision, initial.entries.length], [0, 0]);
    assert.deepEqual([live.revision, live.entries.length], [1, 1]);
  }),
);
