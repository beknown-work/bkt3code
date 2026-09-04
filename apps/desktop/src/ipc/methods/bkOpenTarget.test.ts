import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";

// The module under test imports Electron for the handler; the parser it
// exercises is pure, so a stub shell is enough to let the import resolve.
vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

import { parseForkTargetUrl } from "./bkOpenTarget.ts";

const parsed = (url: string) => Option.getOrNull(parseForkTargetUrl(url));

describe("parseForkTargetUrl", () => {
  it("accepts an app scheme and leaves it for the OS handler", () => {
    expect(parsed("obsidian://open?path=/Users/t/vault/note")).toEqual({
      url: new URL("obsidian://open?path=/Users/t/vault/note"),
      localPath: null,
    });
    expect(parsed("zed://ssh/ubuntu@ds1/home/ubuntu/w")?.localPath).toBeNull();
  });

  it("turns a file URL into a filesystem path to reveal", () => {
    expect(parsed("file:///Users/t/BKT3%20Sessions/bk-docs/vinh")?.localPath).toBe(
      "/Users/t/BKT3 Sessions/bk-docs/vinh",
    );
  });

  it("rejects a file URL naming another host, which would be a share", () => {
    expect(parsed("file://somehost/Users/t")).toBeNull();
  });

  it("rejects executing schemes", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "about:blank", "blob:x"]) {
      expect(parsed(url)).toBeNull();
    }
  });

  it("rejects embedded credentials", () => {
    expect(parsed("obsidian://user:secret@open?path=/x")).toBeNull();
  });

  it("rejects anything that is not an absolute URL", () => {
    for (const value of ["", "/just/a/path", "not a url", 42, null, undefined]) {
      expect(Option.getOrNull(parseForkTargetUrl(value))).toBeNull();
    }
  });
});
