/**
 * T3-CUSTOM(expbkt3): resolving user-defined "Open in…" targets to a URL.
 *
 * Upstream's picker can only offer editors it found on a PATH, and of those
 * only VS Code and its forks work against a remote environment (they ship
 * Remote-SSH). This module covers the rest: Obsidian, a file manager, Zed over
 * SSH, or any app the user installs, on a local *or* remote environment.
 *
 * All of it is client-side. The server contributes only the facts it already
 * advertises (`remoteOpenTargets`: host plus login account), so one client
 * handles any number of hosts with different usernames and no per-host setup
 * beyond an optional path mapping.
 *
 * @module fork/openTargets
 */
import type { OpenTarget, OpenTargetPathMapping } from "@t3tools/contracts";

import type { RemoteOpenState } from "../remoteOpen";

/** Why a target cannot be offered for the current environment. */
export type OpenTargetUnavailableReason =
  /** Remote environment, path is not reachable from this machine, no mapping matched. */
  | "no-path-mapping"
  /** The environment has no SSH route at all, so nothing can be built. */
  | "no-remote-route"
  /** The template has no usable URL scheme. */
  | "invalid-template";

export type OpenTargetResolution =
  | { readonly ok: true; readonly url: string; readonly scheme: string }
  | { readonly ok: false; readonly reason: OpenTargetUnavailableReason };

/** Percent-encodes each segment while leaving separators intact, as `buildRemoteOpenUrl` does. */
function encodePath(absolutePath: string): string {
  const posixPath = absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  return rootedPath.split("/").map(encodeURIComponent).join("/");
}

/** Trailing separators make prefix comparison ambiguous; compare without them. */
function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.replace(/\/+$/, "") : value;
}

/**
 * Applies the first mapping that covers `absolutePath` on `host`.
 *
 * Host-scoped mappings win over unscoped ones, so a rule written for one
 * machine cannot be shadowed by a general rule that happens to be listed
 * first. Returns null when nothing matches.
 */
export function applyPathMapping(input: {
  readonly absolutePath: string;
  readonly host: string | null;
  readonly mappings: ReadonlyArray<OpenTargetPathMapping>;
}): string | null {
  const path = input.absolutePath.replaceAll("\\", "/");
  const candidates = [
    ...input.mappings.filter(
      (mapping) => mapping.host !== undefined && mapping.host === input.host,
    ),
    ...input.mappings.filter((mapping) => mapping.host === undefined),
  ];

  for (const mapping of candidates) {
    const remotePrefix = withoutTrailingSlash(mapping.remotePrefix.replaceAll("\\", "/"));
    if (path !== remotePrefix && !path.startsWith(`${remotePrefix}/`)) {
      continue;
    }
    const remainder = path.slice(remotePrefix.length);
    return `${withoutTrailingSlash(mapping.localPrefix)}${remainder}`;
  }
  return null;
}

/** The scheme of a template, or null when it is not a usable absolute URL. */
export function templateScheme(template: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(template.trim());
  if (match === null) {
    return null;
  }
  const scheme = match[1]!.toLowerCase();
  // Schemes that execute rather than open. Never worth passing to the OS.
  return scheme === "javascript" || scheme === "data" || scheme === "vbscript" ? null : scheme;
}

/**
 * Builds the URL for one target against the environment the picker is showing.
 *
 * In `local-exec` mode the environment is this machine, so the path is used
 * as-is and no mapping is needed. In `remote-links` mode the path lives on
 * another host: a target that must reach a local path (`requiresMappingWhenRemote`)
 * is only offered when a mapping matches, while an SSH-style target (Zed) opts
 * out and receives the remote path plus `{host}`/`{user}`.
 */
export function resolveOpenTargetUrl(input: {
  readonly target: OpenTarget;
  readonly absolutePath: string;
  readonly remote: RemoteOpenState;
}): OpenTargetResolution {
  const scheme = templateScheme(input.target.template);
  if (scheme === null) {
    return { ok: false, reason: "invalid-template" };
  }

  if (input.remote.mode === "remote-unavailable") {
    return { ok: false, reason: "no-remote-route" };
  }

  const host = input.remote.mode === "remote-links" ? input.remote.host.host : null;
  const user = input.remote.mode === "remote-links" ? (input.remote.host.username ?? "") : "";

  let path = input.absolutePath;
  if (input.remote.mode === "remote-links") {
    const mapped = applyPathMapping({
      absolutePath: input.absolutePath,
      host,
      mappings: input.target.pathMappings,
    });
    if (mapped === null) {
      if (input.target.requiresMappingWhenRemote) {
        return { ok: false, reason: "no-path-mapping" };
      }
    } else {
      path = mapped;
    }
  }

  const url = input.target.template
    .trim()
    .replaceAll("{path}", encodePath(path))
    .replaceAll("{host}", encodeURIComponent(host ?? ""))
    .replaceAll("{user}", encodeURIComponent(user));

  return { ok: true, url, scheme };
}

/**
 * Starting points offered in settings. Stored as ordinary targets once added,
 * so a user can rename them, retarget them, or add their own from scratch.
 */
export interface OpenTargetPreset {
  readonly key: string;
  readonly label: string;
  readonly template: string;
  readonly requiresMappingWhenRemote: boolean;
  /** Shown in settings so the user knows what still needs configuring. */
  readonly hint: string;
}

export const OPEN_TARGET_PRESETS: ReadonlyArray<OpenTargetPreset> = [
  {
    key: "obsidian",
    label: "Obsidian",
    template: "obsidian://open?path={path}",
    requiresMappingWhenRemote: true,
    hint: "Obsidian has no SSH mode. For a remote environment, map the host path to the synced copy inside your vault.",
  },
  {
    key: "file-manager",
    label: "Finder / File manager",
    template: "file://{path}",
    requiresMappingWhenRemote: true,
    hint: "Opens a folder on this machine. For a remote environment, map the host path to a mount or mirror.",
  },
  {
    key: "zed-ssh",
    label: "Zed (over SSH)",
    template: "zed://ssh/{user}@{host}{path}",
    requiresMappingWhenRemote: false,
    hint: "Connects over SSH like VS Code does, so it needs no path mapping.",
  },
];

/**
 * Ids only have to be unique within one person's list, and two clicks can land
 * in the same millisecond, so a timestamp alone is not enough to key React
 * rows or to address a target for editing.
 */
export function newOpenTargetId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function presetToOpenTarget(preset: OpenTargetPreset): OpenTarget {
  return {
    id: newOpenTargetId(preset.key),
    label: preset.label,
    template: preset.template,
    pathMappings: [],
    requiresMappingWhenRemote: preset.requiresMappingWhenRemote,
  };
}
