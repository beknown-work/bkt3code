/**
 * T3-CUSTOM(expbkt3): opening a user-defined "Open in…" target.
 *
 * Kept apart from `window.openExternal` on purpose. That handler's allowlist is
 * intentionally narrow — http(s) plus exactly VS Code's remote deep-link shape
 * — and upstream tightened it once already (#7697). Widening it to admit
 * arbitrary app schemes would weaken a security boundary shared with every
 * link in the transcript; this channel carries only URLs the renderer built
 * from the user's own configured targets.
 *
 * `file:` URLs go to `shell.openPath` rather than `openExternal`, because that
 * is what reveals a folder in Finder/Explorer; every other scheme is handed to
 * the OS handler (Obsidian, Zed, or whatever the user installed).
 *
 * @module ipc/methods/bkOpenTarget
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

/** Schemes that execute rather than open. Never handed to the OS. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "about:", "blob:"]);

export interface ParsedForkTarget {
  readonly url: URL;
  /** A filesystem path when the target is `file:`, otherwise null. */
  readonly localPath: string | null;
}

/**
 * Accepts an absolute URL with a plain scheme and no embedded credentials.
 *
 * Credentials are rejected for the same reason upstream rejects them on editor
 * deep links: a `user:password@` authority in a URL handed to the OS is a
 * credential-leak shape, never something a legitimate target needs.
 */
export function parseForkTargetUrl(rawUrl: unknown): Option.Option<ParsedForkTarget> {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return Option.none();
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Option.none();
  }

  if (FORBIDDEN_SCHEMES.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) {
    return Option.none();
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return Option.none();
  }

  if (url.protocol === "file:") {
    // `file:` must name a path on this machine; a host would make it a share.
    if (url.host.length > 0) {
      return Option.none();
    }
    const localPath = decodeURIComponent(url.pathname);
    return localPath.length === 0 ? Option.none() : Option.some({ url, localPath });
  }

  return Option.some({ url, localPath: null });
}

export const openForkTarget = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_FORK_TARGET_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openForkTarget")(function* (rawUrl) {
    return yield* Option.match(parseForkTargetUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (target) =>
        Effect.promise(() =>
          target.localPath === null
            ? Electron.shell.openExternal(target.url.href).then(
                () => true,
                () => false,
              )
            : // openPath resolves to "" on success and an error string otherwise.
              Electron.shell.openPath(target.localPath).then(
                (error) => error.length === 0,
                () => false,
              ),
        ),
    });
  }),
});
