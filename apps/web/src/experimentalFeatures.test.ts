import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("experimental feature build flags", () => {
  it("enables the control center without enabling T3 Conductor", async () => {
    vi.stubEnv("VITE_T3_EXPERIMENTAL_CONTROL_CENTER", "true");
    vi.stubEnv("VITE_T3_CONDUCTOR", "false");

    const flags = await import("./experimentalFeatures");

    expect(flags.EXPERIMENTAL_CONTROL_CENTER_ENABLED).toBe(true);
    expect(flags.T3_CONDUCTOR_ENABLED).toBe(false);
  });

  it("requires the control center before T3 Conductor can be enabled", async () => {
    vi.stubEnv("VITE_T3_EXPERIMENTAL_CONTROL_CENTER", "false");
    vi.stubEnv("VITE_T3_CONDUCTOR", "true");

    const flags = await import("./experimentalFeatures");

    expect(flags.EXPERIMENTAL_CONTROL_CENTER_ENABLED).toBe(false);
    expect(flags.T3_CONDUCTOR_ENABLED).toBe(false);
  });

  it("enables T3 Conductor only when both flags are enabled", async () => {
    vi.stubEnv("VITE_T3_EXPERIMENTAL_CONTROL_CENTER", "true");
    vi.stubEnv("VITE_T3_CONDUCTOR", "true");

    const flags = await import("./experimentalFeatures");

    expect(flags.EXPERIMENTAL_CONTROL_CENTER_ENABLED).toBe(true);
    expect(flags.T3_CONDUCTOR_ENABLED).toBe(true);
  });
});
