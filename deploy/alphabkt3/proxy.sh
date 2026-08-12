#!/usr/bin/env bash
# T3-CUSTOM(expbkt3): Isolated reverse-proxy registration for the alpha domain.
set -euo pipefail

SERVICE_NAME="alphabkt3-proxy"
NETWORK_NAME="bk-dev"
TARGET_ADDRESS="10.31.39.131:18086"

# Unlike expbkt3 there is no apex zone for this lane; `alphabkt3.dev.beknown.live`
# is served by the wildcard record on the Beknown dev zone, so one router pair is
# enough.
labels=(
  --label-add "traefik.enable=true"
  --label-add "traefik.http.services.alphabkt3.loadbalancer.server.port=18086"
  --label-add "traefik.http.routers.alphabkt3.entrypoints=web"
  --label-add 'traefik.http.routers.alphabkt3.rule=Host(`alphabkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.alphabkt3.middlewares=alphabkt3-https-redirect"
  --label-add "traefik.http.middlewares.alphabkt3-https-redirect.redirectscheme.scheme=https"
  --label-add "traefik.http.middlewares.alphabkt3-https-redirect.redirectscheme.permanent=true"
  --label-add "traefik.http.routers.alphabkt3-secure.entrypoints=websecure"
  --label-add 'traefik.http.routers.alphabkt3-secure.rule=Host(`alphabkt3.dev.beknown.live`)'
  --label-add "traefik.http.routers.alphabkt3-secure.tls.certresolver=le"
)

if sudo docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
  sudo docker service update \
    --force \
    "${labels[@]}" \
    --args "tcp-listen:18086,fork,reuseaddr tcp:$TARGET_ADDRESS" \
    "$SERVICE_NAME"
else
  sudo docker service create \
    --name "$SERVICE_NAME" \
    --network "$NETWORK_NAME" \
    "${labels[@]/--label-add/--label}" \
    alpine/socat:latest \
    "tcp-listen:18086,fork,reuseaddr" \
    "tcp:$TARGET_ADDRESS"
fi
