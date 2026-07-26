# T3 Code MCP control center

The experimental control center exposes T3 Code itself as a Streamable HTTP MCP
server. Trusted agents can triage sessions, inspect their history and live state,
send prompts, change session defaults, resolve approvals, create sessions, and
route plans through a dedicated Plannotator review gate.

This feature is intentionally disabled in normal builds. Build the web client with:

```bash
VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true pnpm exec vp run --filter @t3tools/web build
```

The server endpoint is always `/mcp`; external operator authentication remains
disabled until it is enabled in **Settings → Experiments → External T3 MCP
control**.

## Connect an external agent

1. Open Settings → Experiments.
2. Enable **External MCP server**.
3. Generate an operator API key.
4. Set the public URL, normally `https://your-t3-host.example/mcp`.
5. Copy the generated agent configuration.

A generic configuration looks like:

```json
{
  "mcpServers": {
    "t3-code-control": {
      "type": "http",
      "url": "https://your-t3-host.example/mcp",
      "headers": {
        "Authorization": "Bearer <operator-api-key>"
      }
    }
  }
}
```

The operator key is a password-equivalent secret. It grants cross-session control,
including destructive session actions and server setting updates. Rotating the key
immediately invalidates the previous key. Disabling the setting blocks long-lived
external access without affecting short-lived credentials issued to agents already
running inside T3.

Reverse proxies must preserve `Authorization`, support streaming responses, and
avoid buffering the `/mcp` endpoint.

## Credential boundaries

T3 has two MCP principals:

- **Provider session:** automatically created for an agent running inside a T3
  session. It can read and control only its own session, submit its own plan, and
  use collaborative browser tools. The credential expires and is revoked with the
  provider session.
- **External operator:** created in Settings. It can inspect and operate across
  sessions, create sessions, update server settings, and use the validated raw
  orchestration command escape hatch. It does not receive collaborative browser
  access because there is no owning session.

Both principals use the same `/mcp` endpoint. Tool-level capability and session
scope checks run on every call.

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
| `t3_create_session`           | Create a session, optionally with its first prompt. External operators only.                                          |
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

`t3_submit_plan` accepts:

- the target T3 `sessionId` (optional for an in-session caller);
- `format`, either `md` or `html`;
- the complete `content`, up to 2 MiB.

T3 stores the plan in its private state directory, launches
`plannotator --browser none annotate <plan> --gate --json`, and adds an actionable
proposed plan to the session. The plan carries only an opaque, same-origin review
path; its private token is removed from copy, download, and export operations.

The Plan panel shows **Review**. Selecting it replaces the normal right-side
surface with a sandboxed, opaque-origin Plannotator iframe. T3's proxy supplies
the narrow CORS behavior its bundled review UI needs; reviewed HTML cannot access
the parent T3 document. Existing right-panel maximize and close controls continue
to work.

Decisions return through T3's proxy and durable command path:

- **Approve:** starts a default-mode implementation turn linked to the approved
  proposed plan, so T3's normal implementation and approval behavior applies.
- **Request changes / annotations:** combines anchored annotations into feedback
  and starts a plan-mode revision turn. The planning agent is explicitly told not
  to modify files while revising.
- **Deny without feedback:** records the declined review and does not start a
  turn.

Review manifests and plan files live under
`<state-dir>/plannotator/{sessions,plans}`. Process logs live under
`<logs-dir>/plannotator`. Files are created with owner-only permissions. At
startup, a manifest whose process is no longer reachable is marked `exited`
instead of silently appearing live. Use `t3_list_plannotator_reviews` to retrieve
diagnostic paths and status.

## Security and operational notes

- Bind the T3 server to a private interface and expose it only through an
  authenticated TLS reverse proxy.
- Never place an operator key in source control, chat transcripts, shell history,
  screenshots, or logs.
- The settings read tool redacts provider environment secrets and never returns
  the operator key.
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
