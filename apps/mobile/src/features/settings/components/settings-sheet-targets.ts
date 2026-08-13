export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsUsage"
  // T3-CUSTOM(expbkt3): fork Users settings screen.
  | "SettingsSourceControl";

export type SettingsLegalDocumentTarget = "SettingsLegal";
