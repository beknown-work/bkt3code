import { describe, expect, it } from "vite-plus/test";

import { shouldShowRunningSessionGlint } from "./RunningSessionGlint.logic";

describe("shouldShowRunningSessionGlint", () => {
  it("shows the card glint only for active planning and implementation work", () => {
    expect(shouldShowRunningSessionGlint("planning", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("implementing", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("ready", "active")).toBe(false);
    expect(shouldShowRunningSessionGlint("needs_input", "active")).toBe(false);
    expect(shouldShowRunningSessionGlint("implementing", "snoozed")).toBe(false);
  });
});
