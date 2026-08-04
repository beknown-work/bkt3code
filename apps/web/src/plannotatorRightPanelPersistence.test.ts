import { describe, expect, it } from "vite-plus/test";

import { withoutPersistedPlannotatorSurfaces } from "./plannotatorRightPanelPersistence";
import { migratePersistedRightPanelState } from "./rightPanelStore";

describe("Plannotator right-panel persistence", () => {
  it("removes only persisted Plannotator descriptors and preserves surface order", () => {
    const runtime = {
      "env-1:thread-A": {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [
          { id: "plan", kind: "plan" },
          {
            id: "plannotator:/plannotator/review_token/",
            kind: "plannotator",
            url: "/plannotator/review_token/",
          },
          { id: "diff", kind: "diff" },
        ],
      },
    };

    expect(withoutPersistedPlannotatorSurfaces(runtime)).toEqual({
      "env-1:thread-A": {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [
          { id: "plan", kind: "plan" },
          { id: "diff", kind: "diff" },
        ],
      },
    });
    expect(runtime["env-1:thread-A"].surfaces).toHaveLength(3);
  });

  it("selects the nearest remaining surface when Plannotator was active", () => {
    expect(
      withoutPersistedPlannotatorSurfaces({
        thread: {
          isOpen: true,
          activeSurfaceId: "plannotator:/plannotator/review_token/",
          surfaces: [
            { id: "plan", kind: "plan" },
            {
              id: "plannotator:/plannotator/review_token/",
              kind: "plannotator",
              url: "/plannotator/review_token/",
            },
            { id: "diff", kind: "diff" },
          ],
        },
      }),
    ).toEqual({
      thread: {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [
          { id: "plan", kind: "plan" },
          { id: "diff", kind: "diff" },
        ],
      },
    });
  });

  it("omits a panel record when its only persisted surface was Plannotator", () => {
    expect(
      withoutPersistedPlannotatorSurfaces({
        thread: {
          isOpen: true,
          activeSurfaceId: "plannotator:/plannotator/review_token/",
          surfaces: [
            {
              id: "plannotator:/plannotator/review_token/",
              kind: "plannotator",
              url: "/plannotator/review_token/",
            },
          ],
        },
      }),
    ).toEqual({});
  });

  it("removes a legacy version-8 Plannotator descriptor during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          thread: {
            isOpen: true,
            activeSurfaceId: "plannotator:/plannotator/review_token/",
            surfaces: [
              { id: "plan", kind: "plan" },
              {
                id: "plannotator:/plannotator/review_token/",
                kind: "plannotator",
                url: "/plannotator/review_token/",
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        thread: {
          isOpen: true,
          activeSurfaceId: "plan",
          surfaces: [{ id: "plan", kind: "plan" }],
        },
      },
    });
  });
});
