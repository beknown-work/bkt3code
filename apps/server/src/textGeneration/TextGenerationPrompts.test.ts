import { describe, expect, it } from "vite-plus/test";

import {
  buildBranchNamePrompt,
  buildCatchupSummaryPrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildRollingSummaryPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCatchupSummary,
  sanitizeRollingSummary,
  sanitizeThreadTitle,
  MAX_ROLLING_SUMMARY_CHARS,
} from "./TextGenerationUtils.ts";
import { TextGenerationError } from "@t3tools/contracts";

describe("buildCommitMessagePrompt", () => {
  it("includes staged patch and summary in the prompt", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md\n+hello",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Staged files:");
    expect(result.prompt).toContain("M README.md");
    expect(result.prompt).toContain("Staged patch:");
    expect(result.prompt).toContain("diff --git a/README.md b/README.md");
    expect(result.prompt).toContain("Branch: main");
    // Should NOT include the branch generation instruction
    expect(result.prompt).not.toContain("branch must be a short semantic git branch fragment");
  });

  it("includes branch generation instruction when includeBranch is true", () => {
    const result = buildCommitMessagePrompt({
      branch: "feature/foo",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      includeBranch: true,
    });

    expect(result.prompt).toContain("branch must be a short semantic git branch fragment");
    expect(result.prompt).toContain("Return a JSON object with keys: subject, body, branch.");
  });

  it("shows (detached) when branch is null", () => {
    const result = buildCommitMessagePrompt({
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Branch: (detached)");
  });
});

describe("buildPrContentPrompt", () => {
  it("includes branch names, commits, and diff in the prompt", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff --git a/auth.ts b/auth.ts\n+export function login()",
    });

    expect(result.prompt).toContain("Base branch: main");
    expect(result.prompt).toContain("Head branch: feature/auth");
    expect(result.prompt).toContain("Commits:");
    expect(result.prompt).toContain("feat: add login page");
    expect(result.prompt).toContain("Diff stat:");
    expect(result.prompt).toContain("3 files changed");
    expect(result.prompt).toContain("Diff patch:");
    expect(result.prompt).toContain("export function login()");
  });
});

describe("buildBranchNamePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the login timeout bug",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Fix the login timeout bug");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });
});

describe("sanitizeThreadTitle", () => {
  it("truncates long titles with the shared sidebar-safe limit", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });
});

describe("normalizeCliError", () => {
  it("detects 'Command not found' and includes CLI name in the message", () => {
    const error = normalizeCliError(
      "claude",
      "generateCommitMessage",
      new Error("Command not found: claude"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Claude CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateBranchName",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("returns the error as-is if it is already a TextGenerationError", () => {
    const existing = new TextGenerationError({
      operation: "generatePrContent",
      detail: "Already wrapped",
    });

    const result = normalizeCliError("claude", "generatePrContent", existing, "fallback");

    expect(result).toBe(existing);
  });

  it("wraps unknown non-Error values with the fallback message", () => {
    const result = normalizeCliError("codex", "generateCommitMessage", "string error", "fallback");

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("fallback");
  });

  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildRollingSummaryPrompt", () => {
  it("marks the first turn when there is no previous summary", () => {
    const result = buildRollingSummaryPrompt({
      threadTitle: "Add catch-up card",
      previousSummary: null,
      turnTranscript: "user: do the thing\nassistant: did the thing",
      dataLimitChars: 24_000,
    });

    expect(result.prompt).toContain("(none — first turn)");
    expect(result.prompt).toContain("did the thing");
    expect(Object.keys(result.outputSchema.fields)).toEqual(["summary"]);
  });

  it("keeps the tail of an oversized transcript and drops the head", () => {
    const transcript = `HEAD_MARKER${"x".repeat(20_000)}TAIL_MARKER`;
    const result = buildRollingSummaryPrompt({
      threadTitle: "Long session",
      previousSummary: "Earlier work.",
      turnTranscript: transcript,
      dataLimitChars: 4_000,
    });

    expect(result.prompt).toContain("TAIL_MARKER");
    expect(result.prompt).not.toContain("HEAD_MARKER");
    expect(result.prompt).toContain("Earlier work.");
  });
});

describe("buildCatchupSummaryPrompt", () => {
  it("asks for a bounded plain-text note built from the rolling summary", () => {
    const result = buildCatchupSummaryPrompt({
      threadTitle: "Add catch-up card",
      rollingSummary: "Wiring the reactor.",
      turnTail: "Finished the projector case.",
    });

    expect(result.prompt).toContain("at most 3 lines");
    expect(result.prompt).toContain("Wiring the reactor.");
    expect(result.prompt).toContain("Finished the projector case.");
    expect(result.prompt).toContain("no markdown");
    expect(Object.keys(result.outputSchema.fields)).toEqual(["summary"]);
  });
});

describe("sanitizeCatchupSummary", () => {
  it("clamps to three lines and strips markdown markers", () => {
    const result = sanitizeCatchupSummary(
      "- first line\n* second line\n1. third line\n- fourth line",
    );

    expect(result).toBe("first line\nsecond line\nthird line");
  });

  it("drops blank lines and surrounding whitespace", () => {
    expect(sanitizeCatchupSummary("  \n only line \n\n ")).toBe("only line");
  });
});

describe("sanitizeRollingSummary", () => {
  it("truncates summaries past the stored bound", () => {
    const result = sanitizeRollingSummary("y".repeat(MAX_ROLLING_SUMMARY_CHARS + 500));

    expect(result.length).toBeLessThanOrEqual(MAX_ROLLING_SUMMARY_CHARS + 3);
    expect(result.endsWith("...")).toBe(true);
  });

  it("leaves a short summary untouched", () => {
    expect(sanitizeRollingSummary("  short summary  ")).toBe("short summary");
  });
});
