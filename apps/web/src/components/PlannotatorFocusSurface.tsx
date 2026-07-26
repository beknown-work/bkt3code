import { XIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "./ui/button";

interface PlannotatorFocusSurfaceProps {
  url: `/plannotator/${string}/`;
  onClose: () => void;
}

export const PlannotatorFocusSurface = memo(function PlannotatorFocusSurface({
  url,
  onClose,
}: PlannotatorFocusSurfaceProps) {
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      data-plannotator-focus-surface
    >
      <iframe
        key={url}
        src={url}
        title="Plannotator plan review"
        className="h-full min-h-0 w-full border-0 bg-background"
        sandbox="allow-downloads allow-forms allow-modals allow-scripts"
        referrerPolicy="no-referrer"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-end p-3">
        <Button
          size="sm"
          variant="outline"
          className="pointer-events-auto gap-1.5 rounded-full bg-background/92 px-3 shadow-lg backdrop-blur-md"
          aria-label="Close plan review"
          onClick={onClose}
        >
          <XIcon className="size-4" />
          Close
        </Button>
      </div>
    </div>
  );
});

export type { PlannotatorFocusSurfaceProps };
