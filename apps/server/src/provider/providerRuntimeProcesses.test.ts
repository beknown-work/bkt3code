import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  clearProviderRuntimeProcesses,
  findProviderRuntimeProcessesForThread,
  listProviderRuntimeProcesses,
  matchProviderRuntimeCommand,
  registerProviderRuntimeProcess,
  selectOrphanProviderProcesses,
  unregisterProviderRuntimeProcess,
  type OrphanProviderProcessScanInput,
  type ProviderRuntimeProcessRecord,
} from "./providerRuntimeProcesses.ts";

const SELF_PID = 1000;
const GRACE_MS = 5 * 60 * 1000;
const NOW = 10 * 60 * 1000;

const OPENCODE_COMMAND =
  "/home/ubuntu/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=4096";

const record = (
  overrides: Partial<ProviderRuntimeProcessRecord> & { readonly pid: number },
): ProviderRuntimeProcessRecord => ({
  provider: "opencode",
  threadId: "thread-1",
  command: OPENCODE_COMMAND,
  registeredAtMillis: 0,
  ...overrides,
});

const scan = (
  overrides: Partial<OrphanProviderProcessScanInput> & {
    readonly entries: OrphanProviderProcessScanInput["entries"];
  },
) =>
  selectOrphanProviderProcesses({
    cgroupPids: new Set(overrides.entries.map((entry) => entry.pid)),
    selfPid: SELF_PID,
    ancestorPids: new Set<number>(),
    liveThreadIds: new Set<string>(),
    trackedRecords: [],
    nowMillis: NOW,
    trackedGraceMillis: GRACE_MS,
    ...overrides,
  });

const orphanEntry = (pid: number, ppid = 1, command = OPENCODE_COMMAND) => ({
  pid,
  ppid,
  command,
  rssKb: 517_284,
});

afterEach(() => {
  clearProviderRuntimeProcesses();
});

describe("provider runtime command patterns", () => {
  it("recognises an opencode server however it was invoked", () => {
    assert.strictEqual(matchProviderRuntimeCommand(OPENCODE_COMMAND)?.provider, "opencode");
    assert.strictEqual(matchProviderRuntimeCommand("opencode serve")?.provider, "opencode");
  });

  it("ignores other opencode invocations and unrelated commands", () => {
    assert.isNull(matchProviderRuntimeCommand("opencode models --verbose"));
    assert.isNull(matchProviderRuntimeCommand("/usr/bin/myopencodeserver serve"));
    assert.isNull(matchProviderRuntimeCommand("node apps/server/dist/bin.mjs serve --mode web"));
    assert.isNull(matchProviderRuntimeCommand(""));
  });
});

describe("provider runtime process registry", () => {
  it("tracks and releases runtime pids by thread", () => {
    registerProviderRuntimeProcess(record({ pid: 4242 }));
    registerProviderRuntimeProcess(record({ pid: 4243, threadId: "thread-2" }));
    registerProviderRuntimeProcess(record({ pid: 0 }));

    assert.deepStrictEqual(
      findProviderRuntimeProcessesForThread("thread-1").map((entry) => entry.pid),
      [4242],
    );
    assert.strictEqual(listProviderRuntimeProcesses().length, 2);

    unregisterProviderRuntimeProcess(4242);
    assert.deepStrictEqual(findProviderRuntimeProcessesForThread("thread-1"), []);
  });
});

describe("orphan provider process selection", () => {
  it("selects a reparented runtime that no session owns", () => {
    const selected = scan({ entries: [orphanEntry(4242)] });

    assert.deepStrictEqual(selected, [
      {
        pid: 4242,
        provider: "opencode",
        command: OPENCODE_COMMAND,
        rssKb: 517_284,
        reason: "reparented-to-init",
      },
    ]);
  });

  it("never touches an untracked process that still has a live parent", () => {
    assert.deepStrictEqual(scan({ entries: [orphanEntry(4242, SELF_PID)] }), []);
  });

  it("never touches the server itself, its ancestors, or anything outside our cgroup", () => {
    assert.deepStrictEqual(
      scan({ entries: [orphanEntry(SELF_PID)], selfPid: SELF_PID }),
      [],
      "own pid",
    );
    assert.deepStrictEqual(
      scan({ entries: [orphanEntry(900)], ancestorPids: new Set([900]) }),
      [],
      "ancestor",
    );
    assert.deepStrictEqual(
      scan({ entries: [orphanEntry(4242)], cgroupPids: new Set([SELF_PID]) }),
      [],
      "outside cgroup",
    );
    assert.deepStrictEqual(scan({ entries: [orphanEntry(1)] }), [], "init");
  });

  it("never touches a command that is not a known provider runtime", () => {
    assert.deepStrictEqual(
      scan({ entries: [orphanEntry(4242, 1, "node dist/bin.mjs serve --mode web")] }),
      [],
    );
  });

  it("never touches a tracked runtime whose session binding is live", () => {
    assert.deepStrictEqual(
      scan({
        entries: [orphanEntry(4242, 1)],
        trackedRecords: [record({ pid: 4242 })],
        liveThreadIds: new Set(["thread-1"]),
      }),
      [],
    );
  });

  it("reaps a tracked runtime whose session is gone, even before it reparents", () => {
    const selected = scan({
      entries: [orphanEntry(4242, SELF_PID)],
      trackedRecords: [record({ pid: 4242 })],
    });

    assert.deepStrictEqual(
      selected.map(({ pid, reason }) => ({ pid, reason })),
      [{ pid: 4242, reason: "tracked-session-gone" }],
    );
  });

  it("gives a freshly tracked runtime its startup grace period", () => {
    assert.deepStrictEqual(
      scan({
        entries: [orphanEntry(4242, SELF_PID)],
        trackedRecords: [record({ pid: 4242, registeredAtMillis: NOW - GRACE_MS + 1 })],
      }),
      [],
    );
  });

  it("never reaps a shared runtime that is not bound to a thread", () => {
    assert.deepStrictEqual(
      scan({
        entries: [orphanEntry(4242, 1)],
        trackedRecords: [record({ pid: 4242, threadId: null })],
      }),
      [],
    );
  });

  it("ignores a recycled pid whose command no longer looks like a provider runtime", () => {
    assert.deepStrictEqual(
      scan({
        entries: [orphanEntry(4242, 1, "/usr/bin/rsync -a /srv /backup")],
        trackedRecords: [record({ pid: 4242 })],
      }),
      [],
    );
  });
});
