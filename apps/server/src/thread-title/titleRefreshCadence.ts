/**
 * T3-CUSTOM(expbkt3): When a long session's title should be re-derived.
 *
 * Upstream titles a thread exactly once, from its first prompt. A session that
 * runs for hours drifts away from that opening line, and the sidebar ends up
 * full of titles describing what each session *started* as. This decides when to
 * re-run the existing regeneration flow so the title keeps describing the work.
 *
 * Pure on purpose: the reactor call site stays a single marked line.
 */
import type { ThreadTitleMaintenanceSettings } from "@t3tools/contracts/settings";

export function shouldRefreshThreadTitle(input: {
  /** User messages in the thread *including* the one starting this turn. */
  readonly userMessageCount: number;
  /** Durable record that a human named this session. See titleAuthorship.ts. */
  readonly titleManuallySet?: boolean | undefined;
  readonly settings: ThreadTitleMaintenanceSettings;
}): boolean {
  const { enabled, refreshEveryUserPrompts } = input.settings;
  if (!enabled || refreshEveryUserPrompts <= 0) return false;
  // A name you typed is yours. The cadence is the only generated rename that
  // could reach an established session, so it is where that promise is kept;
  // an explicit "Regenerate title" bypasses this function entirely.
  if (input.titleManuallySet === true) return false;
  // The first prompt is upstream's job — it names a still-default title rather
  // than re-deriving one, and doing both would race for the same rename.
  if (input.userMessageCount <= 1) return false;
  return input.userMessageCount % refreshEveryUserPrompts === 0;
}
