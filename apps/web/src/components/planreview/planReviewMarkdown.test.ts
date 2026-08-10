import { describe, expect, it } from "vite-plus/test";

import { hasPlanReviewEditorChange, resolveSubmittedPlanMarkdown } from "./planReviewMarkdown";

const CANONICAL_PLAN = [
  "## Context",
  "",
  "Attaching a second instance is broken today, and it fails closed.",
  "",
  "- Transport is fine — pairing exchange `200`, WebSocket opens, and the descriptor",
  "  advertises every fork capability.",
  "- The session carries **no user at all**.",
  "",
  "The handler uses `resolveIdentity` (line ~494).",
].join("\n");

const PLATE_NORMALIZED_PLAN = [
  "## Context",
  "",
  "Attaching a second instance is broken today, and it fails closed.\\",
  "",
  "* Transport is fine — pairing exchange `200`, WebSocket opens, and the descriptoradvertises every fork capability.",
  "* The session carries **no user at all**.",
  "",
  "The handler uses `resolveIdentity` (line \\~494).",
].join("\n");

describe("resolveSubmittedPlanMarkdown", () => {
  it("preserves the canonical plan when the reviewer did not edit it", () => {
    expect(
      resolveSubmittedPlanMarkdown({
        canonicalMarkdown: CANONICAL_PLAN,
        editorMarkdown: PLATE_NORMALIZED_PLAN,
        hasReviewerEdits: false,
      }),
    ).toBe(CANONICAL_PLAN);
  });

  it("uses the editor markdown after a real reviewer edit", () => {
    expect(
      resolveSubmittedPlanMarkdown({
        canonicalMarkdown: CANONICAL_PLAN,
        editorMarkdown: `${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`,
        hasReviewerEdits: true,
      }),
    ).toBe(`${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`);
  });
});

describe("hasPlanReviewEditorChange", () => {
  it("ignores Plate's load-time change notification", () => {
    expect(
      hasPlanReviewEditorChange({
        baselineEditorMarkdown: PLATE_NORMALIZED_PLAN,
        editorMarkdown: PLATE_NORMALIZED_PLAN,
      }),
    ).toBe(false);
  });

  it("recognizes the first real reviewer edit", () => {
    expect(
      hasPlanReviewEditorChange({
        baselineEditorMarkdown: PLATE_NORMALIZED_PLAN,
        editorMarkdown: `${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`,
      }),
    ).toBe(true);
  });
});
