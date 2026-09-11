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

The current CI can deploy relay instances on two hosts:

- `deploy:relay01`: tag `branch_nd`, public endpoint `relay01.undoo.ru`, NPM
  target port `8088`;
- `deploy:relay02`: tag `branch_nd`, public endpoint `relay02.undoo.ru`, NPM
  target port `8089`;
- `deploy:relay04`: tag `branch_lc`, public endpoint `relay04.undoo.ru`, NPM
  target port `8092`;
- `deploy:relay05`: tag `branch_lc`, public endpoint `relay05.undoo.ru`, NPM
  target port `8093`.

Multiple containers on one host give separate relay identities and separate
live processes, but they remain one physical failure domain. Using both
`branch_nd` and `branch_lc` relay deployments gives a better beta approximation
of independent operator hosts, while the existing local `branch.undoo.ru` relay
on the development machine can remain another test host.

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
- Read access to `/etc/ssl/certs/ca-certificates.crt`; the deploy script copies
  this host CA bundle into the scratch `branch-node` image so building the relay
  image does not need to pull an Alpine certificate stage from Docker Hub.
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
BRANCH_RELAY04_PUBLIC_ENDPOINT=wss://relay04.undoo.ru:443/relay/v0
BRANCH_RELAY05_PUBLIC_ENDPOINT=wss://relay05.undoo.ru:443/relay/v0
BRANCH_RELAY01_ADMIN_TOKEN=<masked protected secret>
BRANCH_RELAY02_ADMIN_TOKEN=<masked protected secret>
BRANCH_RELAY04_ADMIN_TOKEN=<masked protected secret>
BRANCH_RELAY05_ADMIN_TOKEN=<masked protected secret>
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

Configure NPM for relay04 on the `branch_lc` host:

~~~text
Domain: relay04.undoo.ru
Forward Hostname / IP: <builder VM IP or hostname>
Forward Port: 8092
Websockets Support: enabled
SSL: existing certificate
~~~

Configure NPM for relay05 on the `branch_lc` host:

~~~text
Domain: relay05.undoo.ru
Forward Hostname / IP: <builder VM IP or hostname>
Forward Port: 8093
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
| `BRANCH_RELAY04_PUBLIC_ENDPOINT` | `deploy:relay04` | Public relay URL, initially `wss://relay04.undoo.ru:443/relay/v0`. |
| `BRANCH_RELAY05_PUBLIC_ENDPOINT` | `deploy:relay05` | Public relay URL, initially `wss://relay05.undoo.ru:443/relay/v0`. |
| `BRANCH_RELAY01_ADMIN_TOKEN` | `deploy:relay01` | Masked and protected. Used only against the local admin listener. |
| `BRANCH_RELAY02_ADMIN_TOKEN` | `deploy:relay02` | Masked and protected. Use a different value from relay01. |
| `BRANCH_RELAY04_ADMIN_TOKEN` | `deploy:relay04` | Masked and protected. Use a different value from other relays. |
| `BRANCH_RELAY05_ADMIN_TOKEN` | `deploy:relay05` | Masked and protected. Use a different value from other relays. |
| `BRANCH_WSS_ORIGIN_PATTERNS` | relay WSS | Optional comma-separated browser Origin host allowlist. CI defaults beta deploy jobs to `branch.undoo.ru`; leave empty for same-origin/default non-browser clients. |
| `BRANCH_MONITOR_MASTER_URL` | relay monitor | Optional. MASTER webhook URL, usually `https://branch.undoo.ru/node-admin/relay-monitor/reports`. |
| `BRANCH_MONITOR_PUSH_TOKEN` | relay monitor | Optional. Masked and protected. Must match MASTER `BRANCH_MONITOR_INGEST_TOKEN`. |

### Optional relay-scoped TURN test profile

TURN remains off unless the specific relay's variable is exactly `true`. To
test it only on the `relay04` VM, set these GitLab CI/CD variables, scoped to
the protected `relay/relay04` environment:

| Variable | Protection | Value |
| --- | --- | --- |
| `BRANCH_RELAY04_TURN_ENABLED` | protected | `true` explicitly enables only `deploy:relay04`. Any empty or `false` value removes a stale `branch-turn` container. |
| `BRANCH_RELAY04_TURN_REALM` | protected | Stable authentication label, for example `branch-relay04`; it is not required to be a DNS name. |
| `BRANCH_RELAY04_TURN_AUTH_SECRET` | masked + protected | Fresh random REST-auth secret. It reaches only relay04's mode-0600 `compose.env`. |
| `BRANCH_RELAY04_TURN_EXTERNAL_IP` | protected | Public WAN address, or `public-ip/container-private-ip` for an explicit NAT mapping. Do not use the VM's RFC1918 LAN address. |
| `BRANCH_RELAY04_TURN_BIND` | protected, optional | Host bind address; default is `0.0.0.0`. |
| `BRANCH_RELAY04_TURN_PORT` | protected, optional | Listener port; default is `3478`. |

Forward and permit these ports from the public router address to the VM that
runs the `relay04` Compose project: `3478/TCP`, `3478/UDP`, and the complete
`49160-49200/UDP` relay range. The current profile deliberately has no
TLS/DTLS listener, so `5349` is not required. Router forwarding cannot make a
carrier-grade NAT address reachable; confirm that the router has a public WAN
address. These ports are separate from NPM and the WSS proxy port.

This starts only a transient coturn process. It does not advertise TURN to a
PWA, issue credentials, or change relay capability until the future
T-BRANCH-189 protocol work.

Optional variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `BRANCH_RELAY01_GOARCH`, `BRANCH_RELAY02_GOARCH` | `amd64` | Use `arm64` for ARM VPS hosts. |
| `BRANCH_RELAY01_PROXY_BIND`, `BRANCH_RELAY02_PROXY_BIND` | `0.0.0.0` | Host bind address for the nginx container port. |
| `BRANCH_RELAY01_PROXY_PORT`, `BRANCH_RELAY02_PROXY_PORT` | `8088` / `8089` | Host port NPM forwards to. |
| `BRANCH_RELAY01_ADMIN_HOST_PORT`, `BRANCH_RELAY02_ADMIN_HOST_PORT` | `18081` / `18082` | Loopback admin ports used by deploy checks. |
| `BRANCH_RELAY01_WSS_ORIGIN_PATTERNS`, `BRANCH_RELAY02_WSS_ORIGIN_PATTERNS` | `BRANCH_WSS_ORIGIN_PATTERNS` | Per-relay browser Origin host allowlist override. |
| `BRANCH_RELAY_FEDERATION_GITHUB_ENABLED` | `false` | Enables bounded signed BootstrapBeacon carrier discovery for every deployed relay; it does not configure relay peer addresses. |
| `BRANCH_RELAY04_GOARCH`, `BRANCH_RELAY05_GOARCH` | `amd64` | Use `arm64` for ARM builder/runtime hosts. |
| `BRANCH_RELAY04_PROXY_BIND`, `BRANCH_RELAY05_PROXY_BIND` | `0.0.0.0` | Host bind address for the nginx container port. |
| `BRANCH_RELAY04_PROXY_PORT`, `BRANCH_RELAY05_PROXY_PORT` | `8092` / `8093` | Host port NPM forwards to. |
| `BRANCH_RELAY04_ADMIN_HOST_PORT`, `BRANCH_RELAY05_ADMIN_HOST_PORT` | `18084` / `18085` | Loopback admin ports used by deploy checks. |
| `BRANCH_RELAY04_WSS_ORIGIN_PATTERNS`, `BRANCH_RELAY05_WSS_ORIGIN_PATTERNS` | `BRANCH_WSS_ORIGIN_PATTERNS` | Per-relay browser Origin host allowlist override. |
| `BRANCH_RELAY01_MONITOR_MASTER_URL`, `BRANCH_RELAY02_MONITOR_MASTER_URL` | `BRANCH_MONITOR_MASTER_URL` | Per-relay MASTER webhook override. |
| `BRANCH_RELAY01_MONITOR_PUSH_TOKEN`, `BRANCH_RELAY02_MONITOR_PUSH_TOKEN` | `BRANCH_MONITOR_PUSH_TOKEN` | Per-relay monitor token override. |
| `BRANCH_RELAY01_MONITOR_RELAY_ID`, `BRANCH_RELAY02_MONITOR_RELAY_ID` | `relay01` / `relay02` | Per-relay monitor id override. |
| `BRANCH_RELAY01_MONITOR_PUBLIC_ENDPOINT`, `BRANCH_RELAY02_MONITOR_PUBLIC_ENDPOINT` | relay public endpoint | Per-relay monitor endpoint override. |
| `BRANCH_RELAY01_MONITOR_INTERVAL`, `BRANCH_RELAY02_MONITOR_INTERVAL` | `30s` | Per-relay monitor push interval. Minimum enforced by the node is `5s`. |
| `BRANCH_RELAY04_MONITOR_*`, `BRANCH_RELAY05_MONITOR_*` | shared monitor values | Same per-relay monitor override pattern as relay01 and relay02. |
| `BRANCH_DEPLOY_BASE` | `/opt/branch/relays` with sudo, `$HOME/branch/relays` without sudo | Runtime compose directory base on the deploy runner. |
| `BRANCH_DOCKER_PRUNE_UNTIL` | `24h` | Manual cleanup age filter. |
| `BRANCH_DOCKER_PRUNE_ALL` | `0` | Set to `1` only when manual cleanup may remove unused non-dangling images. |

## Deploy flow

1. Push to `main`.
2. `go` runs on `branch_lc`; `web` remains an optional manual check because
   relay deployment ships only the Go node.
3. `build:branch-node` builds `linux/amd64` and `linux/arm64` binaries on
   `branch_lc` in Docker and keeps artifacts for one day.
4. `deploy:relay01`, `deploy:relay02`, `deploy:relay04`, and `deploy:relay05`
   run automatically on the configured runner tags. Jobs sharing one Docker host
   are serialized with CI `resource_group` locks and retried twice for transient
   runner/network failures.
5. Each deploy job writes `<deploy-base>/<relay>/`, starts the compose
   project, checks `/readyz`, and creates relay beacon artifacts.
6. Cleanup jobs run automatically after deploy on each runner host.
7. Publish the generated `relay-artifacts/*-records.br0` content through the
   chosen carrier repository.

## Disk cleanup

GitLab build artifacts expire after one day. Test and build containers are
started with `--rm`. Runtime relay images are labelled
`org.branch.role=relay-node`; each deploy prunes older unused relay-node images.
The cleanup jobs prune stopped containers, old builder cache, and dangling
images on the runner host. Set `BRANCH_DOCKER_PRUNE_ALL=1` only when the VPS can
safely remove all unused images older than the configured age.
On a host with around 7.6 GB free, keep `BRANCH_DOCKER_PRUNE_UNTIL=24h` and run
the cleanup job again manually only if free space drops below roughly 2 GB.

Container logs remain in Docker logs. Relay runtime state on disk is limited to
the named volume containing `/var/lib/branch/node-identity.json`; deploy config
including the admin token is written as root-only
`/opt/branch/relays/<relay>/compose.env`.
