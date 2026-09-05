// T3-CUSTOM(expbkt3): set an environment's nickname, icon and colour.
//
// Every change writes straight through to device preferences: there is no draft
// to lose, and the preview at the top is the live value rather than a copy.
import {
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_DESCRIPTORS,
  type EnvironmentAppearance,
} from "@t3tools/client-runtime/state/environment-appearance";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { environmentIconSymbol, type MobileEnvironmentAppearance } from "./environmentAppearance";
import {
  useStoredEnvironmentAppearance,
  useUpdateEnvironmentAppearance,
} from "./useEnvironmentAppearance";

function FieldLabel(props: { readonly children: string }) {
  return (
    <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
      {props.children}
    </Text>
  );
}

export function EnvironmentAppearanceEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly appearance: MobileEnvironmentAppearance;
  /** The connection label, shown as the placeholder when no nickname is set. */
  readonly fallbackName: string;
}) {
  const { environmentId, appearance } = props;
  const stored = useStoredEnvironmentAppearance(environmentId);
  const update = useUpdateEnvironmentAppearance();
  const checkColor = String(useUniwindTheme()["--color-primary-foreground"]);

  const patch = (changes: EnvironmentAppearance) => {
    update(environmentId, { ...stored, ...changes });
  };

  return (
    <View className="gap-5">
      <View className="flex-row items-center gap-3 rounded-[14px] border border-border bg-subtle px-3 py-2.5">
        <EnvironmentBadge appearance={appearance} variant="icon" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {appearance.name}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {appearance.customized ? "Customised" : "Derived from the environment id"}
          </Text>
        </View>
        {appearance.customized ? (
          <Pressable hitSlop={8} onPress={() => update(environmentId, null)}>
            <Text className="text-xs font-t3-bold text-primary">Reset</Text>
          </Pressable>
        ) : null}
      </View>

      <View className="gap-1.5">
        <FieldLabel>Nickname</FieldLabel>
        <TextInput
          autoCapitalize="words"
          autoCorrect={false}
          className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
          maxLength={40}
          onChangeText={(nickname) => patch({ nickname })}
          placeholder={props.fallbackName}
          value={stored?.nickname ?? ""}
        />
        <Text className="text-xs text-foreground-tertiary">
          Shown wherever sessions from several machines mix. Leave empty to use the connection
          label.
        </Text>
      </View>

      <View className="gap-1.5">
        <FieldLabel>Icon</FieldLabel>
        <View className="flex-row flex-wrap gap-2">
          {ENVIRONMENT_ICON_DESCRIPTORS.map((descriptor) => {
            const active = appearance.iconId === descriptor.id;
            return (
              <Pressable
                accessibilityLabel={descriptor.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                className={cn(
                  "h-11 w-11 items-center justify-center rounded-[12px] border",
                  active ? "border-primary bg-primary/15" : "border-border bg-transparent",
                )}
                key={descriptor.id}
                onPress={() => patch({ iconId: descriptor.id })}
              >
                <SymbolView
                  fallback={
                    <Text className="text-[10px] text-foreground-muted">
                      {descriptor.label.slice(0, 2)}
                    </Text>
                  }
                  name={environmentIconSymbol(descriptor.id)}
                  size={17}
                  tintColor={appearance.color}
                  type="monochrome"
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="gap-1.5">
        <FieldLabel>Colour</FieldLabel>
        <View className="flex-row flex-wrap gap-2.5">
          {ENVIRONMENT_COLOR_OPTIONS.map((option) => {
            const active = appearance.colorId === option.id;
            return (
              <Pressable
                accessibilityLabel={option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                className="h-8 w-8 items-center justify-center rounded-full"
                key={option.id}
                onPress={() => patch({ colorId: option.id })}
                style={{ backgroundColor: option.value }}
              >
                {active ? (
                  <SymbolView name="checkmark" size={12} tintColor={checkColor} type="monochrome" />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
