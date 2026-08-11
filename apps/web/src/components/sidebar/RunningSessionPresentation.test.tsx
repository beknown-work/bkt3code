import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RunningSessionDivider } from "./RunningSessionDivider";
import { RunningSessionGlint } from "./RunningSessionGlint";
import { deriveChatThreadExecutionPresentation } from "./RunningSessionPresentation.logic";

describe("running session presentation", () => {
  it("renders the motion layer as decorative content", () => {
    const markup = renderToStaticMarkup(<RunningSessionGlint />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('class="phase-running-session-glint"');
  });

  it("renders an accessible, quietly labelled section boundary", () => {
    const markup = renderToStaticMarkup(<RunningSessionDivider />);

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Monitoring agent work"');
    expect(markup).toContain("Monitoring");
    expect(markup).not.toContain(">Running<");
  });

  it("stops the chat indicator when the live sidebar execution is idle", () => {
    expect(
      deriveChatThreadExecutionPresentation({
        hasPendingOutboxItem: false,
        isServerThread: true,
        threadExecution: {
          activity: "active",
          intent: {
            desiredState: "running",
            phase: "running",
            recovery: { userActionRequired: false },
          },
        },
        shellExecution: { activity: "idle" },
      }),
    ).toEqual({ active: false, label: null, needsAttention: false });
  });
});
