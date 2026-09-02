# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Session cost

Every thread shows what it would have cost at API list prices, as a small
dollar pill in the thread header, next to the git actions on the desktop and web
apps and beside the header buttons on mobile. Tap or click it for the
breakdown: input, cached and output tokens, the cost per model, the cost per
day for long-running sessions, and how the price was derived.

The figure is an estimate. Subscriptions bill differently, so read it as a
measure of how heavy a session is rather than as a bill. It is priced from the
same public rate table the Usage page uses and gathered from the same provider
transcripts, narrowed to this thread's provider session. A brand-new thread has
no pill until its first turn lands; a model missing from the rate table shows
tokens but no dollar figure.
