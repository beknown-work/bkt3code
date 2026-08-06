import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedClerkIdentityAuthProvider, ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { resolveAppClerkMode, resolveClerkPublishableKey } from "./cloud/publicConfig";
import { TeamIdentityBridge } from "./components/clerk/TeamIdentityBridge";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = resolveClerkPublishableKey();
const clerkMode = resolveAppClerkMode();

const app = <AppRoot router={router} />;
const authenticatedApp =
  clerkMode === "cloud" ? <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider> : app;

// Inside Clerk, expose the token to standalone identity binding and mirror the
// signed-in user for the existing team-mode access controls. Full cloud builds
// additionally activate the managed relay session.
const clerkChildren = (
  <ManagedClerkIdentityAuthProvider>
    <TeamIdentityBridge />
    {authenticatedApp}
  </ManagedClerkIdentityAuthProvider>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && clerkMode !== "disabled" ? (
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
