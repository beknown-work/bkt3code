import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  buildBranchNamePrompt,
  buildCatchupSummaryPrompt,
  buildWorkSummaryPrompt,
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
  sanitizeWorkSummary,
  sanitizeWorkSummaryPercent,
  sanitizeWorkSummaryRemaining,
  sanitizeWorkSummaryStage,
  MAX_ROLLING_SUMMARY_CHARS,
  MAX_WORK_SUMMARY_CHARS,
  MAX_WORK_SUMMARY_REMAINING_CHARS,
  WORK_SUMMARY_STAGES,
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

  it("includes policy instructions", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
      policy: {
        kind: "custom",
        commitInstructions: "Use a terse repository-specific subject.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Additional instructions:");
    expect(result.prompt).toContain("Use a terse repository-specific subject.");
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
    expect(result.prompt).toContain("include headings '## Summary' and '## Testing'");
  });

  it("follows a repository PR template instead of the default body headings", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff",
      changeRequestTemplate: "<!-- remove me -->\n## What changed\n\n## Verification",
      policy: {
        kind: "custom",
        changeRequestInstructions: "Keep the title in sentence case.",
        inferRepositoryConventions: false,
      },
    });

    expect(result.prompt).toContain("Keep the title in sentence case.");
    expect(result.prompt).toContain("follow the repository change request template structure");
    expect(result.prompt).toContain("drop HTML comments from the template");
    expect(result.prompt).toContain("Repository change request template:");
    expect(result.prompt).toContain("<!-- remove me -->\n## What changed\n\n## Verification");
    expect(result.prompt).not.toContain("include headings '## Summary' and '## Testing'");
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
    expect(result.prompt).toContain(
      "Generate a title that will help the user recognize this T3 Code thread weeks later.",
    );
    expect(result.prompt).toContain(
      "Title the subject and outcome. Discard incidental instructions.",
    );
    expect(result.prompt).toContain(
      "Name the product change, not the mock, plan, report, branch, or PR used to produce it.",
    );
    expect(result.prompt).not.toContain(
      "Title should summarize the user's request, not restate it verbatim.",
    );
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

  it("regenerates from recent thread contents and identifies the previous title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain(
      "Regenerate the title for an existing T3 Code thread so the user can recognize it weeks later.",
    );
    expect(result.prompt).toContain('The previous title was "Investigate reconnect regressions".');
    expect(result.prompt).toContain(
      "Read the USER messages first. Identify the latest explicit durable goal.",
    );
    expect(result.prompt).toContain(
      "Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.",
    );
    expect(result.prompt).toContain(
      'A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks,"',
    );
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });

  it("keeps the latest thread contents when regeneration context is truncated", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
    expect(result.prompt).not.toContain("[truncated]");
  });

  it("does not truncate an already-marked regeneration context twice", () => {
    const retainedContext = "x".repeat(7_998);
    const result = buildThreadTitlePrompt({
      message: `[Earlier content truncated]\n\n${retainedContext}`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain(
      `Thread contents:\n[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(result.prompt.match(/\[Earlier content truncated\]/g)).toHaveLength(1);
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
  it("appends user-supplied instructions when configured", () => {
    const result = buildCatchupSummaryPrompt({
      threadTitle: "Add catch-up card",
      rollingSummary: "Wiring the reactor.",
      turnTail: "Finished the projector case.",
      customInstructions: "Always name the files touched.",
    });

    expect(result.prompt).toContain("Additional instructions:");
    expect(result.prompt).toContain("Always name the files touched.");
  });

  it("omits the instructions block when none is configured", () => {
    const result = buildCatchupSummaryPrompt({
      threadTitle: "Add catch-up card",
      rollingSummary: "Wiring the reactor.",
      turnTail: "Finished the projector case.",
    });

    expect(result.prompt).not.toContain("Additional instructions:");
  });

  it("asks for a bounded plain-text note built from the rolling summary", () => {
    const result = buildCatchupSummaryPrompt({
      threadTitle: "Add catch-up card",
      rollingSummary: "Wiring the reactor.",
      turnTail: "Finished the projector case.",
    });

    expect(result.prompt).toContain("exactly 3 lines");
    // Line 1 must re-establish what the session is for.
    expect(result.prompt).toContain("what this session is working on overall");
    expect(result.prompt).toContain("what still remains");
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

// T3-CUSTOM(expbkt3): bulk session manager work summary prompt + sanitizers.
describe("buildWorkSummaryPrompt", () => {
  it("asks for the four structured fields the bulk table renders", () => {
    const result = buildWorkSummaryPrompt({
      context: "Session title: Ship the manager\n\nTranscript:\nuser: build it",
    });

    expect(Object.keys(result.outputSchema.fields)).toEqual([
      "summary",
      "stage",
      "remaining",
      "percent",
    ]);
    expect(result.prompt).toContain(
      "Return a JSON object with keys: summary, stage, remaining, percent.",
    );
    expect(result.prompt).toContain("2 to 4 sentences");
    expect(result.prompt).toContain(WORK_SUMMARY_STAGES.join(", "));
    expect(result.prompt).toContain(String(MAX_WORK_SUMMARY_REMAINING_CHARS));
    expect(result.prompt).toContain("Ship the manager");
  });

  it("accepts only the five sortable stage buckets", () => {
    const isOutput = Schema.is(buildWorkSummaryPrompt({ context: "ctx" }).outputSchema);
    const base = { summary: "did work", remaining: "land it", percent: 50 };

    for (const stage of WORK_SUMMARY_STAGES) {
      expect(isOutput({ ...base, stage })).toBe(true);
    }
    // A sixth bucket would be unsortable in the table and unmappable in the
    // contract, so the provider must reject it rather than pass it through.
    expect(isOutput({ ...base, stage: "shipping" })).toBe(false);
    expect(isOutput({ ...base, stage: "done", percent: "50" })).toBe(false);
  });

  it("appends user-supplied instructions only when configured", () => {
    const withInstructions = buildWorkSummaryPrompt({
      context: "ctx",
      promptInstructions: "Mention the Linear ticket.",
    });
    expect(withInstructions.prompt).toContain("Additional instructions:");
    expect(withInstructions.prompt).toContain("Mention the Linear ticket.");

    const without = buildWorkSummaryPrompt({ context: "ctx" });
    expect(without.prompt).not.toContain("Additional instructions:");
  });
});

describe("work summary sanitizers", () => {
  it("collapses the summary to one plain-text paragraph", () => {
    expect(sanitizeWorkSummary("- did a thing\n\n* then another")).toBe("did a thing then another");
  });

  it("truncates a summary past the table's bound", () => {
    const result = sanitizeWorkSummary("z".repeat(MAX_WORK_SUMMARY_CHARS + 200));

    expect(result.length).toBeLessThanOrEqual(MAX_WORK_SUMMARY_CHARS + 3);
    expect(result.endsWith("...")).toBe(true);
  });

  it("keeps remaining to a single capped line", () => {
    expect(sanitizeWorkSummaryRemaining("- land the PR\nthen celebrate")).toBe("land the PR");
    expect(sanitizeWorkSummaryRemaining("q".repeat(200)).length).toBe(
      MAX_WORK_SUMMARY_REMAINING_CHARS,
    );
  });

  it("falls back to implementing for an unknown stage", () => {
    expect(sanitizeWorkSummaryStage("Awaiting Review")).toBe("awaiting-review");
    expect(sanitizeWorkSummaryStage("shipping")).toBe("implementing");
    expect(sanitizeWorkSummaryStage("")).toBe("implementing");
  });

  it("clamps percent into 0..100", () => {
    expect(sanitizeWorkSummaryPercent(-40)).toBe(0);
    expect(sanitizeWorkSummaryPercent(140)).toBe(100);
    expect(sanitizeWorkSummaryPercent(61.6)).toBe(62);
    expect(sanitizeWorkSummaryPercent(Number.NaN)).toBe(0);
  });
});
