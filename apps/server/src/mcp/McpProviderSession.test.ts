import { describe, expect, it } from "vite-plus/test";

import { upstreamMcpServerName } from "./McpProviderSession.ts";

describe("upstreamMcpServerName", () => {
  it("exposes the shared Bifrost integration under the expected MCP namespace", () => {
    expect(
      upstreamMcpServerName({
        id: "bifrost",
        name: "Bifrost",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/bifrost",
        authMode: "x-bf-vk",
        allowedTools: [],
      }),
    ).toBe("bifrost");
  });

  it("keeps custom user integrations isolated under a reserved namespace", () => {
    expect(
      upstreamMcpServerName({
        id: "custom-tools",
        name: "Custom tools",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/custom-tools",
        authMode: "bearer",
        allowedTools: [],
      }),
    ).toBe("t3_user_custom_tools");
  });
});
