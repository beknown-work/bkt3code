import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRateLimitSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderRateLimitsDetails,
  SidebarProviderRateLimitsView,
} from "./SidebarProviderRateLimits.tsx";
import { buildProviderRateLimitRows } from "./SidebarProviderRateLimits.logic.ts";

const now = Date.parse("2026-08-01T10:00:00.000Z");
const codexSnapshot: ProviderRateLimitSnapshot = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  availability: "available",
  windows: [
    {
      windowId: "codex:primary",
      label: "Primary",
      usedPercent: 26,
      resetsAt: DateTime.makeUnsafe("2026-08-01T12:00:00.000Z"),
      category: "rolling",
    },
  ],
  observedAt: DateTime.makeUnsafe("2026-08-01T09:55:00.000Z"),
  lastRefreshFailed: false,
};
const claudeSnapshot: ProviderRateLimitSnapshot = {
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  availability: "not-applicable",
  windows: [],
  observedAt: DateTime.makeUnsafe("2026-08-01T09:56:00.000Z"),
  lastRefreshFailed: false,
};
const rows = buildProviderRateLimitRows({
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
    },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
    },
  ],
  entries: [codexSnapshot, claudeSnapshot],
  now,
});

describe("SidebarProviderRateLimits", () => {
  it("renders one accessible trigger with an exact 32px bar track", () => {
    const markup = renderToStaticMarkup(
      <SidebarProviderRateLimitsView
        environmentLabel="Workstation"
        now={now}
        onBackdrop={false}
        rows={rows}
      />,
    );

    expect(markup).toContain(
      'aria-label="Provider usage limits: Codex 74% remaining; Claude unavailable"',
    );
    expect(markup.match(/w-8/g)?.length).toBe(2);
    expect(markup.match(/bg-neutral-500\/20/g)?.length).toBe(2);
    expect(markup.match(/border-neutral-500\/25/g)?.length).toBe(2);
    expect(markup).toContain("74%");
    expect(markup).not.toContain("animate-");
  });

  it("keeps cached percentages visible but gray and labels them as cached", () => {
    const cachedRows = buildProviderRateLimitRows({
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      ],
      entries: [],
      cachedEntries: [codexSnapshot],
      now,
    });
    const markup = renderToStaticMarkup(
      <SidebarProviderRateLimitsView
        environmentLabel="Workstation"
        now={now}
        onBackdrop={false}
        rows={cachedRows}
      />,
    );

    expect(markup).toContain("74%");
    expect(markup).toContain('data-source="cache"');
    expect(markup).toContain('data-freshness="stale"');
    expect(markup).toContain("bg-muted-foreground/35");
    expect(markup).toContain("opacity-60");
    expect(markup).toContain("Codex 74% remaining, cached");
  });

  it("renders complete read-only details and API-key degradation copy", () => {
    const markup = renderToStaticMarkup(
      <ProviderRateLimitsDetails environmentLabel="Workstation" now={now} rows={rows} />,
    );

    expect(markup).toContain("Workstation");
    expect(markup).toContain("Primary");
    expect(markup).toContain("74% remaining");
    expect(markup).toContain("Last observed");
    expect(markup).toContain("Subscription limits unavailable for API-key billing");
  });
});
