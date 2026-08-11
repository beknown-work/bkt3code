import type { EnvironmentId } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): BEGIN — identity-scoped shared outbox model.
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { ANONYMOUS_OUTBOX_IDENTITY } from "@t3tools/client-runtime/outbox";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

function asPendingMessage(message: QueuedThreadMessage, identityKey: string): QueuedThreadMessage {
  const { deliveryState: _deliveryState, failureDetail: _failureDetail, ...pending } = message;
  return { ...pending, identityKey, deliveryState: "pending" };
}
// T3-CUSTOM(expbkt3): END

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

// T3-CUSTOM(expbkt3): BEGIN — preserve identity and explicit delivery state.
export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  const identityKey =
    message.identityKey ??
    appAtomRegistry.get(managedRelaySessionAtom)?.accountId ??
    ANONYMOUS_OUTBOX_IDENTITY;
  return threadOutboxManager.enqueue(asPendingMessage(message, identityKey));
}

/** Waits for pending writes to settle; false if the message was rolled back. */
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  const identityKey =
    message.identityKey ??
    appAtomRegistry.get(managedRelaySessionAtom)?.accountId ??
    ANONYMOUS_OUTBOX_IDENTITY;
  return threadOutboxManager.update(asPendingMessage(message, identityKey));
}

export function markThreadOutboxMessageFailed(
  message: QueuedThreadMessage,
  failureDetail: string,
): Promise<boolean> {
  return threadOutboxManager.update({
    ...message,
    deliveryState: "failed",
    failureDetail,
  });
}
// T3-CUSTOM(expbkt3): END

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
