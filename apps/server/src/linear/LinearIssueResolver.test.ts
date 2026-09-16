// T3-CUSTOM(expbkt3): Bifrost result parsing coverage without network access.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BIFROST_MCP_INTEGRATION_ID, UserId } from "@t3tools/contracts";
import type { HttpClient } from "effect/unstable/http";

import { parseLinearToolResult, resolveLinearIssueStatuses } from "./LinearIssueResolver.ts";
import { makeLinearIssueStatusCache } from "./LinearIssueStatusCache.ts";

it.effect("parses only the reduced Linear return value", () =>
  Effect.gen(function* () {
    const issue = yield* parseLinearToolResult(
      'Print output: [TOOL] omitted\nReturn value: {"id":"TEC-811","status":"Today\'s ToDo","statusType":"unstarted","url":"https://linear.app/beknown/issue/TEC-811","updatedAt":"2026-08-03T10:00:00.000Z"}\n\nEnvironment: code mode',
    );
    expect(issue).toEqual({
      id: "TEC-811",
      status: "Today's ToDo",
      statusType: "unstarted",
      url: "https://linear.app/beknown/issue/TEC-811",
      updatedAt: "2026-08-03T10:00:00.000Z",
    });
  }),
);

it.effect("rejects a response without a reduced return value", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseLinearToolResult("Print output only"));
    expect(exit._tag).toBe("Failure");
  }),
);

// T3-CUSTOM(expbkt3): BEGIN — the cache seam in front of Bifrost.
const userId = UserId.make("user-cache-test");

/** A credentialed profile, so the resolver reaches the fetch path at all. */
const profiles = {
  get: () =>
    Effect.succeed({
      integrations: [{ id: BIFROST_MCP_INTEGRATION_ID, enabled: true, credentialConfigured: true }],
    }),
  getIntegrationCredential: () => Effect.succeed("virtual-key"),
} as unknown as Parameters<typeof resolveLinearIssueStatuses>[0]["profiles"];

/** Any outbound read is a failure of the thing under test. */
const forbiddenHttpClient = {
  execute: () => Effect.die(new Error("the resolver went to Bifrost for a cached issue")),
} as unknown as HttpClient.HttpClient;

it.effect("serves a warm identifier without going to Bifrost", () =>
  Effect.gen(function* () {
    const cache = yield* makeLinearIssueStatusCache();
    yield* cache.resolve(["TEC-811"], (missing) =>
      Effect.succeed(
        missing.map((identifier) => ({
          identifier,
          url: "https://linear.app/beknown/issue/TEC-811",
          status: "Implementing",
          statusType: "started",
          updatedAt: "2026-09-16T00:00:00.000Z",
          error: null,
        })),
      ),
    );

    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["TEC-811"],
      profiles,
      httpClient: forbiddenHttpClient,
      cache,
    });

    expect(result.issues).toEqual([
      {
        identifier: "TEC-811",
        url: "https://linear.app/beknown/issue/TEC-811",
        status: "Implementing",
        statusType: "started",
        updatedAt: "2026-09-16T00:00:00.000Z",
        error: null,
      },
    ]);
  }),
);

it.effect("still rejects a malformed identifier before any cache lookup", () =>
  Effect.gen(function* () {
    const cache = yield* makeLinearIssueStatusCache();
    const result = yield* resolveLinearIssueStatuses({
      userId,
      identifiers: ["not-an-identifier"],
      profiles,
      httpClient: forbiddenHttpClient,
      cache,
    });

    expect(result.issues[0]?.error).toBe("Invalid Linear issue identifier.");
  }),
);
// T3-CUSTOM(expbkt3): END
