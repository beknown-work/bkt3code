import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  normalizePlannotatorPreferenceCookie,
  plannotatorPreferenceFragment,
  PlannotatorFocusSurface,
  plannotatorStatusUrl,
  readPlannotatorDecision,
} from "./PlannotatorFocusSurface";

describe("PlannotatorFocusSurface", () => {
  it("renders a sidebar-adjacent focus surface with a persistent close action", () => {
    const markup = renderToStaticMarkup(
      <PlannotatorFocusSurface
        url="/plannotator/review_token/"
        onClose={vi.fn()}
        onDecision={vi.fn()}
        onTerminal={vi.fn()}
      />,
    );

    expect(markup).toContain("data-plannotator-focus-surface");
    expect(markup).toContain('src="/plannotator/review_token/?t3-reopen=1"');
    expect(markup).toContain('title="Plannotator plan review"');
    expect(markup).toContain('aria-label="Close plan review"');
    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).toContain("justify-start");
    expect(markup).not.toContain("justify-end");
    expect(markup).toContain('sandbox="allow-downloads allow-forms allow-modals allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
  });

  it("keeps the review iframe mounted while its thread is hidden", () => {
    const markup = renderToStaticMarkup(
      <PlannotatorFocusSurface
        url="/plannotator/review_token/"
        visible={false}
        onClose={vi.fn()}
        onDecision={vi.fn()}
        onTerminal={vi.fn()}
      />,
    );

    expect(markup).toContain('class="hidden"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('src="/plannotator/review_token/?t3-reopen=1"');
  });

  it("loads the review from the environment that owns it", () => {
    // The desktop renderer is served from `t3code://app` and proxies every
    // root-relative request to its bundled local backend, so a review on any
    // other environment has to be addressed absolutely or it 404s.
    const markup = renderToStaticMarkup(
      <PlannotatorFocusSurface
        url="https://t3.beknown.work/plannotator/review_token/"
        onClose={vi.fn()}
        onDecision={vi.fn()}
        onTerminal={vi.fn()}
      />,
    );

    expect(markup).toContain('src="https://t3.beknown.work/plannotator/review_token/?t3-reopen=1"');
    expect(plannotatorStatusUrl("https://t3.beknown.work/plannotator/review_token/")).toBe(
      "https://t3.beknown.work/plannotator/review_token/__t3/status",
    );
  });

  it("parses only terminal review decisions from the token-scoped status response", () => {
    expect(plannotatorStatusUrl("/plannotator/review_token/")).toBe(
      "/plannotator/review_token/__t3/status",
    );
    expect(readPlannotatorDecision({ decision: "approved" })).toBe("approved");
    expect(readPlannotatorDecision({ decision: "feedback" })).toBe("feedback");
    expect(readPlannotatorDecision({ decision: "denied" })).toBe("denied");
    expect(readPlannotatorDecision({ decision: null })).toBeNull();
    expect(readPlannotatorDecision({ decision: "running" })).toBeNull();
  });

  it("persists only normalized Plannotator preference cookies", () => {
    expect(
      normalizePlannotatorPreferenceCookie(
        "plannotator-auto-close=3; path=/; max-age=31536000; SameSite=Lax",
        true,
      ),
    ).toBe("plannotator-auto-close=3; path=/; max-age=31536000; SameSite=Lax; Secure");
    expect(
      normalizePlannotatorPreferenceCookie("plannotator-auto-close=; path=/; max-age=0", false),
    ).toBe("plannotator-auto-close=; path=/; max-age=0; SameSite=Lax");
    expect(normalizePlannotatorPreferenceCookie("t3-auth=secret", true)).toBeNull();
    expect(
      normalizePlannotatorPreferenceCookie("plannotator-theme=dark\r\nSet-Cookie: t3=x", true),
    ).toBeNull();
  });

  it("passes only Plannotator preferences to the opaque iframe fragment", () => {
    const fragment = plannotatorPreferenceFragment(
      "t3-auth=secret; plannotator-auto-close=5; plannotator-theme=dark",
    );
    expect(fragment).toMatch(/^#t3-preferences=/);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#t3-preferences=".length)))).toEqual({
      "plannotator-auto-close": "5",
      "plannotator-theme": "dark",
    });
    expect(fragment).not.toContain("secret");
    expect(plannotatorPreferenceFragment("t3-auth=secret")).toBe("");
  });
});
