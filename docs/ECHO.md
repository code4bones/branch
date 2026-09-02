# B.R.A.N.C.H. Echo

Status: beta test contact.

Echo is a standing test peer for the current relay transport beta. A client can
send it an HPKE-sealed `branch.echo.request/0.draft` payload and receive the
same plaintext bytes sealed back to the caller's advertised reply HPKE key.

Public contact:

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

Runtime private material is operator-local and must not be committed. The local
development key file is `.runtime/branch-echo.local.json`. The standalone runner
reads:

- `BRANCH_ECHO_KEYS`: optional key file path, defaults to the local development
  file.
- `BRANCH_ECHO_RELAY_ENDPOINT_URI`: WSS relay endpoint to attach to.
- `BRANCH_ECHO_RELAY_PUBLIC_KEY`: relay Ed25519 public key expected during
  attachment.
- `BRANCH_ECHO_PROFILE_MULTIHASH`: optional profile hash override.
- `BRANCH_ECHO_HEARTBEAT_INTERVAL_MS`: optional heartbeat interval.

Run from `packages/branch-core`:

```sh
npm run echo
```

Echo never logs plaintext request or response bytes and keeps no conversation
history. Relay delivery still remains live-only and non-durable.
