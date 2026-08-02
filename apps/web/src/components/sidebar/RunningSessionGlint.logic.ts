import type { PhaseSidebarPhaseId, PhaseSidebarSection } from "./PhaseGroupedSidebar.logic";

/** Running motion belongs only to live lifecycle rows, never parked history. */
export function shouldShowRunningSessionGlint(
  phaseId: PhaseSidebarPhaseId,
  section: PhaseSidebarSection,
): boolean {
  return section === "active" && (phaseId === "planning" || phaseId === "implementing");
}
