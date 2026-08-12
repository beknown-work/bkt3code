import { describe, expect, it } from "@effect/vitest";

import { truncate } from "@t3tools/shared/String";

import {
  DEFAULT_THREAD_TITLE,
  canGeneratedTitleReplace,
  isPlaceholderTitle,
  shouldNameThreadFromFirstPrompt,
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

describe("shouldNameThreadFromFirstPrompt", () => {
  const firstTurn = { userMessageCount: 1 } as const;

  it("names the session on its first prompt", () => {
    expect(shouldNameThreadFromFirstPrompt({ ...firstTurn, title: DEFAULT_THREAD_TITLE })).toBe(
      true,
    );
    // The real shape: the client titled the thread from the prompt and declared
    // that same value as the seed.
    expect(
      shouldNameThreadFromFirstPrompt({
        ...firstTurn,
        title: "what you can do for me ?",
        titleSeed: "what you can do for me ?",
      }),
    ).toBe(true);
    // And an MCP-created session, whose derived title is a clipped prompt.
    expect(
      shouldNameThreadFromFirstPrompt({
        ...firstTurn,
        title: truncate(LONG_PROMPT),
        titleSeed: LONG_PROMPT,
      }),
    ).toBe(true);
  });

  it("only fires on the first prompt", () => {
    for (const userMessageCount of [0, 2, 3, 7]) {
      expect(
        shouldNameThreadFromFirstPrompt({ userMessageCount, title: DEFAULT_THREAD_TITLE }),
      ).toBe(false);
    }
  });

  it("leaves a name the user typed before their first prompt alone", () => {
    expect(
      shouldNameThreadFromFirstPrompt({
        ...firstTurn,
        title: "Release checklist",
        titleManuallySet: true,
      }),
    ).toBe(false);
    // Even without the flag, a title that is neither placeholder nor seed is
    // someone's choice.
    expect(
      shouldNameThreadFromFirstPrompt({
        ...firstTurn,
        title: "Release checklist",
        titleSeed: "something else entirely",
      }),
    ).toBe(false);
  });
});
