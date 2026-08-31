// T3-CUSTOM(expbkt3): The Expo-manifest half of the fork build identity.
//
// Split from bkBuildIdentity.ts so the version-formatting logic stays testable
// without pulling react-native into the unit test environment. That split was
// incomplete: `authClientMetadata` imports this module, so a module-scope
// `expo-constants` import put expo-modules-core on the import graph of every
// test reaching authClientMetadata, and expo-modules-core reads React Native's
// `__DEV__` global as a side effect — which vitest does not define.
//
// So the manifest read is both function-scoped and fail-soft. Outside a real
// Expo runtime there is no manifest to read, and "no manifest" already has a
// defined meaning here: no SHA, so `bkAppVersion` returns the plain version.
import { readBkGitSha } from "./bkBuildIdentity";

function expoConfigExtra(): unknown {
  try {
    const loaded = require("expo-constants") as {
      readonly default?: { readonly expoConfig?: { readonly extra?: unknown } };
      readonly expoConfig?: { readonly extra?: unknown };
    };
    return (loaded.default ?? loaded).expoConfig?.extra;
  } catch {
    return null;
  }
}

export function bkBuildGitSha(): string | null {
  return readBkGitSha(expoConfigExtra());
}
