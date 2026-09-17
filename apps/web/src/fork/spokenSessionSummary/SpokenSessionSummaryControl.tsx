/** T3-CUSTOM(expbkt3): Composer control for generating and reading a whole-session summary. */
import { useEffect, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { randomUUID } from "~/lib/utils";
import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ThreadWorkSummary,
} from "@t3tools/contracts";
import {
  IDLE_SPOKEN_SESSION_SUMMARY_STATE,
  beginSpokenSessionSummary,
  failSpokenSessionSummary,
  observeSpokenSessionSummary,
  type SpokenSessionSummaryState,
} from "@t3tools/client-runtime/spoken-session-summary";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { LoaderCircleIcon, RefreshCwIcon, SquareIcon, Volume2Icon } from "lucide-react";

function failureMessage(value: unknown): string {
  return value instanceof Error && value.message.trim()
    ? value.message
    : "The summary request could not be sent.";
}

export function SpokenSessionSummaryControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workSummary: ThreadWorkSummary | null | undefined;
}) {
  const requestSummary = useAtomCommand(threadEnvironment.requestWorkSummary, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SpokenSessionSummaryState>(IDLE_SPOKEN_SESSION_SUMMARY_STATE);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const spokenRequestRef = useRef<CommandId | null>(null);
  const speechSupported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined";

  const stopSpeech = () => {
    if (speechSupported) window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  const speak = (text: string) => {
    if (!speechSupported) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const generate = async () => {
    stopSpeech();
    setOpen(true);
    const requestId = CommandId.make(randomUUID());
    spokenRequestRef.current = null;
    setState(beginSpokenSessionSummary(props.threadId, requestId));
    const result = await requestSummary({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, commandId: requestId },
    });
    if (result._tag === "Failure") {
      setState((current) =>
        failSpokenSessionSummary(current, failureMessage(squashAtomCommandFailure(result))),
      );
    }
  };

  useEffect(() => {
    setState((current) => observeSpokenSessionSummary(current, props.threadId, props.workSummary));
  }, [props.threadId, props.workSummary]);

  useEffect(() => {
    if (!open || state.phase !== "ready" || spokenRequestRef.current === state.requestId) return;
    spokenRequestRef.current = state.requestId;
    speak(state.summary);
  }, [open, state]);

  useEffect(() => {
    stopSpeech();
    spokenRequestRef.current = null;
    setState(IDLE_SPOKEN_SESSION_SUMMARY_STATE);
  }, [props.threadId]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const pending = state.phase === "requesting" || state.phase === "pending";
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) stopSpeech();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (state.phase === "idle") void generate();
                  }}
                  aria-label="Summarize and read this session"
                >
                  {pending ? <LoaderCircleIcon className="animate-spin" /> : <Volume2Icon />}
                </Button>
              }
            />
          }
        />
        <TooltipPopup>Summarize and read this session</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="end" className="w-80" sideOffset={8}>
        <div className="space-y-3">
          <PopoverTitle className="text-sm">Session summary</PopoverTitle>
          {pending ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" /> Summarizing the complete session…
            </div>
          ) : state.phase === "ready" ? (
            <p className="max-h-52 overflow-y-auto whitespace-pre-wrap text-sm leading-6">
              {state.summary}
            </p>
          ) : state.phase === "error" ? (
            <p className="text-destructive text-sm">{state.message}</p>
          ) : (
            <p className="text-muted-foreground text-sm">Preparing the summary…</p>
          )}
          {!speechSupported && state.phase === "ready" ? (
            <p className="text-muted-foreground text-xs">
              Speech is unavailable in this browser. The summary is shown above.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {isSpeaking ? (
              <Button size="sm" variant="outline" onClick={stopSpeech}>
                <SquareIcon /> Stop
              </Button>
            ) : state.phase === "ready" && speechSupported ? (
              <Button size="sm" variant="outline" onClick={() => speak(state.summary)}>
                <Volume2Icon /> Replay
              </Button>
            ) : null}
            {!pending ? (
              <Button size="sm" variant="outline" onClick={() => void generate()}>
                <RefreshCwIcon /> Regenerate
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
