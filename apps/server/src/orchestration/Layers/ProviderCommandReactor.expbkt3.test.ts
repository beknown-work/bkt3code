// T3-CUSTOM(expbkt3): delayed Stop must not cancel a later accepted setup.
import { expect, it } from "vite-plus/test";

import { isSetupOwnedByStop } from "./ProviderCommandReactor.ts";

it("cancels only the setup fenced by the Stop event", () => {
  expect(
    isSetupOwnedByStop(
      { desiredState: "stopped", phase: "stopping", requestEventSequence: 40 },
      41,
    ),
  ).toBe(true);
  expect(
    isSetupOwnedByStop(
      // This otherwise identical stop-fenced row was accepted after the Stop.
      { desiredState: "stopped", phase: "stopping", requestEventSequence: 42 },
      41,
    ),
  ).toBe(false);
});
