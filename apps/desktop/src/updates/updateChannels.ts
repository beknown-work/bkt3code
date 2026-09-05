import type { DesktopUpdateChannel } from "@t3tools/contracts";

// T3-CUSTOM(expbkt3): untagged integrated upstream revisions remain nightly builds.
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+(?:\.upstream\.g[0-9a-f]+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
