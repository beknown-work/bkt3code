import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders Retry and Dismiss actions for exhausted recovery", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Automatic recovery was exhausted."
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain(">Retry<");
    expect(markup).toContain(">Dismiss<");
  });
});
