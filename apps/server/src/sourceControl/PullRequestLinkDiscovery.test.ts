import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type ThreadExecutionSnapshot,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { discoverPullRequestLinks } from "./PullRequestLinkDiscovery.ts";

const projectId = ProjectId.make("project-pr-links");
const threadId = ThreadId.make("thread-pr-links");
const now = "2026-07-28T00:00:00.000Z";

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 42,
  projects: [
    {
      id: projectId,
      title: "Bridge",
      workspaceRoot: "/work/bridge",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      ownerUserId: null,
      memberUserIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Repair bridge",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/repair",
      worktreePath: "/work/bridge-feature",
      sourceControlProfileId: null,
      latestTurn: null,
      ownerUserId: null,
      memberUserIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
  updatedAt: now,
};

const execution: ThreadExecutionSnapshot = {
  threadId,
  authorityEpoch: "authority",
  revision: 7,
  observedAt: now,
  activity: "idle",
  canStop: false,
  providerSession: {
    state: "ready",
    generation: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    startedAt: now,
    lastObservedAt: now,
    lastError: null,
  },
  turn: null,
};

const status: VcsStatusResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/repair",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 91,
    title: "Repair bridge",
    url: "https://github.com/Beknown-Work/T3-Linear-Bridge/pull/91",
    baseRef: "main",
    headRef: "feature/repair",
    state: "open",
  },
};

it.effect("discovers an accessible GitHub PR link with its execution revision", () =>
  Effect.gen(function* () {
    const result = yield* discoverPullRequestLinks({
      snapshot,
      executions: new Map([[threadId, execution]]),
      getStatus: () => Effect.succeed(status),
    });

    assert.strictEqual(result.snapshotSequence, 42);
    assert.strictEqual(result.failures.length, 0);
    assert.strictEqual(result.links.length, 1);
    assert.deepEqual(result.links[0]?.repository, {
      canonicalKey: "github.com/beknown-work/t3-linear-bridge",
      owner: "Beknown-Work",
      name: "T3-Linear-Bridge",
    });
    assert.strictEqual(result.links[0]?.execution.revision, 7);
  }),
);

it.effect("bounds per-thread resolution failures without failing the discovery request", () =>
  Effect.gen(function* () {
    const result = yield* discoverPullRequestLinks({
      snapshot,
      executions: new Map([[threadId, execution]]),
      getStatus: () => Effect.fail({ _tag: "TestStatusError" }),
    });

    assert.deepEqual(result.links, []);
    assert.deepEqual(result.failures, [{ threadId, reason: "workspace_unavailable" }]);
  }),
);
