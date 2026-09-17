/** T3-CUSTOM(expbkt3): Native composer control and player for whole-session summaries. */
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, View } from "react-native";
import * as Speech from "expo-speech";
import { randomUUID } from "expo-crypto";
import {
  CommandId,
  MAX_SESSION_WORK_SUMMARY_WORDS,
  MIN_SESSION_WORK_SUMMARY_WORDS,
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
  type ThreadWorkSummary,
} from "@t3tools/contracts";
import {
  IDLE_SPOKEN_SESSION_SUMMARY_STATE,
  beginSpokenSessionSummary,
  failSpokenSessionSummary,
  observeSpokenSessionSummary,
  type SpokenSessionSummaryState,
} from "@t3tools/client-runtime/spoken-session-summary";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions } from "../../lib/modelOptions";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function failureMessage(value: unknown): string {
  return value instanceof Error && value.message.trim()
    ? value.message
    : "The summary request could not be sent.";
}

export function SpokenSessionSummaryControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workSummary: ThreadWorkSummary | null | undefined;
  readonly serverConfig: ServerConfig | null;
}) {
  const requestSummary = useAtomCommand(threadEnvironment.requestWorkSummary, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "spoken summary settings update",
    reportFailure: true,
  });
  const [visible, setVisible] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [state, setState] = useState<SpokenSessionSummaryState>(IDLE_SPOKEN_SESSION_SUMMARY_STATE);
  const spokenRequestRef = useRef<CommandId | null>(null);
  const settings = props.serverConfig?.settings.experimental.sessionWorkSummary ?? null;
  const models = useMemo(
    () => buildModelOptions(props.serverConfig, settings?.modelSelection ?? null),
    [props.serverConfig, settings?.modelSelection],
  );

  const stopSpeech = () => {
    void Speech.stop();
    setIsSpeaking(false);
  };

  const speak = (text: string) => {
    void Speech.stop().finally(() => {
      Speech.speak(text, {
        onStart: () => setIsSpeaking(true),
        onDone: () => setIsSpeaking(false),
        onStopped: () => setIsSpeaking(false),
        onError: () => setIsSpeaking(false),
      });
    });
  };

  const generate = async () => {
    stopSpeech();
    setVisible(true);
    setShowSettings(false);
    const requestId = CommandId.make(randomUUID());
    spokenRequestRef.current = null;
    setState(beginSpokenSessionSummary(props.threadId, requestId));
    const result = await requestSummary({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, commandId: requestId },
    });
    if (result._tag === "Failure") {
      setState((current) =>
        failSpokenSessionSummary(current, failureMessage(squashAtomCommandFailure(result))),
      );
    }
  };

  const patchSettings = (patch: Partial<NonNullable<typeof settings>>) => {
    void updateSettings({
      environmentId: props.environmentId,
      input: { patch: { experimental: { sessionWorkSummary: patch } } },
    });
  };

  useEffect(() => {
    setState((current) => observeSpokenSessionSummary(current, props.threadId, props.workSummary));
  }, [props.threadId, props.workSummary]);

  useEffect(() => {
    if (!visible || state.phase !== "ready" || spokenRequestRef.current === state.requestId) return;
    spokenRequestRef.current = state.requestId;
    speak(state.summary);
  }, [state, visible]);

  useEffect(() => {
    stopSpeech();
    setVisible(false);
    setState(IDLE_SPOKEN_SESSION_SUMMARY_STATE);
    spokenRequestRef.current = null;
  }, [props.threadId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") stopSpeech();
    });
    return () => {
      subscription.remove();
      void Speech.stop();
    };
  }, []);

  const pending = state.phase === "requesting" || state.phase === "pending";
  const close = () => {
    stopSpeech();
    setVisible(false);
  };

  return (
    <>
      <ComposerActionButton
        accessibilityLabel="Summarize and read this session"
        icon="brain"
        disabled={pending}
        onPress={() => void generate()}
      />
      <Modal
        animationType="slide"
        presentationStyle="pageSheet"
        visible={visible}
        onRequestClose={close}
      >
        <View className="flex-1 bg-canvas px-4 pb-8 pt-4">
          <View className="mb-4 flex-row items-center gap-3">
            <Pressable
              accessibilityLabel="Close session summary"
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
              onPress={close}
            >
              <SymbolView name="xmark" size={17} tintColorClassName="accent-icon" />
            </Pressable>
            <Text className="flex-1 text-xl font-t3-semibold text-foreground">
              {showSettings ? "Spoken summary settings" : "Session summary"}
            </Text>
            <Pressable
              accessibilityLabel={showSettings ? "Show summary" : "Open spoken summary settings"}
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
              onPress={() => setShowSettings((current) => !current)}
            >
              <SymbolView
                name={showSettings ? "doc.text" : "gearshape"}
                size={18}
                tintColorClassName="accent-icon"
              />
            </Pressable>
          </View>

          {showSettings && settings ? (
            <ScrollView contentContainerClassName="gap-4 pb-8">
              <View className="flex-row items-center rounded-2xl bg-card p-4">
                <View className="flex-1 pr-3">
                  <Text className="text-lg text-foreground">Generate summaries</Text>
                  <Text className="text-sm text-foreground-muted">
                    Uses this environment’s configured low cost model.
                  </Text>
                </View>
                <ThemedSwitch
                  value={settings.enabled}
                  onValueChange={(enabled) => patchSettings({ enabled })}
                />
              </View>

              <View className="rounded-2xl bg-card p-4">
                <Text className="text-lg text-foreground">Maximum length</Text>
                <Text className="mb-3 text-sm text-foreground-muted">
                  {settings.maxWords} words
                </Text>
                <View className="flex-row gap-3">
                  <Pressable
                    accessibilityLabel="Shorten spoken summary"
                    accessibilityRole="button"
                    className="min-h-11 flex-1 items-center justify-center rounded-xl bg-subtle active:opacity-70"
                    disabled={settings.maxWords <= MIN_SESSION_WORK_SUMMARY_WORDS}
                    onPress={() =>
                      patchSettings({
                        maxWords: Math.max(MIN_SESSION_WORK_SUMMARY_WORDS, settings.maxWords - 10),
                      })
                    }
                  >
                    <Text className="text-base font-t3-medium text-foreground">Shorter</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Lengthen spoken summary"
                    accessibilityRole="button"
                    className="min-h-11 flex-1 items-center justify-center rounded-xl bg-subtle active:opacity-70"
                    disabled={settings.maxWords >= MAX_SESSION_WORK_SUMMARY_WORDS}
                    onPress={() =>
                      patchSettings({
                        maxWords: Math.min(MAX_SESSION_WORK_SUMMARY_WORDS, settings.maxWords + 10),
                      })
                    }
                  >
                    <Text className="text-base font-t3-medium text-foreground">Longer</Text>
                  </Pressable>
                </View>
              </View>

              <View className="overflow-hidden rounded-2xl bg-card">
                <Text className="px-4 pb-2 pt-4 text-lg text-foreground">Summary model</Text>
                {models.map((option) => {
                  const selected =
                    option.selection.instanceId === settings.modelSelection.instanceId &&
                    option.selection.model === settings.modelSelection.model;
                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: option.isUnavailable }}
                      className="min-h-12 flex-row items-center border-t border-border-subtle px-4 py-3 active:bg-subtle"
                      disabled={option.isUnavailable}
                      onPress={() => patchSettings({ modelSelection: option.selection })}
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-base text-foreground" numberOfLines={1}>
                          {option.label}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {option.providerLabel}
                        </Text>
                      </View>
                      {selected ? (
                        <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          ) : (
            <View className="flex-1">
              <ScrollView className="flex-1" contentContainerClassName="pb-8">
                {pending ? (
                  <Text className="text-base text-foreground-muted">
                    Summarizing the complete session…
                  </Text>
                ) : state.phase === "ready" ? (
                  <Text className="text-lg leading-7 text-foreground">{state.summary}</Text>
                ) : state.phase === "error" ? (
                  <Text className="text-base text-danger">{state.message}</Text>
                ) : null}
              </ScrollView>
              <View className="flex-row gap-3 pt-3">
                {isSpeaking ? (
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 flex-1 items-center justify-center rounded-xl bg-subtle active:opacity-70"
                    onPress={stopSpeech}
                  >
                    <Text className="font-t3-medium text-foreground">Stop</Text>
                  </Pressable>
                ) : state.phase === "ready" ? (
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 flex-1 items-center justify-center rounded-xl bg-subtle active:opacity-70"
                    onPress={() => speak(state.summary)}
                  >
                    <Text className="font-t3-medium text-foreground">Replay</Text>
                  </Pressable>
                ) : null}
                {!pending ? (
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 flex-1 items-center justify-center rounded-xl bg-primary active:opacity-70"
                    onPress={() => void generate()}
                  >
                    <Text className="font-t3-medium text-primary-foreground">Regenerate</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}
