/**
 * Fork-owned versioning and safety rules for the Beknown desktop release.
 *
 * Two hard constraints shape everything here.
 *
 * 1. **The updater channel.** A GitHub *prerelease* is invisible to
 *    electron-updater's `latest` channel. `resolveDesktopUpdateChannel` in
 *    `../build-desktop-artifact.ts` routes `X.Y.Z-nightly.YYYYMMDD.N` versions to
 *    the `nightly` channel, which publishes as a prerelease and writes a
 *    `nightly-mac.yml` manifest. So every fork build must carry a nightly-form
 *    version, and versions must increase, or teammates never see the update.
 *
 * 2. **The release pipeline must not fire.** `.github/workflows/release.yml`
 *    triggers on tags `v*.*.*` with `!v*-nightly.*` excluded, and it has no
 *    dry-run mode: it publishes `t3` to npm, cuts a public GitHub Release, and
 *    re-aliases app.t3.codes. A nightly-form tag is excluded by that pattern, so
 *    it is the only shape safe to push. {@link isReleaseWorkflowSafeTag} is the
 *    gate, and the publish script refuses anything it rejects.
 */

import * as DateTime from "effect/DateTime";

/** Repository the fork publishes desktop prereleases to. */
export const BK_DESKTOP_RELEASE_REPOSITORY = "beknown-work/bkt3code";

/** Nightly-form version: `X.Y.Z-nightly.YYYYMMDD.N`. */
const NIGHTLY_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

/** Tags safe to push: nightly-form, which release.yml explicitly excludes. */
const SAFE_TAG_PATTERN = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

export interface ParsedNightlyVersion {
  readonly baseVersion: string;
  readonly date: string;
  readonly counter: number;
}

/**
 * Formats a build date as `YYYYMMDD` in UTC.
 *
 * UTC rather than local time: the date is part of an ordering key, and a
 * local-time date can move backwards relative to an earlier build made in a
 * different offset, which would break {@link compareNightlyVersions}.
 */
export function formatBuildDate(dateTime: DateTime.DateTime): string {
  const parts = DateTime.toPartsUtc(dateTime);
  const year = parts.year.toString().padStart(4, "0");
  const month = parts.month.toString().padStart(2, "0");
  const day = parts.day.toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

export function composeNightlyVersion(baseVersion: string, date: string, counter: number): string {
  const version = `${baseVersion}-nightly.${date}.${counter}`;
  if (!NIGHTLY_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Composed version "${version}" is not a valid nightly version. ` +
        `baseVersion must be X.Y.Z, date YYYYMMDD, counter a positive integer.`,
    );
  }
  return version;
}

export function parseNightlyVersion(version: string): ParsedNightlyVersion | undefined {
  const match = NIGHTLY_VERSION_PATTERN.exec(version.trim());
  if (!match) return undefined;
  const [, major, minor, patch, date, counter] = match;
  return {
    baseVersion: `${major}.${minor}.${patch}`,
    date: date ?? "",
    counter: Number(counter),
  };
}

/** Strips a leading `v` so tags and versions compare on equal terms. */
export function versionFromTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function tagFromVersion(version: string): string {
  return `v${version}`;
}

/**
 * True only for tags that cannot trigger `release.yml`.
 *
 * Anything else — `v1.2.3`, `v1.2.3-alpha.1`, even `v0.0.0-test.1` — matches that
 * workflow's `v*.*.*` trigger and would publish a real stable release.
 */
export function isReleaseWorkflowSafeTag(tag: string): boolean {
  return SAFE_TAG_PATTERN.test(tag.trim());
}

/** Orders two nightly versions. Returns <0, 0 or >0 like a comparator. */
export function compareNightlyVersions(
  left: ParsedNightlyVersion,
  right: ParsedNightlyVersion,
): number {
  const leftParts = left.baseVersion.split(".").map(Number);
  const rightParts = right.baseVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  return left.counter - right.counter;
}

/**
 * Next counter for `baseVersion` on `date`, given the tags already published.
 *
 * Counts only tags on the same base version and date; a new day or a bumped base
 * version restarts at 1, which is still strictly greater by
 * {@link compareNightlyVersions}.
 */
export function resolveNextCounter(
  existingTags: ReadonlyArray<string>,
  baseVersion: string,
  date: string,
): number {
  let highest = 0;
  for (const tag of existingTags) {
    const parsed = parseNightlyVersion(versionFromTag(tag));
    if (!parsed) continue;
    if (parsed.baseVersion !== baseVersion || parsed.date !== date) continue;
    if (parsed.counter > highest) highest = parsed.counter;
  }
  return highest + 1;
}

/**
 * Highest nightly version among the given tags, or undefined if there are none.
 * Used to prove a new build is strictly newer before publishing.
 */
export function resolveNewestNightlyVersion(
  existingTags: ReadonlyArray<string>,
): ParsedNightlyVersion | undefined {
  let newest: ParsedNightlyVersion | undefined;
  for (const tag of existingTags) {
    const parsed = parseNightlyVersion(versionFromTag(tag));
    if (!parsed) continue;
    if (!newest || compareNightlyVersions(parsed, newest) > 0) newest = parsed;
  }
  return newest;
}

/**
 * Release assets to upload.
 *
 * `.dmg` is what a teammate downloads. The rest are what auto-update needs: the
 * `.zip` is the Squirrel.Mac update payload, `nightly-mac.yml` is the manifest
 * electron-updater reads, and `.blockmap` enables differential downloads.
 */
export function isNightlyReleaseAsset(fileName: string): boolean {
  return (
    fileName.endsWith(".dmg") ||
    fileName.endsWith(".zip") ||
    fileName.endsWith(".blockmap") ||
    fileName === "nightly-mac.yml"
  );
}

/** The updater manifest whose absence would silently disable auto-update. */
export const NIGHTLY_UPDATE_MANIFEST = "nightly-mac.yml";
