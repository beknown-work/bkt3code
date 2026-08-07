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
  HorizontalRulePlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { LinkPlugin } from "@platejs/link/react";
import { ListPlugin } from "@platejs/list/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";
import remarkGfm from "remark-gfm";
import { MessageSquarePlusIcon } from "lucide-react";
import { Plate, PlateContent, usePlateEditor } from "platejs/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { normalizeQuotedText } from "./planReviewMarkdown";

/**
 * Scoped deliberately to what agent plans actually contain — headings, marks,
 * lists, code, tables, links, quotes — plus comments and suggestions. Every
 * extra node type is bundle weight on a lazily loaded panel and one more
 * markdown round trip to keep honest. Kept module-local and unexported: an
 * exported plugin array would force TypeScript to name Plate's internal option
 * types across package boundaries.
 */
const PLAN_REVIEW_PLUGINS = [
  // Blocks
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
  ListPlugin,
  CodeBlockPlugin,
  CodeLinePlugin,
  TablePlugin,
  TableRowPlugin,
  TableCellPlugin,
  TableCellHeaderPlugin,
  LinkPlugin,
  // Marks
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  StrikethroughPlugin,
  CodePlugin,
  // Review
  CommentPlugin,
  SuggestionPlugin,
  // Markdown last: it reads the node types the plugins above registered.
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
];

interface PlanReviewEditorProps {
  /** Canonical markdown for the version being reviewed. */
  readonly markdown: string;
  readonly readOnly: boolean;
  readonly suggestionMode: boolean;
  /** Fires on every change with freshly serialized markdown. */
  readonly onMarkdownChange: (markdown: string) => void;
  /** Fires when the reviewer comments on a selection. */
  readonly onAddComment: (quotedText: string, body: string) => void;
  /** Reports whether Plate's markdown round trip reached a fixed point. */
  readonly onRoundTripUnstable: () => void;
}

function PlanReviewEditorImpl({
  markdown,
  readOnly,
  suggestionMode,
  onMarkdownChange,
  onAddComment,
  onRoundTripUnstable,
}: PlanReviewEditorProps) {
  const editor = usePlateEditor({ plugins: PLAN_REVIEW_PLUGINS });
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const loadedMarkdownRef = useRef<string | null>(null);
  const commentInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Load canonical markdown into the editor whenever the reviewed version
  // changes. Guarded by the last-loaded value so our own edits do not reload.
  useEffect(() => {
    if (loadedMarkdownRef.current === markdown) return;
    loadedMarkdownRef.current = markdown;

    try {
      const value = editor.api.markdown.deserialize(markdown);
      editor.tf.setValue(value);

      // Round-trip check: an unstable document would make every later diff
      // full of formatting noise the reviewer never typed.
      const once = editor.api.markdown.serialize({ value });
      const twice = editor.api.markdown.serialize({
        value: editor.api.markdown.deserialize(once),
      });
      if (once !== twice) onRoundTripUnstable();
    } catch {
      onRoundTripUnstable();
    }
  }, [editor, markdown, onRoundTripUnstable]);

  useEffect(() => {
    // Suggestion mode is a plugin option rather than editor state, so it can be
    // toggled without rebuilding the editor and losing the selection.
    editor.setOption(SuggestionPlugin, "isSuggesting", suggestionMode && !readOnly);
  }, [editor, suggestionMode, readOnly]);

  const handleChange = useCallback(() => {
    try {
      onMarkdownChange(editor.api.markdown.serialize());
    } catch {
      // A transient invalid tree during typing is not worth surfacing; the
      // next keystroke serializes again.
    }
  }, [editor, onMarkdownChange]);

  const startComment = useCallback(() => {
    const selected = window.getSelection()?.toString() ?? "";
    const quote = normalizeQuotedText(selected);
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
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={startComment}
          aria-label="Comment on the selected text"
        >
          <MessageSquarePlusIcon className="size-3.5" aria-hidden /> Comment on selection
        </Button>
        {suggestionMode && !readOnly ? (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 text-xs dark:text-amber-400">
            Suggesting — edits are tracked
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Plate editor={editor} onChange={handleChange}>
          <PlateContent
            className={cn(
              "prose prose-sm dark:prose-invert max-w-none px-4 py-3 outline-none",
              readOnly && "opacity-90",
            )}
            readOnly={readOnly}
            placeholder="This plan is empty."
            aria-label="Plan document"
          />
        </Plate>
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
