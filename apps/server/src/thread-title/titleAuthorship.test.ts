import { describe, expect, it } from "@effect/vitest";

import { truncate } from "@t3tools/shared/String";

import {
  DEFAULT_THREAD_TITLE,
  canGeneratedTitleReplace,
  isPlaceholderTitle,
} from "./titleAuthorship.ts";

const LONG_PROMPT =
  "Refactor the checkpoint reactor so interrupted turns replay their receipts instead of failing the execution";

describe("isPlaceholderTitle", () => {
  it("treats the default placeholder as replaceable", () => {
    expect(isPlaceholderTitle({ title: DEFAULT_THREAD_TITLE })).toBe(true);
    expect(isPlaceholderTitle({ title: `  ${DEFAULT_THREAD_TITLE}  ` })).toBe(true);
  });

  it("treats a title identical to the seed as replaceable", () => {
    expect(isPlaceholderTitle({ title: "Fix the sidebar", titleSeed: "Fix the sidebar" })).toBe(
      true,
    );
  });

  it("treats the client's truncated seed as replaceable", () => {
    // The regression: the web client titles the thread `truncate(prompt)` and
    // seeds it with the full prompt, so long first prompts were never named.
    const title = truncate(LONG_PROMPT);
    expect(title).not.toBe(LONG_PROMPT);
    expect(isPlaceholderTitle({ title, titleSeed: LONG_PROMPT })).toBe(true);
  });

  it("accepts truncations at budgets other than the default", () => {
    expect(isPlaceholderTitle({ title: truncate(LONG_PROMPT, 20), titleSeed: LONG_PROMPT })).toBe(
      true,
    );
    expect(isPlaceholderTitle({ title: truncate(LONG_PROMPT, 80), titleSeed: LONG_PROMPT })).toBe(
      true,
    );
  });

  it("refuses a human title that merely ends in an ellipsis", () => {
    expect(isPlaceholderTitle({ title: "Something else...", titleSeed: LONG_PROMPT })).toBe(false);
  });

  it("refuses a human title when there is no seed to compare against", () => {
    expect(isPlaceholderTitle({ title: "Checkpoint replay" })).toBe(false);
  });

  it("refuses a title that extends the seed rather than truncating it", () => {
    expect(
      isPlaceholderTitle({ title: `${LONG_PROMPT} and more...`, titleSeed: LONG_PROMPT }),
    ).toBe(false);
  });
});

describe("canGeneratedTitleReplace", () => {
  it("allows generation over a placeholder", () => {
    expect(canGeneratedTitleReplace({ title: DEFAULT_THREAD_TITLE })).toBe(true);
  });

  it("refuses generation over a hand-typed title", () => {
    expect(canGeneratedTitleReplace({ title: "Release checklist", titleManuallySet: true })).toBe(
      false,
    );
  });

  it("refuses even when a manual title looks like the placeholder", () => {
    // Someone can legitimately rename a session back to "New thread".
    expect(canGeneratedTitleReplace({ title: DEFAULT_THREAD_TITLE, titleManuallySet: true })).toBe(
      false,
    );
  });

  it("treats an absent flag as not manually set, for pre-migration rows", () => {
    expect(canGeneratedTitleReplace({ title: truncate(LONG_PROMPT), titleSeed: LONG_PROMPT })).toBe(
      true,
    );
  });
});
