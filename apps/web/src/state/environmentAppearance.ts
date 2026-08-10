/**
 * T3-CUSTOM(expbkt3): environmentAppearance - per-environment nickname, icon and colour.
 *
 * Once a client is attached to more than one environment, every list that mixes
 * their data reads as duplicates: the same repository name and the same path
 * appear twice with nothing to say which machine each row came from. This module
 * owns the identity we attach to an environment so those surfaces can tell them
 * apart.
 *
 * Two decisions worth keeping:
 *
 * - **Appearance is client-local.** A known environment is already a browser-local
 *   record (see `connection/catalog.ts`); the server has no concept of "what this
 *   machine is called to me". Storing a nickname server-side would also make it
 *   shared, when the whole point is that each operator labels their own fleet.
 * - **Every environment gets a distinct look before anyone configures one.** The
 *   fallback is derived from the environment id, so the second machine you attach
 *   is immediately distinguishable without a settings trip. Customising only
 *   overrides the derived value.
 *
 * Colours are applied as inline values rather than Tailwind classes on purpose:
 * the palette is chosen at runtime by the user, and class names assembled at
 * runtime are not statically discoverable by the compiler.
 *
 * @module state/environmentAppearance
 */
import {
  BoxIcon,
  CloudIcon,
  CodeIcon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HouseIcon,
  LaptopIcon,
  type LucideIcon,
  RocketIcon,
  ServerIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

export interface EnvironmentAppearance {
  readonly nickname?: string;
  readonly iconId?: string;
  readonly colorId?: string;
}

export interface EnvironmentIconOption {
  readonly id: string;
  readonly label: string;
  readonly Icon: LucideIcon;
}

export interface EnvironmentColorOption {
  readonly id: string;
  readonly label: string;
  /** Foreground for the glyph and the accent dot. */
  readonly value: string;
}

export const ENVIRONMENT_ICON_OPTIONS: ReadonlyArray<EnvironmentIconOption> = [
  { id: "server", label: "Server", Icon: ServerIcon },
  { id: "laptop", label: "Laptop", Icon: LaptopIcon },
  { id: "cloud", label: "Cloud", Icon: CloudIcon },
  { id: "home", label: "Home", Icon: HouseIcon },
  { id: "cpu", label: "CPU", Icon: CpuIcon },
  { id: "container", label: "Container", Icon: ContainerIcon },
  { id: "database", label: "Database", Icon: DatabaseIcon },
  { id: "flask", label: "Lab", Icon: FlaskConicalIcon },
  { id: "rocket", label: "Rocket", Icon: RocketIcon },
  { id: "globe", label: "Globe", Icon: GlobeIcon },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "code", label: "Code", Icon: CodeIcon },
  { id: "wrench", label: "Tools", Icon: WrenchIcon },
  { id: "zap", label: "Zap", Icon: ZapIcon },
  { id: "box", label: "Box", Icon: BoxIcon },
];

/**
 * Hues spaced far enough apart to stay separable at badge size, and mid-lightness
 * so the same value carries on both light and dark surfaces without a second set.
 */
export const ENVIRONMENT_COLOR_OPTIONS: ReadonlyArray<EnvironmentColorOption> = [
  { id: "blue", label: "Blue", value: "#3b82f6" },
  { id: "violet", label: "Violet", value: "#8b5cf6" },
  { id: "pink", label: "Pink", value: "#ec4899" },
  { id: "red", label: "Red", value: "#ef4444" },
  { id: "orange", label: "Orange", value: "#f97316" },
  { id: "amber", label: "Amber", value: "#f59e0b" },
  { id: "lime", label: "Lime", value: "#84cc16" },
  { id: "emerald", label: "Emerald", value: "#10b981" },
  { id: "teal", label: "Teal", value: "#14b8a6" },
  { id: "cyan", label: "Cyan", value: "#06b6d4" },
  { id: "indigo", label: "Indigo", value: "#6366f1" },
  { id: "slate", label: "Slate", value: "#94a3b8" },
];

export interface ResolvedEnvironmentAppearance {
  readonly name: string;
  readonly iconId: string;
  readonly Icon: LucideIcon;
  readonly colorId: string;
  readonly color: string;
  /** True when the operator picked this, rather than it being derived from the id. */
  readonly customized: boolean;
}

/** FNV-1a: stable across reloads and machines, which a string hash must be here. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function defaultEnvironmentColorId(environmentId: string): string {
  const option =
    ENVIRONMENT_COLOR_OPTIONS[hashString(environmentId) % ENVIRONMENT_COLOR_OPTIONS.length];
  return option?.id ?? "slate";
}

export function defaultEnvironmentIconId(environmentId: string): string {
  // Offset the hash so an id does not land on the same index in both catalogs,
  // which would correlate icon and colour across every environment.
  const option =
    ENVIRONMENT_ICON_OPTIONS[hashString(`${environmentId}:icon`) % ENVIRONMENT_ICON_OPTIONS.length];
  return option?.id ?? "server";
}

function findIcon(iconId: string): EnvironmentIconOption {
  return (
    ENVIRONMENT_ICON_OPTIONS.find((option) => option.id === iconId) ?? ENVIRONMENT_ICON_OPTIONS[0]!
  );
}

function findColor(colorId: string): EnvironmentColorOption {
  return (
    ENVIRONMENT_COLOR_OPTIONS.find((option) => option.id === colorId) ??
    ENVIRONMENT_COLOR_OPTIONS[ENVIRONMENT_COLOR_OPTIONS.length - 1]!
  );
}

/**
 * Combine the stored overrides with the environment's own label and a derived
 * fallback. `label` is the connection's label, which the user may already have
 * edited in Connections; the nickname takes precedence over it.
 */
export function resolveEnvironmentAppearance(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly appearance?: EnvironmentAppearance | undefined;
}): ResolvedEnvironmentAppearance {
  const stored = input.appearance;
  const nickname = stored?.nickname?.trim();
  const iconId = stored?.iconId ?? defaultEnvironmentIconId(input.environmentId);
  const colorId = stored?.colorId ?? defaultEnvironmentColorId(input.environmentId);
  const icon = findIcon(iconId);
  const color = findColor(colorId);

  return {
    name: nickname && nickname.length > 0 ? nickname : input.label,
    iconId: icon.id,
    Icon: icon.Icon,
    colorId: color.id,
    color: color.value,
    customized:
      stored !== undefined &&
      ((nickname !== undefined && nickname.length > 0) ||
        stored.iconId !== undefined ||
        stored.colorId !== undefined),
  };
}

/** A translucent fill derived from the accent, so one palette drives both. */
export function environmentAccentSurface(color: string): string {
  return `color-mix(in srgb, ${color} 16%, transparent)`;
}

export function environmentAccentBorder(color: string): string {
  return `color-mix(in srgb, ${color} 40%, transparent)`;
}

export function sanitizeEnvironmentAppearance(value: unknown): EnvironmentAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : undefined;
  const iconId =
    typeof record.iconId === "string" &&
    ENVIRONMENT_ICON_OPTIONS.some((option) => option.id === record.iconId)
      ? record.iconId
      : undefined;
  const colorId =
    typeof record.colorId === "string" &&
    ENVIRONMENT_COLOR_OPTIONS.some((option) => option.id === record.colorId)
      ? record.colorId
      : undefined;
  if (!nickname && !iconId && !colorId) return null;
  return {
    ...(nickname ? { nickname } : {}),
    ...(iconId ? { iconId } : {}),
    ...(colorId ? { colorId } : {}),
  };
}
