// T3-CUSTOM(expbkt3): the sheet that hosts the environment appearance editor.
// Opened from Settings → Connections and from the phase sidebar's Group-by
// sheet, so the phone can tell its remotes apart the same way the desktop does.
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { EnvironmentAppearanceEditor } from "./EnvironmentAppearanceEditor";
import { useEnvironmentAppearance } from "./useEnvironmentAppearance";

type EnvironmentAppearanceSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>;

export function EnvironmentAppearanceSheet({ route }: EnvironmentAppearanceSheetProps) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;
  const appearance = useEnvironmentAppearance(environmentId);

  return (
    <View className="flex-1 bg-sheet-solid">
      <View className="flex-row items-center justify-between px-4 pt-4">
        <Text className="text-base font-t3-bold text-foreground">Environment appearance</Text>
        <Pressable hitSlop={8} onPress={() => navigation.goBack()}>
          <Text className="text-xs font-t3-bold text-primary">Done</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {environment === null || appearance === null ? (
          <Text className="text-sm text-foreground-muted">
            This environment is no longer known.
          </Text>
        ) : (
          <EnvironmentAppearanceEditor
            appearance={appearance}
            environmentId={environmentId}
            fallbackName={environment.label}
          />
        )}
      </ScrollView>
    </View>
  );
}
