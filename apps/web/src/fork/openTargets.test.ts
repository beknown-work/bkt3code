import type { OpenTarget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RemoteOpenState } from "../remoteOpen";
import {
  applyPathMapping,
  OPEN_TARGET_PRESETS,
  presetToOpenTarget,
  resolveOpenTargetUrl,
  templateScheme,
} from "./openTargets";

const DS1: RemoteOpenState = {
  mode: "remote-links",
  host: { kind: "tailscale", host: "dev-server-1.tailab6257.ts.net", username: "ubuntu" },
};
const MINI: RemoteOpenState = {
  mode: "remote-links",
  host: { kind: "tailscale", host: "mini.tailab6257.ts.net", username: "tushar" },
};
const LOCAL: RemoteOpenState = { mode: "local-exec" };

const target = (overrides: Partial<OpenTarget> = {}): OpenTarget => ({
  id: "t1",
  label: "Obsidian",
  template: "obsidian://open?path={path}",
  pathMappings: [],
  requiresMappingWhenRemote: true,
  ...overrides,
});

const BK_DOCS_MAPPING = {
  remotePrefix: "/home/ubuntu/.t3/bkt3-dev/worktrees/bk-docs",
  localPrefix: "/Users/tushar/BKT3 Sessions/bk-docs",
} as const;

describe("applyPathMapping", () => {
  it("rewrites a path under the mapped prefix", () => {
    expect(
      applyPathMapping({
        absolutePath: "/home/ubuntu/.t3/bkt3-dev/worktrees/bk-docs/vinh",
        host: "dev-server-1.tailab6257.ts.net",
        mappings: [BK_DOCS_MAPPING],
      }),
    ).toBe("/Users/tushar/BKT3 Sessions/bk-docs/vinh");
  });

  it("maps the prefix itself and tolerates trailing separators", () => {
    expect(
      applyPathMapping({
        absolutePath: "/srv/work",
        host: null,
        mappings: [{ remotePrefix: "/srv/work/", localPrefix: "/Users/t/work/" }],
      }),
    ).toBe("/Users/t/work");
  });

  it("returns null when no mapping covers the path", () => {
    expect(
      applyPathMapping({
        absolutePath: "/home/ubuntu/repos/other",
        host: "dev-server-1.tailab6257.ts.net",
        mappings: [BK_DOCS_MAPPING],
      }),
    ).toBeNull();
  });

  it("does not treat a sibling directory as a prefix match", () => {
    expect(
      applyPathMapping({
        absolutePath: "/srv/workshop/thing",
        host: null,
        mappings: [{ remotePrefix: "/srv/work", localPrefix: "/local/work" }],
      }),
    ).toBeNull();
  });

  it("prefers a host-scoped mapping over an unscoped one listed first", () => {
    const mappings = [
      { remotePrefix: "/srv", localPrefix: "/any" },
      { remotePrefix: "/srv", localPrefix: "/mini", host: "mini.tailab6257.ts.net" },
    ];
    expect(
      applyPathMapping({ absolutePath: "/srv/x", host: "mini.tailab6257.ts.net", mappings }),
    ).toBe("/mini/x");
    expect(applyPathMapping({ absolutePath: "/srv/x", host: "other", mappings })).toBe("/any/x");
  });
});

describe("templateScheme", () => {
  it("reads ordinary app schemes", () => {
    expect(templateScheme("obsidian://open?path={path}")).toBe("obsidian");
    expect(templateScheme("file://{path}")).toBe("file");
    expect(templateScheme("zed://ssh/{user}@{host}{path}")).toBe("zed");
  });

  it("rejects executing schemes and non-URLs", () => {
    expect(templateScheme("javascript:alert(1)")).toBeNull();
    expect(templateScheme("data:text/html,x")).toBeNull();
    expect(templateScheme("/just/a/path")).toBeNull();
  });
});

describe("resolveOpenTargetUrl", () => {
  it("uses the path as-is on a local environment, with no mapping needed", () => {
    expect(
      resolveOpenTargetUrl({
        target: target(),
        absolutePath: "/Users/tushar/code/thing",
        remote: LOCAL,
      }),
    ).toEqual({
      ok: true,
      scheme: "obsidian",
      url: "obsidian://open?path=/Users/tushar/code/thing",
    });
  });

  it("maps the path for a remote environment", () => {
    expect(
      resolveOpenTargetUrl({
        target: target({ pathMappings: [BK_DOCS_MAPPING] }),
        absolutePath: "/home/ubuntu/.t3/bkt3-dev/worktrees/bk-docs/vinh",
        remote: DS1,
      }),
    ).toEqual({
      ok: true,
      scheme: "obsidian",
      url: "obsidian://open?path=/Users/tushar/BKT3%20Sessions/bk-docs/vinh",
    });
  });

  it("refuses a mapping-dependent target when nothing matches, rather than opening a dead path", () => {
    expect(
      resolveOpenTargetUrl({
        target: target({ pathMappings: [BK_DOCS_MAPPING] }),
        absolutePath: "/home/ubuntu/.t3/bkt3-dev/worktrees/t3code-bkmain/biryani",
        remote: DS1,
      }),
    ).toEqual({ ok: false, reason: "no-path-mapping" });
  });

  it("substitutes each host's own name and login account for an SSH-style target", () => {
    const sshTarget = target({
      label: "Zed",
      template: "zed://ssh/{user}@{host}{path}",
      requiresMappingWhenRemote: false,
    });
    expect(
      resolveOpenTargetUrl({ target: sshTarget, absolutePath: "/home/ubuntu/w", remote: DS1 }),
    ).toEqual({
      ok: true,
      scheme: "zed",
      url: "zed://ssh/ubuntu@dev-server-1.tailab6257.ts.net/home/ubuntu/w",
    });
    expect(
      resolveOpenTargetUrl({ target: sshTarget, absolutePath: "/Users/t/w", remote: MINI }),
    ).toEqual({
      ok: true,
      scheme: "zed",
      url: "zed://ssh/tushar@mini.tailab6257.ts.net/Users/t/w",
    });
  });

  it("reports no route when the environment advertises no SSH host", () => {
    expect(
      resolveOpenTargetUrl({
        target: target(),
        absolutePath: "/srv/work",
        remote: { mode: "remote-unavailable" },
      }),
    ).toEqual({ ok: false, reason: "no-remote-route" });
  });

  it("rejects an unusable template", () => {
    expect(
      resolveOpenTargetUrl({
        target: target({ template: "javascript:alert(1)" }),
        absolutePath: "/srv/work",
        remote: LOCAL,
      }),
    ).toEqual({ ok: false, reason: "invalid-template" });
  });
});

describe("presets", () => {
  it("mints a distinct id even for repeated adds of the same preset", () => {
    const preset = OPEN_TARGET_PRESETS[0]!;
    const ids = new Set(Array.from({ length: 50 }, () => presetToOpenTarget(preset).id));
    expect(ids.size).toBe(50);
  });

  it("produce resolvable targets with distinct ids", () => {
    const targets = OPEN_TARGET_PRESETS.map(presetToOpenTarget);
    expect(new Set(targets.map((entry) => entry.id)).size).toBe(targets.length);
    for (const entry of targets) {
      expect(templateScheme(entry.template)).not.toBeNull();
      expect(
        resolveOpenTargetUrl({ target: entry, absolutePath: "/srv/work", remote: LOCAL }).ok,
      ).toBe(true);
    }
  });
});
