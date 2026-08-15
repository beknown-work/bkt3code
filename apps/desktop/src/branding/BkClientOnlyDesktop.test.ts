import { describe, expect, it } from "vite-plus/test";

import { resolveBkClientRendererSource } from "./BkManagedEnvironment.ts";

describe("BkClientOnlyDesktop", () => {
  it("serves packaged client assets while connecting to the managed backend", () => {
    expect(
      resolveBkClientRendererSource({
        managedHttpBaseUrl: "https://expbkt3.dev.beknown.live",
        isDevelopment: false,
        devServerUrl: null,
        clientAssetsDirectory: "/Applications/Stage BK T3 Code.app/client",
      }),
    ).toEqual({
      targetOrigin: new URL("https://expbkt3.dev.beknown.live"),
      backendOrigin: new URL("https://expbkt3.dev.beknown.live"),
      clientAssetsDirectory: "/Applications/Stage BK T3 Code.app/client",
    });
  });

  it("uses the Vite renderer in development without enabling a local backend", () => {
    const devServerUrl = new URL("http://127.0.0.1:5733");
    expect(
      resolveBkClientRendererSource({
        managedHttpBaseUrl: "https://expbkt3.dev.beknown.live",
        isDevelopment: true,
        devServerUrl,
        clientAssetsDirectory: "/unused",
      }),
    ).toEqual({
      targetOrigin: devServerUrl,
      backendOrigin: new URL("https://expbkt3.dev.beknown.live"),
    });
  });
});
