// T3-CUSTOM(expbkt3): shared presentation for local outbox and durable server intent.
import type { ThreadExecutionIntent, ThreadExecutionSnapshot } from "@t3tools/contracts";

export interface ThreadExecutionPresentation {
  readonly active: boolean;
  readonly label:
    | "Sending"
    | "Queued"
    | "Preparing"
    | "Starting"
    | "Running"
    | "Waiting for approval"
    | "Waiting for input"
    | "Recovering"
    | "Retrying"
    | "Stopping"
    | "Recovery failed"
    | null;
  readonly needsAttention: boolean;
}

const LABEL_BY_PHASE = {
  queued: "Queued",
  preparing: "Preparing",
  starting: "Starting",
  running: "Running",
  "waiting-for-approval": "Waiting for approval",
  "waiting-for-input": "Waiting for input",
  recovering: "Recovering",
  "retry-wait": "Retrying",
  stopping: "Stopping",
  "recovery-exhausted": "Recovery failed",
} as const satisfies Record<ThreadExecutionIntent["phase"], ThreadExecutionPresentation["label"]>;

export function deriveThreadExecutionPresentation(input: {
  readonly hasPendingOutboxItem: boolean;
  readonly intent:
    | (Pick<ThreadExecutionIntent, "desiredState" | "phase"> & {
        readonly recovery: Pick<ThreadExecutionIntent["recovery"], "userActionRequired">;
      })
    | null;
  readonly providerActivity: ThreadExecutionSnapshot["activity"];
}): ThreadExecutionPresentation {
  if (input.hasPendingOutboxItem) {
    return { active: true, label: "Sending", needsAttention: false };
  }

  if (input.intent !== null) {
    const exhausted = input.intent.phase === "recovery-exhausted";
    return {
      active: !exhausted,
      label: LABEL_BY_PHASE[input.intent.phase],
      needsAttention: exhausted && input.intent.recovery.userActionRequired,
    };
  }

  if (
    input.providerActivity === "active" ||
    input.providerActivity === "blocked" ||
    input.providerActivity === "stopping"
  ) {
    return {
      active: true,
      label: input.providerActivity === "stopping" ? "Stopping" : "Running",
      needsAttention: false,
    };
  }

  return {
    active: false,
    label: null,
    needsAttention: input.providerActivity === "failed",
  };
}
