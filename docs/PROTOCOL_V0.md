# B.R.A.N.C.H. Protocol v0

Status: exploratory sketch. Nothing in this document is stable or ready for
security-sensitive deployment.

## Design constraints

- Carrier-neutral events.
- Portable cryptographic identity.
- Publicly observable but recipient-encrypted rendezvous payloads.
- Signed relay and route descriptors.
- Duplicate, delayed, reordered, and deleted board records are expected.
- Direct connectivity is preferred but not required.
- Relays are replaceable and capability-controlled.
- Existing, reviewed cryptographic constructions must be used; the project will
  not invent custom cryptography.

## Signed event envelope

Illustrative JSON only; canonical encoding is undecided.

```json
{
  "protocol": "branch/0",
  "id": "event-id",
  "type": "rendezvous.offer",
  "sender": "branch:identity-public-key",
  "recipient_tag": "short-routing-tag",
  "created_at": 0,
  "expires_at": 0,
  "nonce": "random-value",
  "payload": "recipient-encrypted-bytes",
  "signature": "sender-signature"
}
```

The outer envelope provides filtering, expiry, replay defence, and
authentication. Sensitive endpoints, device information, and session material
belong inside the encrypted payload.

## Initial event types

| Event | Purpose |
| --- | --- |
| `identity.announce` | Publish a signed identity descriptor or discovery hint. |
| `rendezvous.offer` | Offer a connection to a recipient. |
| `rendezvous.answer` | Answer an offer, possibly through another carrier. |
| `route.update` | Announce new signed routes to an established contact. |
| `relay.announce` | Advertise a community relay and its capabilities. |
| `capability.grant` | Permit bounded delivery through a relay. |
| `capability.revoke` | Revoke a previously granted capability. |

## Board adapter contract

Conceptual interface:

```ts
interface RendezvousBoard {
  publish(event: SignedEvent): Promise<PublicationReceipt>;
  subscribe(filter: EventFilter): AsyncIterable<SignedEvent>;
}
```

Adapters must not be assumed to preserve order, availability, exact formatting,
or authorship metadata. An adapter is responsible only for encoding, publishing,
discovering, and decoding candidate protocol events.

## Relay descriptor

```json
{
  "protocol": "branch-relay/0",
  "relay_key": "relay-public-key",
  "endpoints": [
    "quic://relay.example:443",
    "wss://relay.example/connect"
  ],
  "features": ["forward"],
  "limits": {
    "max_packet_bytes": 0,
    "max_ttl_seconds": 0
  },
  "expires_at": 0,
  "signature": "relay-signature"
}
```

Relay announcements describe capabilities; they do not prove honesty,
availability, privacy, or capacity. The reference relay baseline is live
transit only and does not advertise durable message, file, mailbox, or
store-and-forward storage.

## Minimal relay contract

The reference relay is a capability-controlled live conduit. It can assist
connectivity when direct peer-to-peer paths are unavailable, but it does not own
identity, presence, contacts, messages, files, or conversation state.

### Client attachment

A client attaches to a relay by presenting:

- the protocol version it wants to use;
- a short-lived route or session intent;
- any receiver-issued opaque capability required for admission;
- transport-level authentication appropriate to the chosen transport;
- bounded frame-size and flow-control parameters.

The exact handshake bytes are unresolved. The relay attachment contract must not
require a relay account, global username, or project-operated directory lookup.

### Opaque live forwarding

Relays forward encrypted frames as opaque bytes between live routes. They may
inspect only routing metadata required for admission, quota, expiry, and
backpressure. Payload confidentiality and peer authentication are end-to-end
properties, not relay promises.

Forwarding is best effort and bounded. A relay may drop, reject, or close when a
frame is malformed, oversized, unauthenticated, expired, over quota, or blocked
by a slow consumer. Rejection uses stable protocol errors or connection close
semantics rather than process panic.

### Capability admission

A relay does not accept arbitrary traffic to a globally enumerable identity. A
receiver grants a sender an opaque bounded capability. The token format is still
open, but the capability must bind enough information for the relay to enforce:

- permitted relay action, initially live forwarding;
- expiration time;
- maximum frame size;
- byte, frame, and connection quotas;
- optional transport or route constraints;
- revocation or replacement semantics once specified.

Capabilities are authorization material and must not appear in logs, telemetry,
URLs, public carrier records, or metric labels. They are not identity handles.

### Quotas, expiry, and backpressure

Every queue, frame, connection, route, retry, and forwarding window has an
explicit bound. Slow consumers are disconnected or degraded according to
protocol policy. Transmission buffers are memory-only, short-lived, and
discarded on disconnect, expiry, shutdown, or restart.

After restart a relay may retain only node identity, operator configuration, and
TLS or transport material. It restores no user messages, files, contact state,
session routes, delivery queues, or canonical presence view.

### Relay-to-relay scope

Relay-to-relay behaviour exists to bridge live routes and exchange signed
control-plane freshness such as BootstrapBeacons, HAVE/WANT summaries, and
relay self-announcements. It does not create a shared catalog or durable routing
database. A client may carry signed beacons between relay islands; authenticity
comes from issuer signatures and freshness checks, not from the relay that
transported the record.

### Path migration boundary

A session is bound to authenticated peer identity and session state, not to a
particular relay. Either peer may propose a new path. During migration, old and
new paths may overlap briefly, and delivery identifiers provide deduplication.
Relays participate only as live paths; they do not decide conversation
continuity.

## Carrier hopping

A peer session is bound to authenticated peer identity and session state, not to
a socket or relay. Either peer may propose another path. Both paths may overlap
briefly, and event identifiers provide deduplication during migration.

Example:

```text
GitHub board -> relay A -> direct QUIC -> relay B
```

## Capability-based delivery

A relay should not accept arbitrary traffic addressed to a globally enumerable
identity. The receiver grants a sender an opaque, bounded capability describing
where and how much data may be delivered. Exact token format and revocation
semantics are unresolved.

Baseline relay capabilities are live transit capabilities only. Offline inbox,
mailbox, file custody, or durable store-and-forward semantics are outside the
reference relay boundary and require a separate user-chosen storage-carrier
design if they are ever introduced.

## Explicitly out of scope for v0

- large groups and channels;
- voice and video calls;
- global human-readable usernames;
- perfect metadata protection or anonymity;
- cryptocurrency, token incentives, and relay markets;
- permanent cloud history;
- a universal solution to mobile push restrictions.
