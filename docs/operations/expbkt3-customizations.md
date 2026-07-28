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
or its annotations. Opening the iframe deliberately relaunches a completed or
stopped process and replays stored inline, deletion, and global annotations
through Plannotator's external-annotation API.

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

1. Fetch and merge `upstream/main` into the experimental branch before feature
   work.
2. Resolve upstream-owned files by preserving the smallest marked seam. Prefer
   adapting dedicated custom files over expanding edits inside upstream files.
3. Regenerate the route tree when routes change by running the focused web build.
4. Run focused tests and type checks for changed packages.
5. Run the isolated `test-t3-app` browser pass for visible web changes.
6. Deploy only the verified commit through the experimental workflow.

When upstream adds an equivalent feature, compare behavior at the marked seam
and retire the custom implementation rather than maintaining two paths.
