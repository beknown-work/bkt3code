// @effect-diagnostics nodeBuiltinImport:off - the subject under test is /proc itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  collectAncestorPids,
  collectDescendantPids,
  isProcessAlive,
  readOwnCgroupProcessIds,
  readProcessEntry,
  snapshotProcesses,
  supportsProcessTreeInspection,
  terminateProcessTree,
  type ProcessEntry,
} from "./processTree.ts";

const entry = (pid: number, ppid: number, command = `cmd-${String(pid)}`): ProcessEntry => ({
  pid,
  ppid,
  command,
  rssKb: null,
});

describe("process tree traversal", () => {
  it("collects transitive descendants breadth-first", () => {
    const entries = [
      entry(1, 0),
      entry(10, 1),
      entry(11, 10),
      entry(12, 10),
      entry(13, 11),
      entry(20, 1),
    ];

    assert.deepStrictEqual(
      [...collectDescendantPids(10, entries)].sort((a, b) => a - b),
      [11, 12, 13],
    );
    assert.deepStrictEqual(collectDescendantPids(20, entries), []);
  });

  it("terminates on a self-referential or cyclic parent chain", () => {
    const cyclic = [entry(30, 31), entry(31, 30), entry(32, 32)];

    assert.deepStrictEqual(collectDescendantPids(30, cyclic), [31]);
    assert.deepStrictEqual(collectDescendantPids(32, cyclic), []);
  });

  it("walks ancestors nearest-first", () => {
    const entries = [entry(1, 0), entry(10, 1), entry(11, 10), entry(13, 11)];

    assert.deepStrictEqual(collectAncestorPids(13, entries), [11, 10, 1]);
    assert.deepStrictEqual(collectAncestorPids(1, entries), []);
  });
});

describe("proc parsing", () => {
  it("reads ppid, command and rss from a /proc-shaped directory", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-proc-"));
    try {
      NodeFS.mkdirSync(NodePath.join(root, "4242"));
      NodeFS.writeFileSync(
        NodePath.join(root, "4242", "status"),
        "Name:\topencode\nState:\tS (sleeping)\nPPid:\t1\nVmRSS:\t  517284 kB\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "4242", "cmdline"),
        "opencode\0serve\0--hostname=127.0.0.1\0--port=4096\0",
      );

      const expected: ProcessEntry = {
        pid: 4242,
        ppid: 1,
        command: "opencode serve --hostname=127.0.0.1 --port=4096",
        rssKb: 517284,
      };
      assert.deepStrictEqual(readProcessEntry(4242, root), expected);
      assert.deepStrictEqual(snapshotProcesses(root), [expected]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null instead of throwing for an unreadable entry", () => {
    assert.strictEqual(
      readProcessEntry(4242, NodePath.join(NodeOS.tmpdir(), "t3-proc-missing")),
      null,
    );
    assert.deepStrictEqual(
      snapshotProcesses(NodePath.join(NodeOS.tmpdir(), "t3-proc-missing")),
      [],
    );
  });

  it.effect("resolves the cgroup v2 membership of the current process", () =>
    Effect.gen(function* () {
      if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;
      const pids = readOwnCgroupProcessIds();
      // A container or cgroup-v1 host legitimately has no v2 membership file;
      // the sweep treats that as "cannot prove ownership" and does nothing.
      if (pids === null) return;
      assert.isTrue(pids.has(process.pid));
    }),
  );
});

describe("terminateProcessTree", () => {
  it.effect("reports a clean exit for a pid that is already gone", () =>
    Effect.gen(function* () {
      const outcome = yield* terminateProcessTree({ rootPid: 2_147_483_646 });
      assert.deepStrictEqual(outcome, { exited: true, forced: false, survivingPids: [] });
    }),
  );

  it.live(
    "kills a real detached process tree and verifies every descendant is gone",
    () =>
      Effect.gen(function* () {
        if (!supportsProcessTreeInspection(yield* HostProcessPlatform)) return;

        // `sh` forks two children; the tree is therefore root + 2 descendants.
        const child = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 45 & sleep 45"], {
          detached: true,
          stdio: "ignore",
        });
        const rootPid = child.pid as number;
        assert.isTrue(Number.isInteger(rootPid));

        try {
          let descendants: ReadonlyArray<number> = [];
          for (let attempt = 0; attempt < 50 && descendants.length < 2; attempt += 1) {
            yield* Effect.sleep("50 millis");
            descendants = collectDescendantPids(rootPid, snapshotProcesses());
          }
          assert.isAtLeast(descendants.length, 2, "expected the shell to have forked two sleeps");

          const outcome = yield* terminateProcessTree({
            rootPid,
            gracePeriodMillis: 2_000,
          });

          assert.isTrue(outcome.exited);
          assert.deepStrictEqual(outcome.survivingPids, []);
          assert.isFalse(isProcessAlive(rootPid));
          for (const pid of descendants) {
            assert.isFalse(isProcessAlive(pid), `descendant ${String(pid)} survived`);
          }
        } finally {
          // Belt and braces: never leave a stray `sleep` behind if the
          // assertions above failed.
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }),
    { timeout: 20_000 },
  );
});
