import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("defaults to automatic pricing and round-trips arbitrary model IDs", () => {
    expect(decodeServerSettings({}).usagePriceOverrides).toEqual({});
    const settings = decodeServerSettings({
      usagePriceOverrides: { "  vendor/example-model  ": prices },
    });
    expect(encodeServerSettings(settings).usagePriceOverrides).toEqual({
      "vendor/example-model": prices,
    });
  });

  it("accepts zero rates, optional cache rates, and per-model deletion", () => {
    const overrides = {
      "example-model": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
      "removed-model": null,
    };
    expect(
      decodeServerSettingsPatch({ usagePriceOverrides: overrides }).usagePriceOverrides,
    ).toEqual(overrides);
  });

  it.each([
    "inputCostPerMillionTokens",
    "outputCostPerMillionTokens",
    "cacheReadCostPerMillionTokens",
    "cacheWriteCostPerMillionTokens",
  ])("rejects invalid %s rates at the settings boundary", (field) => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      const usagePriceOverrides = { "example-model": { ...prices, [field]: value } };
      expect(() => decodeServerSettings({ usagePriceOverrides })).toThrow();
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("accepts entries at the settings patch boundary", () => {
    expect(
      decodeServerSettingsPatch({
        providers: { codex: { customModels: [{ slug: "x", capabilities }] } },
      }).providers?.codex?.customModels,
    ).toEqual([{ slug: "x", capabilities }]);
    expect(() =>
      decodeServerSettingsPatch({ providers: { codex: { customModels: [{ name: "no slug" }] } } }),
    ).toThrow();
  });
});

describe("ClaudeSettings auto-compaction", () => {
  it("uses Claude's default threshold when no override is configured", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "300000", "1000000"])(
    "accepts a supported auto-compaction threshold: %s",
    (value) => {
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    },
  );

  it.each(["99999", "1000001", "300k", "invalid"])(
    "rejects an unsupported auto-compaction threshold: %s",
    (value) => {
      expect(() => decodeClaudeSettings({ autoCompactWindow: value })).toThrow();
    },
  );

  it("rejects an unsupported threshold at the settings patch boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300k" } } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300000" } } }),
    ).toBeDefined();
  });
});

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

describe("ClientSettings proactive panels", () => {
  it("is opt-in and accepts client-local updates", () => {
    expect(decodeClientSettings({}).proactivePanelsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({ proactivePanelsEnabled: true }).proactivePanelsEnabled).toBe(
      true,
    );
  });
});

describe("ClientSettings quit confirmation", () => {
  it("defaults to hold", () => {
    expect(decodeClientSettings({}).confirmQuit).toBe("hold");
  });

  it.each(["direct", "hold", "double-click"] as const)("accepts the %s mode", (mode) => {
    expect(decodeClientSettings({ confirmQuit: mode }).confirmQuit).toBe(mode);
    expect(decodeClientSettingsPatch({ confirmQuit: mode }).confirmQuit).toBe(mode);
  });

  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });

  it("rejects legacy booleans at the patch boundary", () => {
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ClientSettings browser recording frame rate", () => {
  it("defaults to 30 fps", () => {
    expect(decodeClientSettings({}).browserRecordingFrameRate).toBe(30);
  });

  it.each([30, 60])("accepts a supported frame rate: %s", (frameRate) => {
    expect(
      decodeClientSettings({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
    expect(
      decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
  });

  it.each([24, 59, 120])("rejects an unsupported frame rate: %s", (frameRate) => {
    expect(() => decodeClientSettings({ browserRecordingFrameRate: frameRate })).toThrow();
    expect(() => decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate })).toThrow();
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

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
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

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar", () => {
    expect(decodeClientSettings({}).legacySidebarEnabled).toBe(false);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });
});

describe("ClientSettings context window meter", () => {
  it("defaults off and preserves an explicit legacy opt-in", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings composer collapse", () => {
  it("collapses on blur and scroll by default and accepts opting out of each", () => {
    const defaults = decodeClientSettings({});
    expect(defaults.composerCollapseOnBlur).toBe(true);
    expect(defaults.composerCollapseOnScroll).toBe(true);

    const blurOff = decodeClientSettings({ composerCollapseOnBlur: false });
    expect(blurOff.composerCollapseOnBlur).toBe(false);
    expect(blurOff.composerCollapseOnScroll).toBe(true);

    expect(
      decodeClientSettingsPatch({ composerCollapseOnScroll: false }).composerCollapseOnScroll,
    ).toBe(false);
  });
});

describe("ServerSettings thread settlement", () => {
  it("defaults merge settlement on and inactivity settlement to three days", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

// T3-CUSTOM(expbkt3): BEGIN — the fork keeps plan mode as a first-class feature.
// Upstream retired it behind an off-by-default flag; these lock the fork default
// so a later upstream merge cannot silently switch plan mode off again.
describe("ClientSettings plan mode", () => {
  it("defaults plan mode on", () => {
    expect(decodeClientSettings({}).planModeAvailable).toBe(true);
  });

  it("drops upstream's retired planModeEnabled key, resetting everyone to on", () => {
    const decoded = decodeClientSettings({ planModeEnabled: false });
    expect(decoded.planModeAvailable).toBe(true);
    expect(decoded).not.toHaveProperty("planModeEnabled");
  });

  it("preserves an explicit opt-out", () => {
    expect(decodeClientSettings({ planModeAvailable: false }).planModeAvailable).toBe(false);
    expect(decodeClientSettingsPatch({ planModeAvailable: false }).planModeAvailable).toBe(false);
  });
});
// T3-CUSTOM(expbkt3): END

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

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

describe("provider enabled defaults", () => {
  it("enables only the stable bindings by default", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.claudeAgent.enabled).toBe(true);
    expect(decoded.providers.cursor.enabled).toBe(false);
    expect(decoded.providers.grok.enabled).toBe(false);
    expect(decoded.providers.opencode.enabled).toBe(false);
  });

  it("keeps Cursor enabled when an existing user explicitly opted in", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = ProviderInstanceId.make("cursor");
    const decoded = decodeServerSettings({
      providers: { cursor: { enabled: true } },
      providerInstances: {
        [cursorId]: { driver: cursor, enabled: true, config: {} },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(resolveProviderInstanceEnabled(decoded.providerInstances[cursorId]!)).toBe(true);
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    // No flags anywhere: driver default applies.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Unknown fork drivers stay enabled.
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    // Envelope flag wins over the driver default.
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    // Legacy in-config flag fills in when the envelope is silent.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    // Conflicting flags: the explicit false wins, whichever side it is on.
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.newWorktreesStartFromOrigin).toBe(true);
    expect(settings.defaultThreadModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
    expect(settings.defaultThreadRuntimeMode).toBe("full-access");
    expect(settings.defaultThreadInteractionMode).toBe("default");
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });

  it("accepts thread model, access, and interaction default updates", () => {
    const patch = decodeServerSettingsPatch({
      defaultThreadModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      },
      defaultThreadRuntimeMode: "approval-required",
      defaultThreadInteractionMode: "plan",
    });

    expect(patch.defaultThreadModelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(patch.defaultThreadRuntimeMode).toBe("approval-required");
    expect(patch.defaultThreadInteractionMode).toBe("plan");
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

describe("ServerSettings environment icon", () => {
  it("defaults to null", () => {
    expect(decodeServerSettings({}).environmentIcon).toBeNull();
  });

  it("keeps a kind this build knows", () => {
    expect(decodeServerSettings({ environmentIcon: "mac-mini" }).environmentIcon).toBe("mac-mini");
  });

  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });

  it("round-trips through encode", () => {
    const settings = decodeServerSettings({ environmentIcon: "laptop" });
    expect(encodeServerSettings(settings).environmentIcon).toBe("laptop");
  });
});
