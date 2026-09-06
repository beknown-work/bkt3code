// T3-CUSTOM(expbkt3): BEGIN — new threads inherit target project and environment defaults.
import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";
import { readProjects, readThreadShell, useProjects, useThread } from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
} from "../lib/chatThreadActions";
import { readT3ProjectFileDefaultThreadEnvMode } from "../lib/t3ProjectFileDefaults";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  // T3-CUSTOM(expbkt3): true only when a caller chose a worktree base.
  baseRefExplicit?: boolean;
  // T3-CUSTOM(expbkt3): promote the eventual thread as a child of this thread.
  parentThreadId?: ThreadId | null;
  // T3-CUSTOM(expbkt3): the environment that parent lives on, when the child is
  // being started somewhere else — typically because the parent's host is down.
  parentEnvironmentId?: EnvironmentId | null;
}

// The workspace options the caller passed explicitly, shaped for the draft
// store: absent keys stay absent so they never overwrite existing draft
// state. Every reuse path applies exactly this set.
function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
    ...(options?.baseRefExplicit !== undefined ? { baseRefExplicit: options.baseRefExplicit } : {}),
    // T3-CUSTOM(expbkt3): explicit parent-thread picks ride along with the
    // other explicit workspace options.
    ...(options?.parentThreadId !== undefined ? { parentThreadId: options.parentThreadId } : {}),
    ...(options?.parentEnvironmentId !== undefined
      ? { parentEnvironmentId: options.parentEnvironmentId }
      : {}),
  };
}

export function useNewThreadHandler() {
  // T3-CUSTOM(expbkt3): a remote project inherits the settings of the server
  // that owns it, matching HTTP, WebSocket, and MCP resolution.
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        baseRefExplicit?: boolean;
        replace?: boolean;
        // T3-CUSTOM(expbkt3): promote the eventual thread as a child of this thread.
        parentThreadId?: ThreadId | null;
        // T3-CUSTOM(expbkt3): the parent's environment, when the child is being
        // started on a different machine from the session it continues.
        parentEnvironmentId?: EnvironmentId | null;
      },
      // Which draft the thread ended up in, so a caller that has something to put in it — a
      // prepared checkout, a task to write — addresses that one rather than looking the project
      // up again and finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const projects = readProjects();
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        // T3-CUSTOM(expbkt3): no applyStickyState/setModelSelection — new
        // threads inherit target project and environment defaults instead of
        // carrying the viewed thread's model selection or sticky state.
        setModelSelection,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const requestingRouteHref = router.state.location.href;
      const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
      const currentRouteTarget = getCurrentRouteTarget();
      // T3-CUSTOM(expbkt3): the upstream carry-of-working-mode block (model
      // selection, runtime mode, interaction mode from the viewed thread) is
      // removed — new threads inherit target project and environment defaults.
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      // The shared resolver owns the priority order. The t3.json read is
      // skipped entirely when a higher-priority source decides, and its
      // query atom caches per project after the first call.
      const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        // T3-CUSTOM(expbkt3): the project's threadCreationDefaults and the
        // owning server's settings replace the primary server's settings as
        // sources, matching HTTP, WebSocket, and MCP resolution.
        const projectSetting = projectDefaults?.environmentMode ?? project?.defaultThreadEnvMode;
        const consultProjectFile = project !== undefined && projectSetting == null;
        return resolveDefaultThreadEnvMode({
          projectSetting,
          projectFile: consultProjectFile
            ? await readT3ProjectFileDefaultThreadEnvMode(
                project.environmentId,
                project.workspaceRoot,
              )
            : null,
          globalDefault: targetSettings.defaultThreadEnvMode,
        });
      };
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const targetSettings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const projectDefaults = project?.threadCreationDefaults;
      const inheritedBaseRef = projectDefaults?.worktreeBaseRef ?? {
        kind: "repository-default" as const,
        source: targetSettings.newWorktreesStartFromOrigin
          ? ("origin" as const)
          : ("local" as const),
      };
      const inheritedBranch = inheritedBaseRef.kind === "branch" ? inheritedBaseRef.branch : null;
      const inheritedStartFromOrigin = inheritedBaseRef.source === "origin";
      const inheritedRuntimeMode =
        projectDefaults?.runtimeMode ?? targetSettings.defaultThreadRuntimeMode;
      const inheritedInteractionMode =
        projectDefaults?.interactionMode ?? targetSettings.defaultThreadInteractionMode;
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const hasBaseRefExplicitOption = options?.baseRefExplicit !== undefined;
      const hasParentThreadIdOption = options?.parentThreadId !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThread !== null &&
        storedDraftThread.promotedTo == null &&
        storedDraftThreadRef !== null &&
        readThreadShell(storedDraftThreadRef) === null
          ? storedDraftThread
          : null;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only
      // ever reuse a draft the user has NOT invested in. A draft with typed
      // text or attachments is work in progress: it stays alive where it is
      // (reachable from the sidebar draft rows) and this request mints a
      // fresh draft instead — the remap in the store preserves invested
      // drafts rather than deleting them.
      const emptyStoredDraftThread =
        reusableStoredDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
          ? reusableStoredDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption ||
            hasBaseRefExplicitOption ||
            // T3-CUSTOM(expbkt3)
            hasParentThreadIdOption;
          // Resurrecting an empty stored draft must not resurrect its stale
          // context: explicit workspace options win outright; otherwise the
          // env context resets to the configured defaults so drafts seeded
          // before a defaults change (or by the old carry-over behavior) stop
          // landing on "current checkout" branches forever. When the draft is
          // already open and no options were passed, leave its workspace
          // context alone entirely — the user may have just picked a branch
          // in the composer. Model selection has its own explicit-pick rule
          // below and does not follow this guard.
          let workspaceContext: NewThreadWorkspaceOptions | null = null;
          if (hasExplicitWorkspaceOption) {
            workspaceContext = {
              ...pickExplicitWorkspaceOptions(options),
              // T3-CUSTOM(expbkt3): always written alongside explicit options
              // so a resurrected draft never keeps a stale parent from a
              // previous seeding.
              parentThreadId: options?.parentThreadId ?? null,
              parentEnvironmentId: options?.parentEnvironmentId ?? null,
            };
          } else if (!isDraftAlreadyOpen) {
            const defaultEnvMode = await resolveDefaultEnvMode();
            if (routeChangedSinceRequest()) {
              return null;
            }
            // The await yields. If the draft was opened (a concurrent
            // invocation's navigation landed), promoted to a real thread,
            // remapped away (a concurrent invocation registered a fresh
            // draft — remapping back would evict the winner and let the
            // store GC it), or gained content (no longer a reusable empty
            // draft) in the meantime, this invocation is a stale loser:
            // resetting context, remapping, or navigating would all clobber
            // state written after the snapshot above. Bail out entirely —
            // the winner already did this work.
            const routeTargetNow = getCurrentRouteTarget();
            const openedMeanwhile =
              routeTargetNow?.kind === "draft" &&
              routeTargetNow.draftId === emptyStoredDraftThread.draftId;
            const promotedMeanwhile =
              storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
            const remappedMeanwhile =
              getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
              emptyStoredDraftThread.draftId;
            const investedMeanwhile = composerDraftHasUserContent(
              getComposerDraft(emptyStoredDraftThread.draftId),
            );
            if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
              return null;
            }
            workspaceContext = {
              // T3-CUSTOM(expbkt3): defaults inherit from the target project's
              // threadCreationDefaults and the owning server's settings.
              branch: inheritedBranch,
              worktreePath: null,
              envMode: defaultEnvMode,
              startFromOrigin: resolveNewDraftStartFromOrigin({
                envMode: defaultEnvMode,
                newWorktreesStartFromOrigin: inheritedStartFromOrigin, // T3-CUSTOM(expbkt3)
              }),
              // T3-CUSTOM(expbkt3): these are shown inherited defaults, not a base pick.
              baseRefExplicit: false,
              parentThreadId: null, // T3-CUSTOM(expbkt3)
            };
          }
          if (workspaceContext) {
            setDraftThreadContext(emptyStoredDraftThread.draftId, {
              ...workspaceContext,
              runtimeMode: inheritedRuntimeMode,
              interactionMode: inheritedInteractionMode,
            });
          }
          // T3-CUSTOM(expbkt3): upstream explicit picks stand; stale seeds return to inherited defaults.
          if (
            !hasExplicitComposerModelSelection(getComposerDraft(emptyStoredDraftThread.draftId))
          ) {
            setModelSelection(emptyStoredDraftThread.draftId, null, { replaceOptions: true });
          }
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              ...workspaceContext,
              runtimeMode: inheritedRuntimeMode,
              interactionMode: inheritedInteractionMode,
            },
          );
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          // Re-read the route: the snapshot from before the await is stale
          // once a concurrent invocation's navigation lands, and navigating
          // again would push a duplicate history entry.
          const routeTargetAfterWrites = getCurrentRouteTarget();
          if (
            routeTargetAfterWrites?.kind === "draft" &&
            routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
          ) {
            return opened;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
          return opened;
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption ||
          hasParentThreadIdOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        return Promise.resolve({
          draftId: currentRouteTarget.draftId,
          threadId: latestActiveDraftThread.threadId,
        });
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
        if (routeChangedSinceRequest()) {
          return null;
        }
        // The await yields, so a concurrent invocation may have registered a
        // draft for this logical project in the meantime. Registering ours
        // too would evict that draft while its navigation is in flight —
        // reuse the winner instead, like the synchronous path above does.
        const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (
          racedDraft &&
          // Only a draft REGISTERED during the await counts as a raced
          // winner. An invested draft this invocation deliberately declined
          // to reuse is still mapped at this point — reusing it here would
          // silently undo mint-fresh semantics.
          racedDraft.draftId !== storedDraftThread?.draftId &&
          readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
        ) {
          // Same remap the reuse paths above perform: point the draft at the
          // caller's project member and apply explicit workspace options if
          // the caller passed any. Without explicit options the winner's
          // context stands untouched — the winner's navigation is landing,
          // which is the isDraftAlreadyOpen "leave it alone" case. Writing
          // this invocation's defaults here instead would clobber the
          // winner's explicit picks and could pair its worktreePath with a
          // contradictory envMode.
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
            threadId: racedDraft.threadId,
            createdAt: racedDraft.createdAt,
            runtimeMode: racedDraft.runtimeMode,
            interactionMode: racedDraft.interactionMode,
            ...pickExplicitWorkspaceOptions(options),
          });
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
          return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? inheritedBranch,
          worktreePath: options?.worktreePath ?? null,
          parentThreadId: options?.parentThreadId ?? null,
          parentEnvironmentId: options?.parentEnvironmentId ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: inheritedStartFromOrigin,
            }),
          // T3-CUSTOM(expbkt3): caller-supplied branch/origin options are picks;
          // automatic draft defaults are intentionally omitted from bootstrap overrides.
          baseRefExplicit:
            options?.baseRefExplicit ??
            (options?.branch !== undefined || options?.startFromOrigin !== undefined),
          runtimeMode: inheritedRuntimeMode,
          interactionMode: inheritedInteractionMode,
        });

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, router, serverConfigs],
  );
}
// T3-CUSTOM(expbkt3): END

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
