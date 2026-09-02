#!/usr/bin/env bash
set -euo pipefail

if docker info >/dev/null 2>&1; then
  exec docker "$@"
fi

if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  exec sudo docker "$@"
fi

printf 'docker daemon is not reachable by this runner user\n' >&2
printf 'fix: add gitlab-runner to the docker group and restart gitlab-runner, or allow passwordless sudo docker\n' >&2
exit 126
