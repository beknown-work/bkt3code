// @effect-diagnostics nodeBuiltinImport:off - drives the real deploy script through fake binaries on PATH.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

/**
 * `deploy/tailnet-serve.sh` publishes one T3 deployment port on the tailnet.
 *
 * The two properties worth protecting are that a repeat run leaves exactly one
 * entry for the port, and that it never disturbs serve entries it does not own
 * — other work on this box owns 46261-46263, and one stray `tailscale serve
 * reset` drops all of them. Both are exercised against the real script through
 * fake `tailscale` and `sudo` binaries, so the sudo decision and the read-back
 * are covered rather than mocked away.
 */
const SCRIPT_PATH = NodePath.join(import.meta.dirname, "..", "deploy", "tailnet-serve.sh");

const TAILNET_HOST = "dev-server-1.tailab6257.ts.net";

/** Mirrors the `tailscale serve status --json` shape for a proxied HTTP port. */
type ServeConfig = {
  readonly TCP?: Record<string, { readonly HTTP?: boolean }>;
  readonly Web?: Record<
    string,
    { readonly Handlers?: Record<string, { readonly Proxy?: string }> }
  >;
};

const serveEntry = (port: number, target: string): ServeConfig => ({
  TCP: { [String(port)]: { HTTP: true } },
  Web: { [`${TAILNET_HOST}:${port}`]: { Handlers: { "/": { Proxy: target } } } },
});

const mergeConfigs = (...configs: ReadonlyArray<ServeConfig>): ServeConfig => ({
  TCP: Object.assign({}, ...configs.map((config) => config.TCP ?? {})),
  Web: Object.assign({}, ...configs.map((config) => config.Web ?? {})),
});

/**
 * Records every argv it receives, answers `serve status --json` from a state
 * file, and applies `serve --bg` to it. Anything else — notably `reset`,
 * `clear`, and `off` — exits non-zero, so a script that grows one fails here.
 */
const TAILSCALE_SHIM = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "$TS_LOG"
if [[ "\${1:-}" == "serve" && "\${2:-}" == "status" ]]; then
  cat "$TS_STATE"
  exit 0
fi
if [[ "\${1:-}" == "serve" && "\${2:-}" == "--bg" ]]; then
  if [[ -n "\${TS_UNAUTHORIZED:-}" ]]; then
    echo "sending serve config: 401 Unauthorized: must be root" >&2
    exit 1
  fi
  port="\${3#--http=}"
  target="$4"
  jq --arg port "$port" --arg target "$target" --arg host "${TAILNET_HOST}" \\
    '.TCP[$port] = {"HTTP": true} | .Web[$host + ":" + $port] = {"Handlers": {"/": {"Proxy": $target}}}' \\
    "$TS_STATE" > "$TS_STATE.next" && mv "$TS_STATE.next" "$TS_STATE"
  echo "Serve started and running in the background."
  exit 0
fi
echo "tailscale shim: refusing unsupported invocation: $*" >&2
exit 64
`;

const SUDO_SHIM = `#!/usr/bin/env bash
[[ "\${1:-}" == "-n" ]] && shift
exec "$@"
`;

const workspaces: Array<string> = [];

const createWorkspace = (initial: ServeConfig = {}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tailnet-serve-"));
  workspaces.push(root);

  const binDir = NodePath.join(root, "bin");
  NodeFS.mkdirSync(binDir);
  for (const [name, source] of [
    ["tailscale", TAILSCALE_SHIM],
    ["sudo", SUDO_SHIM],
  ] as const) {
    const shimPath = NodePath.join(binDir, name);
    NodeFS.writeFileSync(shimPath, source, { mode: 0o755 });
  }

  const statePath = NodePath.join(root, "serve-state.json");
  const logPath = NodePath.join(root, "invocations.log");
  NodeFS.writeFileSync(statePath, JSON.stringify(initial));
  NodeFS.writeFileSync(logPath, "");

  const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
    NodeChildProcess.spawnSync("bash", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TS_STATE: statePath,
        TS_LOG: logPath,
        ...env,
      },
    });

  const config = (): ServeConfig =>
    JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as ServeConfig;
  const invocations = () => NodeFS.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);

  return { run, config, invocations };
};

afterEach(() => {
  while (workspaces.length > 0) {
    NodeFS.rmSync(workspaces.pop()!, { recursive: true, force: true });
  }
});

describe("tailnet-serve.sh", () => {
  it("publishes the port and leaves exactly one entry when run twice", () => {
    const workspace = createWorkspace();

    const first = workspace.run(["18085", "10.31.39.131"]);
    expect(first.status, first.stderr).toBe(0);

    const second = workspace.run(["18085", "10.31.39.131"]);
    expect(second.status, second.stderr).toBe(0);

    expect(workspace.config()).toEqual(serveEntry(18085, "http://10.31.39.131:18085"));

    // The second run must recognise its own config and skip the write entirely.
    const writes = workspace.invocations().filter((line) => line.startsWith("serve --bg"));
    expect(writes).toEqual(["serve --bg --http=18085 http://10.31.39.131:18085"]);
    expect(second.stdout).toContain("already proxies");
  });

  it("leaves serve entries it does not own untouched", () => {
    const foreign = mergeConfigs(
      serveEntry(46261, "http://127.0.0.1:33499"),
      serveEntry(46262, "http://127.0.0.1:8741"),
      serveEntry(46263, "http://127.0.0.1:9000"),
    );
    const workspace = createWorkspace(foreign);

    expect(workspace.run(["18085", "10.31.39.131"]).status).toBe(0);

    const after = workspace.config();
    for (const port of [46261, 46262, 46263] as const) {
      expect(after.TCP?.[String(port)]).toEqual(foreign.TCP?.[String(port)]);
      expect(after.Web?.[`${TAILNET_HOST}:${port}`]).toEqual(
        foreign.Web?.[`${TAILNET_HOST}:${port}`],
      );
    }
    expect(Object.keys(after.TCP ?? {}).sort()).toEqual(["18085", "46261", "46262", "46263"]);

    // A `reset`, `clear`, or `off` would drop the foreign entries wholesale.
    for (const invocation of workspace.invocations()) {
      expect(invocation).not.toMatch(/\b(reset|clear|off)\b/);
    }
  });

  it("replaces a stale target for its own port instead of adding a second entry", () => {
    const workspace = createWorkspace(serveEntry(18085, "http://127.0.0.1:18085"));

    expect(workspace.run(["18085", "10.31.39.131"]).status).toBe(0);

    expect(workspace.config()).toEqual(serveEntry(18085, "http://10.31.39.131:18085"));
  });

  it("reports loudly but still lets the caller start T3 when --best-effort is set", () => {
    const workspace = createWorkspace();

    const result = workspace.run(["--best-effort", "18085", "10.31.39.131"], {
      TS_UNAUTHORIZED: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("401 Unauthorized");
    expect(result.stderr).toContain("NOT published on the tailnet");
    expect(result.stderr).toContain(
      "sudo tailscale serve --bg --http=18085 http://10.31.39.131:18085",
    );
    expect(workspace.config()).toEqual({});
  });

  it("fails when the serve call is rejected and --best-effort is not set", () => {
    const workspace = createWorkspace();

    const result = workspace.run(["18085", "10.31.39.131"], { TS_UNAUTHORIZED: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NOT published on the tailnet");
  });

  it("rejects a port that is not a port", () => {
    const workspace = createWorkspace();

    expect(workspace.run(["--best-effort", "not-a-port", "10.31.39.131"]).status).toBe(2);
    expect(workspace.run(["70000", "10.31.39.131"]).status).toBe(2);
    expect(workspace.run(["18085", ""]).status).toBe(2);
    expect(workspace.invocations()).toEqual([]);
  });
});
