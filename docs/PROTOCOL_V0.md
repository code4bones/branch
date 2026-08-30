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
  "features": ["forward", "store-and-forward"],
  "limits": {
    "max_packet_bytes": 0,
    "max_ttl_seconds": 0
  },
  "expires_at": 0,
  "signature": "relay-signature"
}
```

Relay announcements describe capabilities; they do not prove honesty,
availability, privacy, or capacity.

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

## Explicitly out of scope for v0

- large groups and channels;
- voice and video calls;
- global human-readable usernames;
- perfect metadata protection or anonymity;
- cryptocurrency, token incentives, and relay markets;
- permanent cloud history;
- a universal solution to mobile push restrictions.

