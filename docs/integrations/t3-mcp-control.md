# T3 Code MCP control center

> **T3-CUSTOM(expbkt3):** This integration is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

The experimental control center exposes T3 Code itself as a Streamable HTTP MCP
server. Trusted agents can triage sessions, inspect their history and live state,
send prompts, change session defaults, resolve approvals, create sessions, and
route plans through a dedicated Plannotator review gate. Plans produced through
T3's normal plan mode are detected automatically; the planning agent does not
need to call a special tool.

This feature is intentionally disabled in normal builds. Build the web client with:

```bash
VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true pnpm exec vp run --filter @t3tools/web build
```

The server endpoint is always `/mcp`; external operator authentication remains
disabled until it is enabled in **Settings → Experiments → External T3 MCP
control**.

Experimental builds also expose **Settings → Active Projects** for editing the
nickname shown throughout T3, checking per-project running/attention totals,
opening the latest session, starting a new thread, copying the workspace path,
and removing a T3 project without deleting its files.

## Connect an external agent

1. Open Settings → Experiments.
2. Enable **External MCP server**.
3. Enable **My external access**.
4. Rotate your personal API token and copy it immediately. T3 stores only its
   hash and cannot reveal it again.
5. Set the public URL, normally `https://your-t3-host.example/mcp`.
6. Copy the generated agent configuration.

A generic configuration looks like:

```json
{
  "mcpServers": {
    "t3-code-control": {
      "type": "http",
      "url": "https://your-t3-host.example/mcp",
      "headers": {
        "Authorization": "Bearer <personal-api-token>"
      }
    }
  }
}
```

The personal token is a password-equivalent secret. It resolves to the user who
created it and can see or control only that user's accessible projects and
sessions. It may create user-owned sessions but cannot update server settings,
create server-wide projects, or use the raw command escape hatch. Rotating the
token immediately invalidates the previous token.

Reverse proxies must preserve `Authorization`, support streaming responses, and
avoid buffering the `/mcp` endpoint.

## Credential boundaries

T3 has three MCP principals:

- **Provider session:** automatically created for an agent running inside a T3
  session. The credential carries the authenticated user who started the current
  ACP generation. A normal session can control only itself; that user's persisted
  Conductor also receives `t3.session.create` and user-wide visibility.
- **External user:** created in the user's Experimental settings. It has the same
  user-scoped visibility as that account and may create user-owned sessions.
- **Legacy external operator:** retained only for controlled migration and local
  administration. It has server-wide access, including settings and raw commands.
  Its key is no longer returned to browser clients.

All principals use the same `/mcp` endpoint. Tool-level capability, user access,
and session scope checks run on every call.

## ACP identity and personal upstream MCP

Codex, Claude Code, OpenCode, Cursor, and Grok all receive the same logical MCP
configuration through their provider adapters. The configuration contains only a
short-lived T3 bearer token. It never contains a user's Bifrost, Linear, GitHub,
or other upstream credential.

When a user starts a turn, T3 binds the ACP generation to that authenticated user.
If a different authorized user starts the next turn in a shared session, T3
restarts/resumes the provider generation with the new identity before sending the
turn. This prevents a long-lived ACP process from retaining the previous user's
MCP authority.

Managed integrations are configured under **Settings → Experiments → My managed
MCP integrations**. Each integration can be assigned to every provider instance
or an explicit list, and may carry a tool allowlist. Calls use:

```text
ACP → /mcp/upstream/<integration-id> → user's write-only credential → upstream MCP
```

The proxy accepts the ACP's short-lived T3 token, resolves its `actorUserId`,
verifies the provider assignment and tool allowlist, loads the credential from
`ServerSecretStore`, injects the selected authentication header, and streams the
upstream response. An absent credential fails closed; T3 never falls back to
another user's key.

Bifrost integrations normally use `x-bf-vk`. Bearer, `x-api-key`, and validated
custom-header authentication are also supported.

## Tools

| Tool                          | Purpose                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `t3_list_sessions`            | Triage active or archived sessions with live execution, attention reasons, rolling catch-up, and latest-turn summary. |
| `t3_get_session`              | Inspect recent messages, activities, plans, approvals, inputs, checkpoints, and execution state.                      |
| `t3_list_projects`            | Discover project IDs, roots, repository identity, defaults, scripts, and active session counts.                       |
| `t3_get_configuration`        | Discover redacted server settings and the live provider/model catalog, including supported model options.             |
| `t3_send_prompt`              | Start or steer a durable turn and optionally select model, runtime mode, and plan/default interaction mode.           |
| `t3_update_session`           | Keep title, branch, model, runtime mode, and interaction mode current.                                                |
| `t3_session_action`           | Interrupt, stop, restart, archive, settle, snooze, delete, or request a fresh catch-up.                               |
| `t3_respond_approval`         | Resolve a pending provider approval using the request's allowed decision.                                             |
| `t3_respond_user_input`       | Answer a pending structured user-input request.                                                                       |
| `t3_create_project`           | Register or safely create a workspace project on a fresh T3 server. External operators only.                          |
| `t3_create_session`           | Create a user-owned session. Personal Conductors, external users, and legacy external operators.                      |
| `t3_submit_plan`              | Publish Markdown or HTML and start an attached Plannotator review gate.                                               |
| `t3_list_plannotator_reviews` | Inspect review state, decision, feedback, proxy path, and diagnostics.                                                |
| `t3_update_server_settings`   | Apply a validated settings patch. External operators only.                                                            |
| `t3_dispatch_command`         | Dispatch any current validated orchestration command. External operators only; prefer focused tools.                  |

The MCP JSON schemas describe every field. Agents should call
`t3_get_configuration` before changing models and `t3_get_session` before
answering approvals or structured input.

## Recommended triage loop

1. Call `t3_list_sessions` with `attentionOnly: true`.
2. Read the attention reasons and catch-up text before fetching a full session.
3. Call `t3_get_session` only for sessions that need a decision.
4. Respond to approvals or input using the exact pending request ID.
5. Send a targeted prompt when the agent needs guidance; use `interrupt` first
   only when replacing an active turn.
6. Update a stale title when the objective has materially changed.
7. Re-list sessions to confirm the attention state cleared.

The sidebar counters use the same practical categories: the red attention count
includes pending approvals, structured input, actionable plans, and failures; the
green count includes active, blocked, or stopping executions. Archived sessions
are excluded.

## Plannotator plan workflow

Whenever a provider completes a normal T3 plan, the server observes T3's durable
`proposed-plan-upserted` event, starts a Markdown Plannotator review for that same
plan ID, and updates the existing plan through the standard orchestration command
path. This preserves T3's native **Plan Ready**, implementation linkage, timeline,
projection, and WebSocket behavior.

The server also reconciles the newest actionable plan in every active session at
startup. That gives plans created before this integration a review action and
reopens a review process that did not survive a restart. Archived and deleted
sessions are skipped. Repeated events are coalesced by session and plan ID, and
an already-attached review is reused.

`t3_submit_plan` remains available for agents operating outside T3 or for callers
that need to submit an HTML plan. It accepts:

- the target T3 `sessionId` (optional for an in-session caller);
- `format`, either `md` or `html`;
- the complete `content`, up to 2 MiB.

T3 stores the plan in its private state directory, launches
`plannotator --browser none annotate <plan> --gate --json`, and adds an actionable
proposed plan to the session. The plan carries only an opaque, same-origin review
path; its private token is removed from copy, download, and export operations.

Every actionable native plan card shows a prominent **Review →** action beside
the existing **Expand plan** control. The action briefly shows a preparing state
while the review process starts. Selecting it keeps the left sidebar in place and
replaces every other T3 surface with a sandboxed, opaque-origin Plannotator
iframe. A sticky **Close** action in the upper-left restores the session view.
T3's proxy supplies the narrow CORS behavior its bundled review UI needs;
reviewed HTML cannot access the parent T3 document.

Decisions return through T3's proxy and durable command path:

- **Approve:** first persists the T3 session in Build/default mode, then starts
  an implementation turn linked to the approved proposed plan, so T3's normal
  implementation and approval behavior applies. The focused review surface
  reads a narrow token-scoped status endpoint so it can clear the browser's
  sticky Plan composer state and close the completed iframe.
- **Request changes / annotations:** combines anchored annotations into feedback
  and starts a plan-mode revision turn without changing the persisted mode. The
  planning agent is explicitly told not to modify files while revising. The next
  native plan revision reuses the same review ID, opaque URL, and plan file.
- **Deny without feedback:** records the declined review and does not start a
  turn or change mode.

Submitted inline comments, deletion requests, and global comments are stored in
the review manifest. Opening **Review →** later relaunches the same durable
review and replays that cumulative annotation history before the document is
shown. A reviewer can add and submit another round; equivalent replayed comments
are de-duplicated while genuinely new comments are appended. Plannotator's
unsubmitted crash-recovery draft remains available after an interrupted review,
but a successfully captured round clears that draft so it is not offered as a
duplicate restoration.

Review manifests and plan files live under
`<state-dir>/plannotator/{sessions,plans}`. Process logs live under
`<logs-dir>/plannotator`. Files are created with owner-only permissions. At
startup, a manifest whose process is no longer reachable is marked `exited`
instead of silently appearing live. The newest actionable native plan is then
reconciled to its durable review identity and existing opaque path. Use
`t3_list_plannotator_reviews` to retrieve diagnostic paths, cumulative
`annotationHistory`, and status.

## Security and operational notes

- Bind the T3 server to a private interface and expose it only through an
  authenticated TLS reverse proxy.
- Never place an operator key in source control, chat transcripts, shell history,
  screenshots, or logs.
- The settings read tool redacts provider environment secrets and never returns
  legacy operator or personal integration credentials.
- A shared session changes credential identity only at a serialized turn
  boundary. Direct ACP configuration outside T3's managed proxy is not covered
  by this isolation guarantee.
- Plannotator direct loopback ports are never returned to the browser. The browser
  receives only the opaque T3 proxy path.
- HTML plans execute inside the dedicated iframe surface. Accept HTML only from
  trusted agents.
- Session deletion and advanced raw commands are destructive. Inspect the session
  first and prefer focused tools.
- Rotating the key during `t3_update_server_settings` may invalidate the call's
  credential immediately after the update succeeds.

## Implementation map

- MCP authentication and scopes:
  `apps/server/src/mcp/{McpSessionRegistry,McpInvocationContext}.ts`
- Per-user profile/secret metadata and upstream proxy:
  `apps/server/src/mcp/{UserMcpProfileStore,McpUpstreamProxy}.ts`
- Tool contracts and handlers:
  `apps/server/src/mcp/toolkits/control/`
- Plannotator lifecycle and proxy:
  `apps/server/src/plannotator/`
- Sidebar status derivation:
  `apps/web/src/components/sidebar/sidebarSessionCounters.ts`
- Experimental settings:
  `apps/web/src/components/settings/ExternalMcpSettingsSection.tsx`
- Right-panel review surface:
  `apps/web/src/{rightPanelStore,components/ChatView,components/PlanSidebar}.tsx`
