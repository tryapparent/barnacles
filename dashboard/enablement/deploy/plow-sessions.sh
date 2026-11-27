#!/usr/bin/env bash
set -euo pipefail
umask 077

root="${PLOW_SESSIONS_STATE:-$HOME/.local/share/barnacles/harbor}"
if [[ "${1:-}" == --install ]]; then
  [[ "$#" == 1 && "$root" == "$HOME/.local/share/barnacles/harbor" && -s "$root/cd/url" ]]
  units="$HOME/.config/systemd/user"
  mkdir -p "$units"
  install -m 700 "$0" "$root/cd/plow-sessions.sh"
  cat >"$units/plow-sessions.service" <<'UNIT'
[Unit]
Description=Deploy the verified Plow session history build

[Service]
Type=oneshot
ExecStart=%h/.local/share/barnacles/harbor/cd/plow-sessions.sh
TimeoutStartSec=10min
UNIT
  cat >"$units/plow-sessions.timer" <<'UNIT'
[Unit]
Description=Check for verified Plow session history releases

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now plow-sessions.timer
  exit 0
fi
[[ "$#" == 0 ]]

repo=tryapparent/plow
poller=barnacles-harbor-poller.service
service=barnacles-harbor.service
exec 9>"$root/deploy.lock"
flock -n 9 || exit 0

main_revision() {
  git ls-remote --exit-code "https://github.com/$repo.git" refs/heads/main | cut -f1
}

revision="$(main_revision)"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
previous="$(readlink -f "$root/current")"
[[ -f "$previous/revision" ]]
if [[ "$(cat "$previous/revision")" == "$revision" || "$(cat "$root/cd/failed-revision" 2>/dev/null || true)" == "$revision" ]]; then
  exit 0
fi
run="$(gh run list --repo "$repo" --workflow verify.yml --branch main --commit "$revision" --event push   --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
[[ -n "$run" ]] || exit 0
[[ "$run" =~ ^[0-9]+$ ]]

job="$(mktemp -d /tmp/apparent-dev-plow-sessions-cd-XXXXXX)"
candidate_pid=
restore=0
cleanup() {
  result=$?
  if [[ "$restore" == 1 ]]; then
    activate "$previous" || printf '%s\n' 'Plow session rollback needs attention.' >&2
  fi
  if [[ -n "$candidate_pid" ]]; then
    kill "$candidate_pid" 2>/dev/null || true
    wait "$candidate_pid" 2>/dev/null || true
  fi
  if [[ "$result" == 0 ]]; then
    rm -rf -- "$job"
  else
    printf 'Plow session deployment diagnostics are in %s.\n' "$job" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

gh run download "$run" --repo "$repo" --name plow-sessions --dir "$job" >/dev/null
[[ "$(cat "$job/revision")" == "$revision" && -f "$job/web/index.html" ]]
tar -xzf "$job/source.tar.gz" -C "$job"
export BARNACLES_TEST_DIRECTORY="$job"
(
  cd "$job/source"
  npm ci --ignore-scripts --loglevel error >"$job/npm.log" 2>&1
  node dashboard/prepare.ts "$root/polling/evidence.sqlite" "$job/snapshot" tryapparent/apparent >"$job/prepare.log" 2>&1
)
study="$previous/snapshot/session-study.sqlite"
if [[ ! -f "$study" ]]; then study="$root/cd/session-study.sqlite"; fi
[[ -f "$study" ]] || { printf '%s\n' 'Plow session study is missing.' >&2; exit 1; }
install -m 600 "$study" "$job/snapshot/session-study.sqlite"

verify() {
  node --input-type=module - "$1" <<'JS'
import assert from "node:assert/strict";
const base = process.argv[2];
async function read(path) {
  const response = await fetch(base + path, { redirect: "error", signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  return response;
}
const page = await (await read("/sessions")).text();
const asset = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
assert.ok(asset, "Expected the Plow frontend module");
assert.match(await (await read(asset)).text(), /session-timeline-/);
const data = await (await read("/api/v1/sessions")).json();
assert.ok(data.study && data.sessions?.length, "Expected a populated session study");
await read("/api/v1/shipping?limit=1");
JS
}

(
  cd "$job/source"
  exec node dashboard/prepare.ts --serve "$job/snapshot" 0 "$job/web"
) >"$job/candidate.log" 2>&1 &
candidate_pid=$!
candidate=
for attempt in {1..30}; do
  candidate="$(sed -nE 's/^Barnacles harbor (http:\/\/127\.0\.0\.1:[0-9]+)\/$/\1/p' "$job/candidate.log")"
  [[ -z "$candidate" ]] || break
  kill -0 "$candidate_pid"
  sleep 1
done
[[ -n "$candidate" ]]
verify "$candidate"
kill "$candidate_pid"
wait "$candidate_pid" || true
candidate_pid=

live="$(cat "$root/cd/url")"
[[ "$live" =~ ^https://[a-z0-9.-]+\.ts\.net(:[0-9]{1,5})?$ ]]
[[ "$(main_revision)" == "$revision" ]] || exit 0
release="$(mktemp -d "$root/releases/$revision-XXXXXX")"
mv -- "$job/source" "$job/web" "$job/snapshot" "$job/revision" "$release/"
switch_to() {
  local pointer
  pointer="$(mktemp -d "$root/.plow-current-XXXXXX")" || return
  if ln -s -- "$1" "$pointer/current" && mv -Tf -- "$pointer/current" "$root/current"; then
    rmdir "$pointer"
  else
    rm -rf -- "$pointer"
    return 1
  fi
}
activate() {
  systemctl --user stop "$poller" "$service" &&
    switch_to "$1" &&
    systemctl --user start "$service" "$poller"
}
restore=1
if activate "$release"; then
  for attempt in {1..8}; do
    if verify "$live" >"$job/live.log" 2>&1; then
      restore=0
      printf 'Plow sessions promoted %s from GitHub Actions run %s.\n' "$revision" "$run"
      exit 0
    fi
    sleep 2
  done
fi
if activate "$previous"; then
  restore=0
  printf '%s\n' "$revision" >"$root/cd/failed-revision"
  printf 'Plow sessions release %s failed and was rolled back.\n' "$revision" >&2
else
  restore=0
  printf 'Plow sessions release %s failed and rollback needs attention.\n' "$revision" >&2
fi
exit 1
