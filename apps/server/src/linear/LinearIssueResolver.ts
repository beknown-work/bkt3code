/**
 * T3-CUSTOM(expbkt3): Resolve compact Linear status through the signed-in
 * user's Bifrost integration. Credentials stay server-side and response bodies
 * are never logged because Linear issue descriptions may contain customer data.
 */
import {
  BIFROST_MCP_INTEGRATION_ID,
  BIFROST_MCP_URL,
  PersonalMcpIntegrationId,
  type LinearIssueStatusResult,
  type LinearIssueStatusSummary,
  type UserId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type * as UserMcpProfileStore from "../mcp/UserMcpProfileStore.ts";

const LINEAR_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/u;
const MAX_ISSUES_PER_REQUEST = 25;

const ToolCallResponse = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const ToolIssue = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  statusType: Schema.optional(Schema.String),
  url: Schema.String,
  updatedAt: Schema.optional(Schema.String),
});
const ToolIssueJson = Schema.fromJsonString(ToolIssue);

const unavailable = (identifier: string, error: string): LinearIssueStatusSummary => ({
  identifier,
  url: null,
  status: null,
  statusType: null,
  updatedAt: null,
  error,
});

export const parseLinearToolResult = Effect.fn("LinearIssueResolver.parseToolResult")(function* (
  content: string,
) {
  const marker = "Return value: ";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return yield* Effect.fail(new Error("Bifrost returned no Linear result."));
  const start = markerIndex + marker.length;
  const environmentIndex = content.indexOf("\n\nEnvironment:", start);
  const json = content.slice(start, environmentIndex < 0 ? undefined : environmentIndex).trim();
  return yield* Schema.decodeUnknownEffect(ToolIssueJson)(json).pipe(
    Effect.mapError(() => new Error("Bifrost returned an invalid Linear result.")),
  );
});

const resolveOne = Effect.fn("LinearIssueResolver.resolveOne")(function* (
  httpClient: HttpClient.HttpClient,
  credential: string,
  identifier: string,
) {
  const code = [
    `issue = LinearForUsers.get_issue(id=${JSON.stringify(identifier)})`,
    'result = {"id": issue.get("id"), "status": issue.get("status"), "statusType": issue.get("statusType"), "url": issue.get("url"), "updatedAt": issue.get("updatedAt")}',
  ].join("\n");
  const request = HttpClientRequest.post(BIFROST_MCP_URL).pipe(
    HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
    HttpClientRequest.setHeader("x-bf-vk", credential),
    HttpClientRequest.bodyJsonUnsafe({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "executeToolCode", arguments: { code } },
    }),
  );
  const response = yield* httpClient.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(new Error(`Bifrost returned HTTP ${response.status}.`));
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ToolCallResponse)(response);
  const content = body.result.content.find(
    (entry): entry is typeof entry & { readonly text: string } =>
      entry.type === "text" && entry.text !== undefined,
  )?.text;
  if (content === undefined)
    return yield* Effect.fail(new Error("Bifrost returned no text result."));
  const issue = yield* parseLinearToolResult(content);
  return {
    identifier: issue.id.toUpperCase(),
    url: issue.url,
    status: issue.status,
    statusType: issue.statusType ?? null,
    updatedAt: issue.updatedAt ?? null,
    error: null,
  } satisfies LinearIssueStatusSummary;
});

export const resolveLinearIssueStatuses = Effect.fn("LinearIssueResolver.resolveStatuses")(
  function* (input: {
    readonly userId: UserId;
    readonly identifiers: ReadonlyArray<string>;
    readonly profiles: UserMcpProfileStore.UserMcpProfileStore["Service"];
    readonly httpClient: HttpClient.HttpClient;
  }) {
    const identifiers = [
      ...new Set(input.identifiers.map((identifier) => identifier.trim().toUpperCase())),
    ].slice(0, MAX_ISSUES_PER_REQUEST);
    const validIdentifiers = identifiers.filter((identifier) =>
      LINEAR_IDENTIFIER_PATTERN.test(identifier),
    );
    const invalid = identifiers
      .filter((identifier) => !LINEAR_IDENTIFIER_PATTERN.test(identifier))
      .map((identifier) => unavailable(identifier, "Invalid Linear issue identifier."));
    if (validIdentifiers.length === 0) return { issues: invalid } satisfies LinearIssueStatusResult;

    const configured = yield* input.profiles.get(input.userId).pipe(
      Effect.map((profile) =>
        profile.integrations.some(
          (item) =>
            item.id === BIFROST_MCP_INTEGRATION_ID && item.enabled && item.credentialConfigured,
        ),
      ),
      Effect.catch(() => Effect.succeed(false)),
    );
    const credential = configured
      ? yield* input.profiles
          .getIntegrationCredential(
            input.userId,
            PersonalMcpIntegrationId.make(BIFROST_MCP_INTEGRATION_ID),
          )
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
    if (!credential) {
      return {
        issues: [
          ...invalid,
          ...validIdentifiers.map((identifier) =>
            unavailable(identifier, "Configure and enable Bifrost to read Linear status."),
          ),
        ],
      } satisfies LinearIssueStatusResult;
    }

    const resolved = yield* Effect.forEach(
      validIdentifiers,
      (identifier) =>
        resolveOne(input.httpClient, credential, identifier).pipe(
          Effect.timeout("12 seconds"),
          Effect.catchAllCause((cause) =>
            Effect.succeed(
              unavailable(
                identifier,
                Cause.isInterruptedOnly(cause)
                  ? "Linear status request timed out."
                  : "Linear status is temporarily unavailable.",
              ),
            ),
          ),
        ),
      { concurrency: 2 },
    );
    return { issues: [...invalid, ...resolved] } satisfies LinearIssueStatusResult;
  },
);
