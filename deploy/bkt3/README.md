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

`start.sh` refuses to run unless the worktree is currently on `bkmain`.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-bkmain
./deploy/bkt3/deploy.sh
```

The deployment script fetches and fast-forwards `bkmain`, installs the locked
dependencies, rebuilds the web and server bundles, restarts the service, and waits
for the local endpoint to become healthy.

## GitHub Actions deployment

`.github/workflows/deploy-bkt3.yml` validates pull requests and automatically
deploys successful pushes to `bkmain`. Configure these repository secrets:

- `BKT3_DEPLOY_HOST`: the Tailscale address or name of this server
- `BKT3_DEPLOY_SSH_KEY`: an SSH private key accepted by the `ubuntu` account
- `TAILSCALE_OAUTH_CLIENT_ID`: OAuth client for the CI Tailscale connection
- `TAILSCALE_OAUTH_SECRET`: OAuth secret for the CI Tailscale connection
