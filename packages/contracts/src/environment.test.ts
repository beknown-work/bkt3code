import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });
});

// T3-CUSTOM(expbkt3): fork capability flags (providerRateLimits,
// durableExecutionRecovery) — proves the fork schema fields survive merges.
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
