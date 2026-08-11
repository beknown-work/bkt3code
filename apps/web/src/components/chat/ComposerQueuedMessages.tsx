import { Loader2, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";

export interface ComposerQueuedMessage {
  readonly messageId: string;
  readonly text: string;
}

export function formatQueuedMessagesHeading(options: {
  count: number;
  environmentConnected: boolean;
}): string {
  if (options.environmentConnected) return "Sending queued messages...";
  return `Reconnecting — ${options.count} queued message${
    options.count === 1 ? "" : "s"
  } will send automatically.`;
}

interface ComposerQueuedMessagesProps {
  messages: ReadonlyArray<ComposerQueuedMessage>;
  environmentConnected: boolean;
  onDiscard: (messageId: string) => void;
  className?: string;
}

export function ComposerQueuedMessages({
  messages,
  environmentConnected,
  onDiscard,
  className,
}: ComposerQueuedMessagesProps) {
  if (messages.length === 0) return null;

  return (
    <div
      data-chat-composer-queued-messages="true"
      className={cn("flex flex-col gap-1.5 px-3 py-2", className)}
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>{formatQueuedMessagesHeading({ count: messages.length, environmentConnected })}</span>
      </div>
      <div className="flex flex-col items-start gap-1">
        {messages.map((message) => (
          <span
            key={message.messageId}
            className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "max-w-full pr-1")}
          >
            <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "truncate")}>
              {message.text.length > 0 ? message.text : "(attachments only)"}
            </span>
            <button
              type="button"
              aria-label="Discard queued message"
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDiscard(message.messageId);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
