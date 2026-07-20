import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeObservableLifecycle } from "./observableLifecycle.ts";

const threadId = ThreadId.make("observable-lifecycle");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const turnId = TurnId.make("turn-1");
const now = "2026-07-20T00:00:00.000Z";

it.effect("provides the shared observable lifecycle contract used by every built-in adapter", () =>
  Effect.gen(function* () {
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
    const session = yield* Ref.make<ProviderSession | null>({
      provider,
      providerInstanceId,
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    });
    const interrupted = yield* Ref.make(false);
    const source = {
      hasSession: (_threadId: ThreadId) =>
        Ref.get(session).pipe(Effect.map((value) => value !== null)),
      listSessions: () =>
        Ref.get(session).pipe(Effect.map((value) => (value === null ? [] : [value]))),
      interruptTurn: (_threadId: ThreadId, _turnId?: TurnId) => Ref.set(interrupted, true),
      stopSession: (_threadId: ThreadId) => Ref.set(session, null),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };
    const lifecycle = makeObservableLifecycle(source);

    const inspection = yield* lifecycle.inspectSession(threadId);
    assert.strictEqual(inspection?.state, "running");
    assert.strictEqual(inspection?.activeProviderTurnId, turnId);
    assert.isTrue(inspection?.runtimeAlive);

    const acknowledgement = yield* lifecycle.requestTurnInterrupt(threadId, turnId);
    assert.isTrue(acknowledgement.acknowledged);
    assert.isTrue(yield* Ref.get(interrupted));

    yield* PubSub.publish(runtimeEvents, {
      type: "session.started",
      eventId: EventId.make("session-started"),
      provider,
      providerInstanceId,
      threadId,
      createdAt: now,
      payload: {},
    });
    const watched = yield* lifecycle.watchSession(threadId, 7).pipe(Stream.runHead);
    assert.isTrue(Option.isSome(watched));
    assert.strictEqual(Option.getOrThrow(watched).sessionGeneration, 7);

    const termination = yield* lifecycle.terminateSession(threadId);
    assert.deepStrictEqual(termination, {
      verified: true,
      graceful: true,
      processTreeExited: true,
    });
    assert.strictEqual(yield* lifecycle.inspectSession(threadId), null);
  }),
);
