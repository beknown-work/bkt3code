/**
 * T3-CUSTOM(expbkt3): Shared lifecycle for the web and native spoken-summary controls.
 * A caller supplies the command id, so unrelated or stale durable summary updates
 * cannot open the player or start speech for the wrong request.
 */
import type { CommandId, ThreadId, ThreadWorkSummary } from "@t3tools/contracts";

export type SpokenSessionSummaryState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting"; readonly threadId: ThreadId; readonly requestId: CommandId }
  | { readonly phase: "pending"; readonly threadId: ThreadId; readonly requestId: CommandId }
  | {
      readonly phase: "ready";
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly summary: string;
    }
  | {
      readonly phase: "error";
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly message: string;
    };

export const IDLE_SPOKEN_SESSION_SUMMARY_STATE: SpokenSessionSummaryState = { phase: "idle" };

export function beginSpokenSessionSummary(
  threadId: ThreadId,
  requestId: CommandId,
): SpokenSessionSummaryState {
  return { phase: "requesting", threadId, requestId };
}

export function failSpokenSessionSummary(
  state: SpokenSessionSummaryState,
  message: string,
): SpokenSessionSummaryState {
  if (state.phase === "idle") return state;
  return { phase: "error", threadId: state.threadId, requestId: state.requestId, message };
}

export function observeSpokenSessionSummary(
  state: SpokenSessionSummaryState,
  threadId: ThreadId,
  workSummary: ThreadWorkSummary | null | undefined,
): SpokenSessionSummaryState {
  if (state.phase === "idle" || state.threadId !== threadId) return state;
  if (workSummary?.requestId !== state.requestId) return state;
  if (workSummary.status === "pending") {
    return { phase: "pending", threadId, requestId: state.requestId };
  }
  if (workSummary.status === "ready" && workSummary.summary?.trim()) {
    return {
      phase: "ready",
      threadId,
      requestId: state.requestId,
      summary: workSummary.summary.trim(),
    };
  }
  return {
    phase: "error",
    threadId,
    requestId: state.requestId,
    message: workSummary.error?.trim() || "The session could not be summarized.",
  };
}
