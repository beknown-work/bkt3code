/**
 * T3-CUSTOM(expbkt3): Durable provisioning and fixed sidebar home for the
 * experimental T3 Conductor. The component deliberately owns all lifecycle
 * behavior so the upstream sidebar only needs one render seam and one filter.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import { type ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { CrownIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Equal from "effect/Equal";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { usePersonalMcpProfile } from "../../hooks/usePersonalMcpProfile";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useCurrentUserId } from "../../state/identity";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newMessageId, newProjectId } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildT3ConductorBootstrapPrompt,
  deriveT3ConductorThreadId,
  resolveT3ConductorThreadId,
  resolveT3ConductorStatus,
  T3_CONDUCTOR_TITLE,
} from "./T3Conductor.logic";

type OperationLabel =
  | "Taking the podium"
  | "Restoring home"
  | "Moving home"
  | "Syncing defaults"
  | "Waking up"
  | null;

function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "T3 could not complete the Conductor operation.";
}

function statusToneClass(tone: ReturnType<typeof resolveT3ConductorStatus>["tone"]): string {
  switch (tone) {
    case "active":
      return "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]";
    case "attention":
      return "animate-pulse bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.85)]";
    case "error":
      return "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.75)]";
    case "neutral":
      return "bg-muted-foreground/45";
  }
}

export function T3ConductorCard({
  shellReady,
  activeThreadKey,
  onNavigate,
}: {
  readonly shellReady: boolean;
  readonly activeThreadKey: string | null;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
}) {
  const settings = usePrimarySettings();
  const { profile, update } = usePersonalMcpProfile();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentUserId = useCurrentUserId();
  const projects = useProjects();
  const threads = useThreadShells();
  const legacyConductor = settings.experimental.t3Conductor;
  const legacyThread = threads.find(
    (candidate) =>
      candidate.environmentId === primaryEnvironmentId && candidate.id === legacyConductor.threadId,
  );
  // T3-CUSTOM(expbkt3): Claim the one pre-per-user Conductor only for its
  // existing owner (or the single local user). This migrates experimental
  // deployments without letting another signed-in team member inherit it.
  const shouldMigrateLegacyConductor =
    profile !== null &&
    !profile.conductor.threadId.trim() &&
    !profile.conductor.workspacePath.trim() &&
    Boolean(legacyConductor.threadId.trim() || legacyConductor.workspacePath.trim()) &&
    (currentUserId === null || legacyThread?.ownerUserId === currentUserId);
  const conductor = shouldMigrateLegacyConductor
    ? legacyConductor
    : (profile?.conductor ?? legacyConductor);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const updateThread = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const restartSession = useAtomCommand(threadEnvironment.restartSession, {
    reportFailure: false,
  });
  const [operationLabel, setOperationLabel] = useState<OperationLabel>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const inFlightRef = useRef(false);
  const syncedSignatureRef = useRef<string | null>(null);
  const stoppedWhileDisabledRef = useRef<string | null>(null);
  const restartedSessionRef = useRef<string | null>(null);
  const restoreAttemptedRef = useRef<string | null>(null);
  const legacyMigrationStartedRef = useRef(false);

  useEffect(() => {
    if (!profile || !shouldMigrateLegacyConductor || legacyMigrationStartedRef.current) return;
    legacyMigrationStartedRef.current = true;
    void update({
      conductor: legacyConductor,
      externalAccessEnabled: profile.externalAccessEnabled,
      integrations: profile.integrations,
    });
  }, [legacyConductor, profile, shouldMigrateLegacyConductor, update]);

  const configuredThreadId = conductor.threadId.trim();
  const thread =
    configuredThreadId && primaryEnvironmentId
      ? (threads.find(
          (candidate) =>
            candidate.environmentId === primaryEnvironmentId && candidate.id === configuredThreadId,
        ) ?? null)
      : null;
  const threadProject =
    thread === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ) ?? null);
  const resolvedSelection = useMemo(
    () =>
      resolveAppModelSelectionState(
        { ...settings, textGenerationModelSelection: conductor.modelSelection },
        providers,
      ),
    [conductor.modelSelection, providers, settings],
  );
  const providerEntry = useMemo(() => {
    const entries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
    );
    const instanceId = thread?.modelSelection.instanceId ?? resolvedSelection.instanceId;
    return entries.find((entry) => entry.instanceId === instanceId) ?? null;
  }, [providers, resolvedSelection.instanceId, settings, thread?.modelSelection.instanceId]);

  const patchThreadId = useCallback(
    async (threadId: string) => {
      if (!profile) {
        throw new Error("Your personal T3 profile is still loading.");
      }
      const updated = await update({
        conductor: { ...conductor, threadId },
        externalAccessEnabled: profile.externalAccessEnabled,
        integrations: profile.integrations,
      });
      if (!updated) {
        throw new Error("T3 could not save the personal Conductor session.");
      }
      return updated;
    },
    [conductor, profile, update],
  );

  useEffect(() => {
    // T3-CUSTOM(expbkt3): Never start an ACP until its user-scoped Conductor
    // row (including the durable thread id) is committed. This is what lets
    // McpSessionRegistry grant t3.session.create on the very first generation.
    if (
      !profile ||
      shouldMigrateLegacyConductor ||
      !primaryEnvironmentId ||
      !shellReady ||
      inFlightRef.current
    ) {
      return;
    }

    const workspacePath = conductor.workspacePath.trim();
    const currentThreadRef = thread ? scopeThreadRef(primaryEnvironmentId, thread.id) : null;

    if (!conductor.enabled) {
      restartedSessionRef.current = null;
      if (
        currentThreadRef &&
        thread?.session &&
        ["starting", "running", "ready"].includes(thread.session.status) &&
        stoppedWhileDisabledRef.current !== thread.id
      ) {
        stoppedWhileDisabledRef.current = thread.id;
        inFlightRef.current = true;
        void stopSession({
          environmentId: primaryEnvironmentId,
          input: { threadId: thread.id },
        }).finally(() => {
          inFlightRef.current = false;
        });
      }
      return;
    }

    stoppedWhileDisabledRef.current = null;
    if (thread) restoreAttemptedRef.current = null;
    if (!workspacePath) {
      setError("Choose an existing home workspace in Experimental settings.");
      setOperationLabel(null);
      return;
    }
    if (thread && !threadProject) {
      setOperationLabel("Restoring home");
      return;
    }

    const requireSuccess = (result: AtomCommandResult<unknown, unknown>): void => {
      if (result._tag === "Failure") {
        throw new Error(commandFailureMessage(result));
      }
    };

    const provision = async (threadId: ThreadId) => {
      const environmentProjects = projects.filter(
        (project) => project.environmentId === primaryEnvironmentId,
      );
      const existingProject = findProjectByPath(environmentProjects, workspacePath);
      let projectId = existingProject?.id ?? null;
      if (!projectId) {
        const newProjectIdentifier = newProjectId();
        const createResult = await createProject({
          environmentId: primaryEnvironmentId,
          input: {
            projectId: newProjectIdentifier,
            title: `T3 Conductor · ${inferProjectTitleFromPath(workspacePath)}`,
            workspaceRoot: workspacePath,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: resolvedSelection,
          },
        });
        requireSuccess(createResult);
        projectId = newProjectIdentifier;
      }
      if (projectId === null) {
        throw new Error("T3 Conductor could not resolve its home project.");
      }

      const createdAt = new Date().toISOString();
      const startResult = await startTurn({
        environmentId: primaryEnvironmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildT3ConductorBootstrapPrompt({
              workspacePath,
              personalityInstructions: conductor.personalityInstructions,
              linearIssueUrl: conductor.linearIssueUrl,
            }),
            attachments: [],
          },
          modelSelection: resolvedSelection,
          titleSeed: T3_CONDUCTOR_TITLE,
          runtimeMode: conductor.runtimeMode,
          interactionMode: conductor.interactionMode,
          bootstrap: {
            createThread: {
              projectId,
              title: T3_CONDUCTOR_TITLE,
              modelSelection: resolvedSelection,
              runtimeMode: conductor.runtimeMode,
              interactionMode: conductor.interactionMode,
              branch: null,
              worktreePath: null,
              sourceControlProfileId: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      requireSuccess(startResult);
    };

    inFlightRef.current = true;
    setError(null);
    void (async () => {
      if (thread && threadProject) {
        const currentWorkspace = normalizeProjectPathForComparison(threadProject.workspaceRoot);
        const requestedWorkspace = normalizeProjectPathForComparison(workspacePath);
        if (currentWorkspace !== requestedWorkspace) {
          setOperationLabel("Moving home");
          const archiveResult = await archiveThread({
            environmentId: primaryEnvironmentId,
            input: { threadId: thread.id },
          });
          requireSuccess(archiveResult);
          const nextThreadId = deriveT3ConductorThreadId(primaryEnvironmentId, workspacePath);
          await patchThreadId(nextThreadId);
          const restoreResult = await unarchiveThread({
            environmentId: primaryEnvironmentId,
            input: { threadId: nextThreadId },
          });
          if (restoreResult._tag === "Failure") {
            if (isAtomCommandInterrupted(restoreResult)) {
              throw new Error("Connection interrupted while moving T3 Conductor.");
            }
            await provision(nextThreadId);
          }
          return;
        }

        const desiredSignature = JSON.stringify({
          title: T3_CONDUCTOR_TITLE,
          modelSelection: resolvedSelection,
          runtimeMode: conductor.runtimeMode,
          interactionMode: conductor.interactionMode,
        });
        if (syncedSignatureRef.current !== desiredSignature) {
          syncedSignatureRef.current = desiredSignature;
          setOperationLabel("Syncing defaults");
          const metadataPatch = {
            threadId: thread.id,
            ...(thread.title === T3_CONDUCTOR_TITLE ? {} : { title: T3_CONDUCTOR_TITLE }),
            ...(Equal.equals(thread.modelSelection, resolvedSelection)
              ? {}
              : { modelSelection: resolvedSelection }),
          };
          if (Object.keys(metadataPatch).length > 1) {
            requireSuccess(
              await updateThread({
                environmentId: primaryEnvironmentId,
                input: metadataPatch,
              }),
            );
          }
          if (thread.runtimeMode !== conductor.runtimeMode) {
            requireSuccess(
              await setRuntimeMode({
                environmentId: primaryEnvironmentId,
                input: { threadId: thread.id, runtimeMode: conductor.runtimeMode },
              }),
            );
          }
          if (thread.interactionMode !== conductor.interactionMode) {
            requireSuccess(
              await setInteractionMode({
                environmentId: primaryEnvironmentId,
                input: {
                  threadId: thread.id,
                  interactionMode: conductor.interactionMode,
                },
              }),
            );
          }
        }

        if (
          thread.session &&
          ["stopped", "interrupted", "error"].includes(thread.session.status) &&
          restartedSessionRef.current !== thread.id
        ) {
          restartedSessionRef.current = thread.id;
          setOperationLabel("Waking up");
          requireSuccess(
            await restartSession({
              environmentId: primaryEnvironmentId,
              input: { threadId: thread.id },
            }),
          );
        }
        return;
      }

      const targetThreadId = resolveT3ConductorThreadId({
        configuredThreadId,
        environmentId: primaryEnvironmentId,
        workspacePath,
      });
      if (restoreAttemptedRef.current === targetThreadId) {
        return;
      }
      restoreAttemptedRef.current = targetThreadId;
      if (!configuredThreadId) {
        await patchThreadId(targetThreadId);
      }

      setOperationLabel("Restoring home");
      const restoreResult = await unarchiveThread({
        environmentId: primaryEnvironmentId,
        input: { threadId: targetThreadId },
      });
      if (restoreResult._tag === "Success") {
        return;
      }
      if (isAtomCommandInterrupted(restoreResult)) {
        throw new Error("Connection interrupted while restoring T3 Conductor.");
      }

      // Keep the reserved id after a failed restore. Generating a replacement
      // here caused every delayed projection event to create another thread.
      setOperationLabel("Taking the podium");
      await provision(targetThreadId);
    })()
      .catch((cause: unknown) => {
        syncedSignatureRef.current = null;
        restartedSessionRef.current = null;
        restoreAttemptedRef.current = null;
        setError(cause instanceof Error ? cause.message : "T3 Conductor could not be started.");
      })
      .finally(() => {
        inFlightRef.current = false;
        setOperationLabel(null);
      });
  }, [
    archiveThread,
    conductor,
    configuredThreadId,
    createProject,
    primaryEnvironmentId,
    projects,
    patchThreadId,
    profile,
    resolvedSelection,
    restartSession,
    retryGeneration,
    setInteractionMode,
    setRuntimeMode,
    shellReady,
    startTurn,
    stopSession,
    shouldMigrateLegacyConductor,
    thread,
    threadProject,
    unarchiveThread,
    updateThread,
  ]);

  if (!conductor.enabled) {
    return null;
  }

  const threadRef =
    thread && primaryEnvironmentId ? scopeThreadRef(primaryEnvironmentId, thread.id) : null;
  const status = resolveT3ConductorStatus(thread, operationLabel, error);
  const isActive = threadRef ? scopedThreadKey(threadRef) === activeThreadKey : false;

  return (
    <section className="px-2 pb-2" data-testid="t3-conductor-home">
      <div className="mb-1 flex items-center gap-1.5 px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/55">
        <CrownIcon className="size-3 text-amber-400/80" />
        Command deck
      </div>
      <button
        type="button"
        className={cn(
          "relative flex min-h-16 w-full items-center gap-2.5 overflow-hidden rounded-lg border px-2.5 py-2 text-left outline-hidden transition-colors",
          isActive
            ? "border-amber-400/45 bg-amber-400/10"
            : "border-border/70 bg-gradient-to-br from-amber-400/8 via-background to-emerald-500/6 hover:border-amber-400/35 hover:bg-amber-400/8",
          status.tone === "attention" &&
            "animate-[pulse_1.4s_ease-in-out_infinite] border-amber-400/65 bg-amber-400/15 motion-reduce:animate-none",
          status.tone === "error" && "border-red-500/45 bg-red-500/8",
        )}
        onClick={() => {
          if (threadRef) onNavigate(threadRef);
        }}
        disabled={!threadRef}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-300 shadow-[inset_0_0_12px_rgba(251,191,36,0.08)]">
          <CrownIcon className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-foreground">
              {T3_CONDUCTOR_TITLE}
            </span>
            <span className={cn("size-1.5 shrink-0 rounded-full", statusToneClass(status.tone))} />
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
            {status.label}
            {conductor.workspacePath ? ` · ${conductor.workspacePath}` : ""}
          </span>
        </span>
        {providerEntry ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="absolute right-2 top-2 inline-flex size-4 items-center justify-center" />
              }
            >
              <ProviderInstanceIcon
                driverKind={providerEntry.driverKind}
                displayName={providerEntry.displayName}
                className="size-3.5"
                iconClassName="size-3.5 text-[8px]"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{providerEntry.displayName}</TooltipPopup>
          </Tooltip>
        ) : (
          <Settings2Icon className="absolute right-2 top-2 size-3.5 text-muted-foreground/55" />
        )}
      </button>
      {error ? (
        <div className="mt-1.5 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/8 px-2 py-1.5 text-[10px] text-red-200/85">
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              restartedSessionRef.current = null;
              restoreAttemptedRef.current = null;
              setRetryGeneration((current) => current + 1);
            }}
            aria-label="Retry T3 Conductor"
          >
            <RefreshCwIcon />
          </Button>
        </div>
      ) : null}
    </section>
  );
}
