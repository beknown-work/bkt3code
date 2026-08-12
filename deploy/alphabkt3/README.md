# Alpha T3 Code deployment

> **T3-CUSTOM(expbkt3):** This directory is an isolated deployment unit and
> does not modify upstream release infrastructure.

This deployment is the **identity-system soak lane** for the Beknown fork. It
exists so the BK Identity Service integration can run against a real deployment
for days at a time without occupying `expbkt3`, which stays available for its
normal staging role (proving upstream merges and ordinary fork changes on their
way to `bkmain`).

`alphabkmain` is a long-lived branch, reset from `bkmain` between experiments
exactly like `expbkmain`. Resetting rather than deleting keeps the branch present
on `origin`, which the deployment timer requires (a deleted trigger branch used
to make the timer fail every minute).

- Domain: `https://alphabkt3.dev.beknown.live` (wildcard record on the Beknown
  dev zone; this lane has no apex zone of its own)
- Branch: `alphabkmain`
- Worktree: `/home/ubuntu/repos/t3code-alphabkmain`
- systemd service: `t3-alphabkmain.service`
- Private server: `10.31.39.131:18086`
- Persistent state: `/home/ubuntu/.t3/alphabkt3-dev`
- Swarm proxy: `alphabkt3-proxy`
- Automatic deployment timer: `t3-alphabkmain-deploy.timer`

The web client is built with the same flags as `bkmain`, including
`VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true`, because this lane starts as a clone
of production. It still uses the Clerk configuration in
`/home/ubuntu/.t3/alphabkt3-dev/clerk.env` until the BK Identity Service replaces
it here.

## Resetting the lane keeps it alive only if the lane lives on `bkmain`

`deploy/alphabkt3/` and `.github/workflows/deploy-alphabkt3.yml` are what make
this lane deployable. While they exist only on `alphabkmain`, a reset from
`bkmain` deletes them and the lane stops deploying until they are restored.
Merge them to `bkmain` (the way the `expbkt3` lane files live on `bkmain`) before
relying on repeated resets.

## First installation

```bash
sudo install -m 0644 deploy/alphabkt3/t3-alphabkmain.service /etc/systemd/system/
sudo install -m 0644 deploy/alphabkt3/t3-alphabkmain-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/alphabkt3/t3-alphabkmain-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now t3-alphabkmain.service t3-alphabkmain-deploy.timer
deploy/alphabkt3/proxy.sh
```

Host-only drop-ins this lane needs under
`/etc/systemd/system/t3-alphabkmain{,-deploy}.service.d/`, mirroring the other
lanes (see [deployments.md](../../docs/operations/deployments.md#host-only-dependencies)):

- `clerk.conf` — `EnvironmentFile=-/home/ubuntu/.t3/alphabkt3-dev/clerk.env`, on
  both the runtime and deploy units.
- `github.conf` — wraps `auto-deploy.sh` in
  `t3-deploy-with-github-token` so `gh run download` is authenticated.
- `alert.conf` — `OnFailure=t3-deploy-alert@%n.service`, so a stuck timer is not
  silent.

The proxy script is idempotent.

## Manual deployment

```bash
cd /home/ubuntu/repos/t3code-alphabkmain
./deploy/alphabkt3/deploy.sh
```

The deploy script accepts an optional expected commit SHA. It fetches and
fast-forwards only `alphabkmain`, finds the successful GitHub Actions run for
that exact SHA, verifies and installs its SHA-addressed web/server artifact,
restarts the isolated service, and waits for the private health endpoint.
Dependency installation, tests, and application builds run in GitHub Actions;
they do not run on this host.

## Resetting `alphabkmain` from `bkmain`

`deploy.sh` fast-forwards only, so start a new experiment from a clean
fast-forward rather than a force push:

```bash
git -C /home/ubuntu/repos/t3code-bkmain fetch origin
git push origin origin/bkmain:refs/heads/alphabkmain
```

If `alphabkmain` carries experiment commits that were never merged, the push is
rejected. Confirm the branch is disposable
(`git log --oneline origin/bkmain..origin/alphabkmain`), then force it and reset
the worktree:

```bash
git push --force-with-lease origin origin/bkmain:refs/heads/alphabkmain
git -C /home/ubuntu/repos/t3code-alphabkmain fetch origin
git -C /home/ubuntu/repos/t3code-alphabkmain reset --hard origin/alphabkmain
```
