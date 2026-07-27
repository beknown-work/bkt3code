# Beknown `bkmain` deployment

This deployment serves the Beknown-maintained T3 Code branch at
`https://bkt3.dev.beknown.live` without changing the upstream-style deployment at
`https://t3.dev.beknown.live`.

## Isolation

- Branch: `bkmain`
- Worktree: `/home/ubuntu/repos/t3code-bkmain`
- systemd service: `t3-bkmain.service`
- Server address: `10.31.39.131:18083`
- Persistent state: `/home/ubuntu/.t3/bkt3-dev`
- Swarm proxy: `bkt3-proxy`
- Automatic deployment timer: `t3-bkmain-deploy.timer`
- Web build: experimental control-center and MCP surfaces enabled; T3 Conductor disabled

`start.sh` refuses to run unless the worktree is currently on `bkmain`.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-bkmain
./deploy/bkt3/deploy.sh
```

The deployment script fetches and fast-forwards `bkmain`, installs the locked
dependencies, rebuilds the web and server bundles, restarts the service, and waits
for the local endpoint to become healthy.

## Automatic CI/CD

`.github/workflows/deploy-bkt3.yml` validates, typechecks, and builds pull requests
and pushes targeting `bkmain`.

On the server, `t3-bkmain-deploy.timer` checks the current `origin/bkmain` head once
per minute. It deploys only when the GitHub Actions run for that exact commit has
finished successfully. This avoids storing production SSH or Tailscale credentials
in the public repository and prevents an older workflow run from deploying over a
newer commit. The last successfully deployed commit is recorded separately from the
worktree HEAD, so pushes made directly from the server are still rebuilt and
restarted after CI passes. Local commits that have not been pushed are never
replaced by the deployment watcher.

The root `.gitmodules` entry describes the nested gitlink already present in the
vendored Alchemy reference. It lets GitHub Actions clean credentials safely without
initializing or changing that vendored submodule.
