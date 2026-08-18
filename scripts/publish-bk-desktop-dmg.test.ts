import { describe, expect, it } from "vite-plus/test";

import { fingerprintDesignatedRequirement } from "./publish-bk-desktop-dmg.ts";

// A real Apple-issued requirement embeds the developer's email and Team ID in
// the certificate common name. This repository is public, so the raw string must
// never reach a release body.
const APPLE_REQUIREMENT =
  'identifier "work.beknown.bkt3code" and anchor apple generic and certificate ' +
  'leaf[subject.CN] = "Apple Development: someone@example.com (ABCDE12345)" and ' +
  "certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */";

describe("fingerprintDesignatedRequirement", () => {
  it("publishes no personally identifying data", () => {
    const fingerprint = fingerprintDesignatedRequirement(APPLE_REQUIREMENT);
    expect(fingerprint).not.toContain("someone@example.com");
    expect(fingerprint).not.toContain("ABCDE12345");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across builds of the same identity", () => {
    // codesign appends `Executable=<temp path>`, which differs on every run —
    // and on CI is the runner's temp dir. Including it would both leak that path
    // and make one identity look like two.
    const first = `${APPLE_REQUIREMENT} Executable=/private/var/folders/aa/T/x1/BK T3 Code.app`;
    const second = `${APPLE_REQUIREMENT} Executable=/private/var/folders/zz/T/q9/BK T3 Code.app`;
    expect(fingerprintDesignatedRequirement(first)).toBe(fingerprintDesignatedRequirement(second));
    expect(fingerprintDesignatedRequirement(first)).toBe(
      fingerprintDesignatedRequirement(APPLE_REQUIREMENT),
    );
  });

  it("changes when the signing identity changes", () => {
    // The whole point: a rotated certificate breaks auto-update for every
    // install, so the fingerprint has to make that visible.
    const rotated = APPLE_REQUIREMENT.replace("ABCDE12345", "ZZZZZ99999");
    expect(fingerprintDesignatedRequirement(rotated)).not.toBe(
      fingerprintDesignatedRequirement(APPLE_REQUIREMENT),
    );
  });
});
