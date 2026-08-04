import { describe, expect, it } from "@effect/vitest";

import { isExempt, markedLines } from "./check-fork-markers.ts";

describe("markedLines", () => {
  it("covers every line inside a BEGIN/END block", () => {
    const marked = markedLines(
      [
        "const upstream = 1;",
        "// T3-CUSTOM(expbkt3): BEGIN fork block",
        "const fork = 2;",
        "const forkAgain = 3;",
        "// T3-CUSTOM(expbkt3): END",
        "const upstreamAgain = 4;",
      ].join("\n"),
    );
    expect([...marked].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  it("covers a single-line marker", () => {
    const marked = markedLines(
      ["const a = 1;", "const b = 2; // T3-CUSTOM(expbkt3): why", "const c = 3;"].join("\n"),
    );
    expect([...marked]).toEqual([2]);
  });

  it("leaves unmarked code uncovered", () => {
    const marked = markedLines(["const a = 1;", "const b = 2;"].join("\n"));
    expect(marked.size).toBe(0);
  });

  it("closes a block so later lines are not treated as fork code", () => {
    const marked = markedLines(
      [
        "// T3-CUSTOM(expbkt3): BEGIN",
        "const fork = 1;",
        "// T3-CUSTOM(expbkt3): END",
        "const upstream = 2;",
        "const upstreamAgain = 3;",
      ].join("\n"),
    );
    expect(marked.has(4)).toBe(false);
    expect(marked.has(5)).toBe(false);
  });

  it("handles two blocks in one file", () => {
    const marked = markedLines(
      [
        "// T3-CUSTOM(expbkt3): BEGIN",
        "const one = 1;",
        "// T3-CUSTOM(expbkt3): END",
        "const upstream = 2;",
        "// T3-CUSTOM(expbkt3): BEGIN",
        "const two = 3;",
        "// T3-CUSTOM(expbkt3): END",
      ].join("\n"),
    );
    expect(marked.has(2)).toBe(true);
    expect(marked.has(4)).toBe(false);
    expect(marked.has(6)).toBe(true);
  });
});

describe("isExempt", () => {
  it("exempts tests, generated files and docs", () => {
    expect(isExempt("apps/server/src/ws.test.ts")).toBe(true);
    expect(isExempt("apps/web/src/routeTree.gen.ts")).toBe(true);
    expect(isExempt("docs/operations/expbkt3-customizations.md")).toBe(true);
    expect(isExempt(".github/workflows/ci.yml")).toBe(true);
  });

  it("does not exempt ordinary source files", () => {
    expect(isExempt("apps/server/src/ws.ts")).toBe(false);
    expect(isExempt("packages/contracts/src/rpc.ts")).toBe(false);
  });
});
