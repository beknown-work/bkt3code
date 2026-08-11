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

| Area                       | Dedicated implementation                                                                                                                                                                                                                           | Upstream-facing seams                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Projects            | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`                                                                                                                                                                                            | `SettingsSidebarNav.tsx`, generated route tree                                                                                                          |
| Personal MCP identity      | `ExternalMcpSettingsSection*`, `UserMcpProfileStore.ts`, `McpUpstreamProxy.ts`, `personalMcp.ts`                                                                                                                                                   | provider adapters, RPC group, server route/layer wiring                                                                                                 |
| MCP operator/native tools  | `apps/server/src/mcp/toolkits/control/`                                                                                                                                                                                                            | MCP toolkit assembly and server route wiring                                                                                                            |
| MCP web UI parity          | `apps/server/src/mcp/toolkits/webUi/`                                                                                                                                                                                                              | one reusable authenticated-handler layer export in `ws.ts`; MCP toolkit assembly                                                                        |
| Plannotator runtime        | `apps/server/src/plannotator/`, `packages/shared/src/plannotator.ts`                                                                                                                                                                               | server service layers and proxy route                                                                                                                   |
| Native-plan detection      | `NativePlanBridge.ts`                                                                                                                                                                                                                              | orchestration plan lifecycle hooks                                                                                                                      |
| Focused review UI          | `PlannotatorFocusSurface*`                                                                                                                                                                                                                         | chat, plan card/sidebar, and right-panel store seams                                                                                                    |
| Lifecycle counters         | experimental sidebar counter components                                                                                                                                                                                                            | `SidebarChrome.tsx`                                                                                                                                     |
| Urgent pending input       | `PhaseGroupedSidebar.logic.ts`                                                                                                                                                                                                                     | `PhaseGroupedSidebar.tsx`                                                                                                                               |
| Lifecycle parking shelves  | `PhaseGroupedSidebar.logic.ts` (`partitionPhaseSidebarRows`), `PhaseGroupedSidebar.tsx`                                                                                                                                                            | `useThreadActions.ts`, `Sidebar.snooze.ts`, `Sidebar.logic.ts` (all read-only)                                                                          |
| Thread Linear tags         | `LinearIssueResolver.ts`, `LinearIssueTagDialog.tsx`, `linearIssue.ts`, migration 1004                                                                                                                                                             | orchestration/contracts projections, `ws.ts`, `PhaseGroupedSidebar.tsx`                                                                                 |
| Durable thread bootstrap   | `apps/server/src/thread-bootstrap/`, `ThreadBootstrapPanel*`, `ProjectCreationDefaultsCard.tsx`                                                                                                                                                    | orchestration/contracts projections, dispatcher, terminal manager, chat composer/settings seams                                                         |
| Notification alerts        | `apps/web/src/notifications/`, `NotificationsSettingsPanel.tsx`, `settings.notifications.tsx`                                                                                                                                                      | `__root.tsx` mount, `settingsSearch.ts` path/label, `SettingsSidebarNav.tsx` icon                                                                       |
| Session title maintenance  | `apps/server/src/thread-title/`, `ThreadTitleMaintenanceSettingsSection.tsx`                                                                                                                                                                       | `ProviderCommandReactor.ts` turn-start seam, experimental settings schema, Experiments panel                                                            |
| Row change-request badge   | `PhaseGroupedSidebar.logic.ts` (`resolvePhaseSidebarChangeRequestBadge`)                                                                                                                                                                           | `PhaseGroupedSidebar.tsx` row metadata lane, `threadSettled.ts` merge rule                                                                              |
| Sidebar people filters     | `PhaseGroupedSidebar.logic.ts` facets, `phaseSidebarFilterStore.ts`                                                                                                                                                                                | `PhaseGroupedSidebar.tsx` popover, chips, row projection                                                                                                |
| Execution resume resync    | none — two marked seams only                                                                                                                                                                                                                       | `ws.ts` shell/thread resume, `client-runtime/state/shellReducer.ts` overlay merge                                                                       |
| Native plan review         | `apps/server/src/planreview/`, `persistence/PlanReviewDocuments.ts`, migration 1009, `packages/shared/src/planReview.ts`, `packages/contracts/src/planReview.ts`, `apps/web/src/components/planreview/`, `apps/web/src/fork/planReviewSurface.tsx` | fork RPC group + scopes + handlers, one `ws.ts` dep, right-panel store/tabs, `ChatView.tsx` branch, `ProposedPlanCard.tsx` button, Beta settings toggle |
| Stalled execution watchdog | `apps/server/src/execution/StalledExecutionPolicy.ts`, `StalledExecutionWatchdog.ts`, coordinator dispatch deadline                                                                                                                                | `ProviderCommandReactor.ts` coordinator options, experimental settings schema, one metric                                                               |
| Experimental deployment    | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`                                                                                                                                                                                          | none                                                                                                                                                    |

Generated files such as `apps/web/src/routeTree.gen.ts` do not receive hand-written
markers; they are regenerated from marked route sources.

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

## Sidebar people filters

Two facets in the experimental sidebar's filter popover, both fork-owned logic
with the UI in `PhaseGroupedSidebar.tsx`:

- **Started by me** (`ownedByMe`) matches on `ownerUserId`. It replaced an
  "Assigned to me" facet that tested owner-or-tagged — which is exactly the
  server's visibility rule in `accessRules.ts`, so every thread the operator
  could see already satisfied it and the checkbox selected everything. If a
  future change makes that filter "assigned" again, it is a no-op again.
- **People on the session** (`participantUserIds`) matches threads that include
  _all_ selected people, not any: selecting two teammates asks for their shared
  sessions. The directory comes from `useOrgMembers`, and `reconcile` drops ids
  that leave it — but only when a directory set is supplied, so an empty list
  during load cannot wipe a live selection.

Both persist in the existing `t3code:phase-sidebar-filters:v1` blob; the
sanitizer defaults them off for blobs written before they existed, so the
storage version stays v1.

## Row change-request badge and settle-on-merge

The experimental sidebar row shows its PR next to the Linear tag:
`resolvePhaseSidebarChangeRequestBadge` in `PhaseGroupedSidebar.logic.ts` builds
it, `PhaseGroupedSidebar.tsx` renders it in the metadata lane.

- **The number is the whole label.** State is carried by colour alone — green
  open, violet merged, red closed — reusing the hues `prStatusIndicator` already
  applies in the thread header, so one PR never reads as two colours in one app.
- **Draft, mergeability, review, and checks stay in the tooltip** and the
  accessible name. They are modifiers on "open", not states; a hue each would
  make the densest lane in the app unreadable, and keeping them in the
  accessible name means state is never conveyed by colour alone.

The settle rule in `client-runtime/state/threadSettled.ts` is upstream-owned and
carries one fork edit: **a merge no longer auto-settles a thread.** Landing the
diff is usually where the follow-up starts — watch the deploy, close the ticket,
answer review fallout — so settling at merge time buried work the operator still
had in hand. A merge now only releases the open-PR block, leaving the ordinary
inactivity window in charge. Closing a change request unmerged still settles
immediately: nothing is shipping, so there is no follow-up to bury.

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

## Stalled executions: revive first, error only when spent

A session that is admitted and then produces nothing used to read as **running
forever**. Activity only moves inside a supervisor transition and every caller of
that transition is an event, so silence — the absence of events — could not move
it. Two shapes hit this: a turn whose provider never reached `session.started`,
and a turn that started and then went quiet with no `turn.completed` and no
`session.exited`. Reported crashes were already handled; silence was not.

Nothing here is a second retry loop. The durable coordinator already owns claims,
leases, the ten-step backoff table, and `recovery-exhausted`; the fix is to close
the two places where silence never reaches it.

- **A dispatch that never answers.** `DurableExecutionCoordinator` forks its
  lease-renewal fiber inside the dispatch scope, so a dispatch that neither fails
  nor returns renews its own claim forever and the work item never comes due
  again. Delivery now runs under `dispatchDeadlineMs`, and a timeout becomes an
  ordinary retryable `provider-dispatch-timeout` failure. The deadline starts
  **after `prepare`** — worktree bootstrap honestly takes minutes and must not
  spend it. Because `markProviderStarting` is persisted before the side effect,
  a turn that starts late is _adopted_ by the retry rather than sent twice.
- **An acknowledged turn that goes quiet.** `StalledExecutionWatchdog` sweeps the
  execution projection joined to its durable intent, and reports a judged stall
  through `coordinator.failObserved`, which spends one unit of the existing
  budget. `StalledExecutionPolicy` holds the decision, pure and unit-tested.

`onExhausted` closes the last gap: exhaustion used to set the intent phase and
raise the UI banner while `activity` stayed `active`, so the row still read as
running beside a banner saying it had failed. The execution is now failed with a
specific sentence ("No output from the agent for 94 minutes. Automatic recovery
gave up after 10 attempts.") **before** the provider is terminated — termination
emits `session.exited`, which on a live turn would overwrite that sentence with
the generic "Provider session exited."

Two rules are load-bearing and will look harmless to remove:

- **Silence is measured from `orchestration_events`, never from
  `provider_last_observed_at`.** That column only moves on provider _lifecycle_
  events, because `observeProviderEvent` ends in `default: return null`. A live
  Codex turn streaming output for two hours leaves it two hours stale; a
  watchdog keyed on it would kill healthy sessions.
- **`activity: "blocked"` can never reach a verdict.** It is the policy's first
  rule, before any liveness check. A session waiting for approval or input is
  quiet because it is correct.

Liveness gates the fast path and silence only arms the slow one, deliberately:
`runtimeAlive` is bookkeeping from the adapter's session map rather than an
operating-system probe, so a missing runtime is proof that nothing can produce
output (short grace), while a live runtime cannot distinguish a wedged CLI from a
long quiet tool call (90-minute backstop). Bounds live in
`experimental.stalledExecutionWatchdog`; there is no settings UI, so retune them
through `settings.json` or the settings API.

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
