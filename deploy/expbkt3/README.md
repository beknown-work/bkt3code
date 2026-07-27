# Experimental T3 Code deployment

> **T3-CUSTOM(expbkt3):** This directory is an isolated deployment unit and
> does not modify upstream release infrastructure.

This deployment isolates the MCP control-center and Plannotator experiment from
the normal T3 and `bkmain` instances.

- Public domain: `https://expbkt3.dev`
- Fallback domain while the apex DNS zone is delegated:
  `https://expbkt3.dev.beknown.live`
- Branch: `t3code/exp-t3-mcp-plannator`
- Worktree: `/home/ubuntu/repos/t3code-expbkt3`
- systemd service: `t3-expbkt3.service`
- Private server: `10.31.39.131:18085`
- Persistent state: `/home/ubuntu/.t3/expbkt3-dev`
- Swarm proxy: `expbkt3-proxy`
- Automatic deployment timer: `t3-expbkt3-deploy.timer`

The web client is built with
`VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true`. The normal deployments do not set
that flag, so their sidebars and settings remain unchanged.

## First installation

```bash
sudo install -m 0644 deploy/expbkt3/t3-expbkt3.service /etc/systemd/system/
sudo install -m 0644 deploy/expbkt3/t3-expbkt3-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/expbkt3/t3-expbkt3-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now t3-expbkt3.service t3-expbkt3-deploy.timer
deploy/expbkt3/proxy.sh
```

The proxy script is idempotent. It creates separate Traefik routers for the exact
requested domain and the fallback Beknown hostname, so a missing apex DNS record
does not prevent validation of the application itself.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-expbkt3
./deploy/expbkt3/deploy.sh
```

The deploy script accepts an optional expected commit SHA. It fetches and
fast-forwards only the experimental branch, finds the successful GitHub Actions
run for that exact SHA, verifies and installs its SHA-addressed web/server
artifact, restarts the isolated service, and waits for the private health
endpoint. Dependency installation, tests, and application builds run in GitHub
Actions; they do not run on the production host.
