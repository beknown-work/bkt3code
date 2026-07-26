import { describe, expect, it } from "vite-plus/test";

import { parsePlannotatorDecision, rewritePlannotatorHtml } from "./model.ts";

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
