import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import Constants from "expo-constants";
import { Platform } from "react-native";

export function authClientMetadata(): AuthClientPresentationMetadata {
  return {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    // T3-CUSTOM(expbkt3): attach the built client version to connection metadata.
    ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}
