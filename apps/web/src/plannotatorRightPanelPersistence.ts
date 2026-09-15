/**
 * T3-CUSTOM(expbkt3): Plannotator surfaces are live browser resources, not
 * durable panel descriptors. Strip them only from the persisted copy so a
 * hidden surface remains mounted for the current browser lifetime.
 */
interface PersistedSurface {
  readonly id: string;
  readonly kind: string;
}

interface PersistedThreadPanelState {
  readonly isOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly surfaces: ReadonlyArray<PersistedSurface>;
  /** Upstream's closed-device memory; it must outlive an otherwise empty panel. */
  readonly dismissedDeviceSurfaceIds?: ReadonlyArray<string> | undefined;
}

const hasDismissedDevices = (threadState: PersistedThreadPanelState): boolean =>
  (threadState.dismissedDeviceSurfaceIds?.length ?? 0) > 0;

export function withoutPersistedPlannotatorSurfaces<ThreadState extends PersistedThreadPanelState>(
  byThreadKey: Readonly<Record<string, ThreadState>>,
): Record<string, ThreadState> {
  const persisted: Record<string, ThreadState> = {};

  for (const [threadKey, threadState] of Object.entries(byThreadKey)) {
    if (threadState.surfaces.length === 0) {
      if (hasDismissedDevices(threadState)) persisted[threadKey] = threadState;
      continue;
    }
    const removedIndex = threadState.surfaces.findIndex(
      (surface) => surface.kind === "plannotator",
    );
    if (removedIndex < 0) {
      persisted[threadKey] = threadState;
      continue;
    }

    const surfaces = threadState.surfaces.filter((surface) => surface.kind !== "plannotator");
    if (surfaces.length === 0) {
      if (hasDismissedDevices(threadState)) {
        persisted[threadKey] = {
          ...threadState,
          surfaces,
          activeSurfaceId: null,
          isOpen: false,
        } as unknown as ThreadState;
      }
      continue;
    }

    const activeStillExists = surfaces.some(
      (surface) => surface.id === threadState.activeSurfaceId,
    );
    const fallback = surfaces[Math.min(removedIndex, surfaces.length - 1)] ?? null;
    persisted[threadKey] = {
      ...threadState,
      surfaces,
      activeSurfaceId: activeStillExists ? threadState.activeSurfaceId : (fallback?.id ?? null),
      isOpen: threadState.isOpen && surfaces.length > 0,
    } as unknown as ThreadState;
  }

  return persisted;
}
