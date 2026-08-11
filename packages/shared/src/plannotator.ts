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
