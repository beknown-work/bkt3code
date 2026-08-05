import { expect, it, vi } from "@effect/vitest";
import { OrchestrationProposedPlanId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { reconcileNativePlansOnStartup } from "./PlannotatorManager.ts";

it.effect(
  "reconciles the latest native plan without materializing the full projection snapshot",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-native-plan");
      const proposedPlan = {
        id: OrchestrationProposedPlanId.make("plan-latest"),
        turnId: null,
        planMarkdown: "# Latest plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:01.000Z",
      } as const;
      const schedule = vi.fn(() => Effect.void);
      const query = {
        getSnapshot: () => Effect.die("full projection snapshot materialized"),
        listLatestProposedPlansForActiveThreads: () => Effect.succeed([{ threadId, proposedPlan }]),
      } as unknown as ProjectionSnapshotQuery["Service"];

      yield* reconcileNativePlansOnStartup(query, schedule);

      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(threadId, proposedPlan);
    }),
);
