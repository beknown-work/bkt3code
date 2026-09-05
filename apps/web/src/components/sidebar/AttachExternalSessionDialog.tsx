// T3-CUSTOM(expbkt3): attach a new thread to a Claude/Codex session that was
// started outside T3, so the conversation continues here.
import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { usePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "../../providerInstances";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { buildThreadRouteParams } from "../../threadRoutes";
import { newThreadId, cn } from "../../lib/utils";
import { DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import type { Project } from "../../types";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import {
  normalizeExternalSessionIdInput,
  providerDisplayNoun,
  selectAttachableProviderEntries,
  sessionIdHelpText,
  type AttachStep,
} from "./AttachExternalSessionDialog.logic";

export function AttachExternalSessionDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const router = useRouter();
  const createThread = useAtomCommand(threadEnvironment.create);

  const [step, setStep] = useState<AttachStep>("provider");
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [sessionIdInput, setSessionIdInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const entries = useMemo(
    () =>
      selectAttachableProviderEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const entry = useMemo(
    () => entries.find((candidate) => String(candidate.instanceId) === instanceId) ?? null,
    [entries, instanceId],
  );

  const reset = useCallback(() => {
    setStep("provider");
    setInstanceId(null);
    setProject(null);
    setSessionIdInput("");
    setError(null);
    setSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const normalizedSessionId = normalizeExternalSessionIdInput(sessionIdInput);

  const submit = useCallback(async () => {
    if (!entry || !project || normalizedSessionId === null) return;
    setSubmitting(true);
    setError(null);
    const threadId = newThreadId();
    const resolved = resolveAppModelSelectionState(settings, providers);
    const result = await createThread({
      environmentId: project.environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: `${providerDisplayNoun(String(entry.driverKind))} ${normalizedSessionId.slice(0, 8)}`,
        modelSelection: {
          instanceId: entry.instanceId,
          model:
            resolved.instanceId === entry.instanceId
              ? resolved.model
              : (getDefaultProviderInstanceModel(providers, entry.instanceId) ?? resolved.model),
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        // Resume is bound to the folder the external session ran in, so the
        // thread must use the project checkout rather than a worktree.
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        createdAt: new Date().toISOString(),
        externalSession: {
          providerInstanceId: entry.instanceId,
          sessionId: normalizedSessionId,
        },
      },
    });

    if (result._tag === "Failure") {
      setSubmitting(false);
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not attach that session.");
      return;
    }

    handleOpenChange(false);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
    });
  }, [
    createThread,
    entry,
    handleOpenChange,
    normalizedSessionId,
    project,
    providers,
    router,
    settings,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Attach an existing session</DialogTitle>
          <DialogDescription>
            {step === "provider"
              ? "Continue a Claude Code or Codex session you started in a terminal."
              : step === "project"
                ? "Pick the project the session ran in — resume is bound to that folder."
                : "Paste the session id to continue the conversation in T3."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1">
          {step === "provider" ? (
            entries.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                No Claude or Codex provider instance is configured on this server.
              </p>
            ) : (
              entries.map((candidate) => (
                <button
                  type="button"
                  key={String(candidate.instanceId)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setInstanceId(String(candidate.instanceId));
                    setStep("project");
                  }}
                >
                  <ProviderInstanceIcon
                    driverKind={candidate.driverKind}
                    displayName={candidate.displayName}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
                </button>
              ))
            )
          ) : null}

          {step === "project"
            ? projects.map((candidate) => (
                <button
                  type="button"
                  key={scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id))}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setProject(candidate);
                    setStep("session");
                  }}
                >
                  <ProjectFavicon
                    environmentId={candidate.environmentId}
                    cwd={candidate.workspaceRoot}
                    projectName={candidate.title}
                    projectIcon={candidate.projectIcon}
                  />
                  <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                </button>
              ))
            : null}

          {step === "session" && entry && project ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Resuming in <span className="font-mono">{project.workspaceRoot}</span>
              </div>
              <input
                autoFocus
                value={sessionIdInput}
                spellCheck={false}
                placeholder="00000000-0000-0000-0000-000000000000"
                className={cn(
                  "w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                  sessionIdInput.length > 0 && normalizedSessionId === null && "border-destructive",
                )}
                onChange={(event) => {
                  setSessionIdInput(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && normalizedSessionId !== null && !submitting) {
                    void submit();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {sessionIdHelpText(String(entry.driverKind))}
              </p>
              {sessionIdInput.length > 0 && normalizedSessionId === null ? (
                <p className="text-xs text-destructive">
                  That does not contain a session id. Paste the id, a rollout filename, or a
                  transcript path.
                </p>
              ) : null}
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setStep("project")} disabled={submitting}>
                  Back
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={normalizedSessionId === null || submitting}
                >
                  {submitting ? "Attaching…" : "Attach"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
