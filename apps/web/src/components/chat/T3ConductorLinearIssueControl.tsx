/**
 * T3-CUSTOM(expbkt3): Conductor-only Linear ticket control. Keeping the
 * complete dialog and persistence behavior here leaves ChatHeader with one
 * small, resilient mounting seam when upstream header actions change.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, Link2Icon, UnlinkIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { LinearIcon } from "../Icons";
import { isT3ConductorThread, resolveT3ConductorLinearIssue } from "../sidebar/T3Conductor.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FORM_ID = "t3-conductor-linear-issue-form";

export function T3ConductorLinearIssueControl({
  activeThreadEnvironmentId,
  activeThreadId,
}: {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const conductor = settings.experimental.t3Conductor;
  const linkedIssue = resolveT3ConductorLinearIssue(conductor.linearIssueUrl);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const visible = isT3ConductorThread(conductor, primaryEnvironmentId, {
    environmentId: activeThreadEnvironmentId,
    id: activeThreadId,
  });
  if (!visible) return null;

  const patchLinearIssue = (linearIssueUrl: string) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        t3Conductor: {
          ...conductor,
          linearIssueUrl,
        },
      },
    });
  };

  const openManager = () => {
    setDraft(linkedIssue?.url ?? "");
    setError(null);
    setOpen(true);
  };

  const openLinearIssue = async () => {
    if (!linkedIssue) return;
    try {
      const api = readLocalApi();
      if (!api) throw new Error("T3 could not access the browser link handler.");
      await api.shell.openExternal(linkedIssue.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Linear ticket could not be opened.");
    }
  };

  const saveLinearIssue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextIssue = resolveT3ConductorLinearIssue(draft);
    if (!nextIssue) {
      setError("Enter a Linear identifier such as TEC-123, or paste a Linear issue URL.");
      return;
    }
    patchLinearIssue(nextIssue.url);
    setOpen(false);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={
                linkedIssue
                  ? `Manage linked Linear ticket ${linkedIssue.identifier}`
                  : "Link Linear ticket"
              }
              onClick={openManager}
            />
          }
        >
          <LinearIcon className="size-3.5" />
          <span className="max-w-28 truncate">
            {linkedIssue ? linkedIssue.identifier : "Link Linear"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {linkedIssue ? `Manage ${linkedIssue.identifier}` : "Link a dedicated Linear ticket"}
        </TooltipPopup>
      </Tooltip>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setError(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Conductor Linear ticket</DialogTitle>
            <DialogDescription>
              Link one durable Linear issue to this permanent Conductor workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={FORM_ID} className="space-y-2" onSubmit={saveLinearIssue}>
              <Label htmlFor="t3-conductor-linear-issue">Issue identifier or URL</Label>
              <Input
                id="t3-conductor-linear-issue"
                autoFocus
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                placeholder="TEC-123 or https://linear.app/…"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                A short identifier opens in the BeKnown Linear workspace. Full Linear URLs retain
                their workspace.
              </p>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </form>
          </DialogPanel>
          <DialogFooter className="sm:items-center">
            {linkedIssue ? (
              <>
                <Button
                  className="sm:mr-auto"
                  type="button"
                  variant="destructive-outline"
                  onClick={() => {
                    patchLinearIssue("");
                    setOpen(false);
                  }}
                >
                  <UnlinkIcon />
                  Unlink
                </Button>
                <Button type="button" variant="outline" onClick={() => void openLinearIssue()}>
                  <ExternalLinkIcon />
                  Open ticket
                </Button>
              </>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button form={FORM_ID} type="submit">
              <Link2Icon />
              {linkedIssue ? "Update link" : "Link ticket"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
