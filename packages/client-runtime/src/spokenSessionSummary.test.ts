import { CommandId, ThreadId, type ThreadWorkSummary } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  beginSpokenSessionSummary,
  failSpokenSessionSummary,
  observeSpokenSessionSummary,
} from "./spokenSessionSummary.ts";

const threadId = ThreadId.make("thread-1");
const requestId = CommandId.make("request-1");
const otherRequestId = CommandId.make("request-2");

function summary(status: ThreadWorkSummary["status"], id = requestId): ThreadWorkSummary {
  return {
    status,
    requestId: id,
    summary: status === "ready" ? "The complete session summary." : null,
    stage: status === "ready" ? "done" : null,
    remaining: status === "ready" ? "" : null,
    percent: status === "ready" ? 100 : null,
    error: status === "error" ? "Generation failed." : null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("spoken session summary lifecycle", () => {
  it("accepts only the requested durable update", () => {
    const started = beginSpokenSessionSummary(threadId, requestId);
    assert.strictEqual(
      observeSpokenSessionSummary(started, threadId, summary("ready", otherRequestId)),
      started,
    );
    assert.deepStrictEqual(observeSpokenSessionSummary(started, threadId, summary("pending")), {
      phase: "pending",
      threadId,
      requestId,
    });
    assert.strictEqual(
      observeSpokenSessionSummary(started, threadId, summary("ready")).phase,
      "ready",
    );
  });

  it("keeps command failures tied to their request", () => {
    assert.deepStrictEqual(
      failSpokenSessionSummary(beginSpokenSessionSummary(threadId, requestId), "Offline"),
      { phase: "error", threadId, requestId, message: "Offline" },
    );
  });
});
