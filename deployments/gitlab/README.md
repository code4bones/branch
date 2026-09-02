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

The beta path starts with a shell GitLab Runner on the ND VPS:

- `branch_nd`

The current CI can run two relay instances on that same host:

- `deploy:relay_nd`: public endpoint `nd.relay.undoo.ru`, NPM target port
  `8088`;
- `deploy:relay_fr_on_nd`: future FR-named beta relay, NPM target port `8089`.

Two containers on one VPS give separate relay identities and separate live
processes, but they remain one physical failure domain. The existing local
`branch.undoo.ru` relay on the development machine can serve as the second
independent host for beta checks.

The deploy jobs run on the target host and operate Docker Compose locally. Test
and build jobs use `docker run` with `golang:1.25` and `node:24`, so Go and Node
do not need to be installed on the VPS.

Host prerequisites:

- Docker CLI/daemon and Docker Compose v2, or legacy `docker-compose`.
- `curl`.
- If the runner is not root, passwordless sudo for installing files under
  `/opt/branch/relays`.
- NPM forwards the public host to the per-relay host port with WebSocket support
  enabled.
- Admin ports bind to loopback only: `127.0.0.1:18081` for ND and
  `127.0.0.1:18082` for FR-on-ND.

For the first ND relay, set:

~~~text
BRANCH_ND_PUBLIC_ENDPOINT=wss://nd.relay.undoo.ru:443/relay/v0
~~~

Configure NPM:

~~~text
Domain: nd.relay.undoo.ru
Forward Hostname / IP: <ND VPS IP or hostname>
Forward Port: 8088
Websockets Support: enabled
SSL: existing certificate
~~~

The compose stack publishes nginx on `0.0.0.0:8088` by default so NPM can live
on another host. If NPM runs on the same VPS, set `BRANCH_ND_PROXY_BIND` to
`127.0.0.1`.

## Required CI/CD variables

Set these in GitLab project CI/CD variables:

| Variable | Scope | Notes |
| --- | --- | --- |
| `BRANCH_ND_PUBLIC_ENDPOINT` | `deploy:relay_nd` | Public relay URL, initially `wss://nd.relay.undoo.ru:443/relay/v0`. |
| `BRANCH_FR_PUBLIC_ENDPOINT` | `deploy:relay_fr_on_nd` | Public relay URL when the FR-named host is ready. |
| `BRANCH_ND_ADMIN_TOKEN` | branch_nd deploy | Masked and protected. Used only against the local admin listener. |
| `BRANCH_FR_ADMIN_TOKEN` | FR-on-ND deploy | Masked and protected. Use a different value from ND. |

Optional variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `BRANCH_ND_GOARCH`, `BRANCH_FR_GOARCH` | `amd64` | Use `arm64` for ARM VPS hosts. |
| `BRANCH_ND_PROXY_BIND`, `BRANCH_FR_PROXY_BIND` | `0.0.0.0` | Host bind address for the nginx container port. |
| `BRANCH_ND_PROXY_PORT`, `BRANCH_FR_PROXY_PORT` | `8088` / `8089` | Host port NPM forwards to. |
| `BRANCH_ND_ADMIN_HOST_PORT`, `BRANCH_FR_ADMIN_HOST_PORT` | `18081` / `18082` | Loopback admin ports used by deploy checks. |
| `BRANCH_DOCKER_PRUNE_UNTIL` | `24h` | Manual cleanup age filter. |
| `BRANCH_DOCKER_PRUNE_ALL` | `0` | Set to `1` only when manual cleanup may remove unused non-dangling images. |

## Deploy flow

1. Push to `main`.
2. `build:branch-node` builds `linux/amd64` and `linux/arm64` binaries in
   Docker and keeps artifacts for one day.
3. Run `deploy:relay_nd` manually.
4. The deploy job writes `/opt/branch/relays/<relay>/`, starts the compose
   project, checks `/readyz`, and creates relay beacon artifacts.
5. Publish the generated `relay-artifacts/*-records.br0` content through the
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
