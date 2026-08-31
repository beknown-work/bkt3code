// T3-CUSTOM(expbkt3): The Expo-manifest half of the fork build identity.
//
// Split from bkBuildIdentity.ts so the version-formatting logic stays testable
// without pulling react-native into the unit test environment.
import Constants from "expo-constants";

import { readBkGitSha } from "./bkBuildIdentity";

export function bkBuildGitSha(): string | null {
  return readBkGitSha(Constants.expoConfig?.extra);
}
