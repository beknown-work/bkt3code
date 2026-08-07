/**
 * T3-CUSTOM(expbkt3): shared, dependency-free plan-review prompt format.
 *
 * The server builds these blocks and the web transcript parses them, so the
 * format lives here rather than in either app. `<review_comment>` deliberately
 * matches the existing file/diff review format in
 * `apps/web/src/reviewCommentContext.ts` — that parser already renders these
 * blocks as cards, so anchored plan feedback needs no new transcript UI.
 */

export interface PlanReviewAnchoredComment {
  /** 0-based inclusive line index into the reviewed markdown. */
  readonly startIndex: number;
  /** 0-based inclusive line index into the reviewed markdown. */
  readonly endIndex: number;
  /** The lines the reviewer selected, quoted back for the model. */
  readonly quotedText: string;
  /** The reviewer's note. */
  readonly body: string;
  readonly authorLabel: string | null;
}

export interface PlanReviewFeedbackInput {
  readonly documentId: string;
  readonly planTitle: string;
  readonly globalComment: string;
  readonly comments: ReadonlyArray<PlanReviewAnchoredComment>;
  /** Unified diff of reviewer edits, empty when the plan was not edited. */
  readonly editDiff: string;
  readonly fromRevision: number | null;
  readonly toRevision: number | null;
  readonly editAuthorLabel: string | null;
  /**
   * Set when the edit was too large to express as a diff. The full document is
   * sent instead, and the UI says so.
   */
  readonly fullDocument: string | null;
}

export interface PlanReviewApprovalInput {
  readonly notes: string;
  /**
   * Full plan body. Only present when the policy decided the model cannot see
   * the plan any more — normally null, which is the whole point of the feature.
   */
  readonly resendPlanMarkdown: string | null;
  readonly resendReason: string | null;
  /** Diff from the agent's last version to the approved one, when edited. */
  readonly approvedEditDiff: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Picks a fence long enough to survive backticks inside the content. */
export function planReviewFence(language: string, contents: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, contents.trimEnd(), fence].join("\n");
}

function rangeLabel(startIndex: number, endIndex: number): string {
  const start = startIndex + 1;
  const end = endIndex + 1;
  return start === end ? `L${start}` : `L${start} to L${end}`;
}

export function formatPlanReviewComment(
  documentId: string,
  planTitle: string,
  comment: PlanReviewAnchoredComment,
): string {
  const attributes = [
    `sectionId="${escapeAttribute(`plan:${documentId}`)}"`,
    `sectionTitle="${escapeAttribute("Plan review")}"`,
    `filePath="${escapeAttribute(`${planTitle}.md`)}"`,
    `startIndex="${comment.startIndex}"`,
    `endIndex="${comment.endIndex}"`,
    `rangeLabel="${escapeAttribute(rangeLabel(comment.startIndex, comment.endIndex))}"`,
  ].join(" ");

  const body = comment.authorLabel
    ? `${comment.body.trim()}\n\n— ${comment.authorLabel}`
    : comment.body.trim();

  return [
    `<review_comment ${attributes}>`,
    body,
    planReviewFence("markdown", comment.quotedText),
    "</review_comment>",
  ].join("\n");
}

const FEEDBACK_HEADER = [
  "Revise the plan you proposed. Respond with the complete revised plan.",
  "Do not modify repository files while planning.",
].join("\n");

/**
 * Builds the revision prompt. The plan body is deliberately absent — the model
 * authored it and still has it in context; only the deltas are sent.
 */
export function buildPlanReviewFeedbackPrompt(input: PlanReviewFeedbackInput): string {
  const sections: string[] = [FEEDBACK_HEADER];

  const globalComment = input.globalComment.trim();
  if (globalComment.length > 0) sections.push(globalComment);

  for (const comment of input.comments) {
    sections.push(formatPlanReviewComment(input.documentId, input.planTitle, comment));
  }

  if (input.fullDocument !== null) {
    sections.push(
      [
        `<plan_edit filePath="${escapeAttribute(`${input.planTitle}.md`)}" mode="full">`,
        "The reviewer's edits changed most of the plan, so the full edited document follows.",
        planReviewFence("markdown", input.fullDocument),
        "</plan_edit>",
      ].join("\n"),
    );
  } else if (input.editDiff.trim().length > 0) {
    const attributes = [
      `filePath="${escapeAttribute(`${input.planTitle}.md`)}"`,
      ...(input.fromRevision !== null ? [`fromVersion="${input.fromRevision}"`] : []),
      ...(input.toRevision !== null ? [`toVersion="${input.toRevision}"`] : []),
      ...(input.editAuthorLabel !== null
        ? [`author="${escapeAttribute(input.editAuthorLabel)}"`]
        : []),
    ].join(" ");
    sections.push(
      [`<plan_edit ${attributes}>`, planReviewFence("diff", input.editDiff), "</plan_edit>"].join(
        "\n",
      ),
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the approval prompt. Normally one line: the plan is already in the
 * model's context, so re-sending it is pure waste.
 */
export function buildPlanReviewApprovalPrompt(input: PlanReviewApprovalInput): string {
  const sections: string[] = [];
  const notes = input.notes.trim();

  if (input.resendPlanMarkdown !== null) {
    sections.push("PLEASE IMPLEMENT THIS APPROVED PLAN:");
    sections.push(input.resendPlanMarkdown.trim());
    if (input.resendReason !== null) {
      sections.push(`(The full plan is repeated because ${input.resendReason}.)`);
    }
  } else {
    sections.push("Plan approved. Implement the plan you proposed above, exactly as written.");
    if (input.approvedEditDiff.trim().length > 0) {
      sections.push(
        [
          "The reviewer edited the plan before approving. Apply these changes to it:",
          planReviewFence("diff", input.approvedEditDiff),
        ].join("\n"),
      );
    }
  }

  if (notes.length > 0) {
    sections.push(`Reviewer notes:\n${notes}`);
  }

  return sections.join("\n\n");
}

/**
 * Locates a quoted excerpt in the reviewed markdown and returns its 0-based
 * inclusive line range. Plate anchors comments to document marks, so line
 * numbers are derived at submit time from the quoted text.
 */
export function locateQuotedLineRange(
  markdown: string,
  quotedText: string,
): { readonly startIndex: number; readonly endIndex: number } | null {
  const quoteLines = quotedText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (quoteLines.length === 0) return null;

  const documentLines = markdown.replaceAll("\r\n", "\n").split("\n");
  const trimmedDocument = documentLines.map((line) => line.trim());

  for (let start = 0; start < trimmedDocument.length; start += 1) {
    if (!trimmedDocument[start]?.includes(quoteLines[0]!)) continue;

    let matched = 1;
    let cursor = start + 1;
    while (matched < quoteLines.length && cursor < trimmedDocument.length) {
      // Blank lines in the document do not break a multi-line quote match.
      if (trimmedDocument[cursor] === "") {
        cursor += 1;
        continue;
      }
      if (!trimmedDocument[cursor]!.includes(quoteLines[matched]!)) break;
      matched += 1;
      cursor += 1;
    }

    if (matched === quoteLines.length) {
      return { startIndex: start, endIndex: cursor - 1 };
    }
  }

  return null;
}
