# Claude account switching on dev-server-1

Host tooling that lets every T3 Code session on `ip-10-31-39-131` run under a chosen
Claude account, switched from a terminal, without interrupting existing threads. It
also switches automatically when the active account nears its usage limits.

This is host-only: nothing here ships in the application, and none of it is installed
by a deploy. It is documented here because it changes how the Claude provider is
configured on the Beknown deployments. For the general multi-account pattern, see
[Claude](../user/providers-claude.md).

## Why the obvious approach does not work here

[Claude](../user/providers-claude.md) recommends one provider per account, each with
its own `CLAUDE_CONFIG_DIR path`, and states that switching accounts inside an
existing thread is "usually, no". That is accurate: transcripts live at
`<config-dir>/projects/<slug>/<uuid>.jsonl`, so a thread resumed under a different
config directory finds no transcript for its session id and breaks.

Two extra constraints apply on this host:

- Sessions here are long-lived, so orphaning them is not acceptable.
- T3 Code resolves `binaryPath` and the spawn environment **once per adapter**
  (`claudeSdkExecutablePath` in `apps/server/src/provider/Layers/ClaudeAdapter.ts`),
  so changing either value in Settings has no effect until the provider instance is
  rebuilt.

## Design

One provider, one config-directory string, and a symlink that moves.

```text
Binary path:             claude
CLAUDE_CONFIG_DIR path:  /home/ubuntu/.claude-active     # a symlink
```

```text
~/.claude-active                    -> ~/.claude-profiles/<elected>
~/.claude-profiles/<name>/          per-account: .credentials.json, .claude.json
~/.claude-profiles/<name>/projects  -> ~/.claude/projects        (shared transcripts)
~/.claude-profiles/<name>/{CLAUDE.md,skills,plugins,settings.json,hooks}
                                    -> ~/.claude/<same>          (shared config)
```

Three properties follow, and each solves one of the problems above:

- **Threads survive a switch.** Every profile's `projects/` is the same directory, so
  any account can resume any session.
- **The stale-adapter problem disappears.** The configured value never changes; only
  the symlink target does, and the CLI resolves it at spawn time. A provider instance
  captured long ago still lands on the currently elected account.
- **Account metadata stays intact.** Each profile owns its `.claude.json`, so the
  provider panel reports the real email and plan, and the CLI refreshes its own token.

Do not point `CLAUDE_CONFIG_DIR` at `~/.claude` itself. That directory's account
metadata lives in `~/.claude.json`, _beside_ it rather than inside it, so it resolves
to credentials without an email. `~/.claude.json` is also rewritten by atomic rename,
which replaces a symlink there with a regular file.

## Switching by hand

```bash
claude-profile list             # every profile, the account it holds, which is elected
claude-profile use <name>       # elect a profile for newly spawned sessions
claude-profile active           # which profile is elected
cs <name>                       # switch only the current shell (independent of the above)
```

`claude-profile create <name>` then `claude-profile login <name>` adds an account. Create
re-links shared items and is safe to re-run after adding a new top-level directory to
`~/.claude`.

Two caveats:

- A switch applies to **newly spawned** sessions. A thread mid-turn keeps its account
  until its process restarts. Nothing breaks, because history is shared.
- The provider panel lags a switch by up to five minutes. The account probe is cached
  (`CAPABILITIES_PROBE_TTL` in `apps/server/src/provider/Drivers/ClaudeDriver.ts`) on
  `binaryPath + homePath + cwd`, none of which change when the symlink moves.

## Automatic switching on usage limits

`claude-autoswitch` runs every 30 seconds from `claude-autoswitch.timer` and elects a
different profile when the active account is nearly spent.

It makes **no network requests and never spawns `claude`**. Usage comes from
`<profile>/.claude.json` -> `cachedUsageUtilization`, which the Claude CLI maintains as a
side effect of normal use. A run is three small file reads (~0.06 s, ~16 MB RSS). Note
this is not the source T3 Code displays; the panel uses live stream events via
`normalizeClaudeRateLimitEvent`.

```bash
claude-autoswitch --status      # all profiles, effective percentages, which is elected
claude-autoswitch --dry-run     # decide without switching
tail ~/.claude-profiles/.autoswitch.jsonl        # every decision, with its inputs
```

Config lives in `~/.claude-profiles/.autoswitch.json`:

| key                       | default       | meaning                                                               |
| ------------------------- | ------------- | --------------------------------------------------------------------- |
| `rotation`                | profile names | order tried; first entry is the primary                               |
| `five_hour_trip_pct`      | `85`          | trip when the 5-hour window is this **used**                          |
| `weekly_trip_pct`         | `95`          | trip when the weekly window is this **used**                          |
| `healthy_below_pct`       | `60`          | deadband: an account counts as recovered only below this              |
| `degraded_min_gain_sec`   | `120`         | when all are spent, only move if the target recovers this much sooner |
| `count_weekly_scoped`     | `false`       | include the model-scoped weekly window                                |
| `min_switch_interval_sec` | `120`         | anti-flap floor between switches                                      |
| `failback_to_primary`     | `true`        | return to the primary once it has recovered                           |
| `notify_command`          | `""`          | optional shell command; `{from} {to} {reason}`                        |

`rotation` names host-local profiles, so the live value is whatever
`claude-profile list` shows rather than anything committed here.

The percentages are **used**, not remaining: "switch when under 15% of the 5-hour window
is left" is `five_hour_trip_pct: 85`. The T3 Code panel reports **remaining**, so a
provider showing `5h 18%` is an account at 82% used. `claude-autoswitch --status` prints
both framings side by side to make that comparison direct.

Four rules in the implementation are not obvious and should not be simplified away:

1. **Reset-discounted staleness.** An exhausted account stops running sessions, so its
   cache stops refreshing; a plain freshness check would refuse to act exactly when
   action is needed. Each window's cached percentage is instead discounted against its
   own `resets_at` — past the reset it counts as zero. Stale data can then only
   understate headroom, never overstate it.
2. **Failback must not fight a manual switch.** Returning to the primary happens only
   when state records `auto_moved: true` and `last_to` equals the current profile, so
   the timer only ever reverses its own move. Without this it silently overrides an
   operator who ran `claude-profile use`.
3. **The deadband is what stops it flapping.** Trip thresholds alone are not enough:
   an account one point under the trip line reads as available, gets elected, and
   crosses back over within the hour. Observed in practice as round trips as short as
   35 minutes. `healthy_below_pct` is the resume threshold — an account must fall well
   below the trip line before it is chosen as a fallback or failed back to. When no
   account is recovered, the fallback with the most headroom wins rather than the first
   one that merely squeaks under the line.
4. **When everything is spent, rank by time-to-reset, not by percentage.** Sitting on a
   dead account is what stops sessions, so the switcher moves to whichever account
   recovers soonest — the `RECOVERS` column in `--status`. An account whose _weekly_
   window is also spent ranks behind every account whose weekly still has room, however
   soon its 5-hour window rolls: a fresh 5-hour window is worthless under an exhausted
   weekly cap. `degraded_min_gain_sec` keeps it from shuffling between equally dead
   accounts.

Recurring conditions (`all_exhausted`, `suppressed_by_interval`) are logged at most once
every five minutes. They are re-evaluated on every tick, and at a 30-second cadence
logging each one buries the real decisions.

Disable with `"enabled": false`, or:

```bash
sudo systemctl disable --now claude-autoswitch.timer
```

## Operational notes

The election is **machine-global**. Whichever profile is elected absorbs the usage of
every session spawned on this host, including other operators'. Keep an account out of
`rotation` if its billing must stay attributable to one person.

Anthropic's Consumer Terms, Usage Policy and Commercial Terms place no restriction on one
person holding several accounts, and do not address rate-limit rotation. What they do
prohibit is sharing credentials or making an account available to someone else — which is
why the machine-global point above matters more than the account count.

## Files

| path                                                       | role                                          |
| ---------------------------------------------------------- | --------------------------------------------- |
| `~/.local/bin/claude-profile`                              | create/login/list/use/delete profiles         |
| `~/.local/share/claude-profile/shell-init.sh`              | `cs` shell function, sourced from `~/.bashrc` |
| `~/.local/bin/claude-autoswitch`                           | usage-based switcher (python3, stdlib only)   |
| `~/.local/bin/claude-elected`                              | unused fallback wrapper; see note below       |
| `/etc/systemd/system/claude-autoswitch.{service,timer}`    | five-minute timer, `User=ubuntu`              |
| `~/.claude-profiles/.autoswitch{.json,-state.json,.jsonl}` | config, state, decision log                   |

`claude-elected` injects the elected config directory via a wrapper set as `binaryPath`.
It works standalone but is not in use: `binaryPath` is captured at adapter creation, so a
Settings change to it does not take effect until the instance is rebuilt, whereas the
symlink approach needs no rebuild after the initial setup.
