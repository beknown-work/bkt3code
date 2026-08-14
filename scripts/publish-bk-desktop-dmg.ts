#!/usr/bin/env node

/**
 * Publishes a built Beknown desktop DMG as a GitHub prerelease teammates can
 * download, and that the in-app updater can then read.
 *
 *   node scripts/publish-bk-desktop-dmg.ts --channel staging \
 *     --build-version 0.0.32-staging-nightly.20260810.1
 *   node scripts/publish-bk-desktop-dmg.ts --channel production ... --dry-run
 *
 * Both fork apps publish into the same repository, separated only by the
 * updater channel, so every guard below is channel-aware. In order — each exists
 * because getting it wrong is expensive:
 *
 * - The tag must be nightly-form, so `.github/workflows/release.yml` cannot fire.
 *   That workflow has no dry-run mode; a wrong tag publishes `t3` to npm, cuts a
 *   public GitHub Release and re-aliases app.t3.codes.
 * - The version's channel must be the channel being published, or the other
 *   app's users get offered this build.
 * - The version must be strictly newer than the newest published one *on this
 *   channel*, or the updater will not offer it.
 * - The build must be code signed, or Squirrel.Mac cannot install it as an
 *   update over an already-installed app.
 * - `<channel>-mac.yml` must be present, or auto-update silently does nothing.
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

import { BK_DESKTOP_BRANDS } from "./lib/bk-desktop-brand.ts";
import { isBkManagedChannel, type BkManagedChannel } from "./lib/bk-managed-environment.ts";
import {
  BK_DESKTOP_RELEASE_REPOSITORY,
  compareNightlyVersions,
  isNightlyReleaseAsset,
  isReleaseWorkflowSafeTag,
  parseNightlyVersion,
  resolveNewestNightlyVersion,
  tagFromVersion,
  updateManifestFileName,
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
    manifest: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.manifest} is missing from ${this.releaseDir}. Without it auto-update ` +
      `silently does nothing. Rebuild with scripts/build-bk-desktop-dmg.ts, which configures ` +
      `the channel.`
    );
  }
}

export class InvalidPublishChannelError extends Schema.TaggedErrorClass<InvalidPublishChannelError>()(
  "InvalidPublishChannelError",
  {
    channel: Schema.String,
  },
) {
  override get message(): string {
    return `--channel must be staging or production, got "${this.channel}".`;
  }
}

export class PublishChannelMismatchError extends Schema.TaggedErrorClass<PublishChannelMismatchError>()(
  "PublishChannelMismatchError",
  {
    version: Schema.String,
    channel: Schema.String,
    versionChannel: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.version} is a ${this.versionChannel} build, but --channel is ${this.channel}. ` +
      `Publishing it would attach ${this.versionChannel} artifacts to the ${this.channel} ` +
      `channel, and the wrong app's users would be offered it.`
    );
  }
}

export class UnsignedBuildError extends Schema.TaggedErrorClass<UnsignedBuildError>()(
  "UnsignedBuildError",
  {
    appPath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${this.appPath} is not code signed (${this.detail}). Squirrel.Mac validates an update ` +
      `against the installed app's designated requirement, so publishing this would break ` +
      `auto-update for everyone already on this channel. Rebuild with ` +
      `T3CODE_BK_SIGNING_IDENTITY set; see docs/operations/bk-desktop-build.md.`
    );
  }
}

export class BuiltAppNotFoundError extends Schema.TaggedErrorClass<BuiltAppNotFoundError>()(
  "BuiltAppNotFoundError",
  {
    releaseDir: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Could not find a built .app under ${this.releaseDir} to verify its signature. ` +
      `Expected electron-builder's mac-<arch>/ output next to the artifacts.`
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

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: process.env });
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

const runGh = (args: ReadonlyArray<string>) => runCommand("gh", args);

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

const collectAssets = Effect.fn("collectAssets")(function* (
  releaseDir: string,
  version: string,
  variant: BkManagedChannel,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = updateManifestFileName(variant);

  // A missing directory is the ordinary "you have not built yet" case, so it
  // becomes an empty asset list and the caller's actionable error, not an ENOENT.
  const entries = yield* fs.readDirectory(releaseDir).pipe(Effect.orElseSucceed(() => []));
  const assets: string[] = [];
  for (const entry of entries) {
    if (!isNightlyReleaseAsset(entry, variant)) continue;
    // Guard against stale artifacts from an earlier build sharing the directory —
    // including a build of the *other* fork app, whose manifest sits right beside
    // this one's. The manifest is exempt from the version check because
    // electron-builder names it by channel, not version, so it is matched by its
    // exact channel-specific name instead.
    if (entry !== manifest && !entry.includes(version)) continue;
    const stat = yield* fs
      .stat(path.join(releaseDir, entry))
      .pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;
    assets.push(path.join(releaseDir, entry));
  }
  return assets;
});

/**
 * Locates the packaged `.app` electron-builder left beside the artifacts.
 *
 * electron-builder stages it under `mac-<arch>/` (or plain `mac/` for x64), so
 * scan for the first directory entry ending in `.app` one level down.
 */
const findBuiltApp = Effect.fn("findBuiltApp")(function* (releaseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(releaseDir).pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    if (!entry.startsWith("mac")) continue;
    const nested = yield* fs
      .readDirectory(path.join(releaseDir, entry))
      .pipe(Effect.orElseSucceed(() => []));
    for (const candidate of nested) {
      if (candidate.endsWith(".app")) return path.join(releaseDir, entry, candidate);
    }
  }
  return undefined;
});

/**
 * Refuses to publish an unsigned build.
 *
 * This is the guard that keeps auto-update working. An unsigned app has no
 * designated requirement, so Squirrel.Mac cannot validate an update against it
 * — the download succeeds, the install silently does not, and the only symptom
 * is teammates quietly staying on an old version.
 */
const assertSignedBuild = Effect.fn("assertSignedBuild")(function* (releaseDir: string) {
  const appPath = yield* findBuiltApp(releaseDir);
  if (!appPath) {
    return yield* new BuiltAppNotFoundError({ releaseDir });
  }

  const result = yield* runCommand("codesign", ["--verify", "--strict", appPath]);
  if (result.exitCode !== 0) {
    return yield* new UnsignedBuildError({
      appPath,
      detail: result.stderr.trim().split("\n").at(-1) ?? `codesign exited ${result.exitCode}`,
    });
  }
  return appPath;
});

const command = Command.make(
  "publish-bk-desktop-dmg",
  {
    buildVersion: Flag.string("build-version").pipe(
      Flag.withDescription(
        "Version that was built, for example 0.0.32-staging-nightly.20260810.1.",
      ),
    ),
    channel: Flag.string("channel").pipe(
      Flag.withDescription(
        "Which fork app is being published: staging or production. Must match the version.",
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
  ({ buildVersion, channel, releaseDir, dryRun }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const version = buildVersion.trim();
      const tag = tagFromVersion(version);

      const requestedChannel = channel.trim().toLowerCase();
      if (!isBkManagedChannel(requestedChannel)) {
        return yield* new InvalidPublishChannelError({ channel: requestedChannel });
      }
      const variant: BkManagedChannel = requestedChannel;
      const brand = BK_DESKTOP_BRANDS[variant];
      const manifest = updateManifestFileName(variant);

      const parsed = parseNightlyVersion(version);
      if (!parsed) {
        return yield* new NotANightlyVersionError({ version });
      }

      // Guard 1: the tag must not be able to trigger release.yml.
      if (!isReleaseWorkflowSafeTag(tag)) {
        return yield* new UnsafeReleaseTagError({ tag });
      }

      // Guard 2: the version's channel decides which app picks this up, so it
      // has to be the channel being published.
      if (parsed.variant !== variant) {
        return yield* new PublishChannelMismatchError({
          version,
          channel: variant,
          versionChannel: parsed.variant,
        });
      }

      const publishedTags = yield* listPublishedTags();
      if (publishedTags.some((published) => published.trim() === tag)) {
        return yield* new ReleaseTagAlreadyExistsError({ tag });
      }

      // Guard 3: the version must be strictly newer *within its own channel*, or
      // the updater ignores it. The other app's releases are irrelevant here.
      const newest = resolveNewestNightlyVersion(publishedTags, variant);
      if (newest && compareNightlyVersions(parsed, newest) <= 0) {
        return yield* new ReleaseVersionNotNewerError({
          version,
          newestPublished: `${newest.baseVersion}-${brand.updateChannel}.${newest.date}.${newest.counter}`,
        });
      }

      const resolvedReleaseDir = path.resolve(repoRoot, releaseDir);

      // Guard 4: an unsigned build cannot be installed as an update.
      const signedAppPath = yield* assertSignedBuild(resolvedReleaseDir);

      const assets = yield* collectAssets(resolvedReleaseDir, version, variant);
      if (assets.length === 0) {
        return yield* new NoPublishableArtifactsError({
          version,
          releaseDir: resolvedReleaseDir,
        });
      }

      // Guard 5: without the manifest, the app can never see the update.
      if (!assets.some((asset) => path.basename(asset) === manifest)) {
        return yield* new MissingUpdateManifestError({
          releaseDir: resolvedReleaseDir,
          manifest,
        });
      }

      const sourceBranch = variant === "staging" ? "expbkmain" : "bkmain";
      const notes = [
        `Beknown fork desktop build of \`${sourceBranch}\` — **${brand.productName}**.`,
        ``,
        `Self-signed, Apple Silicon only. On first install macOS will quarantine it:`,
        ``,
        "```sh",
        `xattr -dr com.apple.quarantine "/Applications/${brand.productName}.app"`,
        "```",
        ``,
        `Later builds arrive through the in-app updater: the app notifies you when one is ` +
          `ready, and clicking the notification restarts into it.`,
      ].join("\n");

      const ghArgs = [
        "release",
        "create",
        tag,
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--prerelease",
        "--title",
        `${brand.productName} ${version}`,
        "--notes",
        notes,
        ...assets,
      ];

      yield* Console.log(`Signature verified: ${path.basename(signedAppPath)}`);

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
