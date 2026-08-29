/** T3-CUSTOM(expbkt3): hosted agent-frame redirect protection. */
import { describe, expect, it } from "vite-plus/test";

import { config } from "./vercel";

describe("hosted web framing headers", () => {
  it("makes every hosted shell route unframeable", () => {
    expect(config.headers).toEqual([
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  });
});
