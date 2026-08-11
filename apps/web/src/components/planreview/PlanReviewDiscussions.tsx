/**
 * T3-CUSTOM(expbkt3): anchored discussion rail for the plan review panel.
 *
 * Each discussion carries the text it was anchored to; that quote is what the
 * server turns into a line range when the feedback is sent, so it is shown
 * verbatim rather than paraphrased.
 */
import type { PlanReviewComment, PlanReviewDiscussion } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { Avatar, userDisplayName } from "../ui/avatar";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { useCurrentUserId } from "../../state/identity";
import { useOrgMembers } from "../../state/orgMembers";

interface PlanReviewDiscussionsProps {
  readonly discussions: ReadonlyArray<PlanReviewDiscussion>;
  readonly comments: ReadonlyArray<PlanReviewComment>;
  readonly onResolve: (discussionId: string, isResolved: boolean) => void;
  readonly disabled: boolean;
}

function PlanReviewDiscussionsImpl({
  discussions,
  comments,
  onResolve,
  disabled,
}: PlanReviewDiscussionsProps) {
  const { resolveUser } = useOrgMembers();
  const viewerUserId = useCurrentUserId();

  const commentsByDiscussion = useMemo(() => {
    const grouped = new Map<string, PlanReviewComment[]>();
    for (const comment of comments) {
      const bucket = grouped.get(comment.discussionId);
      if (bucket) bucket.push(comment);
      else grouped.set(comment.discussionId, [comment]);
    }
    return grouped;
  }, [comments]);

  if (discussions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <MessageSquareIcon className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground text-sm">
          Select text in the plan and add a comment to start a discussion.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-2">
      {discussions.map((discussion) => {
        const thread = commentsByDiscussion.get(discussion.discussionId) ?? [];
        return (
          <li
            key={discussion.discussionId}
            className={cn(
              "rounded-md border p-2",
              discussion.isResolved ? "border-border/50 opacity-60" : "border-border",
            )}
          >
            <blockquote className="mb-2 border-primary/40 border-l-2 pl-2 text-muted-foreground text-xs italic">
              {discussion.quotedText}
            </blockquote>

            {thread.map((comment) => {
              const isViewer =
                comment.authorUserId === null || comment.authorUserId === viewerUserId;
              return (
                <div key={comment.commentId} className="mb-1.5 flex gap-2 last:mb-0">
                  {comment.authorUserId === null ? null : (
                    <Avatar user={resolveUser(comment.authorUserId)} size="xs" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-xs">
                      {isViewer ? "You" : userDisplayName(resolveUser(comment.authorUserId!))}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {comment.bodyMarkdown}
                    </p>
                  </div>
                </div>
              );
            })}

            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onResolve(discussion.discussionId, !discussion.isResolved)}
              >
                {discussion.isResolved ? (
                  <>
                    <RotateCcwIcon className="size-3.5" aria-hidden /> Reopen
                  </>
                ) : (
                  <>
                    <CheckIcon className="size-3.5" aria-hidden /> Resolve
                  </>
                )}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export const PlanReviewDiscussions = memo(PlanReviewDiscussionsImpl);
