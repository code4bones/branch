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

A RendezvousBoard is an untrusted publication and observation adapter for
short-lived signed rendezvous events. It is not an identity authority, delivery
guarantee, mailbox, relay, directory, or B.R.A.N.C.H.-operated service.
SearchCarrier bootstrap and RendezvousBoard rendezvous are separate ports even
when one concrete adapter can implement both.

Conceptual TypeScript shape:

```ts
interface RendezvousBoard {
  publish(
    event: SignedEvent,
    options: PublishOptions,
  ): Promise<PublicationReceipt>;

  observe(
    filter: EventFilter,
    options: ObserveOptions,
  ): AsyncIterable<ObservedEvent>;

  search(filter: EventFilter, options: SearchOptions): Promise<SearchPage>;

  capabilities(): Promise<BoardCapabilities>;
}
```

`publish` is best-effort publication. A `PublicationReceipt` is carrier-local
evidence that the adapter attempted or observed carrier acceptance; it never
proves delivery, authenticity, ordering, freshness, or audience.

`observe` returns live or polling observations and must tolerate gaps,
disconnects, duplicate records, out-of-order records, and reconnects. The
iterator has explicit buffer limits, cancellation, and reconnect backoff.

`search` is a bounded recent backfill query for unexpired candidate events. A
live-only board may report `unsupported` for search while still satisfying the
publish/observe contract if its capabilities say so.

`capabilities` reports carrier-local behaviour: supported operations, maximum
event bytes, maximum page size, observation buffer limit, cursor/checkpoint
support, authentication requirements, rate-limit policy, browser-native
read/write viability, expiry support, and whether writes require a
user-supplied credential or proxy.

Adapters must not be assumed to preserve order, availability, exact formatting,
or authorship metadata. An adapter is responsible only for encoding,
publishing, discovering, and decoding candidate protocol events. The protocol
core validates signatures, expiry, canonical form, recipient decryptability,
deduplication, and replay policy before any event affects state.

### Filters, cursors, and checkpoints

Filters may use only public, non-sensitive envelope fields:

- protocol version;
- event type;
- recipient routing tag when present;
- bounded creation or expiry time window;
- carrier-specific topic, kind, tag, or relay-set selector that does not reveal
  secrets.

Carrier cursors and checkpoints are adapter state, not protocol evidence. They
may be used to resume polling or observation, but a malicious or broken carrier
can skip, repeat, rewind, or forge position hints. Clients therefore combine
cursor use with envelope expiry, deduplication, and redundant board selection.

### Encoding limits

Every adapter declares hard limits before it accepts remote data:

- maximum encoded event bytes;
- maximum decoded envelope bytes;
- maximum payload bytes accepted from the carrier;
- maximum page size and carrier response bytes;
- maximum observation buffer depth;
- maximum reconnect delay and retry budget;
- maximum tolerated carrier clock skew when carrier timestamps are consulted.

Carrier framing may wrap the canonical signed event bytes, for example in a
text marker or platform event body. The adapter may normalize carrier framing
only enough to extract candidate signed event bytes. It must not repair,
reinterpret, or reserialize protocol content to make an invalid event valid.

### Deduplication and error semantics

The protocol deduplication key is the signed event identity defined by the event
envelope specification. Exact duplicates observed through one or more boards
are idempotent. The same signed event identity with different canonical bytes is
an equivocation or corruption candidate and is rejected before processing.

Adapter errors use stable categories rather than carrier-specific strings:

- `unsupported`;
- `invalid_filter`;
- `encoded_event_too_large`;
- `carrier_unavailable`;
- `rate_limited`;
- `authentication_required`;
- `permission_denied`;
- `cursor_rejected`;
- `response_too_large`;
- `malformed_carrier_record`;
- `cancelled`;
- `timeout`.

Malformed carrier records are invalid candidates, not process failures. Unknown
carrier metadata is diagnostic-only and must not be treated as protocol
authority. Error details are length-limited and scrubbed before telemetry.

### Hostile carrier behaviour

A carrier may rewrite formatting, wrap text, truncate, moderate, duplicate,
reorder, delay, backdate, delete, rate-limit, inject bogus events, hide selected
results, or falsely report success. Events should be publishable across several
independent boards, and clients must expect duplicates when they do so.

Browser adapters must not require secret platform tokens stored in the PWA. If
a carrier needs privileged API credentials or a CORS proxy, that adapter is not
baseline browser-native. Proxying through a user-chosen relay or node can be
optional plumbing, but it cannot become mandatory discovery or rendezvous
infrastructure.

Live carrier tests are opt-in smoke tests. Ordinary conformance uses recorded
fixtures or local test servers so CI does not depend on public services or user
credentials.

### First proof adapter

The first real RendezvousBoard proof adapter is a Nostr relay-set adapter, with
a local recorded-fixture adapter for conformance, as recorded in D-BRANCH-018.
Nostr is used as a hostile carrier family because public relay implementations
expose browser-usable WebSocket publish/subscribe behaviour and relay
capability metadata. The adapter must use multiple configured relays for
meaningful tests and must not make any specific relay, Nostr identity, project
account, or B.R.A.N.C.H.-owned server mandatory.

Nostr event identifiers, signatures, authorship, relay timestamps, and relay
acceptance messages are carrier metadata around a B.R.A.N.C.H. signed envelope.
They may help the adapter route, publish, or debug, but they do not replace
B.R.A.N.C.H. envelope signatures, expiry, recipient encryption, or
deduplication.

GitHub Issues or Discussions remain useful SearchCarrier and Carry the Ribbon
candidates, but they are not the first live RendezvousBoard adapter because
browser writes normally require account credentials or proxying, indexing is
slower, and platform moderation/API limits make live rendezvous harder to
evaluate.

Shared fixtures for board adapters should include publish encoding, observed
carrier payloads, malformed wrapped payloads, duplicate pages, out-of-order
pages, missing or deleted records, rate-limit responses, CORS or proxy failure,
oversized records, unsupported search, and non-event noise.

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
