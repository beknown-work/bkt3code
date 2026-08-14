/**
 * T3-CUSTOM(expbkt3): Shared, dependency-free Plannotator marker helpers.
 * Exported through an explicit subpath to avoid changing upstream barrels.
 */
const PLANNOTATOR_MARKER_PATTERN = /<!--\s*t3-plannotator:(\/plannotator\/[A-Za-z0-9_-]+\/)\s*-->/g;

export function plannotatorProxyPath(token: string): `/plannotator/${string}/` {
  return `/plannotator/${token}/`;
}

export function plannotatorPlanMarker(proxyPath: string): string {
  return `<!-- t3-plannotator:${proxyPath} -->`;
}

export function withoutPlannotatorPlanMarker(planMarkdown: string): string {
  return planMarkdown.replace(PLANNOTATOR_MARKER_PATTERN, "").trimEnd();
}

export function withPlannotatorPlanMarker(planMarkdown: string, proxyPath: string): string {
  const withoutExistingMarker = withoutPlannotatorPlanMarker(planMarkdown);
  return `${withoutExistingMarker}\n\n${plannotatorPlanMarker(proxyPath)}`;
}

export function plannotatorProxyPathFromPlan(
  planMarkdown: string,
): `/plannotator/${string}/` | null {
  PLANNOTATOR_MARKER_PATTERN.lastIndex = 0;
  return (
    (PLANNOTATOR_MARKER_PATTERN.exec(planMarkdown)?.[1] as `/plannotator/${string}/` | undefined) ??
    null
  );
}

/**
 * A review URL the client can actually fetch: the proxy path resolved against
 * the environment that owns the review.
 *
 * The root-relative proxy path only reaches the right server when the client
 * is served by that same server. The desktop renderer never is — it is served
 * from `t3code://app` and its protocol handler forwards every root-relative
 * request to the *bundled local backend*, while threads (and their reviews)
 * live on whichever environment the thread belongs to. A managed build's
 * primary environment is a central server, so every review resolved relatively
 * hits a backend that has never heard of the token and answers
 * "Plannotator review not found."
 */
export type PlannotatorReviewUrl = string;

export function resolvePlannotatorReviewUrl(
  proxyPath: `/plannotator/${string}/`,
  httpBaseUrl: string | null | undefined,
): PlannotatorReviewUrl | null {
  if (!httpBaseUrl) return null;
  try {
    return new URL(proxyPath, httpBaseUrl).toString();
  } catch {
    return null;
  }
}
