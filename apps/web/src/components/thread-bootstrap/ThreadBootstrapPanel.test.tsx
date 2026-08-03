import { EnvironmentId, type ThreadBootstrapProgress } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ThreadBootstrapPanel } from "./ThreadBootstrapPanel";

const NOW = "2026-08-03T00:00:00.000Z";

function progress(overrides: Partial<ThreadBootstrapProgress> = {}): ThreadBootstrapProgress {
  const pending = {
    status: "pending" as const,
    attempt: 0,
    terminalId: null,
    exitCode: null,
    error: null,
    worktreePath: null,
  };
  return {
    id: "bootstrap-1",
    status: "running",
    worktree: pending,
    setup: pending,
    agent: pending,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const callbacks = {
  agentHasStarted: false,
  onShowOutput: vi.fn(),
  onRetry: vi.fn(),
  onStop: vi.fn(),
  onContinue: vi.fn(),
};

describe("ThreadBootstrapPanel", () => {
  it("shows running setup without loading terminal output", () => {
    const markup = renderToStaticMarkup(
      <ThreadBootstrapPanel
        bootstrap={progress({
          worktree: {
            status: "succeeded",
            attempt: 1,
            terminalId: null,
            exitCode: null,
            error: null,
            worktreePath: "/repo/worktrees/feature",
          },
          setup: {
            status: "running",
            attempt: 1,
            terminalId: "setup-bootstrap-1-1",
            exitCode: null,
            error: null,
            worktreePath: "/repo/worktrees/feature",
          },
        })}
        {...callbacks}
      />,
    );

    expect(markup).toContain("Worktree created");
    expect(markup).toContain("Running setup script…");
    expect(markup).toContain("Show output");
    expect(markup).toContain("Interactive prompts can be answered in the terminal");
    expect(markup).toContain("Stop setup");
    expect(markup).not.toContain("animate-");
  });

  it("offers retry and bypass only for setup failures", () => {
    const markup = renderToStaticMarkup(
      <ThreadBootstrapPanel
        bootstrap={progress({
          status: "failed",
          worktree: {
            status: "succeeded",
            attempt: 1,
            terminalId: null,
            exitCode: null,
            error: null,
            worktreePath: "/repo/worktrees/feature",
          },
          setup: {
            status: "failed",
            attempt: 1,
            terminalId: "setup-bootstrap-1-1",
            exitCode: 1,
            error: "failed",
            worktreePath: "/repo/worktrees/feature",
          },
        })}
        {...callbacks}
      />,
    );

    expect(markup).toContain("Setup script failed");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Continue anyway");
    expect(markup).not.toContain("Change base ref");
  });

  it("offers an exact base-ref replacement without allowing a worktree bypass", () => {
    const markup = renderToStaticMarkup(
      <ThreadBootstrapPanel
        bootstrap={progress({
          status: "failed",
          worktree: {
            status: "failed",
            attempt: 1,
            terminalId: null,
            exitCode: null,
            error: "origin/release is unavailable",
            worktreePath: null,
          },
        })}
        baseRefTarget={{
          environmentId: EnvironmentId.make("environment-1"),
          workspaceRoot: "/repo/project",
          initialValue: { kind: "repository-default", source: "origin" },
        }}
        {...callbacks}
      />,
    );

    expect(markup).toContain("Worktree creation failed");
    expect(markup).toContain("Change base ref");
    expect(markup).not.toContain("Continue anyway");
  });

  it("disappears after the agent starts", () => {
    const succeeded = {
      status: "succeeded" as const,
      attempt: 1,
      terminalId: null,
      exitCode: 0,
      error: null,
      worktreePath: "/repo/worktrees/feature",
    };
    const markup = renderToStaticMarkup(
      <ThreadBootstrapPanel
        bootstrap={progress({
          status: "ready",
          worktree: succeeded,
          setup: { ...succeeded, terminalId: "setup-bootstrap-1-1" },
          agent: { ...succeeded, worktreePath: null },
        })}
        {...callbacks}
      />,
    );

    expect(markup).toBe("");
  });

  it("disappears when the turn proves startup even if progress events were missed", () => {
    const markup = renderToStaticMarkup(
      <ThreadBootstrapPanel bootstrap={progress()} {...callbacks} agentHasStarted />,
    );

    expect(markup).toBe("");
  });
});
