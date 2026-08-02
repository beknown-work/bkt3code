# expbkt3 customization boundaries

The `expbkt3` deployment extends upstream T3 Code with an experimental operations
layer: lifecycle counters, external MCP control, native-plan Plannotator review,
Active Projects administration, and the permanent T3 Conductor.

These changes are structured to keep upstream merges predictable:

- Dedicated implementations carry a file-level `T3-CUSTOM(expbkt3)` comment.
- Small edits inside upstream-owned files are wrapped in
  `T3-CUSTOM(expbkt3): BEGIN` / `T3-CUSTOM(expbkt3): END` comments.
- Web entry points are gated by `VITE_T3_EXPERIMENTAL_CONTROL_CENTER` through
  `apps/web/src/experimentalFeatures.ts`.
- Cross-package Plannotator URL/marker behavior lives in the explicit
  `@t3tools/shared/plannotator` subpath instead of an upstream barrel.

Find every marked boundary with:

```bash
rg 'T3-CUSTOM\\(expbkt3\\)'
```

Marker discipline is enforced in CI by `scripts/check-fork-markers.ts`
(`.github/workflows/fork-markers.yml`). It diffs the branch against
`origin/main` — the byte-pure upstream mirror — and fails when a hunk in an
upstream-owned file sits outside a marker. Files the fork _added_ are
fork-owned and skipped; ownership is decided by git status, never by sniffing
file contents, because upstream-owned files routinely carry a marked fork import
near the top.

`scripts/fork-marker-baseline.json` grandfathers the files that were already
non-compliant when the check landed. It is a ratchet: a new violation in a file
outside the baseline fails, and a baselined file that becomes fully compliant
also fails, with an instruction to drop it from the list. Regenerate with
`node scripts/check-fork-markers.ts --write-baseline` (add `--force` only when
deliberately adopting new violations).

## Core exceptions — permanently fork-owned, not flag-gated

Most fork features sit behind a flag so upstream's code path stays intact and a
post-merge regression can be isolated by switching ours off. The subsystems
below are deliberate exceptions: they are load-bearing infrastructure whose
"off" path would be a second, untested execution mode — flag-gating them would
_increase_ merge and correctness risk rather than reduce it. Treat them as
permanent fork surface and keep them marked instead.

| Subsystem                         | Why it is not flag-gated                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| User management / Clerk team mode | The reason the fork exists. Already conditioned on `T3CODE_CLERK_SECRET_KEY` being configured.              |
| Ownership + access control        | A disabled access-control path is a data-exposure bug, not a fallback. Part of user management in practice. |
| ThreadExecutionSupervisor         | Turn admission and execution revisions are in the dispatch path; a bypass mode would be a second scheduler. |
| Session recovery                  | Reconnect-after-restart has no meaningful "off" state — off is just the pre-existing stuck-session bug.     |
| Thread priority                   | A projection column plus ordering. Nothing to disable; the sidebar that consumes it is itself flag-gated.   |
| Shell projection barrier          | Sync-correctness hardening. Disabling it reintroduces the drift it was written to fix.                      |
| Plannotator plan review           | Relied on daily and mounted unconditionally; documented here rather than retrofitted behind a flag.         |

Everything outside this table should follow the flag rule in `AGENTS.md`.

## Feature ownership

| Area                      | Dedicated implementation                                                                                        | Upstream-facing seams                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Active Projects           | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`                                                         | `SettingsSidebarNav.tsx`, generated route tree                                          |
| Personal MCP identity     | `ExternalMcpSettingsSection*`, `UserMcpProfileStore.ts`, `McpUpstreamProxy.ts`, `personalMcp.ts`                | provider adapters, RPC group, server route/layer wiring                                 |
| MCP operator/native tools | `apps/server/src/mcp/toolkits/control/`                                                                         | MCP toolkit assembly and server route wiring                                            |
| Plannotator runtime       | `apps/server/src/plannotator/`, `packages/shared/src/plannotator.ts`                                            | server service layers and proxy route                                                   |
| Native-plan detection     | `NativePlanBridge.ts`                                                                                           | orchestration plan lifecycle hooks                                                      |
| Focused review UI         | `PlannotatorFocusSurface*`                                                                                      | chat, plan card/sidebar, and right-panel store seams                                    |
| Lifecycle counters        | experimental sidebar counter components                                                                         | `SidebarChrome.tsx`                                                                     |
| Urgent pending input      | `PhaseGroupedSidebar.logic.ts`                                                                                  | `PhaseGroupedSidebar.tsx`                                                               |
| Lifecycle parking shelves | `PhaseGroupedSidebar.logic.ts` (`partitionPhaseSidebarRows`), `PhaseGroupedSidebar.tsx`                         | `useThreadActions.ts`, `Sidebar.snooze.ts`, `Sidebar.logic.ts` (all read-only)          |
| T3 Conductor              | `T3ConductorCard*`, `T3Conductor.logic*`, `T3ConductorLinearIssueControl.tsx`, `T3ConductorSettingsSection.tsx` | experimental settings schema, `PhaseGroupedSidebar.tsx`, and one `ChatHeader.tsx` mount |
| Experimental deployment   | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`                                                       | none                                                                                    |

Generated files such as `apps/web/src/routeTree.gen.ts` do not receive hand-written
markers; they are regenerated from marked route sources.

## T3 Conductor lifecycle

T3 Conductor is one durable primary-environment thread per authenticated user.
Its settings and thread ID live in that user's `user_mcp_profiles` row; the old
server-wide `experimental.t3Conductor` object remains only as a migration/default
compatibility seam. When enabled, its fixed sidebar controller:

- provisions the configured workspace as a normal T3 project when needed;
- initializes the agent with its permanent coordination identity and native T3
  MCP mission;
- reserves one deterministic installation/workspace identity before provisioning,
  so delayed projections and concurrent browser tabs cannot create duplicates;
- keeps provider/model traits, runtime access, and interaction mode synchronized
  with Experimental settings;
- removes the thread from ordinary lifecycle groups and archive affordances;
- restores an archived thread, resumes a stopped session, and recreates a
  deleted thread;
- retires the previous runtime before moving to a different home workspace.

Disabling the feature hides its command-deck card and stops the live provider
session while preserving the durable conversation for the next enable.

An optional dedicated Linear coordination ticket is stored as the canonical URL
in the personal Conductor profile. The Experimental settings field
accepts either `TEAM-123` or a complete `linear.app` issue URL. While the
Conductor thread is open, its isolated top-bar control can link, update, open,
or remove that ticket; ordinary session headers are unchanged.

## Durable Plannotator reviews

A native T3 plan and its later plan-mode revisions share one Plannotator review
identity. `PlannotatorManager` keeps the token, manifest, and captured annotation
history stable, while `NativePlanBridge` associates the next revised native plan
ID with that lineage. Complete HTML documents and balanced top-level HTML plan
fragments use a private `.html` plan path; everything else uses `.md`. A revision
may migrate that path between extensions without replacing the review identity
or its annotations. HTML launch arguments include Plannotator's
`--render-html`; without it Plannotator converts `.html` input back to Markdown.
Opening the iframe deliberately relaunches a completed or stopped process and
replays stored inline, deletion, and global annotations through Plannotator's
external-annotation API.

Archived sessions are excluded from automatic startup reconciliation, but an
explicit review open falls back to the archived thread/project shell. This lets
the same durable review be revisited without unarchiving the T3 session.

Only a submitted review round is added to `annotationHistory`; unsubmitted
Plannotator drafts retain their normal crash-recovery behavior. Review history
is de-duplicated by annotation content because Plannotator assigns new internal
IDs when saved annotations are replayed. Keep lifecycle changes inside
`apps/server/src/plannotator/` and the existing focused-surface seam so upstream
plan rendering remains isolated.

## Upstream merge workflow

1. Fetch and merge `upstream/main` into `expbkmain` — the long-lived staging
   branch — before feature work. Never test an upstream merge directly on
   `bkmain`; see [Beknown deployments](./deployments.md).
2. Resolve upstream-owned files by preserving the smallest marked seam. Prefer
   adapting dedicated custom files over expanding edits inside upstream files.
3. Regenerate the route tree when routes change by running the focused web build.
4. Run focused tests and type checks for changed packages.
5. Run the isolated `test-t3-app` browser pass for visible web changes.
6. Deploy only the verified commit through the experimental workflow, then
   promote it to `bkmain` through a pull request and reset `expbkmain` from
   `bkmain`.

When upstream adds an equivalent feature, compare behavior at the marked seam
and retire the custom implementation rather than maintaining two paths.
