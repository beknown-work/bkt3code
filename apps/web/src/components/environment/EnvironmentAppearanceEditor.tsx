/**
 * T3-CUSTOM(expbkt3): EnvironmentAppearanceEditor - set an environment's nickname,
 * icon and colour.
 *
 * Mounted per environment in Settings → Connections. Every change writes straight
 * through to the persisted store: there is no draft state to lose, and the preview
 * in the header is the live value rather than a copy of it.
 *
 * @module components/environment/EnvironmentAppearanceEditor
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useEnvironmentAppearanceStore } from "../../environmentAppearanceStore";
import {
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_OPTIONS,
  environmentAccentBorder,
  environmentAccentSurface,
  type ResolvedEnvironmentAppearance,
} from "../../state/environmentAppearance";

export function EnvironmentAppearanceEditor({
  environmentId,
  appearance,
  fallbackName,
}: {
  readonly environmentId: EnvironmentId;
  readonly appearance: ResolvedEnvironmentAppearance;
  /** The connection label, shown as the placeholder when no nickname is set. */
  readonly fallbackName: string;
}) {
  const stored = useEnvironmentAppearanceStore(
    (state) => state.appearanceByEnvironmentId[environmentId],
  );
  const setAppearance = useEnvironmentAppearanceStore((state) => state.setAppearance);
  const resetAppearance = useEnvironmentAppearanceStore((state) => state.resetAppearance);

  const update = (patch: {
    readonly nickname?: string;
    readonly iconId?: string;
    readonly colorId?: string;
  }) => {
    const next = { ...stored } as {
      nickname?: string;
      iconId?: string;
      colorId?: string;
    };
    if (patch.nickname !== undefined) next.nickname = patch.nickname;
    if (patch.iconId !== undefined) next.iconId = patch.iconId;
    if (patch.colorId !== undefined) next.colorId = patch.colorId;
    setAppearance(environmentId, next);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`environment-nickname-${environmentId}`}
        >
          Nickname
        </label>
        <Input
          id={`environment-nickname-${environmentId}`}
          value={stored?.nickname ?? ""}
          placeholder={fallbackName}
          maxLength={40}
          onChange={(event) => update({ nickname: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Shown wherever this environment&apos;s sessions and projects appear beside another
          environment&apos;s.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Colour</span>
        <div className="flex flex-wrap gap-1.5">
          {ENVIRONMENT_COLOR_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-label={option.label}
              aria-pressed={appearance.colorId === option.id}
              onClick={() => update({ colorId: option.id })}
              className={cn(
                "size-6 rounded-full border-2 transition-transform hover:scale-110",
                appearance.colorId === option.id ? "border-foreground" : "border-transparent",
              )}
              style={{ backgroundColor: option.value }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Icon</span>
        <div className="flex flex-wrap gap-1.5">
          {ENVIRONMENT_ICON_OPTIONS.map((option) => {
            const selected = appearance.iconId === option.id;
            const Icon = option.Icon;
            return (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={selected}
                onClick={() => update({ iconId: option.id })}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-md border transition-colors",
                  selected ? "" : "border-border text-muted-foreground hover:text-foreground",
                )}
                style={
                  selected
                    ? {
                        color: appearance.color,
                        backgroundColor: environmentAccentSurface(appearance.color),
                        borderColor: environmentAccentBorder(appearance.color),
                      }
                    : undefined
                }
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      </div>

      {appearance.customized ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground"
            onClick={() => resetAppearance(environmentId)}
          >
            <RotateCcwIcon className="size-3" />
            Reset to default
          </Button>
        </div>
      ) : null}
    </div>
  );
}
