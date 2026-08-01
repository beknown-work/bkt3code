import { assert, describe, it } from "@effect/vitest";

import {
  mergeSourceControlEnvironment,
  scrubSourceControlIdentityEnvironment,
} from "./SourceControlExecutionEnvironment.ts";

describe("SourceControlExecutionEnvironment", () => {
  it("removes inherited GitHub, author, SSH, and dynamic Git config values", () => {
    const scrubbed = scrubSourceControlIdentityEnvironment({
      PATH: "/bin",
      GH_TOKEN: "machine-token",
      GITHUB_TOKEN: "machine-github-token",
      GIT_AUTHOR_NAME: "Machine User",
      GIT_COMMITTER_EMAIL: "machine@example.test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "store",
      GIT_SSH_COMMAND: "ssh -i shared-key",
    });

    assert.deepStrictEqual(scrubbed, { PATH: "/bin" });
  });

  it("lets the thread profile win while preserving unrelated provider variables", () => {
    const merged = mergeSourceControlEnvironment(
      { PATH: "/bin", PROVIDER_KEY: "provider", GH_TOKEN: "machine" },
      {
        GH_TOKEN: "alice-token",
        GIT_AUTHOR_NAME: "Alice",
        GIT_AUTHOR_EMAIL: "alice@users.noreply.github.com",
      },
    );

    assert.equal(merged.PATH, "/bin");
    assert.equal(merged.PROVIDER_KEY, "provider");
    assert.equal(merged.GH_TOKEN, "alice-token");
    assert.equal(merged.GIT_AUTHOR_NAME, "Alice");
  });
});
