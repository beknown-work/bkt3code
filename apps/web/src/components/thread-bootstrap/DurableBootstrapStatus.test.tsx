import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DurableBootstrapStatus } from "./DurableBootstrapStatus";

const bootstrap = {
  workspaceMode: "new-worktree" as const,
  base: "origin/main",
  intendedPath: "/tmp/worktree",
  newBranch: "feature/work",
  worktreePhase: "running" as const,
  setupPhase: "pending" as const,
  failureDetail: null,
  setupTerminalId: null,
};

describe("DurableBootstrapStatus", () => {
  it("keeps durable worktree preparation visible without a legacy bootstrap projection", () => {
    const markup = renderToStaticMarkup(<DurableBootstrapStatus bootstrap={bootstrap} />);
    expect(markup).toContain("New worktree");
    expect(markup).toContain("being prepared");
  });

  it("surfaces the retained operation failure", () => {
    const markup = renderToStaticMarkup(
      <DurableBootstrapStatus
        bootstrap={{
          ...bootstrap,
          worktreePhase: "failed",
          failureDetail: "git worktree add failed",
        }}
      />,
    );
    expect(markup).toContain("git worktree add failed");
  });

  it("does not present uncertain preparation as a running setup", () => {
    const markup = renderToStaticMarkup(
      <DurableBootstrapStatus
        bootstrap={{ ...bootstrap, worktreePhase: "uncertain", setupPhase: "pending" }}
      />,
    );
    expect(markup).toContain("preparation status is uncertain");
  });

  it("keeps an uncertain setup visible after the worktree is acknowledged", () => {
    const markup = renderToStaticMarkup(
      <DurableBootstrapStatus
        bootstrap={{ ...bootstrap, worktreePhase: "acknowledged", setupPhase: "uncertain" }}
      />,
    );
    expect(markup).toContain("setup status is uncertain");
  });
});
