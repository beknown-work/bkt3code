import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CatchupSummaryReactor } from "../Services/CatchupSummaryReactor.ts";
// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
import { WorkSummaryReactor } from "../Services/WorkSummaryReactor.ts";
// T3-CUSTOM(expbkt3): END
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
// T3-CUSTOM(expbkt3): archive-time session history export.
import { ArchiveExportReactor } from "../Services/ArchiveExportReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const catchupSummaryReactor = yield* CatchupSummaryReactor;
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
  const workSummaryReactor = yield* WorkSummaryReactor;
  // T3-CUSTOM(expbkt3): END
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  // T3-CUSTOM(expbkt3): archive-time session history export.
  const archiveExportReactor = yield* ArchiveExportReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* catchupSummaryReactor.start();
    // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summaries.
    yield* workSummaryReactor.start();
    // T3-CUSTOM(expbkt3): END
    yield* threadDeletionReactor.start();
    // T3-CUSTOM(expbkt3): archive-time session history export.
    yield* archiveExportReactor.start();
    yield* agentAwarenessRelay.start();
  });

  return {
    start,
    // T3-CUSTOM(expbkt3): recovery scan must follow stale-session reconciliation.
    startDurableRecovery: () => providerCommandReactor.startDurableRecovery?.() ?? Effect.void,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
