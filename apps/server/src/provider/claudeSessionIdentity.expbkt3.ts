// T3-CUSTOM(expbkt3): Claude Code derives its native `userEmail` context from
// the authenticated Claude account. Beknown runs that account on a shared
// machine, so it identifies the subscription rather than the person sending
// the current T3 message. Append the session-scoped identity to Claude's native
// system prompt without changing the account used for authentication.
//
// The CLI offers no way to suppress its own `# userEmail` section, and the
// rotating profile makes its value flap, so the appended block also names that
// section and countermands it explicitly. Without that, two contradictory
// identity claims coexist and the model follows the one that arrives last.

import {
  MESSAGE_SENDER_EMAIL_KEY,
  SESSION_IDENTITY_RUNTIME,
  SESSION_IDENTITY_RUNTIME_KEY,
} from "../identity/SessionIdentityEnvironment.ts";

export function claudeSessionIdentitySystemPrompt(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (environment[SESSION_IDENTITY_RUNTIME_KEY] !== SESSION_IDENTITY_RUNTIME) {
    return undefined;
  }

  const senderEmail = environment[MESSAGE_SENDER_EMAIL_KEY]?.trim();
  if (!senderEmail) {
    return [
      "T3 Code session identity:",
      "- userEmail is unavailable for the user who sent the current message.",
      "- Do not use the Claude account email, operating-system identity, or Git identity to infer the user.",
      "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
    ].join("\n");
  }

  return [
    "T3 Code session identity:",
    `- userEmail is ${JSON.stringify(senderEmail)}.`,
    "- This session-scoped value identifies the user who sent the current message and overrides the Claude account email for user attribution.",
    "- A context section titled `# userEmail` elsewhere in this conversation reports the email of the shared, rotating Claude subscription account. It does NOT identify the user. Ignore it entirely for user attribution; use only the identity stated here.",
  ].join("\n");
}
