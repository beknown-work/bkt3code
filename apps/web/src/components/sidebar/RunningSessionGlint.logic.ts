import type { PhaseSidebarPhaseId, PhaseSidebarSection } from "./PhaseGroupedSidebar.logic";

export function isRunningSessionPhase(phaseId: PhaseSidebarPhaseId): boolean {
  return phaseId === "planning" || phaseId === "implementing";
}

/** Running motion belongs only to live lifecycle rows, never parked history. */
export function shouldShowRunningSessionGlint(
  phaseId: PhaseSidebarPhaseId,
  section: PhaseSidebarSection,
): boolean {
  return section === "active" && isRunningSessionPhase(phaseId);
}

/** Place one quiet boundary before running work when idle groups are also visible. */
export function runningSessionDividerPhase(
  phaseIds: ReadonlyArray<PhaseSidebarPhaseId>,
): PhaseSidebarPhaseId | null {
  if (!phaseIds.some((phaseId) => !isRunningSessionPhase(phaseId))) return null;
  return phaseIds.find(isRunningSessionPhase) ?? null;
}
