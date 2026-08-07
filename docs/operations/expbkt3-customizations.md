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
| Thread Linear tags                | Durable metadata plus a read-only status lookup. The sidebar that consumes it is itself flag-gated.         |
| Shell projection barrier          | Sync-correctness hardening. Disabling it reintroduces the drift it was written to fix.                      |
| Plannotator plan review           | Relied on daily and mounted unconditionally; documented here rather than retrofitted behind a flag.         |

Everything outside this table should follow the flag rule in `AGENTS.md`.

## Deliberately not extracted

Not every fork seam is worth moving to a fork-owned file. These were evaluated
and left in place on purpose — re-deriving the decision costs more than reading
it:

- **`server.ts` fork layers.** Extracting the fork layer graph behind a factory
  saves roughly 80 lines, but the factory needs one generic parameter per
  upstream layer (plus Effect diagnostic suppressions) to keep the service types
  flowing. That makes the file that composes the whole server runtime harder to
  read, and mis-ordering `provide` vs `provideMerge` fails only on a real boot.
  `server.ts` is already among the best-marked files in the fork and its
  conflicts are mechanical, so the seams stay inline and marked.
- **`ProjectionSnapshotQuery.ts` column threading**, **`ProviderService.ts`
  parameter threading**, contract struct field additions, and web component JSX
  mounts. There is no hook shape that removes these; marker discipline is the
  only available lever.
- **`ws.ts` `stopExecution` / `replayEvents` handlers.** They reach into
  ws.ts-local replay machinery (`clamp`, `projectActivityEvent`,
  `enrichOrchestrationEvents`); injecting all of it costs more seam than the
  extraction saves.

Semantic divergence is the expensive kind of fork change — where we _replaced_
an upstream algorithm rather than adding to it. Those merge cleanly and then
break at runtime, so they deserve the loudest markers: the `dispatch`
acknowledgement-timeout rewrite in `client-runtime/operations/commands.ts`, the
turn-settlement rewrite in `state/threadReducer.ts`, the restart predicate in
`ProviderCommandReactor.ts`, and session teardown in `CodexAdapter.ts`.

## Feature ownership

| Area                      | Dedicated implementation                                                                                        | Upstream-facing seams                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Active Projects           | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`                                                         | `SettingsSidebarNav.tsx`, generated route tree                                                  |
| Personal MCP identity     | `ExternalMcpSettingsSection*`, `UserMcpProfileStore.ts`, `McpUpstreamProxy.ts`, `personalMcp.ts`                | provider adapters, RPC group, server route/layer wiring                                         |
| MCP operator/native tools | `apps/server/src/mcp/toolkits/control/`                                                                         | MCP toolkit assembly and server route wiring                                                    |
| MCP web UI parity         | `apps/server/src/mcp/toolkits/webUi/`                                                                           | one reusable authenticated-handler layer export in `ws.ts`; MCP toolkit assembly                |
| Plannotator runtime       | `apps/server/src/plannotator/`, `packages/shared/src/plannotator.ts`                                            | server service layers and proxy route                                                           |
| Native-plan detection     | `NativePlanBridge.ts`                                                                                           | orchestration plan lifecycle hooks                                                              |
| Focused review UI         | `PlannotatorFocusSurface*`                                                                                      | chat, plan card/sidebar, and right-panel store seams                                            |
| Lifecycle counters        | experimental sidebar counter components                                                                         | `SidebarChrome.tsx`                                                                             |
| Urgent pending input      | `PhaseGroupedSidebar.logic.ts`                                                                                  | `PhaseGroupedSidebar.tsx`                                                                       |
| Lifecycle parking shelves | `PhaseGroupedSidebar.logic.ts` (`partitionPhaseSidebarRows`), `PhaseGroupedSidebar.tsx`                         | `useThreadActions.ts`, `Sidebar.snooze.ts`, `Sidebar.logic.ts` (all read-only)                  |
| Thread Linear tags        | `LinearIssueResolver.ts`, `LinearIssueTagDialog.tsx`, `linearIssue.ts`, migration 1004                          | orchestration/contracts projections, `ws.ts`, `PhaseGroupedSidebar.tsx`                         |
| T3 Conductor              | `T3ConductorCard*`, `T3Conductor.logic*`, `T3ConductorLinearIssueControl.tsx`, `T3ConductorSettingsSection.tsx` | experimental settings schema, `PhaseGroupedSidebar.tsx`, and one `ChatHeader.tsx` mount         |
| Durable thread bootstrap  | `apps/server/src/thread-bootstrap/`, `ThreadBootstrapPanel*`, `ProjectCreationDefaultsCard.tsx`                 | orchestration/contracts projections, dispatcher, terminal manager, chat composer/settings seams |
| Notification alerts       | `apps/web/src/notifications/`, `NotificationsSettingsPanel.tsx`, `settings.notifications.tsx`                   | `__root.tsx` mount, `settingsSearch.ts` path/label, `SettingsSidebarNav.tsx` icon               |
| Session title maintenance | `apps/server/src/thread-title/`, `ThreadTitleMaintenanceSettingsSection.tsx`                                    | `ProviderCommandReactor.ts` turn-start seam, experimental settings schema, Experiments panel    |
| Execution resume resync   | none — two marked seams only                                                                                    | `ws.ts` shell/thread resume, `client-runtime/state/shellReducer.ts` overlay merge               |
| Experimental deployment   | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`                                                       | none                                                                                            |

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

Process lifetime follows an in-memory browser lease registry rather than thread
state. Every mounted focus surface has an unpersisted UUID lease: visible
surfaces renew through the 500 ms status cadence, retained-hidden surfaces renew
every 30 seconds, and legacy clients share one compatible lease. Multiple
browsers may own one review; releasing one UUID does not affect the others.
Releasing the final UUID makes the process immediately suspendible, while a
crashed browser expires after two minutes and is collected by the 30-second
reaper. Launch and reopen receive the same two-minute acquisition window so a
process whose iframe never mounts cannot remain indefinitely.

Suspension writes `exited` and clears live port fields before stopping the
manager-captured child. It preserves the manifest, plan, log, cumulative
annotations, and Plannotator recovery draft. The right-panel persistence
transform excludes Plannotator descriptors (storage version 9), but runtime
hidden surfaces remain mounted; a full browser restart therefore requires an
intentional **Review →** reopen instead of resurrecting ghost ownership from
localStorage. Terminal `exited` and `error` responses stop the single recursive
poll loop and remove only the stale panel surface.

## Notification alerts

Alert tones and native notifications live entirely in the browser, in
`apps/web/src/notifications/`. Nothing about them reaches the server, the
contracts package, or the relay.

That is a deliberate boundary rather than an omission. The signal the pile-up
threshold counts is `hasUnseenCompletion`, which compares a turn's `completedAt`
against `threadLastVisitedAtById` — localStorage state the server cannot see. A
server-side preference would therefore describe a number the server cannot
compute. Preferences, uploaded tones, and the alert baseline are all per-browser
for the same reason.

Structure:

| File                          | Responsibility                                                              |
| ----------------------------- | --------------------------------------------------------------------------- |
| `notificationEvents.logic.ts` | Every alert decision, pure and DOM-free. The only file worth unit-testing.  |
| `notificationTones.ts`        | Built-in tones as oscillator specs — no binary assets enter the repository. |
| `notificationSound.ts`        | Web Audio playback and the autoplay unlock.                                 |
| `customToneStorage.ts`        | IndexedDB CRUD for uploaded tones.                                          |
| `browserNotifications.ts`     | Notification API wrapper: permission, delivery, click-to-open.              |
| `alertDedupe.ts`              | Cross-tab claim so three open tabs play one tone.                           |
| `NotificationRunner.tsx`      | Wiring only. Mounted once from `__root.tsx`.                                |

Four runtime constraints are load-bearing; a future edit that drops one will
look harmless and behave badly:

- **Alerts fire on transitions, never on state.** A client with no baseline
  (first render, reconnect) adopts the snapshot silently. A thread appearing
  already in a waiting state counts as pre-existing — reconnects repopulate the
  projection thread by thread, so the alternative turns every reconnect into an
  alarm.
- **Audio needs a user gesture.** The AudioContext is created lazily and resumed
  from the settings panel's Test button; the panel tells the user when audio is
  still locked instead of failing silently.
- **Native notifications only when the tab is hidden.** The visible tab already
  shows the row highlight and badge.
- **The pile-up alert is edge-triggered.** It fires on crossing the threshold and
  re-arms only after the count drops back below it.

Upstream-facing seams are three marked one-line additions — the `__root.tsx`
mount, the `settingsSearch.ts` path plus label, and the `SettingsSidebarNav.tsx`
icon — inside blocks the fork already owns. The whole feature is gated on
`EXPERIMENTAL_CONTROL_CENTER_ENABLED`, so `bkmain` can carry the code with the
runner unmounted.

Escalation to Mattermost deliberately does **not** live here. It belongs to
`t3-linear-bridge`, which already polls `/api/orchestration/shell` for every
thread and owns Mattermost delivery, mention resolution, and idempotency keys.

## Execution state is live-only — keep the resume seams

Execution (`activity`, `turn.state`, the durable intent overlay) is published by
`ThreadExecutionSupervisor` over PubSub. It is **never written to the event log**,
so no replay can carry it. Only `withShellExecutions` / `withThreadExecution` —
the full-snapshot paths — attach it.

That is fine upstream, because `applyShellStreamEvent` replaces the thread
wholesale on every projection upsert: a stale overlay survives at most until the
next title or message update, then falls back to "Checking". The fork changed
that (`fix: preserve optional shell execution`) so a routine upsert stops wiping
the fresher overlay — which turned a one-second flicker into a permanent lie.
A client that missed the terminal frame (server restart, network blip, resumed
tab) rendered **Running forever**, in the sidebar and the chat, while the server
had long recorded `activity: idle` and `turn_state: completed`.

Two seams close it, and both must survive a merge together:

- `ws.ts`, both resume paths (`subscribeShell` and `subscribeThread` with
  `afterSequence`): after the event catch-up, emit the supervisor's current
  execution frames. Reads in-memory supervisor state and reuses the live
  visibility filter, so a resume converges exactly like a fresh snapshot.
- `client-runtime/state/shellReducer.ts` `mergeUpsertedThread`: preserve the
  overlay across upserts **except** when the upsert's own `latestTurn` reports
  the overlay's turn as finished. The upsert carries the contradiction, so the
  client can drop a provably stale overlay without waiting for a frame.

If a future merge reverts either one, the symptom is a session that has clearly
finished still showing Running. Check `projection_thread_executions` first: when
the row says `idle`/`completed` and the UI disagrees, it is this.

## Session title maintenance

Upstream titles a thread once, on its first user turn, from the first prompt
(`maybeGenerateThreadTitleForFirstTurn`). The fork adds a cadence: every N user
prompts, `ProviderCommandReactor`'s turn-start path dispatches an ordinary
`thread.meta.update` with `regenerateTitle: true`, so the refresh reuses the
durable regeneration flow — request ids, supersede checks, and
interrupted-run recovery — rather than renaming behind its back.

`experimental.threadTitleMaintenance` holds `enabled` (default on) and
`refreshEveryUserPrompts` (default 3, 0 disables). The decision itself is a pure
function in `apps/server/src/thread-title/titleRefreshCadence.ts`, so the reactor
seam stays one marked block.

Known trade-off: a refresh replaces a title you set by hand, because nothing
distinguishes a user-authored title from a generated one. The setting's own copy
says so, and turning the cadence off is the escape hatch.

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
