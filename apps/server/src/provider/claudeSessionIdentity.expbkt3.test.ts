import { assert, describe, it } from "@effect/vitest";

import { claudeSessionIdentitySystemPrompt } from "./claudeSessionIdentity.expbkt3.ts";

describe("claudeSessionIdentitySystemPrompt", () => {
  it("uses the current T3 message sender instead of the shared Claude account", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
        BK_MESSAGE_SENDER_EMAIL: " sender@example.test ",
      }),
      [
        "T3 Code session identity:",
        '- userEmail is "sender@example.test".',
        "- This session-scoped value identifies the user who sent the current message and overrides the Claude account email for user attribution.",
      ].join("\n"),
    );
  });

  it("keeps the user unknown when T3 cannot resolve the message sender", () => {
    assert.include(
      claudeSessionIdentitySystemPrompt({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
      }) ?? "",
      "userEmail is unavailable",
    );
  });

  it("does not change upstream Claude sessions", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_MESSAGE_SENDER_EMAIL: "sender@example.test",
      }),
      undefined,
    );
  });
});
