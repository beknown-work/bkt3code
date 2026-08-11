#!/usr/bin/env node

/**
 * Publishes a built Beknown desktop DMG as a GitHub prerelease teammates can
 * download, and that the in-app updater can then read.
 *
 *   node scripts/publish-bk-desktop-dmg.ts --build-version 0.0.32-nightly.20260810.1
 *   node scripts/publish-bk-desktop-dmg.ts --build-version ... --dry-run
 *
 * Guards, in order — each exists because getting it wrong is expensive:
 *
 * - The tag must be nightly-form, so `.github/workflows/release.yml` cannot fire.
 *   That workflow has no dry-run mode; a wrong tag publishes `t3` to npm, cuts a
 *   public GitHub Release and re-aliases app.t3.codes.
 * - The version must be strictly newer than the newest published one, or the
 *   updater will not offer it.
 * - `nightly-mac.yml` must be present, or auto-update silently does nothing.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BK_DESKTOP_RELEASE_REPOSITORY,
  compareNightlyVersions,
  isNightlyReleaseAsset,
  isReleaseWorkflowSafeTag,
  NIGHTLY_UPDATE_MANIFEST,
  parseNightlyVersion,
  resolveNewestNightlyVersion,
  tagFromVersion,
} from "./lib/bk-desktop-release.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const GhReleaseList = Schema.Array(Schema.Struct({ tagName: Schema.String }));
const decodeGhReleaseList = Schema.decodeUnknownEffect(Schema.fromJsonString(GhReleaseList));

export class GhCommandFailedError extends Schema.TaggedErrorClass<GhCommandFailedError>()(
  "GhCommandFailedError",
  {
    operation: Schema.Literals(["list-releases", "create-release"]),
    exitCode: Schema.Number,
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    return `gh ${this.operation} failed with exit code ${this.exitCode}: ${this.stderrTail}`;
  }
}

export class NotANightlyVersionError extends Schema.TaggedErrorClass<NotANightlyVersionError>()(
  "NotANightlyVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return (
      `"${this.version}" is not a nightly version (expected X.Y.Z-nightly.YYYYMMDD.N). ` +
      `Only nightly versions reach the fork's updater channel.`
    );
  }
}

export class UnsafeReleaseTagError extends Schema.TaggedErrorClass<UnsafeReleaseTagError>()(
  "UnsafeReleaseTagError",
  {
    tag: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Refusing to publish tag "${this.tag}". It could match the v*.*.* trigger in ` +
      `.github/workflows/release.yml, which would publish t3 to npm, cut a public GitHub ` +
      `Release and re-alias app.t3.codes. Only nightly-form tags are excluded from that trigger.`
    );
  }
}

export class ReleaseTagAlreadyExistsError extends Schema.TaggedErrorClass<ReleaseTagAlreadyExistsError>()(
  "ReleaseTagAlreadyExistsError",
  {
    tag: Schema.String,
  },
) {
  override get message(): string {
    return `Tag ${this.tag} already exists in ${BK_DESKTOP_RELEASE_REPOSITORY}.`;
  }
}

export class ReleaseVersionNotNewerError extends Schema.TaggedErrorClass<ReleaseVersionNotNewerError>()(
  "ReleaseVersionNotNewerError",
  {
    version: Schema.String,
    newestPublished: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Version ${this.version} is not newer than the newest published ${this.newestPublished}. ` +
      `electron-updater would never offer it; rebuild with a higher build number.`
    );
  }
}

export class NoPublishableArtifactsError extends Schema.TaggedErrorClass<NoPublishableArtifactsError>()(
  "NoPublishableArtifactsError",
  {
    version: Schema.String,
    releaseDir: Schema.String,
  },
) {
  override get message(): string {
    return `No publishable artifacts for ${this.version} found in ${this.releaseDir}.`;
  }
}

export class MissingUpdateManifestError extends Schema.TaggedErrorClass<MissingUpdateManifestError>()(
  "MissingUpdateManifestError",
  {
    releaseDir: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${NIGHTLY_UPDATE_MANIFEST} is missing from ${this.releaseDir}. Without it auto-update ` +
      `silently does nothing. Rebuild with scripts/build-bk-desktop-dmg.ts, which configures ` +
      `the nightly channel.`
    );
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

const runGh = Effect.fn("runGh")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand("gh", [...args], { env: process.env });
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: process.env,
      shell: spawnCommand.shell,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const listPublishedTags = Effect.fn("listPublishedTags")(function* () {
  const result = yield* runGh([
    "release",
    "list",
    "--repo",
    BK_DESKTOP_RELEASE_REPOSITORY,
    "--limit",
    "100",
    "--json",
    "tagName",
  ]);
  if (result.exitCode !== 0) {
    return yield* new GhCommandFailedError({
      operation: "list-releases",
      exitCode: result.exitCode,
      stderrTail: result.stderr.trim(),
    });
  }

  const releases = yield* decodeGhReleaseList(result.stdout);
  return releases.map((release) => release.tagName);
});

const collectAssets = Effect.fn("collectAssets")(function* (releaseDir: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // A missing directory is the ordinary "you have not built yet" case, so it
  // becomes an empty asset list and the caller's actionable error, not an ENOENT.
  const entries = yield* fs.readDirectory(releaseDir).pipe(Effect.orElseSucceed(() => []));
  const assets: string[] = [];
  for (const entry of entries) {
    if (!isNightlyReleaseAsset(entry)) continue;
    // Guard against stale artifacts from an earlier build sharing the directory.
    // The manifest is exempt: electron-builder names it by channel, not version.
    if (entry !== NIGHTLY_UPDATE_MANIFEST && !entry.includes(version)) continue;
    const stat = yield* fs
      .stat(path.join(releaseDir, entry))
      .pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;
    assets.push(path.join(releaseDir, entry));
  }
  return assets;
});

const command = Command.make(
  "publish-bk-desktop-dmg",
  {
    buildVersion: Flag.string("build-version").pipe(
      Flag.withDescription(
        "Nightly version that was built, for example 0.0.32-nightly.20260810.1.",
      ),
    ),
    releaseDir: Flag.string("release-dir").pipe(
      Flag.withDescription("Directory holding the built artifacts."),
      Flag.withDefault("release"),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Run every check and print the gh command without publishing."),
      Flag.withDefault(false),
    ),
  },
  ({ buildVersion, releaseDir, dryRun }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const version = buildVersion.trim();
      const tag = tagFromVersion(version);

      const parsed = parseNightlyVersion(version);
      if (!parsed) {
        return yield* new NotANightlyVersionError({ version });
      }

      // Guard 1: the tag must not be able to trigger release.yml.
      if (!isReleaseWorkflowSafeTag(tag)) {
        return yield* new UnsafeReleaseTagError({ tag });
      }

      const publishedTags = yield* listPublishedTags();
      if (publishedTags.some((published) => published.trim() === tag)) {
        return yield* new ReleaseTagAlreadyExistsError({ tag });
      }

      // Guard 2: the version must be strictly newer, or the updater ignores it.
      const newest = resolveNewestNightlyVersion(publishedTags);
      if (newest && compareNightlyVersions(parsed, newest) <= 0) {
        return yield* new ReleaseVersionNotNewerError({
          version,
          newestPublished: `${newest.baseVersion}-nightly.${newest.date}.${newest.counter}`,
        });
      }

      const resolvedReleaseDir = path.resolve(repoRoot, releaseDir);
      const assets = yield* collectAssets(resolvedReleaseDir, version);
      if (assets.length === 0) {
        return yield* new NoPublishableArtifactsError({
          version,
          releaseDir: resolvedReleaseDir,
        });
      }

      // Guard 3: without the manifest, the app can never see the update.
      if (!assets.some((asset) => path.basename(asset) === NIGHTLY_UPDATE_MANIFEST)) {
        return yield* new MissingUpdateManifestError({ releaseDir: resolvedReleaseDir });
      }

      const notes = [
        `Beknown fork desktop build of \`bkmain\`.`,
        ``,
        `Unsigned, Apple Silicon only. On first install macOS will quarantine it:`,
        ``,
        "```sh",
        `xattr -dr com.apple.quarantine "/Applications/BK T3 Code.app"`,
        "```",
        ``,
        `Later builds arrive through the in-app updater.`,
      ].join("\n");

      const ghArgs = [
        "release",
        "create",
        tag,
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--prerelease",
        "--title",
        `BK T3 Code ${version}`,
        "--notes",
        notes,
        ...assets,
      ];

      yield* Console.log(`Assets (${assets.length}):`);
      for (const asset of assets) {
        yield* Console.log(`  ${path.basename(asset)}`);
      }

      if (dryRun) {
        yield* Console.log(`\nDry run — would publish prerelease ${tag}:`);
        yield* Console.log(
          `  gh ${ghArgs.map((arg) => (arg === notes ? "<notes>" : arg)).join(" ")}`,
        );
        return;
      }

      const result = yield* runGh(ghArgs);
      if (result.exitCode !== 0) {
        return yield* new GhCommandFailedError({
          operation: "create-release",
          exitCode: result.exitCode,
          stderrTail: result.stderr.trim() || result.stdout.trim(),
        });
      }

      yield* Console.log(result.stdout.trim());
      yield* Console.log(
        `\nPublished prerelease ${tag}. Confirm release.yml did not run:\n` +
          `  gh run list --repo ${BK_DESKTOP_RELEASE_REPOSITORY} --workflow release.yml -L 3`,
      );
    }),
).pipe(Command.withDescription("Publish the Beknown desktop DMG as a GitHub prerelease."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
