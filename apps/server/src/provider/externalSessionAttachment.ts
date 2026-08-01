// T3-CUSTOM(expbkt3): bind a new T3 thread to a provider session that was
// started outside T3 (`claude` / `codex` in a terminal).
//
// No new resume machinery is needed for this: ProviderService.startSession
// already falls back to the persisted cursor when the reactor starts a session
// for a brand-new thread. Attaching therefore reduces to writing the cursor a
// native resume would have written, before the first turn runs.
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";

import type { ProviderDriverKind } from "@t3tools/contracts";

/** Providers whose resume contract T3 can seed today. */
export const ATTACHABLE_DRIVER_KINDS = ["claudeAgent", "codex"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pull the trailing UUID out of a rollout filename or a pasted jsonl path. */
const EMBEDDED_UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export class ExternalSessionAttachmentError extends Error {
  readonly _tag = "ExternalSessionAttachmentError";
  constructor(message: string) {
    super(message);
    this.name = "ExternalSessionAttachmentError";
  }
}

/**
 * Normalize whatever the user pasted into a bare session id.
 *
 * Users copy several shapes: the bare UUID, a rollout filename, or the whole
 * path to a transcript file. All of them carry the id, so accept them rather
 * than making the user extract it.
 */
export function normalizeExternalSessionId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (UUID_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  const embedded = EMBEDDED_UUID_PATTERN.exec(trimmed);
  return embedded?.[1] ? embedded[1].toLowerCase() : null;
}

/**
 * Build the resume cursor a native resume of this provider would have left
 * behind, so the existing adapter code path picks it up unchanged.
 */
export function buildExternalResumeCursor(
  driverKind: ProviderDriverKind | string,
  sessionId: string,
): { readonly cursor: unknown; readonly normalizedSessionId: string } {
  const normalized = normalizeExternalSessionId(sessionId);
  switch (driverKind) {
    case "claudeAgent": {
      if (normalized === null) {
        throw new ExternalSessionAttachmentError(
          "A Claude session id must be a UUID. Run `claude --resume` to list sessions, or paste the transcript filename.",
        );
      }
      // Matches readClaudeResumeState's `resume` field, which the adapter
      // hands to the Agent SDK as the session to continue.
      return { cursor: { resume: normalized }, normalizedSessionId: normalized };
    }
    case "codex": {
      if (normalized === null) {
        throw new ExternalSessionAttachmentError(
          "A Codex session id must be a UUID. Paste the thread id printed by `codex`, or the rollout filename.",
        );
      }
      return { cursor: { threadId: normalized }, normalizedSessionId: normalized };
    }
    default:
      throw new ExternalSessionAttachmentError(
        `Attaching an existing session is not supported for provider '${String(driverKind)}' yet.`,
      );
  }
}

export type ExternalSessionProbeResult = "found" | "missing" | "unknown";

/** Claude stores transcripts under a slug of the cwd they ran in. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Best-effort check that the session actually exists for this cwd.
 *
 * This matters most for Codex: on an unknown thread id its runtime logs a
 * warning and silently starts a *fresh* thread, so without this probe an
 * attach would look like it worked and quietly lose the conversation. For
 * Claude it also catches the common "right session, wrong project" mistake,
 * since resume is bound to the directory the session ran in.
 */
export const probeExternalSessionArtifact = Effect.fn("probeExternalSessionArtifact")(
  function* (input: {
    readonly driverKind: ProviderDriverKind | string;
    readonly sessionId: string;
    readonly cwd: string;
    readonly homePath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (input.driverKind === "claudeAgent") {
      const projectDir = path.join(
        input.homePath,
        ".claude",
        "projects",
        claudeProjectSlug(input.cwd),
      );
      const dirExists = yield* fs.exists(projectDir).pipe(Effect.orElseSucceed(() => false));
      // No project dir means Claude has never run here; that is a wrong-project
      // signal rather than proof the session is missing.
      if (!dirExists) return "unknown" as ExternalSessionProbeResult;
      const transcript = path.join(projectDir, `${input.sessionId}.jsonl`);
      const fileExists = yield* fs.exists(transcript).pipe(Effect.orElseSucceed(() => false));
      return (fileExists ? "found" : "missing") satisfies ExternalSessionProbeResult;
    }

    if (input.driverKind === "codex") {
      const sessionsDir = path.join(input.homePath, ".codex", "sessions");
      const dirExists = yield* fs.exists(sessionsDir).pipe(Effect.orElseSucceed(() => false));
      if (!dirExists) return "unknown" as ExternalSessionProbeResult;
      const found = yield* containsSessionFile(fs, path, sessionsDir, input.sessionId, 0);
      return (found ? "found" : "missing") satisfies ExternalSessionProbeResult;
    }

    return "unknown" as ExternalSessionProbeResult;
  },
);

/** Codex nests rollout files under date directories; walk a bounded depth. */
function containsSessionFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
  sessionId: string,
  depth: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (depth > 4) return false;
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      if (entry.includes(sessionId)) return true;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry);
      const stat = yield* fs.stat(child).pipe(Effect.result);
      if (stat._tag === "Success" && stat.success.type === "Directory") {
        if (yield* containsSessionFile(fs, path, child, sessionId, depth + 1)) return true;
      }
    }
    return false;
  });
}
