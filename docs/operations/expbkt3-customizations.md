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

| Area                      | Dedicated implementation                                                                                                                                                                                                                           | Upstream-facing seams                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Projects           | `ActiveProjectsSettingsPanel*`, `settings.projects.tsx`                                                                                                                                                                                            | `SettingsSidebarNav.tsx`, generated route tree                                                                                                                                                                                                                                                                                            |
| Personal MCP identity     | `ExternalMcpSettingsSection*`, `UserMcpProfileStore.ts`, `McpUpstreamProxy.ts`, `personalMcp.ts`                                                                                                                                                   | provider adapters, RPC group, server route/layer wiring                                                                                                                                                                                                                                                                                   |
| MCP operator/native tools | `apps/server/src/mcp/toolkits/control/`                                                                                                                                                                                                            | MCP toolkit assembly and server route wiring                                                                                                                                                                                                                                                                                              |
| MCP web UI parity         | `apps/server/src/mcp/toolkits/webUi/`                                                                                                                                                                                                              | one reusable authenticated-handler layer export in `ws.ts`; MCP toolkit assembly                                                                                                                                                                                                                                                          |
| Plannotator runtime       | `apps/server/src/plannotator/`, `packages/shared/src/plannotator.ts`                                                                                                                                                                               | server service layers and proxy route                                                                                                                                                                                                                                                                                                     |
| Native-plan detection     | `NativePlanBridge.ts`                                                                                                                                                                                                                              | orchestration plan lifecycle hooks                                                                                                                                                                                                                                                                                                        |
| Focused review UI         | `PlannotatorFocusSurface*`                                                                                                                                                                                                                         | chat, plan card/sidebar, and right-panel store seams                                                                                                                                                                                                                                                                                      |
| Lifecycle counters        | experimental sidebar counter components                                                                                                                                                                                                            | `SidebarChrome.tsx`                                                                                                                                                                                                                                                                                                                       |
| Urgent pending input      | `PhaseGroupedSidebar.logic.ts`                                                                                                                                                                                                                     | `PhaseGroupedSidebar.tsx`                                                                                                                                                                                                                                                                                                                 |
| Lifecycle parking shelves | `PhaseGroupedSidebar.logic.ts` (`partitionPhaseSidebarRows`), `PhaseGroupedSidebar.tsx`                                                                                                                                                            | `useThreadActions.ts`, `Sidebar.snooze.ts`, `Sidebar.logic.ts` (all read-only)                                                                                                                                                                                                                                                            |
| Thread Linear tags        | `LinearIssueResolver.ts`, `LinearIssueTagDialog.tsx`, `linearIssue.ts`, migration 1004                                                                                                                                                             | orchestration/contracts projections, `ws.ts`, `PhaseGroupedSidebar.tsx`                                                                                                                                                                                                                                                                   |
| Durable thread bootstrap  | `apps/server/src/thread-bootstrap/`, `ThreadBootstrapPanel*`, `ProjectCreationDefaultsCard.tsx`                                                                                                                                                    | orchestration/contracts projections, dispatcher, terminal manager, chat composer/settings seams                                                                                                                                                                                                                                           |
| Notification alerts       | `apps/web/src/notifications/`, `NotificationsSettingsPanel.tsx`, `settings.notifications.tsx`                                                                                                                                                      | `__root.tsx` mount, `settingsSearch.ts` path/label, `SettingsSidebarNav.tsx` icon                                                                                                                                                                                                                                                         |
| Session title maintenance | `apps/server/src/thread-title/`, `ThreadTitleMaintenanceSettingsSection.tsx`, migration 1013, `decider.titleOwnership.test.ts`                                                                                                                     | `ProviderCommandReactor.ts` turn-start seam, experimental settings schema, Experiments panel, `titleOrigin`/`titleManuallySet` on the meta-update contract, decider/projector/projection columns, MCP create+update handlers, the three sidebars' rename call sites                                                                       |
| Row change-request badge  | `PhaseGroupedSidebar.logic.ts` (`resolvePhaseSidebarChangeRequestBadge`)                                                                                                                                                                           | `PhaseGroupedSidebar.tsx` row metadata lane, `threadSettled.ts` merge rule                                                                                                                                                                                                                                                                |
| Sidebar people filters    | `PhaseGroupedSidebar.logic.ts` facets, `phaseSidebarFilterStore.ts`                                                                                                                                                                                | `PhaseGroupedSidebar.tsx` popover, chips, row projection                                                                                                                                                                                                                                                                                  |
| Execution resume resync   | none — two marked seams only                                                                                                                                                                                                                       | `ws.ts` shell/thread resume, `client-runtime/state/shellReducer.ts` overlay merge                                                                                                                                                                                                                                                         |
| Native plan review        | `apps/server/src/planreview/`, `persistence/PlanReviewDocuments.ts`, migration 1009, `packages/shared/src/planReview.ts`, `packages/contracts/src/planReview.ts`, `apps/web/src/components/planreview/`, `apps/web/src/fork/planReviewSurface.tsx` | fork RPC group + scopes + handlers, one `ws.ts` dep, right-panel store/tabs, `ChatView.tsx` branch, `ProposedPlanCard.tsx` button, Beta settings toggle, nullable comment range in `reviewCommentContext.ts` + `reviewCommentSelection.ts` + `nativeReviewDiffAdapter.ts`, plan-comment card in `MessagesTimeline.tsx` + `ThreadFeed.tsx` |
| Session identity          | `apps/server/src/identity/SessionIdentityEnvironment.ts`, `apps/server/src/provider/claudeSessionIdentity.expbkt3.ts`                                                                                                                              | `ProviderCommandReactor.ts` execution-options seam, `ProviderService.ts` adapter-spawn seam, `identityEnvironment` on `ProviderSessionExecutionOptions`, conditional scrub in `SourceControlExecutionEnvironment.ts`, `server.ts` layer, `ClaudeAdapter.ts` system-prompt append + `UserPromptSubmit` hook seams                          |
| Agent views in chat       | `apps/server/src/agentui/`, `persistence/AgentUiRenders.ts`, migration 1022, `packages/contracts/src/agentUi.ts`, `packages/client-runtime/src/state/agentUi.ts`, `apps/web/src/fork/agentUiSurface.tsx`, `apps/web/src/state/agentUi.ts`          | `t3_show_ui` in the MCP control toolkit, fork RPC group + scopes + handlers, one `ws.ts` dep, one `server.ts` layer, marked handle passthrough in `ActivityPayloadProjection.ts`, `agentUi` field + read in `session-logic.ts`, one import and early return in `MessagesTimeline.tsx`, Experiments toggle + `settingsSearch.ts` entry     |
| Experimental deployment   | `.github/workflows/deploy-expbkt3.yml`, `deploy/expbkt3/`                                                                                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                      |
| BK mobile distribution    | `apps/mobile/app.config.bk.ts`, `apps/mobile/plugins/withBkAndroidReleaseSigning.cjs`, `apps/mobile/src/lib/bkBuildIdentity.ts`, `scripts/build-bk-mobile.ts`, `.github/workflows/mobile-bk-release.yml`                                           | two lines in `app.config.ts` (import + export), one linking prefix in `App.tsx`, one version call in `authClientMetadata.ts`                                                                                                                                                                                                              |

Agent views are scoped by `apps/web/src/fork/agentUiRuntime.ts`. Framed
collaboration apps can decline to join the URL-selected room and render
unrelated origin-local state instead, so `url` renders stay blocked until the
generic URL contract can render truthfully. Agent-authored `html` renders are
unaffected — the document is what the agent produced and mounts from `srcDoc` in
an opaque-origin sandbox — and follow the client setting alone.

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

Two preference seams keep a reopened review from behaving like a first run, and
both are easy to break while merging upstream:

- The parent bridge in `PlannotatorFocusSurface.tsx` stores `plannotator-*`
  preferences in `localStorage`, not in the cookie jar. `document.cookie` is
  inert on origins whose scheme is not cookieable, and the desktop renderer's
  `t3code://app` is one: a write there succeeds silently and reads back empty.
  The cookie is written too, but only so a browser served by the same origin
  keeps seeding the shim across an in-iframe reload — never rely on it alone.
- `PLANNOTATOR_EMBEDDED_ONBOARDING_SEEDS` in `plannotator/model.ts` marks
  Plannotator's one-time onboarding as already answered. T3 owns the
  post-approval permission mode (`applyDecision` issues
  `thread.interaction-mode.set` and never reads Plannotator's choice), so that
  prompt configures nothing here. Seed only the gating flags, never the mode
  itself, and keep client-stored values winning over the seeds. The announcement
  values are Plannotator revisions, so a future upstream revision legitimately
  shows that announcement once.

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

### Title ownership

A generated rename must never replace a name a human typed, so the projection
records who chose the current title. `projection_threads.title_manually_set`
(migration 1013) carries it, `thread.meta.update` moves it through the optional
`titleOrigin` field, and the rules live in
`apps/server/src/thread-title/titleAuthorship.ts`:

- `titleOrigin: "user"` — a rename typed into a client, or `t3_update_session`.
  Durable: the cadence skips the session from then on.
- `titleOrigin: "generated"` — the server's own naming. Hands ownership back.
- **absent** — ownership unchanged. Load-bearing: clients apply the optimistic
  prompt-derived title with this same command before the first turn, and that
  title has to stay replaceable.

"Regenerate title" in the experimental sidebar's row context menu is the way out
of a manual title. It dispatches the existing `regenerateTitle: true` flow,
which never consults ownership — replacing the current name is what it is for —
and the completion records the result as generated, so the cadence resumes.

### First-prompt naming

**First-prompt naming does not work on this fork through upstream's code path,
and the failure is silent.** Upstream forks title generation into the turn-start
scope (`Effect.forkScoped`). That is fine upstream, where turn start runs the
provider start inline, but this fork hands turn start to the durable execution
coordinator and returns as soon as the work is queued — the scope closes and
takes the forked fiber with it, seconds before the model answers. Because the
interrupt is delivered during finalization, the generator's own `catchCause`
never logs, so nothing appears in the journal at all. Symptom: every session on
bkt3 and expbkt3 kept its prompt-derived title forever, while the upstream-style
`t3.dev` deployment titled the same sessions correctly.

`shouldNameThreadFromFirstPrompt` routes the first prompt through the **durable**
regeneration flow instead — the same worker the cadence and the sidebar's
"Regenerate title" use, with request ids, supersede checks and interrupted-run
recovery. One consequence worth knowing: the generator receives speaker-labelled
thread context (`USER:\n…`) rather than the bare first message, and it uses the
regenerate prompt rather than the initial one.

Sessions started over MCP had a second, independent gap: `t3_create_session`
clips a title out of the first ten words of the prompt but sent no `titleSeed`,
so the first turn saw a title it had no reason to believe was a placeholder. It
now seeds that derived title, and only that one — a title the caller passed
explicitly is theirs and is left alone. That fix was necessary but not
sufficient; it opened a gate onto the interrupted path above.

If a future upstream merge makes turn start hold its scope until the provider
session is live, the durable route can be retired in favour of upstream's.

`isPlaceholderTitle` also accepts a _truncation_ of the seed, not just an exact
match, so a client that displays `truncate(prompt)` while seeding the full
prompt still gets named.

## Session identity environment

Every provider session spawns with additive environment variables naming the
people behind the turn, so an agent never has to infer them from the shared
machine:

| Variable                  | Value                                                                   |
| ------------------------- | ----------------------------------------------------------------------- |
| `BK_IDENTITY_RUNTIME`     | Always `t3-code`. Marks the runtime even when nobody could be resolved. |
| `BK_SESSION_OWNER_EMAIL`  | Primary email of the thread owner, from the environment-user directory. |
| `BK_MESSAGE_SENDER_EMAIL` | Primary email of the user who actually sent the message being answered. |

Four rules carry the behaviour:

- **The directory is the only source.** Git config, `whoami`, and checked-in
  dotfiles describe the machine; on a shared box they attribute one
  contributor's session to another, which is the bug this replaces.
- **The sender is never inferred.** Owner fallback is applied for credential
  binding, but `BK_MESSAGE_SENDER_EMAIL` is set only from a real sender. An
  absent variable means "unknown", and an agent must say so rather than guess.
- **Unresolvable identity degrades, never blocks.** A missing user record or an
  unreadable directory leaves the marker alone and the turn proceeds.
- **A changed identity restarts the provider.** The process reads its
  environment once at spawn, so `ProviderCommandReactor` fingerprints what each
  live session was started with and restarts on an owner transfer or a new
  sender, next to the existing credential-actor restart.

Claude Code's native system prompt normally derives `userEmail` from the
authenticated Claude account. That account is shared in the Beknown runtime, so
the Claude adapter appends the resolved `BK_MESSAGE_SENDER_EMAIL` as the
authoritative `userEmail`. When the sender is unresolved, the appended context
explicitly leaves `userEmail` unknown and forbids inference from the shared
Claude account, operating-system identity, or Git identity. Non-T3 Claude
sessions keep the upstream system prompt unchanged.

The CLI still emits its own `# userEmail` context section on every turn and
offers no switch to suppress it, so both branches of the appended block name
that section and countermand it explicitly: it reports the shared, rotating
subscription account, it does not identify the user, and it must be ignored for
user attribution. Naming it matters — the native section arrives later in
context than the appended block, and without the countermand a session answered
"who am I" with the rotated account holder while the appended block correctly
named the sender.

The countermand alone is not enough on smaller models. Verified against the
deployed build on 2026-08-21: Opus 5 answered "who am I" with the T3 sender,
but Sonnet 5 at medium effort failed 3/3 — it quoted the countermand block back
verbatim and still answered with the native `# userEmail` value. Position, not
wording, is what the model weighs, and the native section is a user-context
block that outranks anything written into the system prompt.

So the adapter also registers an SDK `UserPromptSubmit` hook that returns the
same identity as `additionalContext` on **every** turn, which lands at
user-message position and does win (Sonnet 5 medium, 2/2, including adversarial
prompt wording). `claudeSessionIdentityTurnContext` builds that text and
`withClaudeSessionIdentityTurnHook` folds the hook into the SDK query options,
merging with any hooks already registered rather than replacing them. The
system-prompt append stays as the belt to the hook's braces; both are gated on
`BK_IDENTITY_RUNTIME`, so upstream Claude sessions get neither. The identity
environment is read once at spawn and a changed sender already restarts the
provider, so the per-turn text cannot go stale.

The markers compose with source-control profiles rather than replacing them:
`mergeSourceControlEnvironment` scrubs the machine's inherited Git and GitHub
credentials only when the overlay carries a source-control identity of its own,
so machine-identity mode keeps its own `GH_TOKEN` while still carrying the
markers.

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
