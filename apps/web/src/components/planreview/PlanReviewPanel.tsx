/**
 * T3-CUSTOM(expbkt3): the native plan review panel.
 *
 * Default export so `ChatView` can `lazy()` it — Plate is ~200 kB gzip and must
 * not land in the main chunk. Everything the panel needs arrives over the fork
 * `planReview.*` RPCs; the live subscription keeps every open client converged.
 */
import type {
  EnvironmentId,
  PlanReviewSnapshotResult,
  PlanReviewVersion,
} from "@t3tools/contracts";
import { CheckIcon, HistoryIcon, MessageSquareIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PlanReviewDiscussions } from "./PlanReviewDiscussions";
import { PlanReviewEditor } from "./PlanReviewEditor";
import { PlanReviewVersions } from "./PlanReviewVersions";
import { nextPlanDiscussionId } from "./planReviewMarkdown";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { planReviewEnvironment } from "../../state/planReview";
import { toastManager } from "../ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";

interface PlanReviewPanelProps {
  readonly environmentId: EnvironmentId;
  readonly documentId: string;
  readonly onClose: () => void;
}

type PanelTab = "review" | "versions";

const DRAFT_SAVE_DEBOUNCE_MS = 500;

export default function PlanReviewPanel({
  environmentId,
  documentId,
  onClose,
}: PlanReviewPanelProps) {
  const [tab, setTab] = useState<PanelTab>("review");
  const [suggestionMode, setSuggestionMode] = useState(true);
  const [globalComment, setGlobalComment] = useState("");
  const [editedMarkdown, setEditedMarkdown] = useState<string | null>(null);
  const [roundTripWarning, setRoundTripWarning] = useState(false);
  const [comparison, setComparison] = useState<{ from: string; to: string } | null>(null);

  const revisionTokenRef = useRef<string | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initial = useEnvironmentQuery(
    planReviewEnvironment.review({ environmentId, input: { documentId } }),
  );
  const live = useEnvironmentQuery(
    planReviewEnvironment.subscription({ environmentId, input: { documentId } }),
  );

  // The subscription supersedes the one-shot read as soon as it produces a
  // frame, so the panel never renders stale state after another client writes.
  const snapshot: PlanReviewSnapshotResult | null = live.data ?? initial.data ?? null;

  const diffQuery = useEnvironmentQuery(
    comparison === null
      ? null
      : planReviewEnvironment.versionDiff({
          environmentId,
          input: {
            documentId,
            fromVersionId: comparison.from,
            toVersionId: comparison.to,
          },
        }),
  );

  const saveDraft = useAtomCommand(planReviewEnvironment.saveDraft, { reportFailure: false });
  const upsertDiscussion = useAtomCommand(planReviewEnvironment.upsertDiscussion);
  const resolveDiscussion = useAtomCommand(planReviewEnvironment.resolveDiscussion);
  const cutVersion = useAtomCommand(planReviewEnvironment.cutVersion);
  const submit = useAtomCommand(planReviewEnvironment.submit);

  const latestVersion = useMemo(() => snapshot?.versions.at(-1) ?? null, [snapshot?.versions]);

  useEffect(() => {
    if (snapshot?.draft) revisionTokenRef.current = snapshot.draft.revisionToken;
  }, [snapshot?.draft]);

  // A resolved review is history: it stays readable, but nothing can be sent
  // from it twice.
  const isResolved = snapshot !== null && snapshot.document.status !== "open";
  const canonicalMarkdown = latestVersion?.contentMarkdown ?? "";
  const isDirty = editedMarkdown !== null && editedMarkdown.trim() !== canonicalMarkdown.trim();

  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      setEditedMarkdown(markdown);
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        void saveDraft({
          environmentId,
          input: {
            documentId,
            contentValueJson: JSON.stringify({ markdown }),
            expectedRevisionToken: revisionTokenRef.current,
          },
        }).then((result) => {
          if (result._tag === "Success") {
            revisionTokenRef.current = result.value.revisionToken;
            return;
          }
          // A stale token means somebody else edited this plan; say so rather
          // than silently clobbering their work on the next save.
          toastManager.add({
            type: "error",
            title: "Someone else edited this plan",
            description: "Reload the panel to pick up their changes before saving again.",
          });
        });
      }, DRAFT_SAVE_DEBOUNCE_MS);
    },
    [documentId, environmentId, saveDraft],
  );

  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    },
    [],
  );

  const handleAddComment = useCallback(
    (quotedText: string, body: string) => {
      void upsertDiscussion({
        environmentId,
        input: {
          documentId,
          discussionId: nextPlanDiscussionId(),
          quotedText,
          bodyMarkdown: body,
        },
      });
    },
    [documentId, environmentId, upsertDiscussion],
  );

  const handleResolve = useCallback(
    (discussionId: string, isResolvedNext: boolean) => {
      void resolveDiscussion({
        environmentId,
        input: { documentId, discussionId, isResolved: isResolvedNext },
      });
    },
    [documentId, environmentId, resolveDiscussion],
  );

  const handleSaveVersion = useCallback(() => {
    if (editedMarkdown === null) return;
    void cutVersion({
      environmentId,
      input: {
        documentId,
        contentMarkdown: editedMarkdown,
        contentValueJson: null,
        summary: null,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setEditedMarkdown(null);
        toastManager.add({ type: "success", title: "Saved a new version of the plan" });
      }
    });
  }, [cutVersion, documentId, editedMarkdown, environmentId]);

  const handleRestore = useCallback(
    (version: PlanReviewVersion) => {
      // Restoring appends rather than rewriting: history stays append-only.
      void cutVersion({
        environmentId,
        input: {
          documentId,
          contentMarkdown: version.contentMarkdown,
          contentValueJson: null,
          summary: `Restored v${version.revision}`,
        },
      }).then((result) => {
        if (result._tag === "Success") {
          setEditedMarkdown(null);
          setTab("review");
        }
      });
    },
    [cutVersion, documentId, environmentId],
  );

  const handleSubmit = useCallback(
    (decision: "approved" | "changes-requested" | "discarded") => {
      void submit({
        environmentId,
        input: {
          documentId,
          decision,
          globalComment,
          editedMarkdown: isDirty ? editedMarkdown : null,
        },
      }).then((result) => {
        if (result._tag !== "Success") return;
        setGlobalComment("");
        setEditedMarkdown(null);
        if (decision === "approved") {
          toastManager.add({
            type: "success",
            title: "Plan approved",
            description: result.value.resentPlan
              ? "The full plan was re-sent because this session lost it from context."
              : "Implementation started.",
          });
        } else if (decision === "changes-requested") {
          toastManager.add({ type: "success", title: "Feedback sent to the planning agent" });
        }
        onClose();
      });
    },
    [documentId, editedMarkdown, environmentId, globalComment, isDirty, onClose, submit],
  );

  if (snapshot === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">
          {initial.error ? "This plan review could not be loaded." : "Loading plan…"}
        </p>
      </div>
    );
  }

  const openDiscussionCount = snapshot.discussions.filter(
    (discussion) => !discussion.isResolved,
  ).length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate font-medium text-sm" title={snapshot.document.title}>
          {snapshot.document.title}
        </h2>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          v{snapshot.document.currentRevision}
        </span>
        {isResolved ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {snapshot.document.status === "approved" ? "Approved" : snapshot.document.status}
          </span>
        ) : null}
      </header>

      <nav className="flex items-center gap-1 border-b px-2 py-1">
        <Button
          size="sm"
          variant={tab === "review" ? "secondary" : "ghost"}
          onClick={() => setTab("review")}
        >
          <MessageSquareIcon className="size-3.5" aria-hidden /> Review
          {openDiscussionCount > 0 ? (
            <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[11px] tabular-nums">
              {openDiscussionCount}
            </span>
          ) : null}
        </Button>
        <Button
          size="sm"
          variant={tab === "versions" ? "secondary" : "ghost"}
          onClick={() => setTab("versions")}
        >
          <HistoryIcon className="size-3.5" aria-hidden /> Versions
          <span className="ml-1 text-muted-foreground text-[11px] tabular-nums">
            {snapshot.versions.length}
          </span>
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={suggestionMode}
            disabled={isResolved}
            onChange={(event) => setSuggestionMode(event.target.checked)}
          />
          Suggest edits
        </label>
      </nav>

      {roundTripWarning ? (
        <p className="border-amber-500/40 border-b bg-amber-500/10 px-3 py-1.5 text-amber-800 text-xs dark:text-amber-300">
          This plan uses markdown the editor cannot reproduce exactly. Edits may reformat parts of
          it — check the diff before sending.
        </p>
      ) : null}

      {tab === "versions" ? (
        <PlanReviewVersions
          versions={snapshot.versions}
          diff={diffQuery.data?.diff ?? null}
          isDiffPending={comparison !== null && diffQuery.isPending}
          canRestore={!isResolved}
          onCompare={(from, to) => setComparison({ from, to })}
          onRestore={handleRestore}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <PlanReviewEditor
            markdown={canonicalMarkdown}
            readOnly={isResolved}
            suggestionMode={suggestionMode}
            onMarkdownChange={handleMarkdownChange}
            onAddComment={handleAddComment}
            onRoundTripUnstable={() => setRoundTripWarning(true)}
          />
          <aside
            className={cn(
              "min-h-0 shrink-0 overflow-auto border-t lg:w-72 lg:border-t-0 lg:border-l",
              "max-h-56 lg:max-h-none",
            )}
            aria-label="Plan discussions"
          >
            <PlanReviewDiscussions
              discussions={snapshot.discussions}
              comments={snapshot.comments}
              onResolve={handleResolve}
              disabled={isResolved}
            />
          </aside>
        </div>
      )}

      {isResolved ? null : (
        <footer className="border-t p-3">
          <textarea
            className="mb-2 w-full resize-y rounded-md border bg-background p-2 text-sm"
            rows={2}
            value={globalComment}
            placeholder="Overall notes for the agent (optional)"
            aria-label="Overall review notes"
            onChange={(event) => setGlobalComment(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => handleSubmit("approved")}>
              <CheckIcon className="size-3.5" aria-hidden /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleSubmit("changes-requested")}
              disabled={openDiscussionCount === 0 && globalComment.trim().length === 0 && !isDirty}
            >
              <SendIcon className="size-3.5" aria-hidden /> Send feedback
            </Button>
            <Button size="sm" variant="ghost" onClick={handleSaveVersion} disabled={!isDirty}>
              Save version
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => handleSubmit("discarded")}
            >
              <Trash2Icon className="size-3.5" aria-hidden /> Discard
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}
