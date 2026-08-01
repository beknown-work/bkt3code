// T3-CUSTOM(expbkt3): coverage for attaching a thread to an external session.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "@effect/vitest";

import {
  ExternalSessionAttachmentError,
  buildExternalResumeCursor,
  claudeProjectSlug,
  normalizeExternalSessionId,
  probeExternalSessionArtifact,
} from "./externalSessionAttachment.ts";

const SESSION_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("normalizeExternalSessionId", () => {
  it("accepts a bare uuid", () => {
    expect(normalizeExternalSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(normalizeExternalSessionId(`  ${SESSION_ID}  `)).toBe(SESSION_ID);
  });

  it("extracts the id from shapes users actually paste", () => {
    // A Codex rollout filename and a full Claude transcript path both carry
    // the id; making the user dig it out would be pointless friction.
    expect(normalizeExternalSessionId(`rollout-2026-01-01T10-00-00-${SESSION_ID}.jsonl`)).toBe(
      SESSION_ID,
    );
    expect(
      normalizeExternalSessionId(`/home/me/.claude/projects/-home-me-repo/${SESSION_ID}.jsonl`),
    ).toBe(SESSION_ID);
  });

  it("uppercases are normalized, garbage is rejected", () => {
    expect(normalizeExternalSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID);
    expect(normalizeExternalSessionId("not-a-session")).toBe(null);
    expect(normalizeExternalSessionId("")).toBe(null);
  });
});

describe("buildExternalResumeCursor", () => {
  it("builds the cursor shape the Claude adapter already reads", () => {
    expect(buildExternalResumeCursor("claudeAgent", SESSION_ID)).toEqual({
      cursor: { resume: SESSION_ID },
      normalizedSessionId: SESSION_ID,
    });
  });

  it("builds the cursor shape the Codex runtime already reads", () => {
    expect(buildExternalResumeCursor("codex", SESSION_ID)).toEqual({
      cursor: { threadId: SESSION_ID },
      normalizedSessionId: SESSION_ID,
    });
  });

  it("rejects an unusable id before a thread is ever created", () => {
    expect(() => buildExternalResumeCursor("claudeAgent", "nope")).toThrow(
      ExternalSessionAttachmentError,
    );
    expect(() => buildExternalResumeCursor("codex", "nope")).toThrow(
      ExternalSessionAttachmentError,
    );
  });

  it("refuses providers whose resume contract is not seeded yet", () => {
    expect(() => buildExternalResumeCursor("cursor", SESSION_ID)).toThrow(/not supported/i);
  });
});

describe("claudeProjectSlug", () => {
  it("slugifies a cwd the way Claude stores its transcripts", () => {
    expect(claudeProjectSlug("/home/me/repos/app")).toBe("-home-me-repos-app");
    expect(claudeProjectSlug("/home/me/.t3/wt")).toBe("-home-me--t3-wt");
  });
});

describe("probeExternalSessionArtifact", () => {
  it.effect("finds a Claude transcript in the matching project directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attach-claude-" });
      const cwd = "/home/me/repos/app";
      const projectDir = path.join(home, ".claude", "projects", claudeProjectSlug(cwd));
      yield* fs.makeDirectory(projectDir, { recursive: true });
      yield* fs.writeFileString(path.join(projectDir, `${SESSION_ID}.jsonl`), "{}");

      expect(
        yield* probeExternalSessionArtifact({
          driverKind: "claudeAgent",
          sessionId: SESSION_ID,
          cwd,
          homePath: home,
        }),
      ).toBe("found");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports a missing transcript when the project directory exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attach-claude-miss-" });
      const cwd = "/home/me/repos/app";
      yield* fs.makeDirectory(path.join(home, ".claude", "projects", claudeProjectSlug(cwd)), {
        recursive: true,
      });

      // Claude has run here, so an absent transcript is real evidence the id
      // is wrong — not merely inconclusive.
      expect(
        yield* probeExternalSessionArtifact({
          driverKind: "claudeAgent",
          sessionId: SESSION_ID,
          cwd,
          homePath: home,
        }),
      ).toBe("missing");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stays inconclusive when the provider has never run for this cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attach-unknown-" });

      expect(
        yield* probeExternalSessionArtifact({
          driverKind: "claudeAgent",
          sessionId: SESSION_ID,
          cwd: "/home/me/repos/never-used",
          homePath: home,
        }),
      ).toBe("unknown");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("finds a Codex rollout nested under its date directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attach-codex-" });
      const dayDir = path.join(home, ".codex", "sessions", "2026", "01", "01");
      yield* fs.makeDirectory(dayDir, { recursive: true });
      yield* fs.writeFileString(path.join(dayDir, `rollout-10-00-00-${SESSION_ID}.jsonl`), "{}");

      expect(
        yield* probeExternalSessionArtifact({
          driverKind: "codex",
          sessionId: SESSION_ID,
          cwd: "/home/me/repos/app",
          homePath: home,
        }),
      ).toBe("found");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports a missing Codex rollout, guarding the silent fresh-thread fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attach-codex-miss-" });
      yield* fs.makeDirectory(path.join(home, ".codex", "sessions", "2026"), { recursive: true });

      expect(
        yield* probeExternalSessionArtifact({
          driverKind: "codex",
          sessionId: SESSION_ID,
          cwd: "/home/me/repos/app",
          homePath: home,
        }),
      ).toBe("missing");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
