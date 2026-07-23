import { describe, expect, it } from "vitest";

import { connectionAtomRuntime } from "./runtime";

describe("connectionAtomRuntime", () => {
  it("keeps the connection layer mounted across transient subscriber gaps", () => {
    expect(connectionAtomRuntime.keepAlive).toBe(true);
  });
});
