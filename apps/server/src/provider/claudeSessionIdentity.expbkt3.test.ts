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
        "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
      ].join("\n"),
    );
  });

  it("keeps the user unknown when T3 cannot resolve the message sender", () => {
    assert.equal(
      claudeSessionIdentitySystemPrompt({
        BK_IDENTITY_RUNTIME: "t3-code",
        BK_SESSION_OWNER_EMAIL: "owner@example.test",
      }),
      [
        "T3 Code session identity:",
        "- userEmail is unavailable for the user who sent the current message.",
        "- Do not use the Claude account email, operating-system identity, or Git identity to infer the user.",
        "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
      ].join("\n"),
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
