import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanReviewApprovalPrompt,
  buildPlanReviewFeedbackPrompt,
  formatPlanReviewComment,
  locateQuotedLineRange,
  planReviewFence,
} from "./planReview.ts";

const PLAN = [
  "# Auth rewrite",
  "",
  "## Steps",
  "",
  "1. Add the migration",
  "2. Backfill the rows",
  "3. Flip the flag",
].join("\n");

describe("locateQuotedLineRange", () => {
  it("finds a single quoted line", () => {
    expect(locateQuotedLineRange(PLAN, "2. Backfill the rows")).toEqual({
      startIndex: 5,
      endIndex: 5,
    });
  });

  it("finds a multi-line quote", () => {
    expect(locateQuotedLineRange(PLAN, "1. Add the migration\n2. Backfill the rows")).toEqual({
      startIndex: 4,
      endIndex: 5,
    });
  });

  it("tolerates blank lines inside the document between quoted lines", () => {
    expect(locateQuotedLineRange(PLAN, "# Auth rewrite\n## Steps")).toEqual({
      startIndex: 0,
      endIndex: 2,
    });
  });

  it("returns null when the quote is absent", () => {
    expect(locateQuotedLineRange(PLAN, "4. Delete production")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(locateQuotedLineRange(PLAN, "   \n  ")).toBeNull();
  });
});

describe("planReviewFence", () => {
  it("uses a longer fence when the content contains backticks", () => {
    const fenced = planReviewFence("markdown", "use ``` for code");
    expect(fenced.startsWith("````markdown")).toBe(true);
    expect(fenced.endsWith("````")).toBe(true);
  });
});

describe("formatPlanReviewComment", () => {
  it("emits a review_comment block the existing transcript parser understands", () => {
    const block = formatPlanReviewComment("doc-1", "Auth rewrite", {
      startIndex: 4,
      endIndex: 5,
      quotedText: "1. Add the migration\n2. Backfill the rows",
      body: "Split this into two migrations.",
      authorLabel: "Tushar",
    });

    expect(block).toContain('sectionId="plan:doc-1"');
    expect(block).toContain('filePath="Auth rewrite.md"');
    expect(block).toContain('startIndex="4"');
    expect(block).toContain('endIndex="5"');
    expect(block).toContain('rangeLabel="L5 to L6"');
    expect(block).toContain("— Tushar");
    expect(block.startsWith("<review_comment ")).toBe(true);
    expect(block.endsWith("</review_comment>")).toBe(true);
  });

  it("labels a single-line anchor without a range", () => {
    const block = formatPlanReviewComment("doc-1", "Plan", {
      startIndex: 2,
      endIndex: 2,
      quotedText: "## Steps",
      body: "Rename this heading.",
      authorLabel: null,
    });
    expect(block).toContain('rangeLabel="L3"');
    expect(block).not.toContain("—");
  });

  it("escapes quotes in the plan title", () => {
    const block = formatPlanReviewComment("doc-1", 'The "big" rewrite', {
      startIndex: 0,
      endIndex: 0,
      quotedText: "x",
      body: "y",
      authorLabel: null,
    });
    expect(block).toContain('filePath="The &quot;big&quot; rewrite.md"');
  });
});

describe("buildPlanReviewFeedbackPrompt", () => {
  const base = {
    documentId: "doc-1",
    planTitle: "Auth rewrite",
    globalComment: "",
    comments: [],
    editDiff: "",
    fromRevision: null,
    toRevision: null,
    editAuthorLabel: null,
    fullDocument: null,
  };

  it("never includes the plan body", () => {
    const prompt = buildPlanReviewFeedbackPrompt({
      ...base,
      globalComment: "Too broad.",
      comments: [
        {
          startIndex: 4,
          endIndex: 4,
          quotedText: "1. Add the migration",
          body: "Split this.",
          authorLabel: null,
        },
      ],
    });

    expect(prompt).toContain("Revise the plan you proposed.");
    expect(prompt).toContain("Too broad.");
    expect(prompt).toContain("<review_comment ");
    expect(prompt).not.toContain("3. Flip the flag");
  });

  it("attaches reviewer edits as a diff with version attribution", () => {
    const prompt = buildPlanReviewFeedbackPrompt({
      ...base,
      editDiff: "@@ -1,1 +1,1 @@\n-old\n+new",
      fromRevision: 1,
      toRevision: 2,
      editAuthorLabel: "Tushar",
    });

    expect(prompt).toContain('<plan_edit filePath="Auth rewrite.md" fromVersion="1" toVersion="2"');
    expect(prompt).toContain('author="Tushar"');
    expect(prompt).toContain("```diff");
  });

  it("falls back to the full document when the edit rewrote most of the plan", () => {
    const prompt = buildPlanReviewFeedbackPrompt({
      ...base,
      editDiff: "@@ -1,1 +1,1 @@\n-old\n+new",
      fullDocument: "# Rewritten\n\nEverything changed.",
    });

    expect(prompt).toContain('mode="full"');
    expect(prompt).toContain("# Rewritten");
    expect(prompt).not.toContain("```diff");
  });

  it("omits empty sections", () => {
    const prompt = buildPlanReviewFeedbackPrompt(base);
    expect(prompt).toBe(
      "Revise the plan you proposed. Respond with the complete revised plan.\nDo not modify repository files while planning.",
    );
  });
});

describe("buildPlanReviewApprovalPrompt", () => {
  it("sends one short line when the plan is still in context", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      notes: "",
      resendPlanMarkdown: null,
      resendReason: null,
      approvedEditDiff: "",
    });

    expect(prompt).toBe(
      "Plan approved. Implement the plan you proposed above, exactly as written.",
    );
  });

  it("appends reviewer notes without the plan body", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      notes: "Start with the migration.",
      resendPlanMarkdown: null,
      resendReason: null,
      approvedEditDiff: "",
    });

    expect(prompt).toContain("Reviewer notes:\nStart with the migration.");
    expect(prompt).not.toContain("PLEASE IMPLEMENT");
  });

  it("carries the edit diff when the reviewer changed the plan before approving", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      notes: "",
      resendPlanMarkdown: null,
      resendReason: null,
      approvedEditDiff: "@@ -1,1 +1,1 @@\n-old\n+new",
    });

    expect(prompt).toContain("The reviewer edited the plan before approving.");
    expect(prompt).toContain("```diff");
  });

  it("repeats the plan and explains why when the policy demands it", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      notes: "",
      resendPlanMarkdown: PLAN,
      resendReason: "this session compacted its context after the plan was written",
      approvedEditDiff: "",
    });

    expect(prompt).toContain("PLEASE IMPLEMENT THIS APPROVED PLAN:");
    expect(prompt).toContain("3. Flip the flag");
    expect(prompt).toContain("(The full plan is repeated because this session compacted");
  });
});
