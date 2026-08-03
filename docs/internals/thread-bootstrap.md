# Durable thread bootstrap

Thread bootstrap is the high-level, durable path for creating a thread, preparing its workspace,
and optionally dispatching its first turn. It keeps strict `thread.create` deterministic while
giving web, HTTP, WebSocket, and MCP callers one defaults and readiness boundary.

## Resolution and persistence

`thread.bootstrap.request` is normalized at the transport boundary and resolved by
`ThreadCreationDefaultsResolver`. Every defaulted field is merged independently:

```text
explicit request override → project override → target environment app setting
```

The resolved request is stored once. New-worktree requests receive a desired branch and expected
managed worktree path before filesystem work begins. Origin refs are fetched and resolved to a
commit SHA; exact configured refs fail visibly if unavailable.

The event log records the public lifecycle while `projection_thread_bootstraps` retains the
resolved request needed for recovery. Public thread snapshots expose only output-free progress.
Pending prompt content remains in the internal request and terminal bytes remain in capped,
redacted terminal history.

## Coordinator lifecycle

The coordinator persists the thread and `thread.bootstrap-requested`, returns to the caller, then
runs three phases in a detached server fiber:

1. Create or adopt the requested workspace.
2. Run the selected project setup action in a one-shot interactive PTY when this operation created
   a new worktree.
3. Dispatch the first turn with a deterministic command ID after setup succeeds or is bypassed.

Local directories and supplied existing worktrees skip setup. A request without an initial prompt
completes after workspace readiness. A non-zero exit, signal, launch failure, or user stop records a
typed setup failure with terminal ID and never dispatches the pending turn.

Retry reads the project's current setup action, so editing a broken command takes effect without
recreating the thread. Each attempt gets a distinct deterministic terminal ID and prior history is
retained. Continue is accepted only after successful worktree creation and failed setup. Worktree
failures cannot be bypassed.

## Recovery invariants

Browser and transport disconnects do not own the coordinator fiber. At server startup, recovery is
queued behind the existing command-readiness gate and does not wait for interactive setup to end.

- A setup recorded as running becomes an interrupted failure; it is never silently rerun.
- A completed worktree phase is reused.
- A worktree whose creation was in flight is adopted only when repository, desired branch, and
  exact expected managed path all match. Otherwise the step fails for explicit retry.
- Pending or dispatched first turns reuse deterministic command IDs, so recovery cannot start the
  first turn twice.

Setup activities carry terminal ID, exit code, and status but never output. Terminal attachment is
the only output-loading path.

## Compatibility

Servers advertise `durableThreadBootstrap` and `threadCreationDefaults`. New web clients use the
high-level command only when both sides support it; older servers retain the explicit legacy flow.
The legacy `thread.turn.start.bootstrap` command is translated by the dispatcher. MCP
`t3_create_session` returns the thread and bootstrap IDs after durable queueing rather than waiting
for setup.
