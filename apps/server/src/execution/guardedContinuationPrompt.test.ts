// T3-CUSTOM(expbkt3): a guarded recovery must never drop the request it replaces.
import { describe, expect, it } from "@effect/vitest";

import { buildGuardedContinuationPrompt } from "./guardedContinuationPrompt.ts";

describe("buildGuardedContinuationPrompt", () => {
  it("carries the interrupted request, review comments included", () => {
    const approval = [
      "Plan approved — start implementing it now.",
      "",
      '<review_comment sectionId="plan:doc-1" sectionTitle="Plan review" filePath="Plan.md" rangeLabel="L4">',
      "Retire the test row first.",
      "</review_comment>",
    ].join("\n");

    const prompt = buildGuardedContinuationPrompt(`${approval}\n`);

    expect(prompt).toContain("do not repeat completed external actions");
    expect(prompt).toContain(
      ["<interrupted_user_message>", approval, "</interrupted_user_message>"].join("\n"),
    );
  });

  it("falls back to the bare instruction when there is no original text", () => {
    for (const original of [null, "", "   \n"]) {
      const prompt = buildGuardedContinuationPrompt(original);
      expect(prompt).toMatch(/^Continue the unfinished task/);
      expect(prompt).not.toContain("<interrupted_user_message>");
    }
  });
});
