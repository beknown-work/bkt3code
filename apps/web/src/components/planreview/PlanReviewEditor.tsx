/**
 * T3-CUSTOM(expbkt3): the Plate editing surface for a plan document.
 *
 * Suggestion mode is on by default, so every human edit is an attributed
 * insert/delete the reviewer can accept or reject before it becomes a version.
 * The editor owns no persistence: it reports serialized markdown upward and
 * the panel decides when that becomes a draft or a version.
 */
import { CommentPlugin } from "@platejs/comment/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HighlightPlugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { LinkPlugin } from "@platejs/link/react";
import {
  BulletedListPlugin,
  ListItemContentPlugin,
  ListItemPlugin,
  ListPlugin,
  NumberedListPlugin,
  TaskListPlugin,
} from "@platejs/list-classic/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";
import { ParagraphPlugin, Plate, PlateContent, usePlateEditor } from "platejs/react";
import remarkGfm from "remark-gfm";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { PlanReviewFloatingToolbar } from "./plate/PlanReviewFloatingToolbar";
import {
  BlockquoteElement,
  BulletedListElement,
  CodeBlockElement,
  CodeLeaf,
  CodeLineElement,
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
  HighlightLeaf,
  HorizontalRuleElement,
  KbdLeaf,
  LinkElement,
  ListItemElement,
  NumberedListElement,
  ParagraphElement,
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
  TaskListElement,
} from "./plate/PlanReviewNodes";
import { CommentLeaf, SuggestionLeaf } from "./plate/PlanReviewReviewMarks";
import { normalizeQuotedText } from "./planReviewMarkdown";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * Scoped to what agent plans actually contain — headings, marks, lists, code,
 * tables, links, quotes — plus comments and suggestions. Every plugin carries
 * its component: a registered node type with no component renders as an
 * unstyled block, which is what makes an editor look like a textarea.
 *
 * Kept module-local and unexported: an exported plugin array would force
 * TypeScript to name Plate's internal option types across package boundaries.
 */
const PLAN_REVIEW_PLUGINS = [
  ParagraphPlugin.withComponent(ParagraphElement),
  H1Plugin.withComponent(H1Element),
  H2Plugin.withComponent(H2Element),
  H3Plugin.withComponent(H3Element),
  H4Plugin.withComponent(H4Element),
  H5Plugin.withComponent(H5Element),
  H6Plugin.withComponent(H6Element),
  BlockquotePlugin.withComponent(BlockquoteElement),
  HorizontalRulePlugin.withComponent(HorizontalRuleElement),
  CodeBlockPlugin.withComponent(CodeBlockElement),
  CodeLinePlugin.withComponent(CodeLineElement),
  LinkPlugin.withComponent(LinkElement),

  // Classic ul/ol/li lists map straight from markdown, and carry task lists.
  ListPlugin,
  ListItemContentPlugin,
  ListItemPlugin.withComponent(ListItemElement),
  BulletedListPlugin.withComponent(BulletedListElement),
  NumberedListPlugin.withComponent(NumberedListElement),
  TaskListPlugin.withComponent(TaskListElement),

  TablePlugin.withComponent(TableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableCellHeaderElement),

  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  StrikethroughPlugin,
  HighlightPlugin.withComponent(HighlightLeaf),
  CodePlugin.withComponent(CodeLeaf),
  KbdPlugin.withComponent(KbdLeaf),

  CommentPlugin.withComponent(CommentLeaf),
  SuggestionPlugin.withComponent(SuggestionLeaf),

  // Markdown last: it reads the node types the plugins above registered.
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
];

/**
 * Pull-based access to the document.
 *
 * Serializing the whole tree to markdown costs a full walk plus a
 * remark-stringify pass, so the panel asks for it when it actually needs it —
 * on the debounced save and on submit — rather than on every keystroke.
 */
export interface PlanReviewEditorHandle {
  readonly getMarkdown: () => string;
}

interface PlanReviewEditorProps {
  /** Canonical markdown for the version being reviewed. */
  readonly markdown: string;
  readonly readOnly: boolean;
  readonly suggestionMode: boolean;
  readonly handleRef: React.RefObject<PlanReviewEditorHandle | null>;
  /** Cheap notification that the reviewer changed something. */
  readonly onChanged: () => void;
  /** Fires when the reviewer comments on a selection. */
  readonly onAddComment: (quotedText: string, body: string) => void;
  /** Reports whether Plate's markdown round trip reached a fixed point. */
  readonly onRoundTripUnstable: () => void;
}

function PlanReviewEditorImpl({
  markdown,
  readOnly,
  suggestionMode,
  handleRef,
  onChanged,
  onAddComment,
  onRoundTripUnstable,
}: PlanReviewEditorProps) {
  const editor = usePlateEditor({ plugins: PLAN_REVIEW_PLUGINS });
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const loadedMarkdownRef = useRef<string | null>(null);
  // Loading a version fires Plate's onChange; that is not a reviewer edit.
  const loadingRef = useRef(false);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Load canonical markdown into the editor whenever the reviewed version
  // changes. Guarded by the last-loaded value so our own edits do not reload.
  useEffect(() => {
    if (loadedMarkdownRef.current === markdown) return;
    loadedMarkdownRef.current = markdown;

    try {
      loadingRef.current = true;
      const value = editor.api.markdown.deserialize(markdown);
      editor.tf.setValue(value);
      requestAnimationFrame(() => {
        loadingRef.current = false;
      });

      // Round-trip check: an unstable document would make every later diff
      // full of formatting noise the reviewer never typed.
      const once = editor.api.markdown.serialize({ value });
      const twice = editor.api.markdown.serialize({
        value: editor.api.markdown.deserialize(once),
      });
      if (once !== twice) onRoundTripUnstable();
    } catch {
      loadingRef.current = false;
      onRoundTripUnstable();
    }
  }, [editor, markdown, onRoundTripUnstable]);

  useEffect(() => {
    // Suggestion mode is a plugin option rather than editor state, so it can be
    // toggled without rebuilding the editor and losing the selection.
    editor.setOption(SuggestionPlugin, "isSuggesting", suggestionMode && !readOnly);
  }, [editor, suggestionMode, readOnly]);

  useImperativeHandle(
    handleRef,
    () => ({
      getMarkdown: () => {
        try {
          return editor.api.markdown.serialize();
        } catch {
          // A tree mid-edit can be transiently invalid; the caller falls back
          // to the last known good document rather than saving nonsense.
          return "";
        }
      },
    }),
    [editor],
  );

  const handleChange = useCallback(() => {
    if (loadingRef.current) return;
    onChanged();
  }, [onChanged]);

  const startComment = useCallback(() => {
    const quote = normalizeQuotedText(window.getSelection()?.toString() ?? "");
    if (quote.length === 0) return;
    setPendingQuote(quote);
    setCommentBody("");
    requestAnimationFrame(() => commentInputRef.current?.focus());
  }, []);

  const submitComment = useCallback(() => {
    if (pendingQuote === null) return;
    const body = commentBody.trim();
    if (body.length === 0) return;
    onAddComment(pendingQuote, body);
    setPendingQuote(null);
    setCommentBody("");
  }, [commentBody, onAddComment, pendingQuote]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {suggestionMode && !readOnly ? (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 text-xs dark:text-amber-400">
            Suggesting — your edits are tracked
          </span>
          <span className="text-muted-foreground text-xs">Select text to format or comment</span>
        </div>
      ) : null}

      <div ref={surfaceRef} className="relative min-h-0 flex-1 overflow-auto">
        <Plate editor={editor} onChange={handleChange}>
          <PlateContent
            className={cn(
              "min-h-full px-5 py-4 text-[15px] text-foreground leading-relaxed outline-none",
              "[&_::selection]:bg-primary/25",
            )}
            readOnly={readOnly}
            placeholder="This plan is empty."
            aria-label="Plan document"
          />
        </Plate>
        <PlanReviewFloatingToolbar
          containerRef={surfaceRef}
          onComment={startComment}
          readOnly={readOnly}
        />
      </div>

      {pendingQuote !== null ? (
        <div className="border-t bg-card p-3">
          <blockquote className="mb-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
            {pendingQuote}
          </blockquote>
          <textarea
            ref={commentInputRef}
            className="w-full resize-y rounded-md border bg-background p-2 text-sm"
            rows={3}
            value={commentBody}
            placeholder="What should change here?"
            aria-label="Comment body"
            onChange={(event) => setCommentBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPendingQuote(null);
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitComment();
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPendingQuote(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitComment} disabled={commentBody.trim().length === 0}>
              Add comment
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const PlanReviewEditor = memo(PlanReviewEditorImpl);
