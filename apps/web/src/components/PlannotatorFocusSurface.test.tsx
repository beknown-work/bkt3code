import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PlannotatorFocusSurface } from "./PlannotatorFocusSurface";

describe("PlannotatorFocusSurface", () => {
  it("renders a sidebar-adjacent focus surface with a persistent close action", () => {
    const markup = renderToStaticMarkup(
      <PlannotatorFocusSurface url="/plannotator/review_token/" onClose={vi.fn()} />,
    );

    expect(markup).toContain("data-plannotator-focus-surface");
    expect(markup).toContain('src="/plannotator/review_token/"');
    expect(markup).toContain('title="Plannotator plan review"');
    expect(markup).toContain('aria-label="Close plan review"');
    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).toContain('sandbox="allow-downloads allow-forms allow-modals allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
  });
});
