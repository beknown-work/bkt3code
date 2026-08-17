import { describe, expect, it } from "vite-plus/test";

import {
  capActivityPayload,
  isActivityPayloadCapped,
  MAX_ACTIVITY_ARRAY_ITEMS,
  MAX_ACTIVITY_DEPTH,
  MAX_ACTIVITY_STRING_CHARS,
} from "./activityPayloadCap.ts";

const oversized = (extra = 1) => "x".repeat(MAX_ACTIVITY_STRING_CHARS + extra);

describe("capActivityPayload", () => {
  it("returns the identical reference when nothing exceeds a cap", () => {
    // The passthrough guarantee: the common activity must not be copied,
    // re-keyed, or re-serialized on the ingest path.
    const payload = {
      itemType: "command_execution",
      data: { item: { aggregatedOutput: "ok", command: "ls" }, completedAtMs: 1 },
    };
    expect(capActivityPayload(payload)).toBe(payload);
    expect(isActivityPayloadCapped(payload)).toBe(false);
  });

  it("caps the command output path that dominates the database", () => {
    const payload = { data: { item: { aggregatedOutput: oversized(), command: "pnpm test" } } };
    const capped = capActivityPayload(payload) as typeof payload;

    expect(capped).not.toBe(payload);
    const output = capped.data.item.aggregatedOutput;
    // Never above the cap — this is what makes a second pass a no-op.
    expect(output.length).toBeLessThanOrEqual(MAX_ACTIVITY_STRING_CHARS);
    expect(output).toContain("t3:truncated");
    // The marker must describe the drop, so a short payload is never ambiguous.
    expect(output).toContain(String(MAX_ACTIVITY_STRING_CHARS + 1));
    // Untouched siblings keep their exact values.
    expect(capped.data.item.command).toBe("pnpm test");
  });

  it("caps MCP result text nested inside arrays", () => {
    const payload = {
      data: { item: { result: { content: [{ type: "text", text: oversized() }] } } },
    };
    const capped = capActivityPayload(payload) as typeof payload;
    const entry = capped.data.item.result.content[0];

    expect(entry?.type).toBe("text");
    expect(entry?.text.length).toBeLessThan(MAX_ACTIVITY_STRING_CHARS + 200);
    expect(entry?.text).toContain("t3:truncated");
  });

  it("caps the recursive case: activities embedded in an MCP result", () => {
    // t3_get_session returns thread activities, so an oversized output can
    // arrive nested inside another activity's payload.
    const payload = {
      data: {
        item: {
          result: {
            structuredContent: {
              thread: {
                activities: [{ payload: { data: { item: { aggregatedOutput: oversized() } } } }],
              },
            },
          },
        },
      },
    };
    const capped = capActivityPayload(payload);
    expect(JSON.stringify(capped).length).toBeLessThan(MAX_ACTIVITY_STRING_CHARS * 2);
  });

  it("bounds unbounded arrays and records how many were dropped", () => {
    const payload = { content: Array.from({ length: MAX_ACTIVITY_ARRAY_ITEMS + 5 }, () => "a") };
    const capped = capActivityPayload(payload) as { content: Array<string> };

    expect(capped.content).toHaveLength(MAX_ACTIVITY_ARRAY_ITEMS);
    expect(capped.content[MAX_ACTIVITY_ARRAY_ITEMS - 1]).toContain("6 of 1005 items");
    // A second pass must not shrink it further.
    expect(capActivityPayload(capped)).toBe(capped);
  });

  it("stops at the depth limit instead of walking forever", () => {
    let deep: unknown = oversized();
    for (let index = 0; index < MAX_ACTIVITY_DEPTH + 5; index += 1) {
      deep = { nested: deep };
    }
    const capped = capActivityPayload(deep);
    expect(JSON.stringify(capped)).toContain("t3:truncated");
    expect(JSON.stringify(capped).length).toBeLessThan(2_000);
  });

  it("leaves non-plain values and primitives alone", () => {
    // A non-plain prototype must survive by reference: rebuilding it as a plain
    // object here would silently change the payload's shape.
    const exotic = new Map([["k", "v"]]);
    const payload = { exotic, count: 3, flag: true, missing: null };
    const capped = capActivityPayload(payload) as typeof payload;

    expect(capped).toBe(payload);
    expect(capped.exotic).toBe(exotic);
  });

  it("is idempotent — recapping an already-capped payload is a no-op", () => {
    const once = capActivityPayload({ data: { item: { aggregatedOutput: oversized() } } });
    expect(capActivityPayload(once)).toBe(once);
  });
});
