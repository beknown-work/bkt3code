/**
 * T3-CUSTOM(expbkt3): emergency gate for agent-rendered chat surfaces.
 *
 * URL targets can intentionally disable live behavior whenever they run in an
 * iframe, then fall back to origin-local state that is unrelated to the URL the
 * agent supplied. Until T3 has a truthful generic URL-surface contract, no
 * persisted client preference may turn Agent views back on.
 */
export const AGENT_UI_SURFACES_RUNTIME_ENABLED = false;
