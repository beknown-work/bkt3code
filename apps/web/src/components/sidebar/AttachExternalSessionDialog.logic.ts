// T3-CUSTOM(expbkt3): pure logic for attaching a new thread to a provider
// session started outside T3.
import type { ProviderInstanceEntry } from "../../providerInstances";

/** Providers whose resume contract the server can seed today. */
export const ATTACHABLE_DRIVER_KINDS: ReadonlyArray<string> = ["claudeAgent", "codex"];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMBEDDED_UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type AttachStep = "provider" | "project" | "session";

/**
 * Mirror of the server-side normalizer so the dialog can give inline feedback
 * before dispatching. Accepts the shapes users actually paste: a bare id, a
 * rollout filename, or a full transcript path.
 */
export function normalizeExternalSessionIdInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (UUID_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  const embedded = EMBEDDED_UUID_PATTERN.exec(trimmed);
  return embedded?.[1] ? embedded[1].toLowerCase() : null;
}

/** Only providers T3 can seed a resume cursor for are offered. */
export function selectAttachableProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  return entries.filter((entry) => ATTACHABLE_DRIVER_KINDS.includes(String(entry.driverKind)));
}

export function providerDisplayNoun(driverKind: string): string {
  return driverKind === "claudeAgent"
    ? "Claude Code"
    : driverKind === "codex"
      ? "Codex"
      : driverKind;
}

/** Per-provider hint for where to find the session id. */
export function sessionIdHelpText(driverKind: string): string {
  return driverKind === "claudeAgent"
    ? "Run `claude --resume` in the project folder to list sessions, or paste a transcript filename from ~/.claude/projects."
    : "Paste the thread id printed by `codex`, or a rollout filename from ~/.codex/sessions.";
}
