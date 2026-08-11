#!/usr/bin/env node

/**
 * Builds the Beknown-branded macOS DMG from the current checkout.
 *
 * Must run on macOS: electron-builder cannot cross-compile a mac DMG, so this
 * fails fast anywhere else rather than producing something unusable.
 *
 *   node scripts/build-bk-desktop-dmg.ts                  # arm64 DMG, auto version
 *   node scripts/build-bk-desktop-dmg.ts --build-version 0.0.32-nightly.20260810.1
 *
 * See docs/operations/bk-desktop-build.md.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BK_DESKTOP_BRAND_ID,
  BK_DESKTOP_UPDATE_REPOSITORY,
  DESKTOP_BRAND_ENV_VAR,
} from "./lib/bk-desktop-brand.ts";
import {
  BK_DESKTOP_RELEASE_REPOSITORY,
  composeNightlyVersion,
  formatBuildDate,
  parseNightlyVersion,
  resolveNextCounter,
} from "./lib/bk-desktop-release.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { readDesktopBaseVersion } from "./resolve-nightly-release.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const GhReleaseList = Schema.Array(Schema.Struct({ tagName: Schema.String }));
const decodeGhReleaseList = Schema.decodeUnknownEffect(Schema.fromJsonString(GhReleaseList));

export class UnsupportedBuildHostError extends Schema.TaggedErrorClass<UnsupportedBuildHostError>()(
  "UnsupportedBuildHostError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return (
      `A macOS DMG can only be built on macOS (host is "${this.hostPlatform}"). ` +
      `electron-builder cannot cross-compile it. Run this on your Mac; ` +
      `see docs/operations/bk-desktop-build.md.`
    );
  }
}

export class InvalidBkBuildVersionError extends Schema.TaggedErrorClass<InvalidBkBuildVersionError>()(
  "InvalidBkBuildVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return (
      `--build-version must be a nightly version like 0.0.32-nightly.20260810.1, got ` +
      `"${this.version}". Fork builds must use the nightly channel or auto-update cannot ` +
      `see them; see scripts/lib/bk-desktop-release.ts.`
    );
  }
}

export class BuildNumberUnavailableError extends Schema.TaggedErrorClass<BuildNumberUnavailableError>()(
  "BuildNumberUnavailableError",
  {
    suggestedVersion: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Could not list releases from ${BK_DESKTOP_RELEASE_REPOSITORY} to pick the next build ` +
      `number. Authenticate with \`gh auth login\`, or pass ` +
      `--build-version ${this.suggestedVersion} explicitly.`
    );
  }
}

export class BkDesktopBuildFailedError extends Schema.TaggedErrorClass<BkDesktopBuildFailedError>()(
  "BkDesktopBuildFailedError",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop artifact build failed with exit code ${this.exitCode}.`;
  }
}

const forwardStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
): Effect.Effect<void, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.sync(() => output.write(chunk))),
  );

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

/**
 * Lists existing fork release tags so the build can pick the next counter.
 *
 * Returns `undefined` when `gh` is missing, unauthenticated, or returns something
 * unexpected. That is not fatal here — the caller turns it into an actionable
 * error telling the user to pass --build-version instead.
 */
const listPublishedTags = Effect.fn("listPublishedTags")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("gh", [
        "release",
        "list",
        "--repo",
        BK_DESKTOP_RELEASE_REPOSITORY,
        "--limit",
        "100",
        "--json",
        "tagName",
      ]),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return undefined;
    }
    const releases = yield* decodeGhReleaseList(stdout);
    return releases.map((release) => release.tagName);
  }).pipe(Effect.option);

  return Option.getOrUndefined(result);
});

const resolveBuildVersion = Effect.fn("resolveBuildVersion")(function* (
  requested: Option.Option<string>,
) {
  if (Option.isSome(requested)) {
    const version = requested.value.trim();
    if (!parseNightlyVersion(version)) {
      return yield* new InvalidBkBuildVersionError({ version });
    }
    return version;
  }

  const baseVersion = yield* readDesktopBaseVersion(undefined);
  const date = formatBuildDate(yield* DateTime.now);
  const publishedTags = yield* listPublishedTags();
  if (!publishedTags) {
    return yield* new BuildNumberUnavailableError({
      suggestedVersion: composeNightlyVersion(baseVersion, date, 1),
    });
  }

  return composeNightlyVersion(
    baseVersion,
    date,
    resolveNextCounter(publishedTags, baseVersion, date),
  );
});

const runBuild = Effect.fn("runBuild")(function* (options: {
  readonly version: string;
  readonly arch: string;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // loadRepoEnv folds .env/.env.local in and normalises the Clerk aliases, the
  // same way apps/web and apps/desktop resolve them at build time.
  const repoEnv = loadRepoEnv();
  const clerkPublishableKey = repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!clerkPublishableKey) {
    // Not fatal — the app still builds — but team mode silently disappears, which
    // is the exact trap called out in .github/workflows/deploy-bkt3.yml.
    yield* Console.warn(
      "WARNING: no Clerk publishable key resolved. This build will ship with team mode off: " +
        'no sign-in gate, no member tagging, no "Assigned to me". ' +
        "Set VITE_CLERK_PUBLISHABLE_KEY in .env.local to match the bkt3 deployment.",
    );
  }

  const buildEnv: Record<string, string | undefined> = {
    ...process.env,
    ...repoEnv,
    [DESKTOP_BRAND_ENV_VAR]: BK_DESKTOP_BRAND_ID,
    // Points electron-updater at the fork's releases instead of upstream's.
    T3CODE_DESKTOP_UPDATE_REPOSITORY: BK_DESKTOP_UPDATE_REPOSITORY,
    VITE_T3_EXPERIMENTAL_CONTROL_CENTER: "true",
    ...(clerkPublishableKey
      ? {
          VITE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
          T3CODE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
        }
      : {}),
  };

  const args = [
    path.join(repoRoot, "scripts/build-desktop-artifact.ts"),
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    options.arch,
    "--build-version",
    options.version,
    ...(options.verbose ? ["--verbose"] : []),
  ];

  const spawnCommand = yield* resolveSpawnCommand("node", args, { env: buildEnv });
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: spawnCommand.shell,
    }),
  );
  const [, , exitCode] = yield* Effect.all(
    [
      forwardStream(child.stdout, process.stdout),
      forwardStream(child.stderr, process.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BkDesktopBuildFailedError({ exitCode });
  }
});

const command = Command.make(
  "build-bk-desktop-dmg",
  {
    buildVersion: Flag.string("build-version").pipe(
      Flag.withDescription("Nightly version to stamp, for example 0.0.32-nightly.20260810.1."),
      Flag.optional,
    ),
    arch: Flag.string("arch").pipe(
      Flag.withDescription("Target architecture (arm64 or x64)."),
      Flag.withDefault("arm64"),
    ),
    verbose: Flag.boolean("verbose").pipe(
      Flag.withDescription("Stream electron-builder output."),
      Flag.withDefault(true),
    ),
  },
  ({ buildVersion, arch, verbose }) =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform !== "darwin") {
        return yield* new UnsupportedBuildHostError({ hostPlatform });
      }

      const version = yield* resolveBuildVersion(buildVersion);
      yield* Console.log(`Building BK T3 Code ${version} (mac/${arch}, unsigned)...`);
      yield* runBuild({ version, arch, verbose });
      yield* Console.log(
        `Done. Artifacts are in release/. Publish them with:\n` +
          `  node scripts/publish-bk-desktop-dmg.ts --build-version ${version}`,
      );
    }),
).pipe(Command.withDescription("Build the Beknown-branded macOS desktop DMG."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
