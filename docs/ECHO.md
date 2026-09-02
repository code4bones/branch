# B.R.A.N.C.H. Echo

Status: beta self-addressed transport probe.

The default Echo check is a self-addressed relay loopback probe. A client sends
an HPKE-sealed `branch.echo.request/0.draft` payload to its own peer id through
one or more validated relay routes, receives the same live envelope back from
the first working route, opens it with its own HPKE key, and verifies that the
body matches.

This proves the beta client can attach, authenticate, rendezvous, forward,
receive sender-attributed envelopes, and decrypt payloads through a relay. It
does not require a project-operated Echo account, a daemon, a relay directory,
or any durable relay state.

Client-side beta check:

```ts
import { runEchoRoundTrip } from "@code4bones/branch-core";

const report = await runEchoRoundTrip({
  routes,
  body: "hello Echo"
});
```

The client supplies validated relay routes from normal discovery/transport
policy. The helper races bounded route attempts and returns the first route that
actually loops the message back, which is the current beta meaning of "nearest"
without introducing a relay directory or global location service.

Optional standing-peer contact:

```json
{
  "id": "branch.echo/0.draft",
  "label": "B.R.A.N.C.H. Echo",
  "peer_id": "UEfNJ9Ty0YZOSsIvr6zzdMrEThX7wegv2fy_epiVKYQ",
  "hpke_public_key": "Yn2kTy3rAzZGh_93cc6QR0lN1f9vEwdSkJWc_Z8OhBE",
  "payload_type": "branch.echo.request/0.draft"
}
```

The same public record is served by the web build at
`/.well-known/branch/echo.json`.

That fixed contact is an explicit interop experiment for testing a separate
online peer. It is not the default PWA Echo behaviour. To address it, pass the
contact explicitly to `runEchoRoundTrip`.

Runtime private material is operator-local and must not be committed. The local
development key file is `.runtime/branch-echo.local.json`.

The standalone runner starts Echo as one fixed peer across one or more relay
routes. It is optional and exists to test separate-peer interop; relay selection
still remains normal transport/discovery machinery.

The runner reads:

- `BRANCH_ECHO_KEYS`: optional key file path, defaults to the local development
  file.
- `BRANCH_ECHO_RELAY_MONITOR_URL`: optional MASTER relay monitor reports URL.
  Each report's signed `bootstrap_beacon.wrapper` is validated and converted to
  a route.
- `BRANCH_ECHO_RELAY_MONITOR_TOKEN`: optional bearer token for the monitor URL.
- `BRANCH_ECHO_BOOTSTRAP_WRAPPERS_FILE`: optional file containing whitespace
  separated `BRANCH0.` wrappers.
- `BRANCH_ECHO_BOOTSTRAP_WRAPPERS`: optional whitespace separated `BRANCH0.`
  wrappers.
- `BRANCH_ECHO_RELAY_ROUTES_JSON`: optional explicit route array with
  `endpointUri`, `relayPublicKey`, and optional `profileMultihash`.
- `BRANCH_ECHO_RELAY_ENDPOINT_URI`: legacy single WSS relay endpoint fallback.
- `BRANCH_ECHO_RELAY_PUBLIC_KEY`: legacy single relay Ed25519 public key
  fallback.
- `BRANCH_ECHO_PROFILE_MULTIHASH`: optional profile hash override.
- `BRANCH_ECHO_HEARTBEAT_INTERVAL_MS`: optional heartbeat interval.
- `BRANCH_ECHO_ATTACH_TIMEOUT_MS`: optional per-route attach timeout. A slow
  or unavailable route fails independently and does not block other routes.

Run from `packages/branch-core`:

```sh
npm run echo
```

For the local MASTER monitor on the development machine, the usual beta shape
is:

```sh
BRANCH_ECHO_RELAY_MONITOR_URL=http://127.0.0.1:8081/relay-monitor/reports \
BRANCH_ECHO_RELAY_MONITOR_TOKEN="$(cat ../../.runtime/branch-admin-token)" \
npm run echo
```

Echo never logs plaintext request or response bytes and keeps no conversation
history. Relay delivery still remains live-only and non-durable.
