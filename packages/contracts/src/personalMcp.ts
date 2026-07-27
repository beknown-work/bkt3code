/**
 * T3-CUSTOM(expbkt3): Per-user T3 automation and MCP integration contracts.
 *
 * These schemas deliberately contain credential metadata only. Credential
 * values are accepted by update inputs, written to the server secret store,
 * and never returned to a client.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString, UserId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_T3_CONDUCTOR_PERSONALITY, T3ConductorSettings } from "./settings.ts";

export const PersonalMcpAuthMode = Schema.Literals([
  "bearer",
  "x-bf-vk",
  "x-api-key",
  "custom-header",
]);
export type PersonalMcpAuthMode = typeof PersonalMcpAuthMode.Type;

export const PersonalMcpIntegrationId = TrimmedNonEmptyString;
export type PersonalMcpIntegrationId = typeof PersonalMcpIntegrationId.Type;

export const PersonalMcpIntegration = Schema.Struct({
  id: PersonalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  authMode: PersonalMcpAuthMode,
  customHeaderName: TrimmedString,
  credentialConfigured: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  allowedTools: Schema.Array(TrimmedNonEmptyString),
});
export type PersonalMcpIntegration = typeof PersonalMcpIntegration.Type;

export const PersonalMcpIntegrationUpdate = Schema.Struct({
  id: PersonalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  authMode: PersonalMcpAuthMode,
  customHeaderName: TrimmedString,
  /** Undefined preserves the existing secret; empty removes it. */
  credential: Schema.optional(Schema.String),
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  allowedTools: Schema.Array(TrimmedNonEmptyString),
});
export type PersonalMcpIntegrationUpdate = typeof PersonalMcpIntegrationUpdate.Type;

export const DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS = T3ConductorSettings.make({
  enabled: false,
  threadId: "",
  workspacePath: "",
  linearIssueUrl: "",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  personalityInstructions: DEFAULT_T3_CONDUCTOR_PERSONALITY,
});

export const PersonalMcpProfile = Schema.Struct({
  userId: UserId,
  conductor: T3ConductorSettings,
  externalAccessEnabled: Schema.Boolean,
  externalTokenConfigured: Schema.Boolean,
  externalTokenPrefix: TrimmedString,
  integrations: Schema.Array(PersonalMcpIntegration),
  updatedAt: IsoDateTime,
});
export type PersonalMcpProfile = typeof PersonalMcpProfile.Type;

export const PersonalMcpProfileUpdate = Schema.Struct({
  conductor: T3ConductorSettings,
  externalAccessEnabled: Schema.Boolean,
  integrations: Schema.Array(PersonalMcpIntegrationUpdate),
});
export type PersonalMcpProfileUpdate = typeof PersonalMcpProfileUpdate.Type;

export const PersonalMcpTokenResult = Schema.Struct({
  profile: PersonalMcpProfile,
  /** Present only for the rotate response. T3 never persists the raw token. */
  token: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalMcpTokenResult = typeof PersonalMcpTokenResult.Type;

export class PersonalMcpSettingsError extends Schema.TaggedErrorClass<PersonalMcpSettingsError>()(
  "PersonalMcpSettingsError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}

export const emptyPersonalMcpProfile = (userId: UserId, updatedAt: string): PersonalMcpProfile => ({
  userId,
  conductor: DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS,
  externalAccessEnabled: false,
  externalTokenConfigured: false,
  externalTokenPrefix: "",
  integrations: [],
  updatedAt: IsoDateTime.make(updatedAt),
});
