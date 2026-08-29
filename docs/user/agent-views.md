# Agent views in chat

> **T3-CUSTOM(expbkt3):** This feature is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

Agent views are temporarily disabled in the experimental client. Calls to
`t3_show_ui` remain visible as ordinary collapsed tool rows, but the client does
not mount their documents or URL targets.

This is an enforced runtime safety gate. It overrides clients that previously
persisted **Agent views in chat** as enabled.

## What a view is

Some live collaboration apps deliberately disable room bootstrap whenever they
run inside an iframe. In that state, a room URL can display data cached for the
app's origin instead of joining the room named by the URL. Storage partitioning
can turn that stale content into an empty canvas, but it cannot make the framed
app join. T3 therefore cannot truthfully render those URLs inline without a
change owned by the embedded app or a different browser-level integration.

Disabling the surface is the generic fail-closed behavior: T3 does not
special-case an app or domain, rewrite URL fragments, proxy encryption keys, or
weaken the iframe sandbox.

## Turning it off

**Settings → Experiments → Agent views in chat** shows the runtime-disabled
state. The switch cannot re-enable the surface while this mitigation is active.

## Limits

- One view is capped at roughly 256,000 characters. An agent that needs more is
  told to render something smaller.
- Height is capped, so a view cannot take over the transcript.
- Views are stored with the session and are removed when the session's data is
  reclaimed.
