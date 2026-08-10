# T3 Code docs

## Using T3 Code

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [User management](./user/user-management.md)
- [Source control integrations](./user/source-control.md)
- [Worktree setup and new-thread defaults](./user/worktree-setup.md)
- [T3 Code MCP control center](./user/t3-mcp-control.md)
- [Background service (Linux)](./user/background-service.md)
- [Provider usage limits](./user/provider-limits.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on T3 Code

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Durable thread bootstrap](./internals/thread-bootstrap.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Provider rate limits](./internals/provider-rate-limits.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [Thread-owned source-control identity](./internals/source-control-identity.md)
- [T3 Connect](./internals/t3-connect.md)
- [CI gates](./internals/ci.md)
- [Beknown deployments](./operations/deployments.md)
- [expbkt3 customization boundaries](./operations/expbkt3-customizations.md)
- [Personal MCP identity architecture](./internals/t3-personal-mcp-architecture.md)

### Runbooks

- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
- [Claude account switching on dev-server-1](./operations/claude-account-switching.md)
