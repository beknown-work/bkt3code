import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// T3-CUSTOM(expbkt3): BEGIN — recovery and failed outbox actions.
export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onRetry,
  onDismiss,
  retryLabel = "Retry",
  dismissLabel = "Dismiss",
}: {
  error: string | null;
  // T3-CUSTOM(expbkt3): exhausted durable work exposes explicit retry/dismiss.
  onRetry?: () => void;
  onDismiss?: () => void;
  retryLabel?: string;
  dismissLabel?: string;
}) {
  if (!error) return null;
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {(onRetry || onDismiss) && (
          <AlertAction>
            {onRetry ? (
              <>
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  {retryLabel}
                </Button>
                {onDismiss && (
                  <Button variant="ghost" size="sm" onClick={onDismiss}>
                    {dismissLabel}
                  </Button>
                )}
              </>
            ) : (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
// T3-CUSTOM(expbkt3): END
