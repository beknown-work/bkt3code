/**
 * T3-CUSTOM(expbkt3): Single feature-flag boundary for every experimental
 * control-center UI seam. Keep upstream-facing additions gated through this
 * constant so they remain easy to locate and merge.
 */
export const EXPERIMENTAL_CONTROL_CENTER_ENABLED =
  import.meta.env.VITE_T3_EXPERIMENTAL_CONTROL_CENTER?.trim().toLowerCase() === "true";
