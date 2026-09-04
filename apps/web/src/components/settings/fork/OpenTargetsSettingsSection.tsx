/**
 * T3-CUSTOM(expbkt3): managing user-defined "Open in…" targets.
 *
 * A target is a URL template plus, for remote environments, the path
 * translation that points it at a copy of the worktree on this machine. Both
 * live in client settings, so they follow the person rather than the server.
 *
 * @module components/settings/fork/OpenTargetsSettingsSection
 */
import type { OpenTarget, OpenTargetPathMapping } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback } from "react";

import {
  newOpenTargetId,
  OPEN_TARGET_PRESETS,
  presetToOpenTarget,
  templateScheme,
} from "../../../fork/openTargets";
import { useClientSettings, useUpdateClientSettings } from "../../../hooks/useSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";

function MappingEditor({
  mapping,
  onChange,
  onRemove,
}: {
  readonly mapping: OpenTargetPathMapping;
  readonly onChange: (next: OpenTargetPathMapping) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Path on the environment host"
        className="min-w-56 flex-1"
        placeholder="/home/ubuntu/.t3/bkt3-dev/worktrees/bk-docs"
        value={mapping.remotePrefix}
        onChange={(event) => onChange({ ...mapping, remotePrefix: event.target.value })}
      />
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        →
      </span>
      <Input
        aria-label="Path on this machine"
        className="min-w-56 flex-1"
        placeholder="/Users/you/BKT3 Sessions/bk-docs"
        value={mapping.localPrefix}
        onChange={(event) => onChange({ ...mapping, localPrefix: event.target.value })}
      />
      <Input
        aria-label="Only for host (optional)"
        className="w-56"
        placeholder="any host"
        value={mapping.host ?? ""}
        onChange={(event) => {
          const host = event.target.value.trim();
          onChange(
            host.length === 0
              ? { remotePrefix: mapping.remotePrefix, localPrefix: mapping.localPrefix }
              : { ...mapping, host },
          );
        }}
      />
      <Button aria-label="Remove mapping" onClick={onRemove} size="icon-sm" variant="ghost">
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

export function OpenTargetsSettingsSection() {
  const openTargets = useClientSettings((settings) => settings.openTargets);
  const updateClientSettings = useUpdateClientSettings();

  const write = useCallback(
    (next: ReadonlyArray<OpenTarget>) => {
      updateClientSettings({ openTargets: next });
    },
    [updateClientSettings],
  );

  const patch = useCallback(
    (id: string, changes: Partial<OpenTarget>) => {
      write(openTargets.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
    },
    [openTargets, write],
  );

  return (
    <SettingsSection id="open-targets" title="Open in… targets">
      <SettingsRow
        description={
          "Apps offered alongside your editors in a thread's Open menu. " +
          "A remote environment's path is rewritten with the mappings below, " +
          "because apps like Obsidian and Finder can only open a path on this machine. " +
          "Use {path}, {host} and {user} in a template."
        }
        title="Your targets"
      >
        <div className="flex flex-wrap gap-2">
          {OPEN_TARGET_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              onClick={() => write([...openTargets, presetToOpenTarget(preset)])}
              size="sm"
              variant="outline"
            >
              <PlusIcon className="size-4" />
              Add {preset.label}
            </Button>
          ))}
          <Button
            onClick={() =>
              write([
                ...openTargets,
                {
                  id: newOpenTargetId("custom"),
                  label: "My app",
                  template: "myapp://open?path={path}",
                  pathMappings: [],
                  requiresMappingWhenRemote: true,
                },
              ])
            }
            size="sm"
            variant="outline"
          >
            <PlusIcon className="size-4" />
            Add custom app
          </Button>
        </div>
      </SettingsRow>

      {openTargets.length === 0 ? null : (
        <div className="space-y-4">
          {openTargets.map((target) => {
            const scheme = templateScheme(target.template);
            return (
              <div className="space-y-3 rounded-lg border border-border p-3" key={target.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Menu label"
                    className="w-48"
                    placeholder="Obsidian"
                    value={target.label}
                    onChange={(event) => patch(target.id, { label: event.target.value })}
                  />
                  <Input
                    aria-label="URL template"
                    className="min-w-64 flex-1 font-mono text-xs"
                    placeholder="obsidian://open?path={path}"
                    value={target.template}
                    onChange={(event) => patch(target.id, { template: event.target.value })}
                  />
                  <Button
                    aria-label={`Remove ${target.label}`}
                    onClick={() => write(openTargets.filter((entry) => entry.id !== target.id))}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>

                {scheme === null && (
                  <p className="text-destructive text-xs">
                    Needs an app URL scheme, for example <code>obsidian://</code>.
                  </p>
                )}

                <div className="flex items-center gap-3">
                  <Switch
                    checked={target.requiresMappingWhenRemote}
                    id={`${target.id}-requires-mapping`}
                    onCheckedChange={(checked) =>
                      patch(target.id, { requiresMappingWhenRemote: checked === true })
                    }
                  />
                  <label className="text-sm" htmlFor={`${target.id}-requires-mapping`}>
                    Needs a local path (off for apps that connect over SSH themselves, like Zed)
                  </label>
                </div>

                <div className="space-y-2">
                  {target.pathMappings.map((mapping, index) => (
                    <MappingEditor
                      key={`${target.id}-mapping-${index}`}
                      mapping={mapping}
                      onChange={(next) =>
                        patch(target.id, {
                          pathMappings: target.pathMappings.map((entry, position) =>
                            position === index ? next : entry,
                          ),
                        })
                      }
                      onRemove={() =>
                        patch(target.id, {
                          pathMappings: target.pathMappings.filter(
                            (_entry, position) => position !== index,
                          ),
                        })
                      }
                    />
                  ))}
                  <Button
                    onClick={() =>
                      patch(target.id, {
                        pathMappings: [
                          ...target.pathMappings,
                          { remotePrefix: "", localPrefix: "" },
                        ],
                      })
                    }
                    size="sm"
                    variant="ghost"
                  >
                    <PlusIcon className="size-4" />
                    Add path mapping
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
