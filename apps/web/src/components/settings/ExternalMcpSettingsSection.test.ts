import { describe, expect, it } from "vite-plus/test";

import { formatExternalMcpApiKey } from "./ExternalMcpSettingsSection";

describe("formatExternalMcpApiKey", () => {
  it("creates a stable high-entropy prefixed credential", () => {
    expect(formatExternalMcpApiKey(new Uint8Array([0, 1, 15, 16, 255]))).toBe("t3exp_00010f10ff");
  });
});
