import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const { automaticGitFetchInterval, ...patchForMerge } = patch;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacements = {
    ...next,
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
  };
  // The catch-up summarizer model selection follows the same
  // replace-on-provider/model rule as textGenerationModelSelection.
  const summarySelectionPatch = patch.experimental?.sessionSummary?.modelSelection;
  const withSummarySelection = summarySelectionPatch
    ? {
        ...nextWithReplacements,
        experimental: {
          ...nextWithReplacements.experimental,
          sessionSummary: {
            ...nextWithReplacements.experimental.sessionSummary,
            modelSelection: createModelSelection(
              summarySelectionPatch.instanceId ??
                current.experimental.sessionSummary.modelSelection.instanceId,
              summarySelectionPatch.model ??
                current.experimental.sessionSummary.modelSelection.model,
              shouldReplaceTextGenerationModelSelection(summarySelectionPatch)
                ? summarySelectionPatch.options
                : mergeModelSelectionOptionsById({
                    current: current.experimental.sessionSummary.modelSelection.options,
                    patch: summarySelectionPatch.options,
                  }),
            ),
          },
        },
      }
    : nextWithReplacements;

  // T3-CUSTOM(expbkt3): Conductor provider/model switches must replace stale
  // provider traits, matching the semantics of every other model picker.
  const conductorSelectionPatch = patch.experimental?.t3Conductor?.modelSelection;
  const withConductorSelection = conductorSelectionPatch
    ? {
        ...withSummarySelection,
        experimental: {
          ...withSummarySelection.experimental,
          t3Conductor: {
            ...withSummarySelection.experimental.t3Conductor,
            modelSelection: createModelSelection(
              conductorSelectionPatch.instanceId ??
                current.experimental.t3Conductor.modelSelection.instanceId,
              conductorSelectionPatch.model ??
                current.experimental.t3Conductor.modelSelection.model,
              shouldReplaceTextGenerationModelSelection(conductorSelectionPatch)
                ? conductorSelectionPatch.options
                : mergeModelSelectionOptionsById({
                    current: current.experimental.t3Conductor.modelSelection.options,
                    patch: conductorSelectionPatch.options,
                  }),
            ),
          },
        },
      }
    : withSummarySelection;

  if (!selectionPatch) {
    return withConductorSelection;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...withConductorSelection,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
