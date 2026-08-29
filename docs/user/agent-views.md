# Agent views in chat

> **T3-CUSTOM(expbkt3):** This feature is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

An agent can render a small interactive view directly in the conversation: a
chart, a diagram, a table, a form, a preview. The view appears inline, in the
place where the agent produced it, rather than as a file you have to open.

Ask for something visual — "chart the request latency by endpoint", "show me the
migration order as a diagram", "lay these options out side by side" — and the
agent decides whether a view says it better than text.

## What a view is

Each view is a box in the transcript with a title bar you can collapse. Inside
is a document the agent wrote, rendered in a sandbox:

- Its styles and scripts run, so charts, tabs and hover states work.
- It cannot reach T3 Code, your session, your cookies, or the network as you.
- It cannot navigate the app or read anything outside its own box.

Agent-written documents are snapshots. When an agent shows you an updated
version it appears as a new box further down the conversation, so scrolling back
still shows what it produced at that point in the work.

An agent can also embed a page by its `https` address instead of writing the
document itself. Some sites refuse to be embedded and will show an empty box;
that is the site's decision, not a fault in T3.

URL views are live pages. T3 keeps only one live URL view from the same origin at
a time, across both the transcript and the expanded view. Opening another one
disconnects the previous iframe before loading the selected URL in a fresh one.
Older cards stay in the transcript and offer **Open this view** when inactive.
This prevents same-origin apps from concurrently restoring or broadcasting stale
state between views.

In Chromium, cross-origin URL views also use a credentialless iframe. Its cookies
and browser storage are temporary and scoped to the current top-level T3 page;
closing or reloading T3 can discard that state. This is not a separate storage
partition for every view, which is why T3 also allows only one live iframe per
origin. Firefox and Safari currently ignore this protection and fall back to the
same exclusive iframe lifecycle.

Credentialless pages do not receive ambient sign-in cookies. Apps that require
an existing login, third-party cookies, or an OAuth flow may therefore ask you to
sign in again or may not work inside a view. T3 does not relax the sandbox for
those apps.

## Turning it off

**Settings → Experiments → Agent views in chat.** While it is off, an agent that
tries to show a view leaves an ordinary collapsed tool row instead, and nothing
is rendered. The setting is per client, so turning it off on your laptop does not
change what you see on your phone.

## Limits

- One view is capped at roughly 256,000 characters. An agent that needs more is
  told to render something smaller.
- Height is capped, so a view cannot take over the transcript.
- URL views from the same origin cannot stay open side by side.
- Views are stored with the session and are removed when the session's data is
  reclaimed.
