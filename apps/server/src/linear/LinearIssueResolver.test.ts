// T3-CUSTOM(expbkt3): Bifrost result parsing coverage without network access.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseLinearToolResult } from "./LinearIssueResolver.ts";

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
