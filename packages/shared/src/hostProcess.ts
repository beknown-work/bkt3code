import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@t3tools/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

// T3-CUSTOM(expbkt3): BEGIN - backport of upstream #8305. The login account on
// the environment host, so a remote open-in-editor deep link can name the user
// to SSH as. Hosts differ (ds1 is `ubuntu`, a Mac is not), and the viewer's own
// username is not a usable guess, so the host reports its own.
export const HostProcessUsername = Context.Reference<string | null>(
  "@t3tools/shared/hostProcess/HostProcessUsername",
  {
    defaultValue: () => {
      try {
        return NodeOS.userInfo().username.trim() || null;
      } catch {
        return null;
      }
    },
  },
);
// T3-CUSTOM(expbkt3): END

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const HostProcessWorkingDirectory = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessWorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const HostProcessExecutablePath = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const HostProcessArguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/hostProcess/HostProcessArguments",
  {
    defaultValue: () => process.argv,
  },
);

/** Undefined on platforms without POSIX uids (Windows). */
export const HostProcessUserId = Context.Reference<number | undefined>(
  "@t3tools/shared/hostProcess/HostProcessUserId",
  {
    defaultValue: () => process.getuid?.(),
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
