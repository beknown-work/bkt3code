import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function useReconnectThreadSession() {
  const restartSession = useAtomCommand(threadEnvironment.restartSession, {
    reportFailure: false,
  });

  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const result = await restartSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });

      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Reconnecting session",
          description: "The provider conversation is being resumed.",
        });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;

      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to reconnect session",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [restartSession],
  );
}
