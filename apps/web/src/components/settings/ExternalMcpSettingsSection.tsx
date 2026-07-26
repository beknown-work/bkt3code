import { CopyIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function formatExternalMcpApiKey(bytes: Uint8Array): string {
  return `t3exp_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function generateExternalMcpApiKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return formatExternalMcpApiKey(bytes);
}

export function ExternalMcpSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const externalMcp = settings.experimental.externalMcp;
  const [revealed, setRevealed] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const { copyToClipboard: copyApiKey, isCopied: apiKeyCopied } = useCopyToClipboard({
    target: "external MCP API key",
  });
  const { copyToClipboard: copyConfig, isCopied: configCopied } = useCopyToClipboard({
    target: "external MCP configuration",
  });

  const effectiveUrl =
    externalMcp.publicUrl.trim() ||
    (typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`);
  const configSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "t3-code-control": {
              type: "http",
              url: effectiveUrl,
              headers: {
                Authorization: `Bearer ${externalMcp.apiKey || "<API_KEY>"}`,
              },
            },
          },
        },
        null,
        2,
      ),
    [effectiveUrl, externalMcp.apiKey],
  );

  const patchExternalMcp = (patch: Partial<typeof externalMcp>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        externalMcp: { ...externalMcp, ...patch },
      },
    });
  };

  const rotateKey = () => {
    const apiKey = generateExternalMcpApiKey();
    patchExternalMcp({ apiKey });
    setRevealed(true);
  };

  return (
    <SettingsSection title="External T3 MCP control">
      <SettingsRow
        title="Enable external MCP server"
        description="Allow trusted agents outside T3 Code to inspect and control sessions through the authenticated /mcp endpoint. The API key has operator-level access."
        status={
          externalMcp.enabled && externalMcp.apiKey.length >= 24
            ? `Ready at ${effectiveUrl}`
            : externalMcp.enabled
              ? "Generate an API key to finish enabling external access."
              : "Disabled. In-session agents continue to receive their own short-lived scoped MCP credential."
        }
        control={
          <Switch
            checked={externalMcp.enabled}
            onCheckedChange={(checked) => {
              const enabled = Boolean(checked);
              patchExternalMcp({
                enabled,
                ...(enabled && externalMcp.apiKey.length < 24
                  ? { apiKey: generateExternalMcpApiKey() }
                  : {}),
              });
            }}
            aria-label="Enable external T3 MCP server"
          />
        }
      />

      <SettingsRow
        title="Public MCP URL"
        description="URL agents use for Streamable HTTP MCP. Leave blank to use this browser's origin plus /mcp."
      >
        <Input
          className="mt-3 mb-3.5 font-mono text-xs"
          value={urlDraft ?? externalMcp.publicUrl}
          onChange={(event) => setUrlDraft(event.target.value)}
          onFocus={() => setUrlDraft(externalMcp.publicUrl)}
          onBlur={() => {
            const next = (urlDraft ?? externalMcp.publicUrl).trim();
            setUrlDraft(null);
            if (next !== externalMcp.publicUrl) patchExternalMcp({ publicUrl: next });
          }}
          placeholder={effectiveUrl}
          spellCheck={false}
          aria-label="External MCP public URL"
        />
      </SettingsRow>

      <SettingsRow
        title="Operator API key"
        description="Treat this like a password. Rotating it immediately invalidates the previous external credential; agent-scoped credentials are unaffected."
      >
        <div className="mt-3 mb-3.5 flex items-center gap-2">
          <Input
            className="font-mono text-xs"
            type={revealed ? "text" : "password"}
            value={externalMcp.apiKey}
            readOnly
            placeholder="Generate an API key"
            aria-label="External MCP operator API key"
          />
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => setRevealed((current) => !current)}
            disabled={!externalMcp.apiKey}
            aria-label={revealed ? "Hide API key" : "Reveal API key"}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => copyApiKey(externalMcp.apiKey)}
            disabled={!externalMcp.apiKey}
            aria-label="Copy API key"
          >
            <CopyIcon />
          </Button>
          <Button size="sm" variant="outline" onClick={rotateKey}>
            <RefreshCwIcon />
            {externalMcp.apiKey ? "Rotate" : "Generate"}
          </Button>
        </div>
        {apiKeyCopied ? <p className="mb-3 text-xs text-emerald-600">API key copied.</p> : null}
      </SettingsRow>

      <SettingsRow
        title="Agent configuration"
        description="Paste this JSON into an MCP-capable agent. Tool descriptions are self-documenting, and focused tools are preferred over the advanced raw command escape hatch."
      >
        <div className="mt-3 mb-3.5 space-y-2">
          <Textarea
            className="min-h-52 font-mono text-xs"
            value={configSnippet}
            readOnly
            spellCheck={false}
            aria-label="External MCP agent configuration"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyConfig(configSnippet)}
              disabled={!externalMcp.apiKey}
            >
              <CopyIcon />
              {configCopied ? "Copied" : "Copy configuration"}
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
