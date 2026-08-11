// T3-CUSTOM(expbkt3): attach-to-external-session dialog logic.
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  normalizeExternalSessionIdInput,
  providerDisplayNoun,
  selectAttachableProviderEntries,
  sessionIdHelpText,
} from "./AttachExternalSessionDialog.logic";

const SESSION_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function makeEntry(instanceId: string, driverKind: string): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driverKind),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
  } as ProviderInstanceEntry;
}

describe("normalizeExternalSessionIdInput", () => {
  it("accepts the id itself", () => {
    expect(normalizeExternalSessionIdInput(SESSION_ID)).toBe(SESSION_ID);
    expect(normalizeExternalSessionIdInput(` ${SESSION_ID.toUpperCase()} `)).toBe(SESSION_ID);
  });

  it("extracts the id from a rollout filename or transcript path", () => {
    expect(normalizeExternalSessionIdInput(`rollout-2026-01-01-${SESSION_ID}.jsonl`)).toBe(
      SESSION_ID,
    );
    expect(
      normalizeExternalSessionIdInput(`/home/me/.claude/projects/-home-me-app/${SESSION_ID}.jsonl`),
    ).toBe(SESSION_ID);
  });

  it("rejects input with no id in it", () => {
    expect(normalizeExternalSessionIdInput("")).toBe(null);
    expect(normalizeExternalSessionIdInput("my session")).toBe(null);
  });
});

describe("selectAttachableProviderEntries", () => {
  it("offers only providers whose resume cursor the server can seed", () => {
    const entries = [
      makeEntry("claudeAgent", "claudeAgent"),
      makeEntry("codex", "codex"),
      makeEntry("cursor", "cursor"),
      makeEntry("grok", "grok"),
    ];
    expect(
      selectAttachableProviderEntries(entries).map((entry) => String(entry.instanceId)),
    ).toEqual(["claudeAgent", "codex"]);
  });
});

describe("copy helpers", () => {
  it("names providers the way users know them", () => {
    expect(providerDisplayNoun("claudeAgent")).toBe("Claude Code");
    expect(providerDisplayNoun("codex")).toBe("Codex");
  });

  it("tells the user where to find a session id", () => {
    expect(sessionIdHelpText("claudeAgent")).toContain("claude --resume");
    expect(sessionIdHelpText("codex")).toContain(".codex/sessions");
  });
});
