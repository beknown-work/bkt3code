// T3-CUSTOM(expbkt3): Keep routed chat execution aligned with the live sidebar shell.
import { deriveThreadExecutionPresentation } from "@t3tools/client-runtime/state/thread-execution-presentation";

type ExecutionPresentationInput = Parameters<typeof deriveThreadExecutionPresentation>[0];
type ExecutionPresentationSource = {
  readonly activity: ExecutionPresentationInput["providerActivity"];
  readonly intent?: ExecutionPresentationInput["intent"];
};

export function deriveChatThreadExecutionPresentation(input: {
  readonly hasPendingOutboxItem: boolean;
  readonly isServerThread: boolean;
  readonly threadExecution: ExecutionPresentationSource | null | undefined;
  readonly shellExecution: ExecutionPresentationSource | null | undefined;
}) {
  const execution = input.isServerThread ? input.shellExecution : input.threadExecution;

  return deriveThreadExecutionPresentation({
    hasPendingOutboxItem: input.hasPendingOutboxItem,
    intent: execution?.intent ?? null,
    providerActivity: execution?.activity ?? "idle",
  });
}
