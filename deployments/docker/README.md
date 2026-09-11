# Optional coturn profile

`branch-turn` is an operator-owned, opt-in coturn process for local and future
WebRTC validation. It is not a B.R.A.N.C.H. relay attachment capability and it
does not issue client credentials. Until T-BRANCH-189 defines and implements
the authenticated, short-lived ICE credential flow, a running TURN service is
not advertised to a PWA and has no effect on ordinary WSS connectivity.

Start it deliberately, alongside the ordinary compose stack:

```sh
export BRANCH_TURN_REALM=turn.example.net
export BRANCH_TURN_AUTH_SECRET="$(openssl rand -hex 32)"
# Required when Docker is behind NAT: public-ip[/container-private-ip].
export BRANCH_TURN_EXTERNAL_IP=203.0.113.10
docker compose -f deployments/docker/compose.yml --profile turn up -d
```

Keep `BRANCH_TURN_AUTH_SECRET` in the protected operator environment or a
mode-0600 compose env file. It is coturn's server-side REST-auth secret, never
a PWA setting, BootstrapBeacon field, carrier record, diagnostic value, or a
long-lived client password. Coturn's `--use-auth-secret` mode requires a future
issuer to derive short-lived username/credential pairs; the reference project
does not contain that issuer yet.

The profile exposes TCP+UDP `3478` and UDP relay ports `49160-49200`. Open the
same ports in the host firewall and cloud security group. TLS/DTLS TURN is
intentionally not enabled by this initial scaffold because it needs
operator-managed certificates and the T-BRANCH-189 wire/configuration work.
Do not point nginx at this service. Restarting it restores no messages, files,
signaling state, credentials, or conversation data.
