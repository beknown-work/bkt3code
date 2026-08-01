import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    profiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:profiles",
      tag: WS_METHODS.sourceControlProfilesList,
    }),
    upsertProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:profiles:upsert",
      tag: WS_METHODS.sourceControlProfilesUpsert,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    testProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:profiles:test",
      tag: WS_METHODS.sourceControlProfilesTest,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    replaceProfileCredential: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:profiles:replace-credential",
      tag: WS_METHODS.sourceControlProfilesReplaceCredential,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    disconnectProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:profiles:disconnect",
      tag: WS_METHODS.sourceControlProfilesDisconnect,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    archiveProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:profiles:archive",
      tag: WS_METHODS.sourceControlProfilesArchive,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    setThreadOwner: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:thread-owner:set",
      tag: WS_METHODS.sourceControlThreadOwnerSet,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    convertRemote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:remote:convert",
      tag: WS_METHODS.sourceControlConvertRemote,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
