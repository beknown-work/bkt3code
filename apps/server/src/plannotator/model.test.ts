import { describe, expect, it } from "vite-plus/test";

import {
  mergePlannotatorAnnotationHistory,
  parsePlannotatorDecision,
  parsePlannotatorSubmission,
  rewritePlannotatorHtml,
} from "./model.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("parsePlannotatorDecision", () => {
  it("recognizes approval from the feedback endpoint", () => {
    expect(parsePlannotatorDecision("/api/feedback", bytes({ approved: true }))).toEqual({
      kind: "approved",
      feedback: "",
    });
  });

  it("collects global and anchored annotation feedback", () => {
    expect(
      parsePlannotatorDecision(
        "/api/feedback",
        bytes({
          approved: false,
          annotations: [
            { quote: "old behavior", comment: "Explain the fallback." },
            { note: "Add a failure test." },
          ],
        }),
      ),
    ).toEqual({
      kind: "feedback",
      feedback: "> old behavior\n\nExplain the fallback.\n\nAdd a failure test.",
    });
  });

  it("retains structured annotations for durable review replay", () => {
    expect(
      parsePlannotatorSubmission(
        "/api/feedback",
        bytes({
          approved: false,
          annotations: [
            {
              id: "inline-1",
              type: "COMMENT",
              text: "Explain the fallback.",
              originalText: "old behavior",
              author: "Reviewer A",
            },
            {
              id: "global-1",
              type: "GLOBAL_COMMENT",
              text: "Add a failure test.",
              originalText: "",
            },
            {
              id: "deletion-1",
              type: "DELETION",
              text: "Delete this section.",
              originalText: "Legacy rollout",
            },
          ],
        }),
      ),
    ).toEqual({
      decision: {
        kind: "feedback",
        feedback:
          "> old behavior\n\nExplain the fallback.\n\nAdd a failure test.\n\nRemove:\n\n> Legacy rollout",
      },
      annotations: [
        {
          id: "inline-1",
          type: "COMMENT",
          text: "Explain the fallback.",
          originalText: "old behavior",
          author: "Reviewer A",
        },
        {
          id: "global-1",
          type: "GLOBAL_COMMENT",
          text: "Add a failure test.",
          originalText: "",
          author: "",
        },
        {
          id: "deletion-1",
          type: "DELETION",
          text: "Delete this section.",
          originalText: "Legacy rollout",
          author: "",
        },
      ],
    });
  });

  it("does not treat an external annotation update as submitted feedback", () => {
    expect(
      parsePlannotatorSubmission(
        "/api/external-annotations",
        bytes({
          annotations: [
            {
              source: "agent-review",
              type: "GLOBAL_COMMENT",
              text: "Consider a staged rollout.",
            },
          ],
        }),
      ),
    ).toEqual({
      decision: null,
      annotations: [
        {
          id: ["GLOBAL_COMMENT", "", "Consider%20a%20staged%20rollout.", ""].join(":"),
          type: "GLOBAL_COMMENT",
          text: "Consider a staged rollout.",
          originalText: "",
          author: "",
        },
      ],
    });
  });

  it("de-duplicates replayed annotations while appending a later review round", () => {
    expect(
      mergePlannotatorAnnotationHistory(
        [
          {
            id: "round-1-id",
            type: "COMMENT",
            text: "Explain the fallback.",
            originalText: "Fallback",
            author: "Reviewer",
            submittedAt: "2026-07-27T10:00:00.000Z",
          },
        ],
        [
          {
            id: "replayed-random-id",
            type: "COMMENT",
            text: "Explain the fallback.",
            originalText: "Fallback",
            author: "Reviewer",
          },
          {
            id: "round-2-id",
            type: "GLOBAL_COMMENT",
            text: "Add a rollback test.",
            originalText: "",
            author: "Reviewer",
          },
        ],
        "2026-07-27T11:00:00.000Z",
      ),
    ).toEqual([
      {
        id: "round-1-id",
        type: "COMMENT",
        text: "Explain the fallback.",
        originalText: "Fallback",
        author: "Reviewer",
        submittedAt: "2026-07-27T10:00:00.000Z",
      },
      {
        id: "round-2-id",
        type: "GLOBAL_COMMENT",
        text: "Add a rollback test.",
        originalText: "",
        author: "Reviewer",
        submittedAt: "2026-07-27T11:00:00.000Z",
      },
    ]);
  });

  it("treats an empty deny endpoint as a denial", () => {
    expect(parsePlannotatorDecision("/api/deny", new Uint8Array())).toEqual({
      kind: "denied",
      feedback: "",
    });
  });
});

describe("rewritePlannotatorHtml", () => {
  it("rewrites static root paths and injects runtime networking shims", () => {
    const rewritten = rewritePlannotatorHtml(
      '<html><head></head><body><script src="/assets/app.js"></script></body></html>',
      "/plannotator/opaque",
    );

    expect(rewritten).toContain('src="/plannotator/opaque/assets/app.js"');
    expect(rewritten).toContain("window.EventSource=W");
    expect(rewritten).toContain("window.XMLHttpRequest");
    expect(rewritten).toContain('"sessionStorage":"localStorage"');
    expect(rewritten).toContain("Object.defineProperty(window,sn");
  });
});
