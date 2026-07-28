/**
 * T3-CUSTOM(expbkt3): Detect the renderer from provider-authored plan content.
 * Native provider contracts call the field `planMarkdown` even when its value
 * is an HTML document or a self-contained visual HTML fragment.
 */
export function detectPlannotatorPlanFormat(content: string): "md" | "html" {
  const document = content.trim();
  const withoutLeadingComments = document.replace(/^(?:<!--[\s\S]*?-->\s*)*/i, "");
  if (/^(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/i.test(withoutLeadingComments)) {
    return "html";
  }

  // Providers such as Claude may emit the entire visual plan as one balanced
  // root fragment instead of adding document-level html/head/body elements.
  // Requiring the matching closing root avoids treating ordinary Markdown
  // containing an inline HTML example as an HTML plan.
  const rootedFragment = /^<(body|main|article|section|div)(?:\s|>)/i.exec(withoutLeadingComments);
  if (rootedFragment) {
    const root = rootedFragment[1];
    if (new RegExp(`</${root}>\\s*$`, "i").test(withoutLeadingComments)) {
      return "html";
    }
  }

  return "md";
}

/**
 * Preserve an explicitly selected HTML renderer, but let legacy Markdown
 * sessions self-heal when their persisted content is actually HTML.
 */
export function resolveStoredPlannotatorPlanFormat(
  currentFormat: "md" | "html",
  content: string,
): "md" | "html" {
  return currentFormat === "html" ? "html" : detectPlannotatorPlanFormat(content);
}
