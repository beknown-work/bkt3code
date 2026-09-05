# Source control

T3 Code integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### Collaborative GitHub identity

<!-- T3-CUSTOM(expbkt3): owner-based identity for Beknown team deployments. -->

On a shared T3 Code server, an administrator can enable **user-owned GitHub identity** in
**Settings → Users**. Every thread is owned by the user who created it. All commits, pushes, pull
requests, comments, reviews, agent commands, and integrated terminal commands started from that
thread automatically use the GitHub profile assigned to its durable owner.

To add a collaborator:

1. Create an expiring fine-grained GitHub personal access token for that collaborator. Grant only
   the repositories and permissions they need. Most coding workflows need **Contents: read/write**
   and **Pull requests: read/write**.
2. Under **Users → GitHub profiles**, add a profile with the token, Git display name, and a verified
   GitHub email or GitHub noreply email.
3. Assign the profile to its Clerk user, test it, then enable **Use each thread owner's GitHub
   identity**.
4. Create a thread normally. T3 assigns its creator as owner and uses that user's GitHub profile;
   clone and publish flows use the signed-in user's profile automatically.

The token is write-only: T3 Code stores it in the server secret store and never sends it back to a
client. Disconnecting a profile removes its token while keeping its label for historical threads.
Archiving prevents new assignments without changing past attribution.

Transferring durable thread ownership restarts its provider session and closes its integrated
terminals. Work started after the transfer uses the new owner's assigned profile; existing commits
and pull requests keep their original attribution. A transfer waits until the current turn,
terminal command, and Git action are idle.

GitHub remotes must use HTTPS in owner-based mode. If a repository uses a GitHub SSH remote, T3
Code blocks authenticated network operations and offers to convert `origin` to a token-free HTTPS
URL. It never falls back to the server's shared SSH key or machine-wide GitHub account.

Externally hosted OpenCode runtimes cannot receive a thread's environment because T3 Code does not
own that process. Built-in Git actions still use the durable owner's assigned profile, but
agent-issued GitHub commands are unavailable for those runtimes in enforced mode.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

<!-- T3-CUSTOM(expbkt3): actionable shared-identity failures. -->

- **A thread cannot start GitHub activity:** assign a connected profile to its owner in **Settings → Users**.
- **GitHub SSH remote is blocked:** choose **Convert origin to HTTPS**. The URL contains no token.
- **Profile is invalid or disconnected:** replace its token in **Settings → Users → GitHub profiles**.
