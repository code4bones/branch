#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_tmp="$(mktemp -d)"
trap 'rm -rf "$test_tmp"' EXIT

mkdir -p "$test_tmp/bin" "$test_tmp/dist"
ln -s "$repo_root/deployments" "$test_tmp/deployments"
printf '#!/bin/sh\nexit 0\n' >"$test_tmp/dist/branch-node-linux-amd64"
chmod 0755 "$test_tmp/dist/branch-node-linux-amd64"
printf 'test certificate bundle\n' >"$test_tmp/ca-certificates.crt"

cat >"$test_tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = info ]; then
  exit 0
fi
if [ "$1" = compose ] && [ "${2:-}" = version ]; then
  exit 0
fi
printf '%s\n' "$*" >>"$BRANCH_TEST_DOCKER_LOG"
EOF
chmod 0755 "$test_tmp/bin/docker"

cat >"$test_tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" /bootstrap/beacon "*) printf '%s\n' '{"wrapper":"test-record"}' ;;
  *) printf '%s\n' '{}' ;;
esac
EOF
chmod 0755 "$test_tmp/bin/curl"

run_deploy() {
  local enabled="$1"
  local log_file="$2"
  (
    cd "$test_tmp"
    PATH="$test_tmp/bin:$PATH" \
    BRANCH_TEST_DOCKER_LOG="$log_file" \
    BRANCH_CA_CERT_BUNDLE="$test_tmp/ca-certificates.crt" \
    BRANCH_DEPLOY_BASE="$test_tmp/runtime" \
    BRANCH_RELAY_NAME=relay04 \
    BRANCH_RELAY_ENV_PREFIX=BRANCH_RELAY04 \
    BRANCH_RELAY04_PUBLIC_ENDPOINT=wss://relay04.example.test/relay/v0 \
    BRANCH_RELAY04_ADMIN_TOKEN=test-admin-token \
    BRANCH_RELAY04_TURN_ENABLED="$enabled" \
    BRANCH_RELAY04_TURN_REALM=branch-relay04 \
    BRANCH_RELAY04_TURN_AUTH_SECRET=test-turn-secret \
    BRANCH_RELAY04_TURN_EXTERNAL_IP=198.51.100.44 \
    bash deployments/gitlab/deploy-branch-node.sh
  )
}

enabled_log="$test_tmp/enabled.log"
run_deploy true "$enabled_log"
grep -F -- '--profile turn up -d --build --remove-orphans' "$enabled_log" >/dev/null
grep -F -- 'BRANCH_TURN_AUTH_SECRET=test-turn-secret' "$test_tmp/runtime/relay04/compose.env" >/dev/null
if grep -F -- 'test-turn-secret' "$enabled_log" >/dev/null; then
  printf '%s\n' 'TURN secret was written to the Docker command log' >&2
  exit 1
fi

disabled_log="$test_tmp/disabled.log"
run_deploy false "$disabled_log"
grep -F -- '--profile turn rm -f -s branch-turn' "$disabled_log" >/dev/null
grep -F -- 'up -d --build --remove-orphans' "$disabled_log" >/dev/null
if grep -F -- 'BRANCH_TURN_AUTH_SECRET=' "$test_tmp/runtime/relay04/compose.env" >/dev/null; then
  printf '%s\n' 'disabled relay retained a TURN secret in compose.env' >&2
  exit 1
fi

invalid_output="$test_tmp/invalid.out"
if run_deploy enabled "$test_tmp/invalid.log" >"$invalid_output" 2>&1; then
  printf '%s\n' 'invalid TURN enable value unexpectedly succeeded' >&2
  exit 1
fi
grep -F -- 'expected true or false' "$invalid_output" >/dev/null

printf '%s\n' 'relay-scoped TURN deployment gate tests passed'
