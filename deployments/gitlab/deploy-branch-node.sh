#!/usr/bin/env bash
set -euo pipefail

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'required variable is empty: %s\n' "$name" >&2
    exit 2
  fi
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'required command is missing: %s\n' "$name" >&2
    exit 2
  fi
}

require_var BRANCH_RELAY_NAME
require_command curl
require_command docker
if [ "$(id -u)" = "0" ]; then
  SUDO=()
else
  require_command sudo
  sudo -n true
  SUDO=(sudo)
fi

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif [ "${#SUDO[@]}" -gt 0 ] && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  printf 'docker daemon is not reachable by this runner user\n' >&2
  exit 2
fi

case "$BRANCH_RELAY_NAME" in
  branch_nd)
    BRANCH_RELAY_ENV_PREFIX="${BRANCH_RELAY_ENV_PREFIX:-BRANCH_ND}"
    ;;
  branch_fr)
    BRANCH_RELAY_ENV_PREFIX="${BRANCH_RELAY_ENV_PREFIX:-BRANCH_FR}"
    ;;
  *)
    BRANCH_RELAY_ENV_PREFIX="${BRANCH_RELAY_ENV_PREFIX:-}"
    ;;
esac

relay_var() {
  local suffix="$1"
  local fallback_name="BRANCH_${suffix}"
  local prefixed_name="${BRANCH_RELAY_ENV_PREFIX}_${suffix}"
  local value="${!fallback_name:-}"
  if [ -z "$value" ] && [ -n "$BRANCH_RELAY_ENV_PREFIX" ]; then
    value="${!prefixed_name:-}"
  fi
  printf '%s' "$value"
}

BRANCH_PUBLIC_ENDPOINT="$(relay_var PUBLIC_ENDPOINT)"
BRANCH_ADMIN_TOKEN="$(relay_var ADMIN_TOKEN)"
BRANCH_GOARCH="$(relay_var GOARCH)"
BRANCH_PROXY_BIND="$(relay_var PROXY_BIND)"
BRANCH_PROXY_PORT="$(relay_var PROXY_PORT)"
BRANCH_ADMIN_HOST_PORT="$(relay_var ADMIN_HOST_PORT)"

require_var BRANCH_PUBLIC_ENDPOINT
require_var BRANCH_ADMIN_TOKEN

BRANCH_GOARCH="${BRANCH_GOARCH:-amd64}"
BRANCH_PROXY_BIND="${BRANCH_PROXY_BIND:-0.0.0.0}"
BRANCH_DEPLOY_BASE="${BRANCH_DEPLOY_BASE:-/opt/branch/relays}"
BRANCH_DEPLOY_DIR="${BRANCH_DEPLOY_DIR:-${BRANCH_DEPLOY_BASE}/${BRANCH_RELAY_NAME}}"
BRANCH_COMPOSE_PROJECT="${BRANCH_COMPOSE_PROJECT:-branch-${BRANCH_RELAY_NAME//_/-}}"
BRANCH_IMAGE_NAME="${BRANCH_IMAGE_NAME:-branch-node:${BRANCH_RELAY_NAME}-${CI_COMMIT_SHORT_SHA:-local}}"

case "$BRANCH_RELAY_NAME" in
  branch_nd | relay_nd)
    BRANCH_PROXY_PORT="${BRANCH_PROXY_PORT:-8088}"
    BRANCH_ADMIN_HOST_PORT="${BRANCH_ADMIN_HOST_PORT:-18081}"
    ;;
  branch_fr | relay_fr)
    BRANCH_PROXY_PORT="${BRANCH_PROXY_PORT:-8089}"
    BRANCH_ADMIN_HOST_PORT="${BRANCH_ADMIN_HOST_PORT:-18082}"
    ;;
  *)
    require_var BRANCH_PROXY_PORT
    require_var BRANCH_ADMIN_HOST_PORT
    ;;
esac

if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  COMPOSE=("${DOCKER[@]}" compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif [ "${#SUDO[@]}" -gt 0 ] && sudo -n docker-compose version >/dev/null 2>&1; then
  COMPOSE=(sudo docker-compose)
else
  printf 'required command is missing: docker compose or docker-compose\n' >&2
  exit 2
fi

binary="dist/branch-node-linux-${BRANCH_GOARCH}"
if [ ! -x "$binary" ]; then
  printf 'deploy binary not found or not executable: %s\n' "$binary" >&2
  find dist -maxdepth 1 -type f -print >&2 || true
  exit 2
fi

"${SUDO[@]}" install -d -m 0755 -o root -g root "$BRANCH_DEPLOY_DIR"
"${SUDO[@]}" install -m 0755 -o root -g root "$binary" "${BRANCH_DEPLOY_DIR}/branch-node"
"${SUDO[@]}" install -m 0644 -o root -g root deployments/docker/branch-node.Dockerfile "${BRANCH_DEPLOY_DIR}/branch-node.Dockerfile"
"${SUDO[@]}" install -m 0644 -o root -g root deployments/docker/compose.yml "${BRANCH_DEPLOY_DIR}/compose.yml"
"${SUDO[@]}" install -m 0644 -o root -g root deployments/docker/nginx.conf "${BRANCH_DEPLOY_DIR}/nginx.conf"

compose_env_file="$(mktemp)"
trap 'rm -f "$compose_env_file"' EXIT
chmod 0600 "$compose_env_file"
{
  printf 'BRANCH_ADMIN_TOKEN=%s\n' "$BRANCH_ADMIN_TOKEN"
  printf 'BRANCH_IMAGE_NAME=%s\n' "$BRANCH_IMAGE_NAME"
  printf 'BRANCH_PROXY_BIND=%s\n' "$BRANCH_PROXY_BIND"
  printf 'BRANCH_PROXY_PORT=%s\n' "$BRANCH_PROXY_PORT"
  printf 'BRANCH_ADMIN_HOST_PORT=%s\n' "$BRANCH_ADMIN_HOST_PORT"
} >"$compose_env_file"
"${SUDO[@]}" install -m 0600 -o root -g root "$compose_env_file" "${BRANCH_DEPLOY_DIR}/compose.env"

"${COMPOSE[@]}" --env-file "${BRANCH_DEPLOY_DIR}/compose.env" -p "$BRANCH_COMPOSE_PROJECT" -f "${BRANCH_DEPLOY_DIR}/compose.yml" up -d --build --remove-orphans

for attempt in 1 2 3 4 5; do
  if curl -fsS -H "Authorization: Bearer ${BRANCH_ADMIN_TOKEN}" "http://127.0.0.1:${BRANCH_ADMIN_HOST_PORT}/readyz" >/dev/null; then
    break
  fi
  if [ "$attempt" = "5" ]; then
    "${COMPOSE[@]}" --env-file "${BRANCH_DEPLOY_DIR}/compose.env" -p "$BRANCH_COMPOSE_PROJECT" -f "${BRANCH_DEPLOY_DIR}/compose.yml" ps || true
    "${COMPOSE[@]}" --env-file "${BRANCH_DEPLOY_DIR}/compose.env" -p "$BRANCH_COMPOSE_PROJECT" -f "${BRANCH_DEPLOY_DIR}/compose.yml" logs --no-color --tail=80 || true
    exit 1
  fi
  sleep 1
done

mkdir -p relay-artifacts
curl -fsS -H "Authorization: Bearer ${BRANCH_ADMIN_TOKEN}" \
  "http://127.0.0.1:${BRANCH_ADMIN_HOST_PORT}/readyz" \
  >"relay-artifacts/${BRANCH_RELAY_NAME}-readyz.json"

curl -fsS -H "Authorization: Bearer ${BRANCH_ADMIN_TOKEN}" \
  --get --data-urlencode "endpoint=${BRANCH_PUBLIC_ENDPOINT}" \
  "http://127.0.0.1:${BRANCH_ADMIN_HOST_PORT}/bootstrap/beacon" \
  >"relay-artifacts/${BRANCH_RELAY_NAME}-beacon.json"

wrapper="$(sed -n 's/.*"wrapper":"\([^"]*\)".*/\1/p' "relay-artifacts/${BRANCH_RELAY_NAME}-beacon.json")"
if [ -n "$wrapper" ]; then
  printf '%s\n' "$wrapper" >"relay-artifacts/${BRANCH_RELAY_NAME}-records.br0"
fi

"${DOCKER[@]}" image prune -af --filter "label=org.branch.role=relay-node" >/dev/null || true

printf 'deployed %s via Docker Compose; NPM target %s:%s; beacon endpoint %s\n' "$BRANCH_RELAY_NAME" "$BRANCH_PROXY_BIND" "$BRANCH_PROXY_PORT" "$BRANCH_PUBLIC_ENDPOINT"
