import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import {
  hasClerkPublicConfig,
  hasCloudPublicConfig,
  resolveClerkPublishableKey,
} from "./cloud/publicConfig";
import { TeamIdentityBridge } from "./components/clerk/TeamIdentityBridge";
import { getRouter } from "./router";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = resolveClerkPublishableKey();

const app = <AppRoot router={router} />;

// Inside Clerk: mirror the signed-in user into the identity atom (team mode),
// and keep the managed relay auth bridge only when full cloud config is present
// (publish-only Clerk sign-in does not need the relay JWT template / relay URL).
const clerkChildren = (
  <>
    <TeamIdentityBridge />
    {hasCloudPublicConfig() ? <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider> : app}
  </>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasClerkPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
          {clerkChildren}
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>{clerkChildren}</ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
