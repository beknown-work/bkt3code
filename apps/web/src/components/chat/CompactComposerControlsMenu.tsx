// T3-CUSTOM(expbkt3): fresh-thread controls include an inherited-defaults reverse action.
import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  // T3-CUSTOM(expbkt3): BEGIN — MenuItem renders the creation-defaults reset.
  MenuItem,
  // T3-CUSTOM(expbkt3): END
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  // T3-CUSTOM(expbkt3): BEGIN — fresh threads can return to inherited defaults.
  showCreationDefaultsReset: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onResetCreationDefaults: () => void;
  // T3-CUSTOM(expbkt3): END
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
        {/* T3-CUSTOM(expbkt3): BEGIN — inherited-defaults reverse action. */}
        {props.showCreationDefaultsReset ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onResetCreationDefaults}>
              <RotateCcwIcon className="size-4 shrink-0" />
              Use project/app defaults
            </MenuItem>
          </>
        ) : null}
        {/* T3-CUSTOM(expbkt3): END */}
      </MenuPopup>
    </Menu>
  );
});
