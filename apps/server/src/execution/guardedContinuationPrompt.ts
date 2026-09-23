// T3-CUSTOM(expbkt3): the prompt a guarded recovery sends in place of the original message.

const CONTINUE_INSTRUCTION =
  "Continue the unfinished task from the persisted conversation and current workspace state. Inspect what already completed before acting, and do not repeat completed external actions.";

/**
 * Builds the prompt for an `inspect-or-continue` recovery.
 *
 * "Uncertain delivery" routinely means the provider process was replaced before
 * it read the message, so the persisted conversation may not contain the
 * request at all. A bare "continue" then silently drops it: a plan approval and
 * its review comments become a turn that re-reports status and still waits for
 * the approval. Quoting the original makes the lost request recoverable while
 * the dedupe instruction still covers the case where it did arrive.
 */
export function buildGuardedContinuationPrompt(originalMessageText: string | null): string {
  const original = originalMessageText?.trim() ?? "";
  if (original.length === 0) return CONTINUE_INSTRUCTION;
  return [
    CONTINUE_INSTRUCTION,
    "The interrupted request is quoted below. It may never have reached you. If the conversation above does not already contain it, act on it now as if it had just been sent.",
    ["<interrupted_user_message>", original, "</interrupted_user_message>"].join("\n"),
  ].join("\n\n");
}
