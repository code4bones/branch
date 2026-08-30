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

The signed event envelope is the carrier-neutral object exchanged through
RendezvousBoard adapters, SearchCarrier records where applicable, relay route
announcements, and future control-plane gossip. It is authenticated before its
payload is used and remains valid or invalid independent of the carrier that
transported it.

The canonical protocol identifier for this draft is `branch/connectivity/0`, as
recorded in D-BRANCH-019. Earlier scaffold vectors that used `branch/0` are
legacy draft material and must be replaced before any v0 publication claim.

### Diagnostic shape

JSON below is diagnostic only. Ordinary JSON serialization is not signed and is
not normative.

```json
{
  "protocol": "branch/connectivity/0",
  "event_id": "base64url-32-byte-random-id",
  "type": "rendezvous.offer",
  "sender": {
    "key_alg": "ed25519",
    "public_key": "base64url-32-byte-public-key"
  },
  "recipient_tag": "base64url-16-or-32-byte-routing-tag",
  "created_at": 1700000000,
  "expires_at": 1700000300,
  "payload_mode": "sealed",
  "payload": "base64url-canonical-payload-bytes",
  "signature_alg": "ed25519",
  "signature": "base64url-64-byte-signature"
}
```

The outer envelope provides filtering, expiry, replay defence, and
authentication. Sensitive endpoints, device information, and session material
belong inside the encrypted payload.

### Canonical encoding and signed bytes

The normative envelope encoding is deterministic CBOR. It must use the RFC 8949
core deterministic encoding requirements: preferred serialization, definite
lengths, deterministic map ordering, no duplicate map keys, and no non-minimal
integer or length encodings. Tags, floating point values, indefinite length
items, duplicate top-level fields, and unknown top-level fields are rejected for
`branch/connectivity/0`.

The signature input is:

```text
"BRANCH signed event v0\n" || deterministic_cbor(unsigned_event)
```

`unsigned_event` contains every envelope field except `signature`. A decoder
must verify the exact canonical bytes; decoding and re-encoding through a
different representation must not alter the signed object.

Text carriers wrap the canonical signed envelope bytes as:

```text
BRANCH0.<base64url(deterministic_cbor(signed_event))>
```

Base64url values are unpadded. Carriers may wrap this text in platform-specific
records, but adapter extraction never changes the signed bytes.

### Field rules

- `protocol` is exactly `branch/connectivity/0`; unknown protocols are ignored
  as unsupported versions during carrier scanning and are never reinterpreted as
  v0.
- `event_id` is a random 256-bit value encoded as unpadded base64url. It is
  signed and provides event identity, deduplication, and replay separation.
- `type` is a controlled enum. Unknown event types are rejected or ignored with
  a stable unsupported-type reason before payload processing.
- `sender.key_alg` is `ed25519` for this draft.
- `sender.public_key` is the 32-byte Ed25519 public signing key encoded as
  unpadded base64url. It is self-contained sender authentication material, not
  a server account or carrier identity.
- `recipient_tag` is required for recipient-filtered rendezvous, route, and
  relay capability events. It is absent for public announcement events.
- `created_at` and `expires_at` are Unix seconds represented as integers where
  `0 <= created_at < expires_at <= 9007199254740991`.
- `payload_mode` is `sealed` for recipient-specific events. `public` is allowed
  only for explicitly public announcement types.
- `payload` is opaque bytes to the envelope layer and is encoded as unpadded
  base64url in diagnostic JSON. Sealed payload encryption must use a reviewed
  construction specified separately, such as HPKE if accepted; the envelope
  does not invent ECIES-like or ad hoc cryptography.
- `signature_alg` is `ed25519` for this draft unless a registry decision adds
  another algorithm before publication.
- `signature` is the 64-byte Ed25519 signature over the domain-separated
  canonical unsigned envelope.

The envelope has no separate `nonce` field. Event-level replay separation comes
from `event_id`. Any nonce required by the payload encryption suite belongs to
the sealed payload construction and is authenticated by that construction.

### Event type constraints

| Event | Recipient tag | Payload mode | Notes |
| --- | --- | --- | --- |
| `identity.announce` | Absent unless recipient-filtered | `public` or `sealed` | Public form contains no secrets. |
| `rendezvous.offer` | Required | `sealed` | Offers connection material to one recipient. |
| `rendezvous.answer` | Required | `sealed` | Answers an offer, possibly through another board. |
| `route.update` | Required or session-bound | `sealed` | Updates routes after contact exists. |
| `relay.announce` | Absent | `public` | Advertises relay capabilities, not honesty or storage. |
| `capability.grant` | Required | `sealed` | Grants bounded live relay delivery capability. |
| `capability.revoke` | Required | `sealed` | Revokes or replaces a previous capability. |

### Validation order

Structural validation is deterministic and clock-free:

1. bound encoded size before decoding;
2. decode deterministic CBOR and reject non-canonical forms;
3. reject unknown fields, duplicate keys, unknown enum values, unsafe integers,
   empty required strings, invalid base64url, and wrong key or signature sizes;
4. validate event type constraints, recipient tag presence, and payload mode;
5. construct the unsigned canonical bytes and verify the Ed25519 signature;
6. return an authenticated envelope candidate to the caller.

Acceptance-time validation is separate because it uses local policy and a local
clock. It checks expiry, future-created events, clock skew tolerance, local
capability support, deduplication state, and whether the recipient can decrypt a
sealed payload. A malformed remote packet returns a typed protocol error or is
ignored as an invalid carrier candidate; it must never panic the process.

### Expiry, replay, and deduplication

The protocol deduplication key is:

```text
(protocol, sender.public_key, event_id)
```

Exact duplicate valid events are idempotent and processed at most once. The same
deduplication key with different canonical bytes is rejected as an equivocation
or corruption candidate. Expired events are ignored, never refreshed by a
carrier, and never republished as current. Future-created events outside the
accepted skew window are rejected in v0.

Relay, board, and carrier adapter caches for replay or deduplication are
bounded and may be memory-only. A relay restart has no requirement to remember
seen event IDs and must not restore user messages, payloads, delivery queues, or
conversation state. Clients may persist seen event IDs in local user-owned state
when a product flow needs longer replay protection.

### Size limits

The default maximum encoded signed envelope is 64 KiB. The default maximum
payload inside that envelope is 48 KiB. Specific carriers, boards, relays, and
paths may advertise smaller limits, and senders must obey the smallest limit on
the chosen path. Decoders enforce limits before allocation or payload parsing.

### Test-vector requirements

Shared Go and TypeScript vectors must include:

- canonical deterministic CBOR signed envelope bytes;
- unsigned signature-input bytes;
- Ed25519 seed, public key, and expected signature for test-only keys;
- diagnostic JSON rendering, clearly marked non-normative;
- text carrier wrapper string;
- valid public `relay.announce`;
- valid sealed `rendezvous.offer` and `rendezvous.answer`;
- invalid unknown field, wrong protocol, unknown event type, invalid base64url,
  wrong key length, wrong signature length, non-canonical CBOR, mutated payload,
  public rendezvous payload, expired event, future-created event, and unsafe
  integer cases;
- deduplication cases for exact duplicate, same ID with changed payload, and the
  same event observed through multiple carriers;
- relay invariant case proving that relay restart restores no user traffic and
  has no durable seen-event requirement.

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

## First-contact rendezvous flow

First contact is a control-plane sequence, recorded in D-BRANCH-020, that lets
two clients establish an authenticated direct or relayed session without a
mandatory project-operated server, directory, board, or relay. Public carriers
help peers find candidate events, but they do not authenticate identity,
guarantee delivery, or become conversation state.

The roles below are Alice as initiator and Bob as recipient. The same sequence
applies when either side is a browser PWA, native client, or node-mediated
client, subject to local policy and available adapters.

### Preconditions

- Alice has local identity and signing material controlled by the user.
- Bob has published or directly shared signed bootstrap material sufficient for
  Alice to learn Bob's identity key, supported protocol versions, recipient tag
  derivation or current rendezvous tags, candidate RendezvousBoards, and relay
  or direct-route hints.
- Alice and Bob may have no prior trust relationship. A first-contact session
  is authenticated to cryptographic keys before it is socially trusted by a
  user.
- All bootstrap records, board observations, route hints, and relay
  announcements are untrusted until signature, expiry, and policy checks pass.

### Sequence

1. Alice discovers Bob's bootstrap material through SearchCarrier results, a
   carried repository payload, QR/manual import, a contact export, or another
   non-authoritative carrier.
2. Alice validates Bob's signed material: protocol version, issuer signature,
   expiry, sequence or freshness policy when present, supported capabilities,
   and absence of mandatory project infrastructure.
3. Alice selects a board set from Bob's advertised boards, Alice's local policy,
   and adapter capabilities. Selection prefers multiple independent failure
   domains when available and rejects boards that require unsupported credentials
   or exceed local privacy policy.
4. Alice creates a fresh first-contact attempt with local state: offer ID,
   selected boards, expiry, retry budget, route candidates, and deduplication
   state. This state is user-owned client state, not relay or board state.
5. Alice builds a `rendezvous.offer` signed envelope for Bob's current
   `recipient_tag`. The envelope uses `payload_mode = sealed`, a fresh
   `event_id`, short expiry, and Alice's signing key.
6. The sealed offer payload contains only encrypted first-contact material:
   Alice's identity proof or contact-introduction proof, an ephemeral handshake
   contribution, supported connectivity protocol versions, supported
   capabilities, route candidates, optional relay capability requests, answer
   board hints, and the offer transcript binding needed by the reviewed
   handshake construction.
7. Alice publishes the same canonical offer, or independent equivalent offers
   with distinct `event_id` values, to the selected boards. Publication
   receipts are recorded only as carrier-local diagnostics.
8. Bob observes or searches his selected boards using public non-secret filters
   such as protocol, event type, recipient tag, and bounded time windows.
9. Bob extracts candidate envelopes and performs structural validation,
   signature verification, expiry checks, deduplication, payload-mode checks,
   and recipient decryptability checks before the payload affects state.
10. Bob applies first-contact policy. Policy may require local user approval,
    proof-of-work, invitation material, mutual contacts, local allowlists, rate
    limits, or other anti-abuse controls before responding or revealing richer
    route information.
11. Bob creates a `rendezvous.answer` signed envelope sealed to Alice. The
    answer may be published through the same board, through one of Alice's
    answer board hints, or through another mutually supported board. It binds to
    Alice's offer transcript and contains Bob's selected route candidates,
    supported protocol version, and any relay capability grant needed for live
    forwarding.
12. Alice observes or searches her answer boards, validates Bob's answer using
    the same envelope rules, decrypts it, checks transcript binding, and
    confirms Bob's identity key matches the discovered bootstrap material or an
    explicitly accepted replacement.
13. Both clients attempt connection establishment according to route policy:
    existing authenticated direct route, direct IPv6, ICE-assisted UDP or TCP,
    shared relay, then relay-to-relay route when supported. Direct routes are
    preferred when viable.
14. The chosen data-plane handshake authenticates both peer identities, binds
    the offer and answer transcripts, negotiates the highest mutually supported
    compatible protocol version and capabilities, and derives session keys using
    a reviewed construction.
15. After the authenticated session is established, ordinary encrypted message
    transport uses the selected direct or live relay path. The original
    RendezvousBoard is no longer required. Boards may still be used later for
    route recovery or wake-up signaling, not as conversation storage.

### Expiry, replay, and retry

Offers and answers are short-lived. Expired events are ignored even if a carrier
keeps returning them. A carrier cannot refresh an event by republishing or
moving it. Future-created events outside the accepted skew window are rejected
for v0.

Duplicate valid offers or answers are idempotent. The same deduplication key
with different canonical bytes is rejected as equivocation or corruption.
Retries use new event IDs and remain bounded by local retry policy. The sender
retains pending outbound attempt state locally; relays and boards do not provide
durable delivery queues.

### Board disappearance and path recovery

If the original board disappears before Bob sees the offer, Alice retries on
another selected board until the attempt expires or retry policy stops. If Bob
has seen the offer but cannot publish an answer on the same board, Bob may use
Alice's answer board hints or another mutually supported board.

If a board disappears after session establishment, the session continues over
the active data-plane path. If that path later fails, peers use authenticated
route migration and fresh rendezvous events on remaining boards as needed. A
new board event may help discover a route, but it does not change peer identity
or overwrite the authenticated session transcript.

### First-contact security boundaries

- A public board proves only that some carrier record was observed.
- A relay proves only live reachability under its advertised limits.
- Peer authentication is cryptographic first and user-trust policy second.
- No first-contact step may require a B.R.A.N.C.H. account, official board,
  official relay, project domain, or durable relay storage.
- Sensitive endpoints, capabilities, introductions, and device details remain
  inside sealed payloads.
- Logs, metrics, diagnostics, and board metadata never include plaintext
  payloads, keys, capabilities, identity exports, or authentication material.

### First-contact fixtures

Conformance fixtures must cover:

- discovery of Bob's signed bootstrap material through at least two carrier
  records with one stale or invalid record;
- offer publication to multiple boards with duplicate observation;
- answer through a different board than the offer;
- expired offer ignored;
- same offer ID with mutated canonical bytes rejected;
- unsupported board search with observe fallback;
- original board unavailable before answer publication;
- original board unavailable after session establishment while the session
  continues;
- relay unavailable during initial route selection followed by another route;
- peer identity mismatch between bootstrap material and answer rejected;
- first-contact policy rejection without leaking sealed payload contents.

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
