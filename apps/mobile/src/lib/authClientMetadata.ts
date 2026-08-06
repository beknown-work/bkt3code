import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): BEGIN - attach a test-safe native build identity.
import { Platform } from "react-native";
import { MOBILE_APP_VERSION } from "../../app-version";
// T3-CUSTOM(expbkt3): END

export function authClientMetadata(): AuthClientPresentationMetadata {
  // T3-CUSTOM(expbkt3): BEGIN - expose the native version to connected servers.
  return {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    appVersion: MOBILE_APP_VERSION,
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
  // T3-CUSTOM(expbkt3): END
}
