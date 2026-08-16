/**
 * Fork-owned bootstrap for managed BK desktop distributions.
 *
 * A managed build is an Electron client for the central BK environment. It
 * serves the packaged renderer itself and deliberately never starts, exposes,
 * or registers a local T3 backend.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopClerk from "../app/DesktopClerk.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { readBkManagedEnvironment, resolveBkClientRendererSource } from "./BkManagedEnvironment.ts";

const { logInfo } = DesktopObservability.makeComponentLogger("bk-client-only-bootstrap");

/** Returns true when this managed bootstrap handled desktop startup. */
export const bootstrapBkClientOnlyDesktop = Effect.gen(function* () {
  const managedEnvironment = readBkManagedEnvironment();
  if (managedEnvironment === null) return false;

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const renderer = resolveBkClientRendererSource({
    managedHttpBaseUrl: managedEnvironment.httpBaseUrl,
    isDevelopment: environment.isDevelopment,
    devServerUrl: Option.getOrNull(environment.devServerUrl),
    clientAssetsDirectory: environment.clientAssetsDirectory,
  });

  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    targetOrigin: renderer.targetOrigin,
    backendOrigin: renderer.backendOrigin,
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
    ...(renderer.clientAssetsDirectory
      ? { clientAssetsDirectory: renderer.clientAssetsDirectory }
      : {}),
  });
  yield* installDesktopIpcHandlers();
  yield* logInfo("managed client-only desktop ready", {
    channel: managedEnvironment.channel,
    primaryEnvironment: managedEnvironment.httpBaseUrl,
    renderer: renderer.clientAssetsDirectory ? "packaged-client" : "development-server",
  });

  if (!(yield* Ref.get(state.quitting))) {
    yield* desktopWindow.handleBackendReady(renderer.backendOrigin);
  }
  return true;
}).pipe(Effect.withSpan("desktop.bootstrap.bkClientOnly"));
