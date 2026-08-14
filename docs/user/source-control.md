# Source Control Integrations

T3 Code connects to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving the app.

## Supported Providers

T3 Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push, in one flow
- If the local repository has no commits yet, publishing creates the remote and wires it up but does not push. Make a commit, then push normally.

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git actions controls in the toolbar
- T3 Code can suggest titles and descriptions based on your commits
- Supports GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, and Azure DevOps Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open several reviews from the **Pull requests** page as tabs in the right panel
- While working in a thread, open linked reviews in the same compact right-panel tabs without
  leaving the conversation
- Open the review directly in your browser with one click
- Command-click (Control-click on Windows and Linux) a pull request number in the sidebar to open it in your browser instead of in T3 Code
- Check out a teammate's branch to review code locally

**Fix what you wrote, in place**

- Rewrite a pull request's title and description from the review itself, in Markdown, with a
  preview before you save
- Rewrite your own comments the same way, wherever they are shown
- Works on GitHub, GitLab, and Bitbucket. Azure DevOps takes a new title and description; its
  comments stay read-only here, as they already were

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI on the machine running T3 Code:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in T3 Code and verify GitHub shows as authenticated

You can now clone, publish, and create pull requests.

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

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses tokens instead of a CLI tool. Two options, both set as environment variables on the
machine running T3 Code.

Recommended, a Bitbucket access token:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or an Atlassian account email plus API token, with read/write access to pull requests and
repositories:

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

If both are set, the access token wins. Restart T3 Code and verify the connection in **Source
Control settings**.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T3 Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T3 Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)
- **A thread cannot start GitHub activity** – Assign a connected GitHub profile to its durable owner under **Settings → Users**
- **GitHub SSH remote is blocked** – Use the offered **Convert origin to HTTPS** action; no token is written into the URL
- **Profile is invalid or disconnected** – Replace its token under **Settings → Users → GitHub profiles**

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)
