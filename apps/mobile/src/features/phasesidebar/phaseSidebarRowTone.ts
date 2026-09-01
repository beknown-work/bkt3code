// T3-CUSTOM(expbkt3): mobile's class strings for the phase sidebar.
//
// The web sidebar keeps its own equivalents under apps/web because Tailwind only
// scans source there. Mobile's uniwind scans apps/mobile, so the class strings
// have to appear literally in this file — which is why these are duplicated by
// design rather than shared. Everything that *decides* a tone is shared; only
// the literal class names live here.
import type { PhaseSidebarPhaseId } from "@t3tools/client-runtime/state/phase-sidebar";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";

/** Lifecycle header tint, matching the web sidebar's phase hues. */
export function phaseSidebarSectionToneClassName(phaseId: PhaseSidebarPhaseId): string {
  switch (phaseId) {
    case "needs_input":
      return "text-amber-600 dark:text-amber-300";
    case "plan_ready":
      return "text-violet-700 dark:text-violet-300";
    case "ready":
      return "text-emerald-700 dark:text-emerald-300";
    case "planning":
      return "text-indigo-700 dark:text-indigo-300";
    case "implementing":
      return "text-sky-700 dark:text-sky-300";
  }
}

/**
 * Priority pill. P0 reads as urgent and desaturates as it descends, so a screen
 * full of P2s does not shout.
 */
export function phaseSidebarPriorityToneClassName(priority: number): string {
  if (priority <= 0) return "bg-orange-500 text-white";
  if (priority === 1) return "bg-amber-500 text-white";
  if (priority === 2) return "bg-amber-700/70 text-white";
  return "bg-muted text-muted-foreground";
}

/**
 * PR state by colour alone, matching web: green open, violet merged, red closed.
 * State words stay out of the lane — it is already the densest text on screen.
 */
export function phaseSidebarChangeRequestToneClassName(state: ChangeRequestStateLike): string {
  switch (state) {
    case "merged":
      return "text-violet-600 dark:text-violet-300";
    case "closed":
      return "text-rose-600 dark:text-rose-300";
    default:
      return "text-emerald-600 dark:text-emerald-300";
  }
}

/** Worktree codename tint. Mirrors web's static tone table, same 12 hues. */
const CHECKOUT_TONES: readonly string[] = [
  "text-rose-600 dark:text-rose-300/90",
  "text-orange-600 dark:text-orange-300/90",
  "text-amber-600 dark:text-amber-300/90",
  "text-lime-600 dark:text-lime-300/90",
  "text-emerald-600 dark:text-emerald-300/90",
  "text-teal-600 dark:text-teal-300/90",
  "text-cyan-600 dark:text-cyan-300/90",
  "text-sky-600 dark:text-sky-300/90",
  "text-indigo-600 dark:text-indigo-300/90",
  "text-violet-600 dark:text-violet-300/90",
  "text-fuchsia-600 dark:text-fuchsia-300/90",
  "text-pink-600 dark:text-pink-300/90",
];

export function phaseSidebarCheckoutToneClassName(toneIndex: number | null): string {
  if (toneIndex === null) return "text-muted-foreground";
  return CHECKOUT_TONES[toneIndex % CHECKOUT_TONES.length] ?? "text-muted-foreground";
}
