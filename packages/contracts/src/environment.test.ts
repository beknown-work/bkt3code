import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

describe("ExecutionEnvironmentDescriptor optional capabilities", () => {
  it("keeps older servers compatible when the capability is absent", () => {
    const descriptor = decodeDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    });

    expect(descriptor.capabilities.providerRateLimits).toBeUndefined();
    expect(descriptor.capabilities.durableExecutionRecovery).toBeUndefined();
  });

  it("decodes support advertised by newer servers", () => {
    const descriptor = decodeDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true, providerRateLimits: true },
    });

    expect(descriptor.capabilities.providerRateLimits).toBe(true);
  });

  it("decodes durable execution recovery support advertised by newer servers", () => {
    const descriptor = decodeDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true, durableExecutionRecovery: true },
    });

    expect(descriptor.capabilities.durableExecutionRecovery).toBe(true);
  });
});
