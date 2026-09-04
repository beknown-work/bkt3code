// T3-CUSTOM(expbkt3): the mobile face of an environment's identity.
//
// The catalogue, the derived fallback and the sanitizer are client-runtime's, so
// a machine derives the same icon and colour here as it does in the browser.
// This module only maps each icon id to an SF Symbol.
import {
  resolveEnvironmentIdentity,
  type EnvironmentAppearance,
  type ResolvedEnvironmentIdentity,
} from "@t3tools/client-runtime/state/environment-appearance";

import type { SFSymbol } from "../../components/AppSymbol";

const SYMBOL_BY_ICON_ID: Readonly<Record<string, SFSymbol>> = {
  server: "server.rack",
  laptop: "laptopcomputer",
  cloud: "cloud.fill",
  home: "house.fill",
  cpu: "cpu",
  container: "shippingbox.fill",
  database: "cylinder.split.1x2.fill",
  flask: "flask.fill",
  rocket: "paperplane.fill",
  globe: "globe",
  terminal: "terminal.fill",
  code: "chevron.left.forwardslash.chevron.right",
  wrench: "wrench.fill",
  zap: "bolt.fill",
  box: "cube.fill",
};

export interface MobileEnvironmentAppearance extends ResolvedEnvironmentIdentity {
  readonly symbol: SFSymbol;
}

export function environmentIconSymbol(iconId: string): SFSymbol {
  return SYMBOL_BY_ICON_ID[iconId] ?? "server.rack";
}

export function resolveMobileEnvironmentAppearance(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly appearance?: EnvironmentAppearance | undefined;
}): MobileEnvironmentAppearance {
  const identity = resolveEnvironmentIdentity(input);
  return { ...identity, symbol: environmentIconSymbol(identity.iconId) };
}
