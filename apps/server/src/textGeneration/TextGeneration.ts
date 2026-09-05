import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

// T3-CUSTOM(expbkt3): BEGIN — fork summary generation inputs.
export interface RollingSummaryGenerationInput {
  cwd: string;
  threadTitle: string;
  /** Previous rolling summary for the thread, or null on the first turn. */
  previousSummary: string | null;
  /** Transcript of the turn that just completed. */
  turnTranscript: string;
  /** Upper bound on transcript characters sent to the model. */
  dataLimitChars: number;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface RollingSummaryGenerationResult {
  summary: string;
}

export interface CatchupSummaryGenerationInput {
  cwd: string;
  threadTitle: string;
  rollingSummary: string;
  /** Tail of the latest turn, so the note leans on how the session ended. */
  turnTail: string;
  /** Optional user-supplied prompt instructions from settings. */
  customInstructions?: string | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CatchupSummaryGenerationResult {
  summary: string;
}

// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
//
// A peer of the catch-up summary rather than an extension of it: separate
// settings, separate model, separate prompt, and a structured result the table
// sorts by. The reactor renders `context` itself so every provider receives an
// identical, already budget-capped payload.
export interface WorkSummaryGenerationInput {
  cwd: string;
  /** Rendered session context, already capped to the configured char budget. */
  context: string;
  /** Optional user-supplied prompt instructions from settings. */
  promptInstructions?: string | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface WorkSummaryGenerationResult {
  summary: string;
  stage: "planning" | "implementing" | "blocked" | "awaiting-review" | "done";
  remaining: string;
  percent: number;
}
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): END

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /**
     * Fold a completed turn into the thread's rolling catch-up summary.
     */
    readonly updateRollingSummary: (
      input: RollingSummaryGenerationInput,
    ) => Effect.Effect<RollingSummaryGenerationResult, TextGenerationError>;

    /**
     * Write the short catch-up note shown under a long turn's final output.
     */
    readonly generateCatchupSummary: (
      input: CatchupSummaryGenerationInput,
    ) => Effect.Effect<CatchupSummaryGenerationResult, TextGenerationError>;

    /**
     * T3-CUSTOM(expbkt3): BEGIN — Write the bulk session manager's work summary
     * and assigned progress for one session.
     */
    readonly generateWorkSummary: (
      input: WorkSummaryGenerationInput,
    ) => Effect.Effect<WorkSummaryGenerationResult, TextGenerationError>;
    // T3-CUSTOM(expbkt3): END
  }
>()("t3/textGeneration/TextGeneration") {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "updateRollingSummary"
  | "generateCatchupSummary"
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
  | "generateWorkSummary";
// T3-CUSTOM(expbkt3): END

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
    updateRollingSummary: (input) =>
      resolveInstance(registry, "updateRollingSummary", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.updateRollingSummary(input)),
      ),
    generateCatchupSummary: (input) =>
      resolveInstance(registry, "generateCatchupSummary", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCatchupSummary(input)),
      ),
    // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
    generateWorkSummary: (input) =>
      resolveInstance(registry, "generateWorkSummary", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateWorkSummary(input)),
      ),
    // T3-CUSTOM(expbkt3): END
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
