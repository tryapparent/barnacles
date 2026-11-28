set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${PLOW_LGTM_WORKDIR:?Set the private runtime directory}"
: "${PLOW_TAILNET_VIEWER:?Set the allowed Tailscale login}"
: "${PLOW_TAILNET_HTTPS_PORT:?Set the dedicated Tailscale HTTPS port}"
: "${PLOW_GRAFANA_PORT:?Set the dedicated Grafana loopback port}"
node_name=$(tailscale status --json | jq -er '.Self.DNSName | rtrimstr(".")')
export PLOW_GRAFANA_ROOT_URL="https://$node_name:$PLOW_TAILNET_HTTPS_PORT/"
export PLOW_GRAFANA_TAILNET_AUTH=true PLOW_LGTM_RESTART=unless-stopped
authority="$node_name:$PLOW_TAILNET_HTTPS_PORT"
backend="http://127.0.0.1:$PLOW_GRAFANA_PORT"
route=$(tailscale serve status --json)
jq -e --arg authority "$authority" --arg backend "$backend" '
  (.AllowFunnel[$authority] != true) and
  (.Web[$authority] == null or (.Web[$authority].Handlers | keys == ["/"]) and .Web[$authority].Handlers["/"].Proxy == $backend)
' <<< "$route" > /dev/null
umask 077
mkdir -p "$PLOW_LGTM_WORKDIR/spool"
if [[ ! -s "$PLOW_LGTM_WORKDIR/grafana-password" ]]; then
  openssl rand -hex 32 > "$PLOW_LGTM_WORKDIR/grafana-password"
  chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"
fi

docker compose -p plow-grafana config --quiet
docker compose -p plow-grafana up -d --build --wait --wait-timeout 120
admin() {
  curl -fsS --max-time 15 --netrc-file <(printf 'machine 127.0.0.1 login admin password %s\n' "$(cat "$PLOW_LGTM_WORKDIR/grafana-password")") "$@"
}
users=$(admin "$backend/api/org/users")
if ! jq -e --arg user "$PLOW_TAILNET_VIEWER" 'any(.[]; .login == $user)' <<< "$users" > /dev/null; then
  openssl rand -hex 32 |
    jq -Rc --arg user "$PLOW_TAILNET_VIEWER" '{name:"Plow viewer",login:$user,email:$user,password:.}' |
    admin -H 'Content-Type: application/json' --data-binary @- "$backend/api/admin/users" > /dev/null
fi
admin "$backend/api/org/users" |
  jq -e --arg user "$PLOW_TAILNET_VIEWER" 'any(.[]; .login == $user and .role == "Viewer")' > /dev/null
if [[ ${PLOW_TAILNET_SUDO:-false} == true ]]; then
  sudo -n tailscale serve --bg --https="$PLOW_TAILNET_HTTPS_PORT" "$backend"
else
  tailscale serve --bg --https="$PLOW_TAILNET_HTTPS_PORT" "$backend"
fi
printf '%s\n' "$PLOW_GRAFANA_ROOT_URL"
