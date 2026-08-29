/**
 * T3-CUSTOM(expbkt3): the pure half of agent-rendered UI surfaces.
 *
 * `resolveAgentUiSurface` runs on every work-log row in the timeline, before any
 * hooks, so it has to stay total: an unexpected payload shape must fall back to
 * the ordinary tool row rather than throw inside the list renderer.
 */
import { describe, expect, it } from "vite-plus/test";

import { resolveAgentUiSurface, resolveEmbedSandbox } from "./agentUiSurface";

describe("resolveAgentUiSurface", () => {
  it("reads a well-formed handle", () => {
    expect(
      resolveAgentUiSurface({ agentUi: { renderId: "aui_1", kind: "html", height: 400 } }),
    ).toEqual({ renderId: "aui_1", kind: "html", height: 400 });
  });

  it("returns null for an ordinary work entry", () => {
    expect(resolveAgentUiSurface({})).toBeNull();
    expect(resolveAgentUiSurface({ agentUi: undefined })).toBeNull();
  });

  it("survives payload shapes it was not built for", () => {
    for (const agentUi of [null, "aui_1", 42, [], { renderId: 7 }, { renderId: "" }]) {
      expect(resolveAgentUiSurface({ agentUi })).toBeNull();
    }
  });

  it("defaults the kind to html and only accepts url as the alternative", () => {
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a" } })?.kind).toBe("html");
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", kind: "url" } })?.kind).toBe("url");
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", kind: "nonsense" } })?.kind).toBe(
      "html",
    );
  });

  it("clamps a height an agent could otherwise use to take over the transcript", () => {
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: 99_999 } })?.height).toBe(900);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: -10 } })?.height).toBe(120);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a", height: "tall" } })?.height).toBe(360);
    expect(resolveAgentUiSurface({ agentUi: { renderId: "a" } })?.height).toBe(360);
  });
});

describe("resolveEmbedSandbox", () => {
  const page = "https://bkt3.dev.beknown.live";

  it("gives a cross-origin app its own origin back so storage works", () => {
    const sandbox = resolveEmbedSandbox("https://draw-canvas.dev.beknown.live/", page);
    // Without this, localStorage and IndexedDB throw and real apps never boot.
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-scripts");
  });

  it("withholds allow-same-origin from a self-referential embed", () => {
    // allow-scripts + allow-same-origin on our OWN origin is a sandbox escape:
    // the frame could reach the signed-in session directly.
    for (const url of [page, `${page}/settings`, `${page}/?x=1#y`]) {
      expect(resolveEmbedSandbox(url, page)).not.toContain("allow-same-origin");
    }
  });

  it("treats a different port or scheme on the same host as cross-origin", () => {
    expect(resolveEmbedSandbox("https://bkt3.dev.beknown.live:8443/", page)).toContain(
      "allow-same-origin",
    );
  });

  it("falls back to the locked-down sandbox for an unparseable url", () => {
    expect(resolveEmbedSandbox("not a url", page)).not.toContain("allow-same-origin");
  });
});
