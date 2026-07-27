/**
 * T3-CUSTOM(expbkt3): Plannotator-specific domain model kept outside upstream
 * orchestration contracts.
 */
export type PlannotatorDecision =
  | { readonly kind: "approved"; readonly feedback: string }
  | { readonly kind: "feedback"; readonly feedback: string }
  | { readonly kind: "denied"; readonly feedback: string };

export interface PlannotatorReviewAnnotation {
  readonly id: string;
  readonly type: "COMMENT" | "DELETION" | "GLOBAL_COMMENT";
  readonly text: string;
  readonly originalText: string;
  readonly author: string;
}

export interface PlannotatorSubmission {
  readonly decision: PlannotatorDecision | null;
  readonly annotations: ReadonlyArray<PlannotatorReviewAnnotation>;
}

export type PersistedPlannotatorReviewAnnotation = PlannotatorReviewAnnotation & {
  readonly submittedAt: string;
};

function reviewAnnotationKey(annotation: PlannotatorReviewAnnotation): string {
  return [annotation.type, annotation.originalText, annotation.text, annotation.author].join(
    "\u0000",
  );
}

export function mergePlannotatorAnnotationHistory(
  current: ReadonlyArray<PersistedPlannotatorReviewAnnotation>,
  submitted: ReadonlyArray<PlannotatorReviewAnnotation>,
  submittedAt: string,
): ReadonlyArray<PersistedPlannotatorReviewAnnotation> {
  const merged = new Map(
    current.map((annotation) => [reviewAnnotationKey(annotation), annotation]),
  );
  for (const annotation of submitted) {
    const key = reviewAnnotationKey(annotation);
    if (!merged.has(key)) merged.set(key, { ...annotation, submittedAt });
  }
  return [...merged.values()];
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reviewAnnotations(value: unknown): ReadonlyArray<PlannotatorReviewAnnotation> {
  if (!Array.isArray(value)) return [];
  const annotations: Array<PlannotatorReviewAnnotation> = [];
  for (const annotation of value) {
    if (!annotation || typeof annotation !== "object") continue;
    const record = annotation as Record<string, unknown>;
    const text =
      trimmed(record.text) ||
      trimmed(record.comment) ||
      trimmed(record.note) ||
      trimmed(record.body);
    if (!text) continue;
    const originalText = trimmed(record.originalText) || trimmed(record.quote);
    const rawType = trimmed(record.type).toUpperCase();
    const type =
      rawType === "DELETION" && originalText
        ? ("DELETION" as const)
        : rawType === "COMMENT" && originalText
          ? ("COMMENT" as const)
          : ("GLOBAL_COMMENT" as const);
    const author = trimmed(record.author);
    const id =
      trimmed(record.id) || [type, originalText, text, author].map(encodeURIComponent).join(":");
    annotations.push({ id, type, text, originalText, author });
  }
  return annotations;
}

function annotationComments(value: unknown): string {
  return reviewAnnotations(value)
    .map((annotation) =>
      annotation.type === "DELETION"
        ? `Remove:\n\n> ${annotation.originalText}`
        : annotation.originalText
          ? `> ${annotation.originalText}\n\n${annotation.text}`
          : annotation.text,
    )
    .join("\n\n");
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
  if (body.byteLength === 0) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(body));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function feedbackFromPayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  return trimmed(payload.feedback) || annotationComments(payload.annotations);
}

export function parsePlannotatorSubmission(
  proxyPath: string,
  body: Uint8Array,
): PlannotatorSubmission {
  const payload = parseJson(body);
  const explicitDecision = trimmed(payload?.decision).toLowerCase();
  const feedback = feedbackFromPayload(payload);
  const annotations = reviewAnnotations(payload?.annotations);

  if (proxyPath.startsWith("/api/approve") || payload?.approved === true) {
    return { decision: { kind: "approved", feedback }, annotations };
  }
  if (explicitDecision === "approved") {
    return { decision: { kind: "approved", feedback }, annotations };
  }
  if (explicitDecision === "annotated" && feedback) {
    return { decision: { kind: "feedback", feedback }, annotations };
  }
  if (explicitDecision === "denied" || explicitDecision === "rejected") {
    return {
      decision: feedback ? { kind: "feedback", feedback } : { kind: "denied", feedback: "" },
      annotations,
    };
  }
  if (proxyPath.startsWith("/api/feedback")) {
    return {
      decision: feedback ? { kind: "feedback", feedback } : { kind: "denied", feedback: "" },
      annotations,
    };
  }
  if (proxyPath.startsWith("/api/external-annotations")) {
    // External annotations update the open review but do not submit it. The
    // eventual approve/feedback request captures the complete review round.
    return { decision: null, annotations };
  }
  if (proxyPath.startsWith("/api/deny") || proxyPath.startsWith("/api/reject")) {
    return {
      decision: feedback ? { kind: "feedback", feedback } : { kind: "denied", feedback: "" },
      annotations,
    };
  }
  return { decision: null, annotations };
}

export function parsePlannotatorDecision(
  proxyPath: string,
  body: Uint8Array,
): PlannotatorDecision | null {
  return parsePlannotatorSubmission(proxyPath, body).decision;
}

export function rewritePlannotatorHtml(html: string, proxyPrefix: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['href="/', `href="${proxyPrefix}/`],
    ['src="/', `src="${proxyPrefix}/`],
    ['action="/', `action="${proxyPrefix}/`],
    ['fetch("/', `fetch("${proxyPrefix}/`],
    ["fetch('/", `fetch('${proxyPrefix}/`],
  ];
  let rewritten = html;
  for (const [source, replacement] of replacements) {
    rewritten = rewritten.replaceAll(source, replacement);
  }

  const serializedPrefix = JSON.stringify(proxyPrefix);
  const shim = `<script>(function(){var P=${serializedPrefix};function rw(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.lastIndexOf(P+"/",0)!==0)return P+u;return u;}function ms(){var m={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}}}for(var si=0;si<2;si++){var sn=si?"sessionStorage":"localStorage";try{window[sn].length}catch(e){try{Object.defineProperty(window,sn,{value:ms()})}catch(x){}}}var f=window.fetch;if(f)window.fetch=function(i,o){if(typeof i==="string")return f.call(this,rw(i),o);if(i&&typeof i.url==="string"){var n=rw(i.url);if(n!==i.url){try{return f.call(this,new Request(n,i),o)}catch(e){}}}return f.call(this,i,o)};var E=window.EventSource;if(E){var W=function(u,c){return new E(rw(u),c)};W.prototype=E.prototype;window.EventSource=W}var X=window.XMLHttpRequest;if(X&&X.prototype&&X.prototype.open){var op=X.prototype.open;X.prototype.open=function(m,u){try{if(arguments.length>1)arguments[1]=rw(u)}catch(e){}return op.apply(this,arguments)}}})();</script>`;
  const headIndex = rewritten.indexOf("<head>");
  return headIndex >= 0
    ? `${rewritten.slice(0, headIndex + "<head>".length)}${shim}${rewritten.slice(headIndex + "<head>".length)}`
    : `${shim}${rewritten}`;
}
