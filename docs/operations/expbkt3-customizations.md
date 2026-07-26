# expbkt3 customization boundaries

The `expbkt3` deployment extends upstream T3 Code with an experimental operations
layer: lifecycle counters, external MCP control, native-plan Plannotator review,
and Active Projects administration.

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

| Area                      | Dedicated implementation                                             | Upstream-facing seams                                |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| Active Projects           | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`              | `SettingsSidebarNav.tsx`, generated route tree       |
| External MCP settings     | `ExternalMcpSettingsSection*`                                        | `ExperimentsSettingsPanel.tsx`                       |
| MCP operator/native tools | `apps/server/src/mcp/toolkits/control/`                              | MCP toolkit assembly and server route wiring         |
| Plannotator runtime       | `apps/server/src/plannotator/`, `packages/shared/src/plannotator.ts` | server service layers and proxy route                |
| Native-plan detection     | `NativePlanBridge.ts`                                                | orchestration plan lifecycle hooks                   |
| Focused review UI         | `PlannotatorFocusSurface*`                                           | chat, plan card/sidebar, and right-panel store seams |
| Lifecycle counters        | experimental sidebar counter components                              | `SidebarChrome.tsx`                                  |
| Urgent pending input      | `PhaseGroupedSidebar.logic.ts`                                       | `PhaseGroupedSidebar.tsx`                            |
| Experimental deployment   | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`            | none                                                 |

Generated files such as `apps/web/src/routeTree.gen.ts` do not receive hand-written
markers; they are regenerated from marked route sources.

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
