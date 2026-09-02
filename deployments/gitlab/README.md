# GitLab CI relay deployment

This deploy path is for independent beta relay VPS hosts operated by the
project owner. It builds `branch-node` in Docker during CI and deploys a small
Docker Compose stack on the runner host:

- `branch-node`: the relay process;
- `branch-relay-nginx`: a local HTTP/WebSocket proxy for Nginx Proxy Manager.

The deployment does not add a database, durable queue, mailbox, or
store-and-forward path. The only persistent runtime data is the relay node
identity volume and operator configuration.

## Runner model

The beta path uses separate shell GitLab Runners for heavy CI work and runtime
deployment:

- `branch_lc`: builder VM for Dockerized Go and web test/build jobs;
- `branch_nd`: relay VPS for Docker Compose deploy and cleanup jobs.

The current CI can run two relay instances on that same host:

- `deploy:relay01`: public endpoint `relay01.undoo.ru`, NPM target port
  `8088`;
- `deploy:relay02`: public endpoint `relay02.undoo.ru`, NPM target port
  `8089`.

Two containers on one VPS give separate relay identities and separate live
processes, but they remain one physical failure domain. The existing local
`branch.undoo.ru` relay on the development machine can serve as the second
independent host for beta checks.

The deploy jobs run on the target host and operate Docker Compose locally. Test
and build jobs run on `branch_lc` using `docker run` with `golang:1.25` and
`node:24`, so Go and Node do not need to be installed on the relay VPS.

Builder host prerequisites:

- GitLab Runner registered with tag `branch_lc`.
- Docker CLI/daemon reachable by the runner user.
- Enough memory for TypeScript, lint, tests, Go race tests, staticcheck, and
  govulncheck.

Relay VPS prerequisites:

- Docker CLI/daemon and Docker Compose v2, or legacy `docker-compose`.
- `curl`.
- If the runner is not root, the `gitlab-runner` user can reach Docker directly
  through the `docker` group, or it can run passwordless `sudo docker`.
- If the runner is root or has passwordless sudo, runtime files are installed
  under `/opt/branch/relays` by default.
- If the runner is not root and has no passwordless sudo, runtime files are
  installed under `$HOME/branch/relays` by default. Set `BRANCH_DEPLOY_BASE` to
  a different runner-writable directory if needed.
- NPM forwards the public host to the per-relay host port with WebSocket support
  enabled.
- Admin ports bind to loopback only: `127.0.0.1:18081` for relay01 and
  `127.0.0.1:18082` for relay02.

For the two relay instances, set:

~~~text
BRANCH_RELAY01_PUBLIC_ENDPOINT=wss://relay01.undoo.ru:443/relay/v0
BRANCH_RELAY02_PUBLIC_ENDPOINT=wss://relay02.undoo.ru:443/relay/v0
BRANCH_RELAY01_ADMIN_TOKEN=<masked protected secret>
BRANCH_RELAY02_ADMIN_TOKEN=<masked protected secret>
~~~

To enable beta central relay monitoring, set the MASTER node with:

~~~text
BRANCH_MONITOR_INGEST_TOKEN=<masked local secret>
~~~

Then set these CI/CD variables for relay deploy jobs:

~~~text
BRANCH_MONITOR_MASTER_URL=https://branch.undoo.ru/node-admin/relay-monitor/reports
BRANCH_MONITOR_PUSH_TOKEN=<same value as BRANCH_MONITOR_INGEST_TOKEN for this beta>
~~~

The deploy script derives `BRANCH_MONITOR_RELAY_ID` from `BRANCH_RELAY_NAME`
and `BRANCH_MONITOR_PUBLIC_ENDPOINT` from the relay public endpoint unless
per-relay overrides are configured. Monitoring reports are optional bounded
status snapshots, stored only in MASTER process memory with TTL. They are not a
discovery source, routing input, bootstrap authority, or durable relay state.

Configure NPM for relay01:

~~~text
Domain: relay01.undoo.ru
Forward Hostname / IP: <relay VPS IP or hostname>
Forward Port: 8088
Websockets Support: enabled
SSL: existing certificate
~~~

The compose stack publishes nginx on `0.0.0.0:8088` by default so NPM can live
on another host. If NPM runs on the same VPS, set `BRANCH_RELAY01_PROXY_BIND` to
`127.0.0.1`.

Configure NPM for relay02:

~~~text
Domain: relay02.undoo.ru
Forward Hostname / IP: <relay VPS IP or hostname>
Forward Port: 8089
Websockets Support: enabled
SSL: existing certificate
~~~

If CI fails with Docker socket permission errors, fix the runner host:

~~~sh
sudo usermod -aG docker gitlab-runner
sudo systemctl restart gitlab-runner
~~~

Then rerun the failed pipeline. The CI scripts also fall back to `sudo docker`
when passwordless sudo allows it, but docker-group access is the simpler steady
state for relay deploy jobs. The builder runner should use direct Docker access
and should not host runtime relay containers.

If a deploy job fails with `sudo: a password is required`, either configure
passwordless sudo for that runner or let the script use its no-sudo default
runtime directory under `$HOME/branch/relays`. The no-sudo path still starts the
same Docker Compose stack and publishes the same NPM-facing ports.

## Required CI/CD variables

Set these in GitLab project CI/CD variables:

| Variable | Scope | Notes |
| --- | --- | --- |
| `BRANCH_RELAY01_PUBLIC_ENDPOINT` | `deploy:relay01` | Public relay URL, initially `wss://relay01.undoo.ru:443/relay/v0`. |
| `BRANCH_RELAY02_PUBLIC_ENDPOINT` | `deploy:relay02` | Public relay URL, initially `wss://relay02.undoo.ru:443/relay/v0`. |
| `BRANCH_RELAY01_ADMIN_TOKEN` | `deploy:relay01` | Masked and protected. Used only against the local admin listener. |
| `BRANCH_RELAY02_ADMIN_TOKEN` | `deploy:relay02` | Masked and protected. Use a different value from relay01. |
| `BRANCH_MONITOR_MASTER_URL` | relay monitor | Optional. MASTER webhook URL, usually `https://branch.undoo.ru/node-admin/relay-monitor/reports`. |
| `BRANCH_MONITOR_PUSH_TOKEN` | relay monitor | Optional. Masked and protected. Must match MASTER `BRANCH_MONITOR_INGEST_TOKEN`. |

Optional variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `BRANCH_RELAY01_GOARCH`, `BRANCH_RELAY02_GOARCH` | `amd64` | Use `arm64` for ARM VPS hosts. |
| `BRANCH_RELAY01_PROXY_BIND`, `BRANCH_RELAY02_PROXY_BIND` | `0.0.0.0` | Host bind address for the nginx container port. |
| `BRANCH_RELAY01_PROXY_PORT`, `BRANCH_RELAY02_PROXY_PORT` | `8088` / `8089` | Host port NPM forwards to. |
| `BRANCH_RELAY01_ADMIN_HOST_PORT`, `BRANCH_RELAY02_ADMIN_HOST_PORT` | `18081` / `18082` | Loopback admin ports used by deploy checks. |
| `BRANCH_RELAY01_MONITOR_MASTER_URL`, `BRANCH_RELAY02_MONITOR_MASTER_URL` | `BRANCH_MONITOR_MASTER_URL` | Per-relay MASTER webhook override. |
| `BRANCH_RELAY01_MONITOR_PUSH_TOKEN`, `BRANCH_RELAY02_MONITOR_PUSH_TOKEN` | `BRANCH_MONITOR_PUSH_TOKEN` | Per-relay monitor token override. |
| `BRANCH_RELAY01_MONITOR_RELAY_ID`, `BRANCH_RELAY02_MONITOR_RELAY_ID` | `relay01` / `relay02` | Per-relay monitor id override. |
| `BRANCH_RELAY01_MONITOR_PUBLIC_ENDPOINT`, `BRANCH_RELAY02_MONITOR_PUBLIC_ENDPOINT` | relay public endpoint | Per-relay monitor endpoint override. |
| `BRANCH_RELAY01_MONITOR_INTERVAL`, `BRANCH_RELAY02_MONITOR_INTERVAL` | `30s` | Per-relay monitor push interval. Minimum enforced by the node is `5s`. |
| `BRANCH_DEPLOY_BASE` | `/opt/branch/relays` with sudo, `$HOME/branch/relays` without sudo | Runtime compose directory base on the deploy runner. |
| `BRANCH_DOCKER_PRUNE_UNTIL` | `24h` | Manual cleanup age filter. |
| `BRANCH_DOCKER_PRUNE_ALL` | `0` | Set to `1` only when manual cleanup may remove unused non-dangling images. |

## Deploy flow

1. Push to `main`.
2. `go` and optional `web` run on `branch_lc`.
3. `build:branch-node` builds `linux/amd64` and `linux/arm64` binaries on
   `branch_lc` in Docker and keeps artifacts for one day.
4. Run `deploy:relay01` manually on `branch_nd`.
5. The deploy job writes `<deploy-base>/<relay>/`, starts the compose
   project, checks `/readyz`, and creates relay beacon artifacts.
6. Publish the generated `relay-artifacts/*-records.br0` content through the
   chosen carrier repository.

## Disk cleanup

GitLab build artifacts expire after one day. Test and build containers are
started with `--rm`. Runtime relay images are labelled
`org.branch.role=relay-node`; each deploy prunes older unused relay-node images.
The manual cleanup jobs prune stopped containers, old builder cache, and
dangling images on the runner host. Set `BRANCH_DOCKER_PRUNE_ALL=1` only when
the VPS can safely remove all unused images older than the configured age.
On a host with around 7.6 GB free, keep `BRANCH_DOCKER_PRUNE_UNTIL=24h` and run
the cleanup job after successful deploys if free space drops below roughly 2 GB.

Container logs remain in Docker logs. Relay runtime state on disk is limited to
the named volume containing `/var/lib/branch/node-identity.json`; deploy config
including the admin token is written as root-only
`/opt/branch/relays/<relay>/compose.env`.
