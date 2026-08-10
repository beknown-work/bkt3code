import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorktreeCodename } from "@t3tools/shared/worktreeCodename";

import { ThreadWorktreeIndicator } from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("leads the accessible label with the worktree codename", () => {
    const worktreePath = "/tmp/worktrees/sidebar-indicator";
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath,
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      `aria-label="Worktree ${resolveWorktreeCodename(worktreePath)} (feature/sidebar-indicator) · sidebar-indicator"`,
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it("keeps the codename when the thread has no branch", () => {
    const worktreePath = "/tmp/worktrees/t3code-2d633e64";
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: null,
          worktreePath,
        }}
      />,
    );

    expect(markup).toContain(
      `aria-label="Worktree ${resolveWorktreeCodename(worktreePath)} · t3code-2d633e64"`,
    );
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
