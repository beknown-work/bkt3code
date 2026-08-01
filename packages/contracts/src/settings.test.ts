import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_T3_CONDUCTOR_PERSONALITY,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings phase-grouped sidebar", () => {
  it("defaults the experiment off for legacy settings", () => {
    expect(decodeClientSettings({}).phaseGroupedSidebarEnabled).toBe(false);
    expect(decodeServerSettings({}).experimental.externalMcp).toEqual({
      enabled: false,
      apiKey: "",
      publicUrl: "",
    });
    // T3-CUSTOM(expbkt3): Legacy settings decode with Conductor safely disabled.
    expect(decodeServerSettings({}).experimental.t3Conductor).toEqual({
      enabled: false,
      threadId: "",
      workspacePath: "",
      linearIssueUrl: "",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      personalityInstructions: DEFAULT_T3_CONDUCTOR_PERSONALITY,
    });
  });

  it("accepts persisted values and client patches", () => {
    expect(
      decodeClientSettings({ phaseGroupedSidebarEnabled: true }).phaseGroupedSidebarEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ phaseGroupedSidebarEnabled: true }).phaseGroupedSidebarEnabled,
    ).toBe(true);
  });
});

// T3-CUSTOM(expbkt3): Contract coverage for the durable Conductor profile.
describe("ServerSettings T3 Conductor", () => {
  it("accepts an independently patchable orchestration profile", () => {
    expect(
      decodeServerSettingsPatch({
        experimental: {
          t3Conductor: {
            enabled: true,
            threadId: "conductor-1",
            workspacePath: "/workspace",
            linearIssueUrl: "https://linear.app/beknown/issue/TEC-123",
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.6-terra",
              options: [{ id: "effort", value: "medium" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            personalityInstructions: "Keep the team focused.",
          },
        },
      }).experimental?.t3Conductor,
    ).toEqual({
      enabled: true,
      threadId: "conductor-1",
      workspacePath: "/workspace",
      linearIssueUrl: "https://linear.app/beknown/issue/TEC-123",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-terra",
        options: [{ id: "effort", value: "medium" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      personalityInstructions: "Keep the team focused.",
    });
  });
});

describe("ClientSettings resource monitor", () => {
  it("defaults the experiment off for legacy settings", () => {
    expect(decodeClientSettings({}).resourceMonitorEnabled).toBe(false);
  });

  it("accepts persisted values and client patches", () => {
    expect(decodeClientSettings({ resourceMonitorEnabled: true }).resourceMonitorEnabled).toBe(
      true,
    );
    expect(decodeClientSettingsPatch({ resourceMonitorEnabled: true }).resourceMonitorEnabled).toBe(
      true,
    );
  });
});

describe("ClientSettings provider usage limits", () => {
  it("defaults the header indicator on for legacy settings", () => {
    expect(decodeClientSettings({}).providerRateLimitsEnabled).toBe(true);
  });

  it("accepts persisted values and client patches", () => {
    expect(
      decodeClientSettings({ providerRateLimitsEnabled: false }).providerRateLimitsEnabled,
    ).toBe(false);
    expect(
      decodeClientSettingsPatch({ providerRateLimitsEnabled: false }).providerRateLimitsEnabled,
    ).toBe(false);
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("treats settings written before the beta had a per-channel default as unconfigured", () => {
    // The stored blob always carries `sidebarV2Enabled`, so only the companion
    // flag can distinguish "user opted out" from "never touched it".
    expect(decodeClientSettings({ sidebarV2Enabled: false }).sidebarV2ConfiguredByUser).toBe(false);
    expect(decodeClientSettings({ sidebarV2Enabled: true }).sidebarV2ConfiguredByUser).toBe(false);
  });

  it("preserves an explicit beta choice", () => {
    const settings = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("carries an explicit beta opt-out through the patch the beta toggle writes", () => {
    const patch = decodeClientSettingsPatch({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(patch.sidebarV2Enabled).toBe(false);
    expect(patch.sidebarV2ConfiguredByUser).toBe(true);
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings source-control profiles", () => {
  it("defaults legacy installations to machine identity with no profiles", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlIdentityMode).toBe("machine");
    expect(settings.environmentUserIdentityMode).toBe("optional");
    expect(settings.sourceControlProfiles).toEqual({});
  });

  it("never retains credentials in profile metadata or serialized settings", () => {
    const secret = "github_pat_must_not_be_serialized";
    const settings = decodeServerSettings({
      sourceControlIdentityMode: "thread-profile",
      sourceControlProfiles: {
        alice: {
          id: "alice",
          provider: "github",
          label: "Alice",
          login: "alice",
          accountId: 42,
          avatarUrl: null,
          gitName: "Alice Example",
          gitEmail: "42+alice@users.noreply.github.com",
          archived: false,
          credential: secret,
          credentialStatus: "connected",
        },
      },
    });

    const [profile] = Object.values(settings.sourceControlProfiles);
    expect(profile?.ownerUserId).toBeNull();
    expect(profile).not.toHaveProperty("credential");
    expect(profile).not.toHaveProperty("credentialStatus");
    expect(JSON.stringify(encodeServerSettings(settings))).not.toContain(secret);
  });

  it("persists the collaborative Clerk identity mode and profile owner", () => {
    const settings = decodeServerSettings({
      environmentUserIdentityMode: "required",
      sourceControlProfiles: {
        alice: {
          id: "alice",
          provider: "github",
          label: "Alice",
          login: "alice",
          accountId: 42,
          avatarUrl: null,
          gitName: "Alice Example",
          gitEmail: "42+alice@users.noreply.github.com",
          ownerUserId: "user_clerk_alice",
          archived: false,
        },
      },
    });

    expect(settings.environmentUserIdentityMode).toBe("required");
    expect(Object.values(settings.sourceControlProfiles)[0]?.ownerUserId).toBe("user_clerk_alice");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
