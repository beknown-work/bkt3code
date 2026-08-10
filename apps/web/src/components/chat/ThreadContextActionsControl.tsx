/**
 * T3-CUSTOM(expbkt3): Session context handoff actions.
 *
 * One header menu with three ways out of a session — copy its full context,
 * or seed a new / child thread's draft composer with it. Everything is served
 * by the `threadContext.export` RPC, which reads the projection and the
 * worktree only, so these actions keep working while the session's provider
 * is erroring — that broken-session escape hatch is the reason this exists.
 *
 * Kept self-contained (data fetching, clipboard, draft seeding) so ChatHeader
 * stays a one-line mounting seam, mirroring T3ConductorLinearIssueControl.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadContextExportResult, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ClipboardCopyIcon,
  FileOutputIcon,
  GitForkIcon,
  MessageSquarePlusIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useThreadShell } from "../../state/entities";
import { sessionArchiveEnvironment } from "../../state/sessionArchive";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function ThreadContextActionsControl({
  activeThreadEnvironmentId,
  activeThreadId,
}: {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
}) {
  const shell = useThreadShell(scopeThreadRef(activeThreadEnvironmentId, activeThreadId));
  const exportContext = useAtomCommand(sessionArchiveEnvironment.exportContext, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const [isBusy, setIsBusy] = useState(false);

  if (shell === null) {
    return null;
  }

  const reportError = (title: string, cause: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };

  const fetchDigest = async (): Promise<ThreadContextExportResult | null> => {
    const result = await exportContext({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId },
    });
    if (result._tag !== "Success") {
      reportError("Could not export session context", squashAtomCommandFailure(result as never));
      return null;
    }
    return result.value as ThreadContextExportResult;
  };

  const notifyTruncated = (digest: ThreadContextExportResult) => {
    if (!digest.truncated) return;
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Context was shortened",
        description:
          "The transcript exceeded the size cap, so older messages were elided. The summary and git state are complete.",
      }),
    );
  };

  const runGuarded = async (action: () => Promise<void>) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await action();
    } finally {
      setIsBusy(false);
    }
  };

  const copyContext = () =>
    runGuarded(async () => {
      const digest = await fetchDigest();
      if (digest === null) return;
      try {
        await writeTextToClipboard(digest.markdown, "session context");
      } catch (cause) {
        reportError("Could not copy session context", cause);
        return;
      }
      notifyTruncated(digest);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Session context copied",
          description: `${digest.messageCount} messages distilled into a handoff digest. Paste it into any session to continue there.`,
        }),
      );
    });

  const seedThreadWithContext = (mode: "new" | "child") =>
    runGuarded(async () => {
      const digest = await fetchDigest();
      if (digest === null) return;
      const projectRef = scopeProjectRef(activeThreadEnvironmentId, shell.projectId);
      // "New" replaces a broken session: isolate it in a fresh worktree.
      // "Child" continues alongside the source: reuse its worktree and branch
      // so uncommitted work stays visible (or local mode when it had one).
      const workspaceOptions =
        mode === "child"
          ? shell.worktreePath
            ? {
                envMode: "worktree" as const,
                worktreePath: shell.worktreePath,
                branch: shell.branch ?? null,
                parentThreadId: activeThreadId,
              }
            : {
                envMode: "local" as const,
                worktreePath: null,
                branch: null,
                parentThreadId: activeThreadId,
              }
          : {
              envMode: "worktree" as const,
              worktreePath: null,
              branch: null,
              parentThreadId: null,
            };
      await handleNewThread(projectRef, workspaceOptions);
      const store = useComposerDraftStore.getState();
      const draftSession = store.getDraftSessionByProjectRef(projectRef);
      if (draftSession === null) {
        reportError(
          "Could not seed the new thread",
          new Error("The draft thread was not found after creation."),
        );
        return;
      }
      const existingPrompt = store.getComposerDraft(draftSession.draftId)?.prompt ?? "";
      const prefill =
        existingPrompt.trim().length > 0
          ? `${digest.markdown}\n\n${existingPrompt}`
          : `${digest.markdown}\n\n`;
      store.setPrompt(draftSession.draftId, prefill);
      notifyTruncated(digest);
    });

  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="outline" aria-label="Session context actions" />}
        disabled={isBusy}
      >
        <FileOutputIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={isBusy} onClick={() => void copyContext()}>
          <ClipboardCopyIcon />
          Copy full context
        </MenuItem>
        <MenuItem disabled={isBusy} onClick={() => void seedThreadWithContext("new")}>
          <MessageSquarePlusIcon />
          New thread with this context…
        </MenuItem>
        <MenuItem disabled={isBusy} onClick={() => void seedThreadWithContext("child")}>
          <GitForkIcon />
          New child thread with this context…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
