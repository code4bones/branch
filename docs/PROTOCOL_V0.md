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

## Connectivity profile constitution

The Connectivity Protocol is the small immutable interoperability surface shared
by independent clients, relays, boards, carriers, and test suites. Application
releases, relay binaries, PWA mirrors, UI features, observation-front builds,
and carrier adapters may change without changing a numbered wire version. This
constitution is recorded in D-BRANCH-026.

This document still describes a pre-publication draft. Once a numbered wire
version is published, its protocol identifier, profile schema, registries,
canonical encodings, validation rules, state machines, and test vectors are
frozen. A defect in a published version is fixed by publishing a new version and
supporting overlap, not by reinterpreting old bytes.

### Version and profile negotiation

Every protocol-bearing announcement, rendezvous payload, relay attachment, and
session handshake advertises support as a bounded list of version offers. A
version offer contains:

- `wire_version`: the human-readable numbered wire version, such as `0`;
- `protocol`: the protocol identifier, such as `branch/connectivity/0`;
- `profile_multihash`: the multihash of the canonical machine-readable profile
  accepted by the implementation;
- `capabilities`: optional capability names supported for this role;
- `required_capabilities`: capability names that must be understood for this
  offer to be usable;
- `extensions`: optional extension names;
- `required_extensions`: extension names that make the offer unusable when
  unsupported.

Negotiation is deterministic after local policy filters unsupported or
untrusted options:

1. discard unknown wire versions and protocol identifiers;
2. discard offers whose `profile_multihash` is not locally accepted for that
   `wire_version`;
3. discard offers with unknown required capabilities or required extensions;
4. discard offers that exceed local limits, expiry, role, or transport policy;
5. choose the highest locally preferred remaining wire version, then the locally
   preferred profile hash, then the smallest mutually required capability set.

Downgrade resistance comes from transcript binding. Rendezvous offers, answers,
relay attachments, and data-plane handshakes bind the complete advertised
version/profile/capability lists and the final selection into the reviewed
session construction. A peer that offered `v0` and `v1` can still establish a
`v0` session with a `v0`-only peer; it cannot later claim that the same
transcript negotiated different semantics.

Unknown optional capabilities and extensions are ignored. Unknown required
capabilities and extensions fail negotiation before any sealed payload,
capability token, route material, or user message is accepted. Implementations
may support several published wire versions concurrently, and the network does
not require a coordinated global upgrade.

### Canonical machine-readable profile

A published wire version has one or more accepted connectivity profiles. A
profile is a deterministic CBOR object containing at least:

- `profile_schema`: the profile object schema version;
- `wire_version` and `protocol`;
- the canonical envelope schema and signature input domain;
- the public payload schemas used by this wire version;
- algorithm, capability, extension, message, frame, and error registries;
- size, time, retry, queue, and candidate-count limits;
- state-machine definitions for rendezvous, relay attachment, authenticated
  session setup, framing, delivery deduplication, and path migration;
- a manifest of required valid and invalid interoperability test vectors.

The profile multihash is computed over the exact deterministic CBOR profile
bytes using the published hash algorithm for the profile schema. The initial
profile schema uses a SHA-256 multihash encoded for transport as a bounded text
field. The human-readable version number is never enough to prove wire
compatibility; implementations verify the exact accepted `profile_multihash`
before treating a peer or relay as conformant.

The draft profile has no final multihash until the machine-readable profile
artifact and vector manifest are generated. Draft implementations may exchange a
development profile hash for testing, but they must not claim published v0
conformance until the accepted profile hash and vector set exist.

The current development profile artifact is
`spec/connectivity-profile-v0.draft.json`. It is exact-byte UTF-8 JSON for
scaffold testing, not the final published deterministic CBOR profile. Its
current development multihash is:

```text
uEiCaVLmVxHgth49YdSwXKM201oM4W6PHc61z_1rz-J_xVw
```

The current shared development vector manifest is
`testdata/vectors/protocol-v0/manifest.json`. It links envelope fixtures to the
profile artifact and to `conformance-transcripts.json`, which covers draft
negotiation, relay attachment rejection, delivery deduplication during path
overlap, path migration, and relay restart with no restored user traffic.
Independent two-client and two-relay conformance is explicitly marked
`not-yet-demonstrated` until separate implementations run the same manifest.

### Identifier and algorithm registries

Identifiers are case-sensitive ASCII strings. A published identifier is
immutable inside its wire version. New semantics require a new identifier, a new
extension, or a new wire version.

Baseline draft identifiers:

| Registry | Identifier | Meaning |
| --- | --- | --- |
| Protocol | `branch/connectivity/0` | Draft connectivity protocol identifier. |
| Text wrapper | `BRANCH0.` | Text carrier wrapper for exact signed envelope bytes. |
| Envelope encoding | `cbor.det.rfc8949` | RFC 8949 deterministic CBOR. |
| Identity key algorithm | `ed25519` | User, device, and node signing identity key. |
| Signature algorithm | `ed25519` | Signed event envelope signature algorithm. |
| Profile hash | `multihash.sha2-256` | Initial profile multihash algorithm. |
| Public event | `bootstrap.beacon` | Searchable public bootstrap record. |
| Rendezvous events | `rendezvous.offer`, `rendezvous.answer` | Sealed first-contact control-plane events. |
| Route event | `route.update` | Sealed route migration or recovery event. |
| Relay events | `relay.announce`, `capability.grant`, `capability.revoke` | Public relay descriptor and sealed live-transit capability events. |

Payload encryption and authenticated data-plane session construction are still
pre-publication blockers. They must be selected from reviewed constructions and
recorded in a decision before a published v0 profile hash is accepted. Until
then, sealed payloads and session handshakes are specified by required
properties and transcript bindings, not by invented cryptographic bytes.

D-BRANCH-036 selects a beta-only HPKE payload envelope path for the proof of
concept. Its draft suite identifier is `branch.hpke/0.draft`; the preferred
candidate is RFC 9180 `DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM`.
This lets test clients stop forwarding plaintext-like payloads through
`ENVELOPE` frames while keeping relays as opaque live transit. It is not a
published v0 session suite and does not by itself freeze the final profile hash,
frame encoding, traffic-key schedule, or conformance vectors.

### Capability registry rules

Capabilities describe optional behaviour, not trust. A capability name is
versioned, bounded, and role-specific. Capabilities never contain bearer tokens,
private endpoints, identity exports, plaintext contact graph, or user messages.
Tokens, if any, are transmitted only inside sealed payloads or authenticated
relay attachment flows.

The initial capability families are:

- `search.direct-browser/0`: browser-readable SearchCarrier access without a
  project proxy;
- `board.publish/0`, `board.observe/0`, `board.search/0`: RendezvousBoard
  operations;
- `relay.forward.live/0`: non-durable live encrypted frame forwarding;
- `route.direct.webrtc/0`: direct WebRTC route candidate support;
- `route.relay.wss/0`: WSS relay route candidate support;
- `route.migrate/0`: authenticated path migration within an established
  session;
- `visual.ribbon-block/0.draft`: Ribbon Image block-carrier discovery support.

Advertising a capability does not prove that a carrier, board, or relay is
honest, available, fresh, or well provisioned. It only states the sender's claim
about protocol behaviour and limits, which the receiver verifies through
validation, active probes, and local policy.

### Rendezvous payload contract

`rendezvous.offer` and `rendezvous.answer` are signed event envelopes with
sealed payloads. Their exact payload encryption suite is unresolved, but the
plaintext contract that the suite must authenticate is fixed for profile
definition:

- `attempt_id`: random first-contact attempt identifier scoped to the initiator;
- `transcript_parent`: hash or binding to the discovered bootstrap material and
  signed offer/answer envelope bytes, as defined by the selected session suite;
- `version_offers`: bounded list of version/profile/capability offers;
- `route_candidates`: bounded list of direct and relay route candidates;
- `relay_capability_requests` or `relay_capability_grants`: bounded live-transit
  requests or grants;
- `answer_boards`: optional bounded hints for answer publication;
- `expiry`, retry, and clock-skew policy values;
- anti-abuse or introduction proofs required by local policy.

An answer selects exactly one mutually supported version/profile and capability
set or rejects with a typed reason. The selected version/profile, all originally
advertised alternatives, both signed envelope byte strings, and both peers'
identity keys are bound into the data-plane session transcript.

### Route candidates and relay attachment

Route candidates are hints, not authority. A route candidate contains a bounded
route identifier, route type, endpoint or board/relay reference, expiry, limits,
priority, required capabilities, and transport-specific public parameters. It
does not contain plaintext messages, portable identity exports, private contact
graph, or durable delivery promises.

For the beta relay-to-relay vertical slice, a client may attach a bounded
`route_hints` array to a `RENDEZVOUS` frame after it has already discovered and
validated a peer's signed BootstrapBeacon through a SearchCarrier or addressed
carrier. Each route hint carries one WSS relay endpoint candidate, the relay
Ed25519 public key from the signed beacon, and a local priority. The receiving
relay treats the hint as hostile routing input: it bounds the candidate list,
validates endpoint shape before dialing, requires the remote attachment
challenge to prove the hinted relay key, opens only a live bridge for the
specific route attempt, and forgets the hint when the route/session ends. Route
hints are not a global relay directory, not presence, not a mailbox, and not
operator mesh configuration.

A relay attachment is accepted only for a live route and only after the relay
validates:

- the offered wire version and accepted `profile_multihash`;
- the requested live action, initially `relay.forward.live/0`;
- an opaque receiver-issued capability or equivalent admission proof;
- expiry, frame-size, byte, frame, connection, and rate limits;
- the transport authentication and flow-control parameters required by the
  relay profile.

Relay attachment state is memory-only and expires on disconnect, quota
exhaustion, shutdown, or restart. Relays do not restore session routes, delivery
queues, user messages, files, contact state, or canonical presence after
restart.

### Same-relay WSS attachment draft

D-BRANCH-034 defines the first transport milestone as an online-only vertical
slice where two simultaneously connected clients attach to one relay over WSS.
This subsection fixes the executable draft frame contract used by current
fixtures. It is not the final published deterministic CBOR wire encoding.

The current draft attachment schema is `branch.relay-attachment/0.draft`.
Diagnostic fixtures encode frames as strict JSON objects only so the Go and
TypeScript protocol cores can execute the same structural tests before the WSS
adapter exists. Final wire publication still requires deterministic CBOR
profile bytes and reviewed session encryption.

All relay attachment frames are bounded before decoding. Unknown fields are
rejected. Binary identifiers, nonces, transcript hashes, ciphertext, and
signatures are rendered in fixtures as unpadded base64url strings. The relay
must treat every remote field as hostile until decoded, bounded, and validated.

The initial frame roles are:

| Frame | Direction | Purpose |
| --- | --- | --- |
| `HELLO` | client to relay | Offers `branch/connectivity/0`, profile hashes, requested `relay.forward.live/0`, client nonce, client time, and client frame limit. |
| `CHALLENGE` | relay to client | Selects one accepted offer, returns relay nonce, relay public key, transcript hash, and relay proof. |
| `AUTH` | client to relay | Returns client public key, both nonces, transcript hash, and client proof. |
| `READY` | relay to client | Opens a memory-only live session with session id, route id, heartbeat interval, presence TTL, and accepted limits. |
| `PRESENCE` | authenticated client to relay | Announces a live peer id and short TTL for the current session route. |
| `HEARTBEAT` | authenticated client to relay | Renews the live presence TTL. |
| `LOOKUP` | authenticated client to relay | Asks whether a specific peer id is currently reachable under local policy. |
| `RENDEZVOUS` | authenticated client/relay | Binds a live route id to a currently reachable peer id; beta frames may include bounded client-discovered relay `route_hints`. |
| `ENVELOPE` | authenticated client/relay | Carries opaque end-to-end encrypted bytes over a live route only. |
| `ACK` | relay/client | Reports relay acceptance/forwarding or peer receipt; it never claims durable custody. |
| `ERROR` | relay/client | Carries a typed bounded failure code and retryability hint. |

`HELLO` contains `client_nonce`, `client_time`, `requested_role`,
`max_frame_bytes`, and an ordered bounded `offers` array. Each offer contains
`wire_version`, `protocol`, `profile_multihash`, `capabilities`,
`required_capabilities`, `extensions`, and `required_extensions`. The relay
rejects unsupported versions, unaccepted profile hashes, and missing
`relay.forward.live/0` before creating presence, route, mailbox, or message
state.

`CHALLENGE` contains the original `client_nonce`, a fresh `relay_nonce`,
`issued_at`, `expires_at`, the relay Ed25519 public key, the selected offer,
`transcript_hash`, and `relay_proof`. The relay public key must match the
Ed25519 `sender.public_key` from the validated BootstrapBeacon used to choose
this endpoint. TLS protects the transport, but it is not the B.R.A.N.C.H. relay
identity. The challenge freshness window is bounded to at most 60 seconds in
the executable draft fixtures; an expired, zero-length, or overlong challenge
window is rejected before AUTH state is accepted.

The relay proof input is domain separated:

```text
"BRANCH relay attachment v0\n" || canonical_attachment_transcript
```

`canonical_attachment_transcript` binds at least the original BootstrapBeacon
signed bytes or hash, the complete HELLO offer set, the selected offer,
`client_nonce`, `relay_nonce`, relay endpoint URI, and relay public key. The
current executable fixtures validate the presence and size of these fields.
The WSS adapter task must implement actual Ed25519 verification against the
same transcript once the final canonical bytes are accepted.

`AUTH` mirrors the nonce and transcript binding from the client side. It does
not authorize offline delivery, durable retry, global presence publication, or
carrier scraping. A client AUTH that references a mismatched, expired, replayed,
or unknown challenge fails with an authentication or replay error and creates no
presence, route, mailbox, or message state.

`READY` returns `session_id`, `route_id`, `presence_ttl_seconds`,
`heartbeat_interval_seconds`, and `accepted_limits`. Accepted limits include
`max_frame_bytes`, `max_queue_depth`, `max_frames_per_session`, and
`max_bytes_per_session`. A relay may choose lower limits than the client
offered. Limits are live connection limits, not storage quotas.

`PRESENCE` and `HEARTBEAT` create only ephemeral routing state. A peer is
currently reachable only until disconnect, close, quota exhaustion, relay
shutdown, or TTL expiry. Presence is not a searchable directory, social graph,
mailbox, or delivery receipt. `LOOKUP` and `RENDEZVOUS` can only return live
routes currently permitted by local policy. A relay may bind `RENDEZVOUS` to the
requester's own live peer id for bounded loopback diagnostics; this still
creates only an in-memory route and never authorizes durable delivery.

`RENDEZVOUS.route_hints`, when present in the executable beta JSON profile, is
an ordered bounded array of at most eight candidate objects. Each object
contains `transport`, `uri`, `relay_public_key`, and `priority`. The current
browser transport is `wss`; local test fixtures may use `ws` against in-process
test relays only. `uri` must be an absolute `/relay/v0` WebSocket endpoint with
no userinfo or fragment. `relay_public_key` is the base64url Ed25519 relay key
from a validated signed BootstrapBeacon. The relay may dial those candidates
for this one route attempt, but it must not retain them as a directory or scan
outside the supplied bounded list.

`ENVELOPE` sent by a client contains `session_id`, `route_id`, `path_epoch`,
`stream_id`, `delivery_id`, `ciphertext`, and `ack_requested`. A delivered beta
`ENVELOPE` may also contain relay-set `sender_peer_id`, which identifies the
live sender peer on that route so multi-contact clients and the Echo test
service can bind HPKE AAD and reply to the correct caller. `sender_peer_id` is
ephemeral route attribution, not a directory entry, user account, durable
presence record, or trust authority. The relay validates only the outer routing
and bounds needed for live forwarding. It must not decrypt, persist, index,
replay after restart, or log the ciphertext. If the destination is absent,
disconnected, expired, over quota, or unreachable, the relay returns `ERROR`
with `peer_unavailable` or another explicit transient code. It does not create a
"you were called" event.

`ACK` distinguishes `relay.accepted`, `relay.forwarded`, and `peer.received`.
The `durable` field is always `false` for relay acknowledgements in this
profile. Sender-owned pending retry state may keep a stable `delivery_id`, but
that persistence belongs to the client, not the relay.

### Authenticated session and framing contract

An authenticated session is established only after the selected reviewed session
construction authenticates both peer identities, binds the offer/answer
transcript and version/profile negotiation, and derives fresh traffic keys.
Transport security such as TLS, WSS, DTLS, or QUIC is useful transport
protection but does not replace end-to-end peer authentication.

The data-plane frame contract is:

- frames are length-prefixed and bounded before allocation;
- frame headers are authenticated by the selected session construction;
- ciphertext is opaque to relays and boards;
- every frame carries a `session_id`, `path_epoch`, `stream_id`, `delivery_id`,
  frame type, flags, and ciphertext length;
- `delivery_id` is stable across retransmission of the same encrypted delivery
  on another path and is unique within `(session_id, sender, stream_id)`;
- acknowledgements and flow-control updates are bounded and authenticated;
- malformed, oversized, unauthenticated, replayed, or unsupported frames are
  rejected with a typed error or connection close, never panic.

Frame bytes, header encoding, traffic-key schedule, and replay windows become
immutable only when the reviewed session suite and machine-readable profile are
accepted. The properties above are mandatory for any candidate suite.

For the beta HPKE payload path from D-BRANCH-036, additional authenticated data
binds the protocol identifier, profile multihash, sender and recipient peer
keys, delivery id, path epoch, stream id, frame type, acknowledgement flag, and
the beta suite identifier. It deliberately does not bind a relay hostname or
carrier repository so the same encrypted delivery can be retried over another
validated path during migration.

### Path migration state machine

Path migration is a session state transition, not a relay feature. Either peer
may propose a new path with a sealed `route.update` or an authenticated in-band
migration message. The transition is:

1. `active`: one or more paths carry authenticated frames for the current
   `path_epoch`;
2. `probing`: a peer proposes a new route candidate with a higher proposed
   epoch and bounded expiry;
3. `overlap`: both old and new paths may carry frames, and receivers deduplicate
   by `(session_id, sender, stream_id, delivery_id)`;
4. `commit`: both peers acknowledge the selected path and epoch;
5. `retire`: old paths are closed or left idle until their timers expire.

If probing or commit fails, peers continue on any still-authenticated active
path or return to rendezvous recovery. A relay cannot decide migration
continuity, refresh expired routes, or recreate session state after restart.

### Protocol error registry

Errors use stable machine-readable codes and bounded diagnostic text. Error
details must not contain plaintext payloads, keys, capabilities, identity
exports, authentication material, or permanent user identifiers.

Baseline error families:

- `unsupported_version`;
- `unsupported_profile`;
- `profile_hash_mismatch`;
- `required_capability_missing`;
- `required_extension_missing`;
- `malformed_envelope`;
- `signature_invalid`;
- `payload_decrypt_failed`;
- `frame_too_large`;
- `frame_malformed`;
- `frame_replayed`;
- `authentication_failed`;
- `capability_required`;
- `capability_expired`;
- `capability_revoked`;
- `quota_exceeded`;
- `peer_unavailable`;
- `route_unavailable`;
- `migration_rejected`;
- `rate_limited`;
- `timeout`;
- `internal_unavailable`.

An implementation may map these codes to local exceptions or UI text, but the
wire/profile code and conformance meaning remain fixed.

### Extension rules

Extensions are explicit and versioned. An extension may add a new optional
capability, event type, payload field, route type, frame type, or error detail
only when old implementations can ignore it safely. If support is required for
correctness or safety, it appears in `required_extensions` and changes
negotiation outcome before any affected payload or frame is processed.

No extension may redefine an existing field, weaken validation, change signed
bytes, reinterpret an old event type, require a project-operated service, add
durable relay custody to the reference relay, or make observability a
connectivity dependency. Experimental identifiers are local and non-conformant
until recorded in a decision and included in an accepted profile.

### Conformance suite

Conformance is based on shared fixtures, state-machine transcripts, and
cross-implementation execution. A published profile must ship a vector manifest
that includes:

- canonical valid and invalid signed envelopes and payloads;
- version/profile negotiation transcripts, including unknown versions,
  unsupported profile hashes, unknown required capabilities, and dual-version
  overlap without coordinated global upgrade;
- offer/answer transcripts with alternate-board answers, replay, expiry,
  identity mismatch, unsupported capability, and downgrade attempts;
- relay attachment transcripts for accepted live forwarding, missing or expired
  capability, quota exhaustion, frame too large, slow consumer, and relay
  restart with no restored traffic state;
- data-plane frame transcripts for delivery deduplication across overlapping
  paths, replay rejection, malformed frames, flow control, and path migration;
- SearchCarrier, RendezvousBoard, Ribbon Bearer, repository drop-in, and Ribbon
  Image fixtures defined later in this document.

Before any implementation claims published v0 conformance, at least two client
implementations and two relay implementations must run the same manifest. For
the reference project this means Go and TypeScript protocol cores must agree on
the same vectors, and relay/client integration tests must prove that disabling a
carrier and then an active relay does not require a B.R.A.N.C.H.-owned service
or durable relay state. Additional independent implementations can replace or
augment the reference pair, but a single code path exercised through two CLIs
does not satisfy the interoperability proof.

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

The draft-beta CBOR envelope uses a top-level deterministic map with text-string
keys. The binary fields `event_id`, `sender.public_key`, `recipient_tag` when
present, `payload`, and `signature` are CBOR byte strings. The string fields
`protocol`, `type`, `sender.key_alg`, `payload_mode`, and `signature_alg` are
CBOR text strings. `created_at` and `expires_at` are CBOR unsigned integers.
Diagnostic JSON renders those binary fields as unpadded base64url strings only
for human inspection and fixtures; JSON bytes are never signature input.

### Field rules

- `protocol` is exactly `branch/connectivity/0`; unknown protocols are ignored
  as unsupported versions during carrier scanning and are never reinterpreted as
  v0.
- `event_id` is a random 256-bit value. It is signed and provides event
  identity, deduplication, and replay separation.
- `type` is a controlled enum. Unknown event types are rejected or ignored with
  a stable unsupported-type reason before payload processing.
- `sender.key_alg` is `ed25519` for this draft.
- `sender.public_key` is the 32-byte Ed25519 public signing key. It is
  self-contained sender authentication material, not a server account or carrier
  identity.
- `recipient_tag` is required for recipient-filtered rendezvous, route, and
  relay capability events. It is absent for public announcement events.
- `created_at` and `expires_at` are Unix seconds represented as integers where
  `0 <= created_at < expires_at <= 9007199254740991`.
- `payload_mode` is `sealed` for recipient-specific events. `public` is allowed
  only for explicitly public announcement types.
- `payload` is opaque bytes to the envelope layer and is rendered as unpadded
  base64url only in diagnostic JSON. Sealed payload encryption must use a
  reviewed construction specified separately, such as HPKE if accepted; the
  envelope does not invent ECIES-like or ad hoc cryptography.
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
| `bootstrap.beacon` | Absent | `public` | Publishes searchable bootstrap hints. |
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
- valid public `bootstrap.beacon`;
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

## Bootstrap discovery

Bootstrap discovery is the slow control-plane entry path, recorded in
D-BRANCH-021, for a client that has no content URL, no configured relay, and no
project-operated directory. The client starts with the B.R.A.N.C.H. query
grammar and several SearchCarrier adapters, searches public indexes for signed
`bootstrap.beacon` events, and validates candidate beacons before using any
rendezvous board or relay hint.

A SearchCarrier is not an authority, mailbox, relay, delivery layer, or
presence directory. Search result ordering, timestamps, snippets, repository
metadata, package metadata, and account names are carrier evidence only. The
signed beacon and its referenced signed records remain the authority.

### BootstrapBeacon v0

A BootstrapBeacon is a public signed event envelope:

- `protocol = branch/connectivity/0`;
- `type = bootstrap.beacon`;
- no `recipient_tag`;
- `payload_mode = public`;
- short enough for all selected SearchCarrier publication surfaces;
- signed and encoded by the signed event envelope rules in D-BRANCH-019.

The public payload is deterministic CBOR and contains no secrets, capability
tokens, plaintext contact graph, user messages, private endpoints, identity
exports, or authentication material. The payload fields are:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `beacon_id` | Required | 32 random bytes stable for one relay announcement lineage. |
| `sequence` | Required | Monotonic unsigned integer scoped to `sender` and `beacon_id`. |
| `issued_at` | Required | Unix seconds when this beacon payload was issued. |
| `expires_at` | Required | Unix seconds after which the beacon is stale. |
| `previous_beacon_id` | Optional | Continuity link to the previous beacon for this sender and lineage. |
| `revokes` | Optional | Bounded list of beacon IDs or sequence ranges revoked by this issuer. |
| `protocol_versions` | Required | Supported connectivity protocol versions. |
| `profile_multihashes` | Required | Accepted connectivity profile hashes, unique and deterministic. |
| `relay_capabilities` | Required | Public bounded relay capability names, never tokens. |
| `relay_endpoints` | Required | One to eight route descriptors for this same relay identity. |
| `rendezvous_boards` | Optional | Public board hints such as Nostr relay-set descriptors. |
| `mirror_hints` | Optional | Independent PWA mirror hints, never required for identity. |
| `proofs` | Optional | Cross-publication hints or bundle proofs, not authority. |

For `branch/connectivity/0`, one `bootstrap.beacon` advertises one relay
identity. The relay identity is the Ed25519 public key in the signed event
`sender`; v0 payloads do not duplicate `relay_key` and do not carry delegated
relay keys.

`relay_endpoints` is an ordered deterministic CBOR array. Each descriptor is a
map with `transport`, `uri`, and `priority`; lower priority values are tried
first. Descriptors are unique by `(transport, uri)`. The mandatory browser v0
transport is `wss`. A `wss` URI is absolute, bounded, contains no userinfo and
no fragment, and carries an explicit valid port. DNS names, IPv4 literals, and
bracketed IPv6 literals are allowed when the browser TLS stack can validate
them; port 443 is recommended for public web deployment.

`protocol_versions`, `profile_multihashes`, and `relay_capabilities` are
bounded, unique, and deterministically ordered. Unknown optional transports or
capabilities may be skipped, but client acceptance requires at least one
supported profile hash and one supported endpoint.

The BootstrapBeacon payload uses a deterministic CBOR map with text-string
keys. `beacon_id` and `previous_beacon_id` are 32-byte CBOR byte strings.
`sequence`, `issued_at`, `expires_at`, and endpoint `priority` are CBOR
unsigned integers. Text arrays and optional public hint fields are bounded.

`expires_at` in the payload must match the outer signed envelope expiry. If both
are present and differ, the beacon is invalid. `issued_at` must not be later
than the outer `created_at`. Relay liveness is never inferred from publication;
clients actively probe relay endpoints before treating them as usable. The relay
must prove possession of the signed event sender key during attachment.

BootstrapBeacon payloads must not contain client presence, user or device IPs,
mailbox addresses, durable route state, conversation data, TURN passwords,
session secrets, cookies, bearer tokens, or reusable attachment credentials.

### IdentityContact v0 draft

An IdentityContact is a public signed `identity.announce` event that makes a
person identity discoverable without assigning a server-side UIN or account
identifier:

- `protocol = branch/connectivity/0`;
- `type = identity.announce`;
- no `recipient_tag` for the public form;
- `payload_mode = public`;
- `sender.public_key` is the root person identity key;
- the payload `branch_id` must equal the self-certifying BranchID derived from
  `sender.public_key`;
- the signed record is bounded, expiring, sequenced, and carrier-neutral.

The draft BranchID format is:

```text
br1.<base64url(multihash.sha2-256("BRANCH identity id v0\n" || root_public_key))>
```

This is an address and verification handle, not a relay route, account, login,
or proof of current online presence. BranchIDs are not sequential, not assigned
by relays, not delegated to GitHub/GitLab accounts, and not issued by a
B.R.A.N.C.H.-operated service.

The public payload is deterministic CBOR with text-string keys:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `contact_id` | Required | 32 random bytes stable for one contact-record lineage. |
| `branch_id` | Required | Self-certifying BranchID derived from `sender.public_key`. |
| `sequence` | Required | Monotonic unsigned integer scoped to the identity and record family. |
| `issued_at` | Required | Unix seconds when this contact payload was issued. |
| `expires_at` | Required | Unix seconds after which this contact record is stale. |
| `display_name` | Optional | Bounded human label, never authoritative. |
| `aliases` | Required | Zero to eight normalized search aliases, candidate evidence only. |
| `protocol_versions` | Required | Supported connectivity protocol versions. |
| `profile_multihashes` | Required | Accepted connectivity profile hashes. |
| `route_hints` | Required | Zero to eight relay/direct route hints for live rendezvous attempts. |

Each route hint is a map with `transport`, `uri`, `relay_public_key`,
`profile_multihash`, and `priority`. A route hint is not authority; relay
identity is still proven during attachment and liveness is actively probed.

IdentityContact payloads must not contain UINs, server-assigned account IDs,
passwords, cookies, bearer tokens, private keys, identity exports, plaintext
messages, mailbox state, or global presence claims.

### SearchCarrier contract

Conceptual TypeScript shape:

```ts
interface SearchCarrier {
  search(query: SearchQuery, options: SearchOptions): Promise<SearchPage>;

  recognize(
    record: CarrierRecord,
    options: RecognitionOptions,
  ): CandidateBeacon[];

  capabilities(): Promise<SearchCarrierCapabilities>;
}
```

`search` performs a bounded public query against one carrier failure domain.
`recognize` extracts candidate `BRANCH0.` wrappers from carrier records without
repairing or reserializing signed bytes. `capabilities` reports maximum query
length, maximum response bytes, maximum result count, authentication
requirements, CORS/browser-native read viability, rate-limit class, freshness
expectations, pagination style, and publication constraints when known.

Adapters return candidates. Protocol core validates deterministic CBOR,
signature, expiry, sequence, revocation, deduplication, and payload schema.

### Query grammar

The baseline query grammar uses public markers only:

- `branchbootstrapv0`;
- `BRANCH0`;
- `branch/connectivity/0`;
- `branch-bootstrap-v0`;
- optional public subject or capability terms chosen by the user or local
  policy.

`branchbootstrapv0` is the canonical punctuation-free cross-index locator for
v0 publication metadata. It is searched first by carrier adapters and may be
combined with legacy marker fallbacks during the v0 transition. The locator is
not a signed payload field, relay identity, trust assertion, secret, or protocol
version.

No query may require a specific project repository, organization, domain, raw
URL, official account, relay, or board. Direct URLs and known repositories are
allowed as hints after discovery begins, but they are never the sole bootstrap
root.

### Initial public-search profiles

The initial independent SearchCarrier profiles are:

| Profile | Baseline use | Notes |
| --- | --- | --- |
| GitHub public repository/search surfaces | Search repository metadata, topics, README text, and committed `.branch` payloads where the chosen surface exposes them. | Unauthenticated public search may be limited by surface and rate limit; credentialed code/API search is optional and uses the operator's own account. |
| GitLab public project metadata surfaces | Search public project metadata using `branchbootstrapv0`, then read committed `.branch` payloads from candidate public projects. | The GitLab `/search` API is not the unauthenticated baseline; global code search and credentials are optional experiments only. |
| npm package registry search | Search package metadata for marker terms and package pages that carry beacon wrappers. | Publication requires a package owner account; bootstrap reading must not require a B.R.A.N.C.H. credential. |
| crates.io package search | Search crate metadata using unauthenticated registry search and package pages carrying beacon wrappers. | Publication requires a crate owner account; the adapter treats package ownership as carrier metadata. |

GitLab's Search API is a credentialed candidate profile, not the baseline blank
client path. The baseline GitLab repository profile uses unauthenticated public
project listing and repository-file reads where the instance allows them.

Multiple frontends, mirrors, or API wrappers over the same underlying platform
count as one failure domain. A discovery result set should include valid beacons
from at least three configured independent profiles before it is considered
healthy. A client may still proceed with fewer when local policy allows degraded
bootstrap.

### Browser-native validation boundary

Browser-native status is determined from a real browser origin, not from
command-line HTTP reachability. A carrier is browser-native only when an
ordinary PWA can perform the required read without a project proxy, without
secret platform credentials in browser storage, and within the carrier's current
CORS, CSP, and rate-limit constraints.

A local 2026-08-31 HTTPS browser probe from a static test origin confirmed CORS
`fetch` access to three independent public SearchCarrier read paths:

| Carrier read path | Browser result | Operational caveat |
| --- | --- | --- |
| GitHub repository search API | HTTP 200 CORS response with `total_count`, `incomplete_results`, and `items`. | Unauthenticated search rate limit was reported as 10 requests per minute for the search resource during the probe; code search returned authentication-required and is not a baseline anonymous path. |
| npm registry search API | HTTP 200 CORS response with `objects`, `total`, and `time`. | Registry responses are cached and rate limited by npm/Cloudflare policy; package ownership remains carrier metadata only. |
| crates.io crate search API | HTTP 200 CORS response with `crates` and `meta` from a browser user agent. | Non-browser probes without an acceptable user agent can receive HTTP 403; browser viability must be retested from the target PWA origin. |

This validation only proves that a browser can read candidate carrier records.
It does not prove that useful BootstrapBeacon records exist, that carrier
results are fresh or complete, or that a carrier will preserve access later.
Each returned record remains hostile until bounded, wrapper-extracted,
canonical-decoded, signature-verified, freshness-checked, and merged by the
protocol-core rules above.

The serving mirror's CSP is part of the browser-native contract. A static shell
with `connect-src 'self'` intentionally blocks direct carrier and relay access.
A functional B.R.A.N.C.H. PWA must explicitly allow its configured
SearchCarrier APIs, RendezvousBoard WebSocket endpoints, relay WSS endpoints,
and any user-approved WebRTC ICE infrastructure. This allowlist is local mirror
or user policy; it is not a global B.R.A.N.C.H. registry and must not require a
project-operated proxy.

### Validation, freshness, and merge

SearchCarrier adapters bound response size before parsing and ignore carrier
records that exceed local limits. Candidate wrappers are decoded as exact
signed event bytes. Unknown protocols, non-canonical encodings, invalid
signatures, expired beacons, future-created beacons outside skew policy, payload
schema failures, and unsupported required capabilities are rejected before the
beacon affects state.

Deduplication first uses the signed envelope key
`(protocol, sender.public_key, event_id)`, then the beacon payload `beacon_id`
for content identity across republications. For the same issuer and subject,
clients prefer the highest valid sequence that is not expired or revoked. A
lower sequence can be retained as historical evidence but not as current
bootstrap state. Carrier ranking and timestamps never override signed sequence
or expiry.

Search poisoning and eclipse resistance require querying several independent
failure domains, bounding per-carrier influence, merging by signature and
subject rather than carrier rank, and surfacing degraded discovery when too few
independent valid results remain. A result from one carrier cannot suppress a
valid result from another carrier unless the signed issuer/subject revocation
rules say so.

### Republication and bundles

Anyone may republish a bit-identical valid BootstrapBeacon or bundle of valid
beacons. Republication does not extend expiry, change sequence, alter payload,
or add authority. Curator bundles may help distribution, but a bundle signature
never replaces the subject or issuer signatures of the contained beacons.

Relay search-proxy caches, when used for browser CORS boundaries, are bounded,
memory-only, short-lived, and untrusted. Proxy output is validated by the
client exactly like direct carrier output.

### Ribbon Bearer gossip

A Ribbon Bearer is any client, node, repository, mirror, or other participant
that voluntarily carries valid signed bootstrap records. It is a distributor,
not an authority. Carrying the Ribbon never requires a project-operated account,
server, registry, board, or relay.

Source records and carrier publications are separate objects:

- the source record is the exact signed event bytes plus the deterministic public
  payload covered by that signature;
- the carrier publication is where those bytes were observed, such as a
  repository file, package metadata field, mirror bundle, board record, or
  peer-gossip response;
- carrier URL, carrier account, publication timestamp, search rank, snippet,
  wrapper formatting, mirror hostname, and retrieval path are untrusted
  observation metadata;
- a bearer republishes only exact signed bytes or an exact bundle of signed
  records. It must not repair, reserialize, refresh, rewrap with changed signed
  bytes, or merge source records into a new authority claim.

For each source record family, freshness is scoped by
`(record_type, subject, issuer)`:

- `sequence` is a monotonic unsigned integer chosen by the issuer for that
  subject and record type;
- `issued_at` is the signed source-record creation time and must not be later
  than the outer event `created_at`;
- `expires_at` is the signed freshness limit and must match the outer event
  expiry when both are present;
- `beacon_id` is the signed content identity for a BootstrapBeacon payload and
  is used to detect exact republication across carriers;
- `previous_beacon_id` links the issuer's previous current record when known;
- `revokes` may address exact beacon IDs, inclusive sequence ranges, or both.

Expiry and republication cadence are client and operator policy defaults, not a
way to reinterpret the signed expiry. Whatever defaults v0 chooses, a client may
use stricter freshness policy and may mark otherwise valid records as degraded
when local clock confidence is low. Republishing a record never changes its
signed `expires_at`; only a new valid issuer sequence can refresh freshness.

Supersession is deterministic after validation. For the same
`(record_type, subject, issuer)`, the highest valid non-revoked sequence that is
not expired is current. A lower sequence is historical evidence only. A higher
sequence from an unauthorized issuer does not supersede a lower sequence from an
authorized issuer. A revocation is valid only when signed by the issuer
authorized for that subject and record family; carrier deletion, package
replacement, repository force-push, or mirror disappearance is not revocation.

Bundles are distribution aids. A bundle contains exact signed records and may
include unsigned observations such as carrier names, first-seen times, or failure
domain hints. A bundle signature can say "this curator saw these bytes", but it
does not replace source signatures, extend expiry, raise sequence, revoke
records, prove liveness, or authorize a mirror. Multi-subject distribution is
done by bundling separate signed subject records, not by making one
BootstrapBeacon authoritative for unrelated subjects.

Mirrors may serve static bundles, repository drop-ins, package metadata, or other
carrier-readable copies. A mirror must not claim that rehosting a record refreshes
it. If all contained source records expire, the mirror can still present them as
historical material, but clients must not treat them as current bootstrap state.

Authenticated peers may exchange bootstrap freshness after session establishment
using bounded HAVE/WANT gossip:

- `HAVE` carries summaries only: protocol, record type, subject, issuer,
  sequence, beacon ID, expiry, and the sender's observed failure-domain count;
- `WANT` asks for exact signed bytes by beacon ID, by subject/issuer current
  sequence, or by a bounded "newer than sequence" request;
- responses carry exact signed source bytes or exact bundles and are validated
  identically to SearchCarrier results;
- gossip messages have explicit byte, record-count, and rate limits and must not
  include payload plaintext, private endpoints, capability tokens, identity
  exports, contact names, or user messages.

Client-to-client gossip helps already connected peers repair discovery state. It
is not a global directory and it does not help a fresh client unless the user
already has a trusted peer, local cache, carried bundle, or search path.

SearchCarrier republication is opt-in. A client or node may republish valid
records to configured carriers only when local policy allows it and any required
carrier credential belongs to the operator or user. It must use bounded rate
limits, avoid recursive churn, and never silently publish through a user's
personal account. Republishing an expired record as current is invalid; only the
subject or authorized issuer can create a new signed sequence with a new expiry.

Healthy public bootstrap targets at least three independent carrier failure
domains. The same underlying platform, even through several mirrors or APIs,
counts as one failure domain. Bearers should prefer carriers that add failure
domain diversity rather than many copies on one platform. When fewer than three
independent current records remain, clients surface degraded bootstrap and may
continue only under explicit local policy.

Relay liveness is probed separately from signed freshness. A valid
BootstrapBeacon can advertise a relay descriptor, but the client must perform a
bounded active liveness probe before using that relay for rendezvous or transport.
Probe results are local, short-lived observations and never extend beacon expiry,
authorize the relay, or create durable presence.

When no fresh publisher remains, expired signed records are retained only as
historical evidence. Existing contacts and already authenticated sessions may
continue using user-owned local state and freshly authenticated routes, but a
fresh bootstrap client must not treat stale public records as current network
entry material. Recovery then requires a new signed sequence from the subject or
authorized issuer, an explicit user-carried bundle that still contains fresh
records, or another user-chosen trust path.

### Carry the Ribbon repository drop-in

Carry the Ribbon is an optional repository integration that lets any public
project wear the Blue Ribbon and carry signed bootstrap records. It is a carrier
profile, not a registry. A repository owner opts in by adding a visible local
badge, searchable marker text, and a machine-readable `.branch` directory. No
project-operated repository, badge server, image host, domain, action, account,
or relay is required.

The README badge is vendorable and self-contained:

```md
[![Blue Ribbon — Carry the Ribbon](.branch/ribbon.svg)](.branch/README.md)
```

The badge image is stored in the repository, not loaded from a central image
service. The badge link targets a local explanation file such as
`.branch/README.md`. That explanation should identify B.R.A.N.C.H. by its full
name, describe the independent Blue Ribbon tribute, and avoid implying
affiliation with or endorsement by the Electronic Frontier Foundation.

Search markers are public text, not authority. A participating GitHub
repository, or GitLab project using the public project metadata profile, should
carry exactly one required repository/project topic:

- `branchbootstrapv0`.

Other indexed fields such as README text, package metadata, or carrier-specific
descriptions may also include the legacy protocol and campaign markers:

- `BRANCH0`;
- `branch/connectivity/0`;
- `branch-bootstrap-v0`;
- `carry-the-ribbon`.

Additional repository/project topics such as `carry-the-ribbon` or
`branch-protocol` are not part of the GitHub or GitLab publication profile.
Multiple topic names on the same repository or project do not create additional
failure domains.

The `.branch` directory is a local carrier payload. The baseline layout is:

```text
.branch/
├── README.md
├── ribbon.svg
├── records.br0
└── manifest.json
```

`records.br0` is UTF-8 text containing one exact `BRANCH0.` wrapper per line.
Blank lines are ignored. Lines beginning with `#` are comments for humans and
must not be interpreted as protocol data. Each non-comment record is decoded as
the exact signed event bytes defined by the text carrier wrapper; clients must
not normalize, pretty-print, repair, or reserialize those bytes before signature
validation.

`manifest.json` is unsigned carrier metadata for tools and SearchCarrier
adapters. It may contain:

```json
{
  "schema": "branch.repository-dropin/0",
  "locator": "branchbootstrapv0",
  "markers": [
    "branchbootstrapv0",
    "BRANCH0",
    "branch/connectivity/0",
    "branch-bootstrap-v0",
    "carry-the-ribbon"
  ],
  "records_path": ".branch/records.br0",
  "badge_path": ".branch/ribbon.svg",
  "root_readme_snippet": "optional generated badge markdown for the repository README",
  "github_repository_description": "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon",
  "github_repository_topics": ["branchbootstrapv0"],
  "gitlab_project_description": "B.R.A.N.C.H. bootstrap carrier branchbootstrapv0 carry-the-ribbon",
  "gitlab_project_topics": ["branchbootstrapv0"],
  "generated_at": 0,
  "source_commit": "optional-vcs-commit",
  "tool": "optional-generator"
}
```

The manifest never authenticates a beacon, extends expiry, revokes records,
authorizes a mirror, proves relay liveness, or changes failure-domain counting.
Its paths are local repository hints only. For the GitHub publication profile,
`branchbootstrapv0` is carried as repository topic metadata and searched with
`topic:branchbootstrapv0`; README marker search is a bounded legacy fallback.
For the GitLab public project profile, `branchbootstrapv0` is carried as one
project topic and project description marker; the adapter searches public
project metadata first and reads `.branch/records.br0` from each public
candidate. It must not require a username, token, OAuth flow, authenticated
cookies, GitLab Pages, CI status, or global code search.
SearchCarrier implementations may use unsigned metadata to find candidate bytes
more efficiently, then must validate the signed records exactly as if they had
been found in README text.

The Admin GitHub Check surface may display candidate repository status together
with local protocol-core validation of extracted `BRANCH0.` wrappers, including
accepted or rejected reason, expiry, relay endpoint hints, and profile hashes.
This diagnostic display is not relay liveness, attachment proof, trust
delegation, or durable discovery state.

A drop-in may carry several signed source records and curator bundles, but it
must preserve each signed record byte-for-byte. Repository ownership, stars,
release tags, branch names, commit signatures, package ownership, and CI status
are publication evidence only. They can help a human decide whether to trust the
repository owner, but they do not replace BootstrapBeacon issuer signatures.

Freshness follows Ribbon Bearer rules. A workflow can replace `records.br0` with
a newer valid issuer sequence, remove expired records from the current set, or
keep expired records only in a clearly historical section. Updating
`manifest.json` metadata, README marker text, wrapper placement, or generated
timestamps must never make an expired source record appear fresh.

The GitHub drop-in is a minimal-permission workflow or reusable workflow. Its
baseline triggers are:

- `push`, so ordinary repository activity can refresh carried records;
- `workflow_dispatch`, so the owner can refresh manually;
- `schedule`, so long-lived repositories can republish before records expire.

Default permissions are read-only:

```yaml
permissions:
  contents: read
```

If the repository owner opts into automated commits, the workflow may request
`contents: write` only for the job that writes `.branch` files. It must not
request package, deployment, identity-token, issue, pull-request, secret, or
administration permissions unless an equivalent host requires a documented
narrow permission for the same local update.

The workflow stages are:

1. checkout the repository;
2. load configured signed source records or locally generated new issuer
   sequences;
3. verify signatures, expiry, sequence, revocation, and unsupported capability
   handling before writing;
4. update only `.branch/records.br0`, `.branch/manifest.json`, local badge
   assets, and local README marker text when policy allows;
5. compare exact file content and skip commits when no byte changes are needed;
6. publish a commit, pull request, or build artifact according to repository
   policy.

Automation must avoid recursive churn:

- generated commits include a recognizable marker such as `[branch-skip]`;
- workflows ignore commits that only repeat the same `.branch` bytes;
- schedules use bounded jitter and one update per configured cadence window;
- failed carrier publication does not retry unboundedly or spam commits;
- a repository must never silently publish through a user's personal account or
  create new public carriers without explicit owner configuration.

Policy-compatible behaviour is required. On a protected branch, the workflow
opens a pull request, uploads an artifact, or reports a check result instead of
bypassing review. On a repository that forbids bot commits, manual dispatch can
produce the exact `.branch` directory as an artifact for the owner to commit.
When signing keys are used in automation, they are delegated publication keys
scoped to the advertised subject and record family, not portable user identity
keys or relay capability tokens.

Equivalent non-GitHub integrations use the same contract: `branchbootstrapv0`,
a visible local badge, searchable marker text, `.branch/records.br0`,
`.branch/manifest.json`, signature verification before publication, minimal
write scope, manual and scheduled refresh, recursion avoidance, and no central
image or mandatory project service.
GitLab CI, Forgejo/Gitea actions, SourceHut builds, Buildkite, cron jobs, or a
plain local script can all satisfy the profile when they preserve these
semantics.

### Ribbon Image carrier

A Ribbon Image is a human-carried visual SearchCarrier payload, recorded in
D-BRANCH-025. It lets an operator publish a current signed BootstrapBeacon
inside ordinary artwork and manually move that image through visual platforms,
screenshots, downloads, chat attachments, printed pages, or offline exchange.
The visual carrier is a distribution path only. Authenticity is the decoded
B.R.A.N.C.H. signed event envelope, never the image file, image hash, platform
account, board, pin, caption, EXIF block, ancillary PNG chunk, or original
uploaded bytes.

The baseline journey is:

1. an operator opens the local node administration UI;
2. the operator selects a cover image and a visual profile;
3. the node constructs a compact current public `bootstrap.beacon`, signs it
   with the relay or advertised subject's delegated publication key, and wraps
   the exact signed bytes in a visual frame;
4. the generator renders the carrier image and immediately runs the local
   decoder against the generated output;
5. the operator manually uploads or shares the resulting image using their own
   platform account, browser session, device, or offline path;
6. another user imports a downloaded, shared, screenshotted, or photographed
   copy into a B.R.A.N.C.H. client;
7. the client extracts the visual frame, decodes exact candidate bytes, validates
   the signed envelope and beacon freshness, probes advertised relay liveness,
   and only then adds route material to local user-owned state.

No visual-carrier profile may require automated publishing, a Pinterest API
credential, a project-operated account, a central image server, a public
B.R.A.N.C.H. board, or a relay database. Platform captions, alt text, links,
boards, pins, comments, reposts, and account names are untrusted observation
metadata.

#### Image publication metadata

The visual publication preset uses the same cross-index locator as repository
profiles, but applies it as carrier metadata rather than as protocol authority.
For Pinterest-like image carriers, the generated title remains human-readable,
such as `Carry the Ribbon`, while `branchbootstrapv0` is placed in the Pin
description or equivalent searchable metadata field. The locator is also the
operator-facing search query.

Pinterest discovery is not currently a baseline automated SearchCarrier.
Pinterest public help says Pin descriptions are used for relevance and that
title, description, board metadata, links, and topic tags can all influence
distribution. Its public API documentation exposes `GET /search/pins` as a
user-account operation whose query accepts description keywords or comma
separated Pin IDs. That is useful evidence for publication presets, but not a
project-neutral global search contract.

Duplicate results for `branchbootstrapv0` are expected. Clients deduplicate
after visual decode and BootstrapBeacon validation by signed identity,
`beacon_id`, `sequence`, and expiry, never by image title, Pinterest account,
board, URL, filename, EXIF, or image hash.

#### Visual frame

The only active Ribbon Image profile in this draft is
`ribbon-block/0.draft`. Earlier QR, tint, watermark, and locator experiments are
retired from the reference generator and decoder. They are historical
measurements, not advertised capabilities.

The decoded visual payload is a framed byte string carried inside the block
packet. The inner visual frame is exact bytes:

```text
magic               = "BRIMG0"                 ; 6 ASCII bytes
profile_id_length   = uint8
profile_id          = "ribbon-block/0.draft"   ; UTF-8 profile string
frame_flags         = uint8                    ; bit 0 means BRANCH0. text payload
payload_len         = uint16 big endian
payload             = exact payload bytes
crc32c_payload      = uint32 big endian CRC32C(payload)
```

Receivers reject unknown profile identifiers, unsupported flag combinations,
payload lengths above the local/profile limit, non-exact frame length, CRC
failure, and a payload-kind mismatch before attempting signed beacon
validation.

`payload` is either an exact `BRANCH0.` text wrapper or exact deterministic CBOR
signed-event bytes with an explicit payload-kind bit. The receiver must preserve
the decoded payload bytes exactly. It may retry bounded image preprocessing, but
it must not normalize, repair, reserialize, or guess protocol bytes after visual
decoding. CRC32C is a corruption filter only. It is not authentication and it
never replaces Ed25519 signature verification.

#### Block profile

`ribbon-block/0.draft` is the browser-local measurement profile for ordinary
service-upload survivability. It renders exact `BRIMG0` visual frame bytes into
bounded distributed differential pixel cells over the full carrier image, using
the top-left image origin and no separate locator/header band. It intentionally
accepts a visible block texture as the Blue Ribbon visual treatment instead of
trying to hide the carrier. The current draft packet is:

```text
magic           = "BRBLK0"        ; 6 ASCII bytes encoded in pixels
block_version   = uint8           ; current draft value 0
frame_len       = uint16 big endian
frame           = exact BRIMG0 visual frame bytes
crc32c_frame    = uint32 big endian CRC32C(frame)
```

Each logical packet bit is written as one or more repeated cells selected by a
deterministic permutation. A cell applies a balanced grayscale luminance bias
using one of a bounded set of deterministic masks; the decoder averages the
masked luminance score and majority-decodes repeated cells. The repeat factor
is selected only from bounded odd values that fit the carrier capacity, and
receivers try the same bounded repeat set before validating magic, length,
CRC32C, and then the enclosed `BRIMG0` frame. This profile is intended to
measure resistance to common service transformations such as JPEG/WebP
recompression, resize, and screenshot-style resampling. It is not a
generic-camera barcode and is not accepted v0 conformance until the published
corpus records its measured limits.

#### Payload capacity and size policy

The visual beacon must be compact enough to fit comfortably inside the bounded
block carrier. The first generator should target a public relay or mirror
BootstrapBeacon payload of at most 512 bytes before visual framing and must
reject payloads above 768 bytes unless a profile-specific corpus proves reliable
decoding. Larger multi-subject bundles belong in repository drop-ins or ordinary
SearchCarrier records, not the visual MVP.

Minimum reliable image size is a measured property, not a protocol constant. The
current acceptance target for `ribbon-block/0.draft` starts from a 1000 x 1500 px
sRGB image with the payload distributed across the full image from the top-left
origin. A generated image must declare its profile, payload length, canvas size,
and local diagnostic status. That metadata is not signed and is not required for
decoding.

The measured minimum accepted by v0 is the smallest source and post-transform
carrier region that passes the repeatable corpus below with the accepted
payload-size class. Until generator/decoder tests produce that measurement, no
implementation may claim Ribbon Image v0 conformance.

#### Transformation corpus

The repeatable local corpus starts from generated PNG sRGB fixtures and records
the exact decoded payload or failure reason for each transform:

- JPEG recompression at quality 95, 85, 75, 65, and 50;
- WebP recompression at quality 95, 85, 75, 65, and 50;
- resizing to common service output dimensions such as 1000, 800, 640, 480, and
  320 px on the carrier-region short side;
- screenshot capture at common desktop and mobile display scales;
- at least one manually executed Pinterest upload/download round trip;
- manually executed VK/Facebook-style upload/download round trips when available;
- negative controls with no visual carrier and with a mutated decoded payload.

As of 2026-08-31, Pinterest's public help says uploaded images may be converted
to standard 8-bit RGB JPEG for Pins and ads, recommends sRGB PNG upload to
reduce quality loss, and recommends 2:3 static images around 1000 x 1500 px with
20 MB desktop upload limit. These are platform observations for the corpus, not
B.R.A.N.C.H. protocol requirements, and they must be rechecked before declaring
platform-specific conformance:

- https://help.pinterest.com/en/business/article/pinterest-product-specs
- https://help.pinterest.com/en/article/review-pin-specs

The Pinterest leg is manual by design. The operator uses their own account and
browser session. The test records only the before/after image dimensions,
content type, transform class, decode result, and signature validation result.
It must not record platform cookies, account identifiers, private board names,
access tokens, or unrelated image metadata.

The current automated `ribbon-block/0.draft` corpus is recorded in
`testdata/visual-carrier/corpus.json` and exercised by
`web/tests/ribbon-image.test.ts`. For the current 80-byte wrapper fixture and a
1000 x 1500 px source image, the local RGBA corpus currently records:

- nearest-neighbour resize to 75% succeeds and 50% is the first recorded
  automated failure;
- screenshot-style scale down/up through 2x succeeds;
- blank images and CRC/payload violations reject without unbounded search.

JPEG/WebP recompression, real-device screenshot/camera capture, and the manual
Pinterest upload/download round trip remain measurement work. They are not
required by the decoder API and must not introduce platform credentials or
automated publishing.

#### Verification and failure semantics

Visual decoding returns one of:

- `no_carrier_detected`;
- `visual_sync_failed`;
- `visual_ecc_failed`;
- `visual_crc_failed`;
- `payload_too_large`;
- `payload_kind_unsupported`;
- `payload_not_branch_wrapper`;
- `signed_event_invalid`;
- `beacon_expired`;
- `beacon_signature_invalid`;
- `beacon_accepted`.

Only `beacon_accepted` can affect discovery state. Any image may be hostile. A
decoder must bound image dimensions, pixel count, memory, transform attempts,
candidate count, and decode time before processing. It must strip or ignore
metadata by default and never log image payload bytes, signed event bytes,
capability tokens, private endpoints, identity exports, or account material.

If several candidate visual payloads decode from one image, each candidate is
validated independently by exact bytes and signature. Conflicting valid beacons
are merged using the normal issuer, subject, sequence, expiry, and revocation
rules. An invalid visual carrier is a failed SearchCarrier observation, not a
protocol error against a peer and not evidence of relay misbehaviour.

### Bootstrap fixtures

Shared Go and TypeScript fixtures must cover:

- valid canonical `bootstrap.beacon` envelope and payload;
- text carrier wrapper and diagnostic JSON rendering;
- the same beacon found through GitHub, npm, and crates.io carrier fixtures;
- duplicate republication across carriers;
- expired beacon, future-created beacon, revoked old sequence, and lower
  sequence merge;
- higher sequence replacing current state for the same issuer and subject;
- mutated payload with reused signature;
- carrier truncation, wrapping, snippets, HTML noise, and non-event records;
- oversized response, oversized record, rate limit, auth-required, and CORS or
  proxy failure;
- poisoned search results with invalid signatures;
- relay announced by a valid beacon but rejected by active liveness probe;
- degraded discovery when fewer than three independent failure domains return
  valid beacons;
- peer HAVE/WANT summaries that request exact signed source bytes by beacon ID or
  sequence;
- curator bundles that cannot extend expiry or override source signatures;
- mirror republication of expired records treated as historical, not current;
- opt-in SearchCarrier republication that preserves exact signed bytes;
- repository drop-in discovery from README marker text, repository topics,
  `.branch/records.br0`, and `.branch/manifest.json`;
- workflow refresh cases that update only `.branch` bytes, skip no-op commits,
  and avoid recursive generated commits;
- visual carrier fixtures for `ribbon-block/0.draft`, including
  exact decoded payload bytes, visual corruption failures, no-carrier negatives,
  transformed images from the corpus above, and signature rejection after a
  payload mutation.

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

### Browser connectivity validation boundary

A 2026-08-31 local HTTPS browser probe confirmed that the browser runtime can
open an outbound WSS connection to a relay-like endpoint and establish a local
WebRTC data channel between two same-page peers. This is a platform viability
check, not proof of Internet NAT traversal, relay admission, capability
authorization, end-to-end handshake security, or route migration.

Functional connectivity validation must be run from the actual PWA origin
because CSP can block WSS, carrier `fetch`, and ICE infrastructure even when the
browser platform supports them. The test matrix distinguishes:

- local WSS reachability to a relay endpoint allowed by CSP;
- public or independently operated relay WSS reachability allowed by operator
  policy;
- WebRTC peer connection without external ICE when local candidates are enough;
- WebRTC peer connection with user-approved STUN or TURN when required by the
  network;
- closed-app or backgrounded-app resume, measured as route reconciliation rather
  than relay state restoration.

Failures in these checks do not authorize durable relay storage, global presence
lookup, or a project-operated connectivity service. They select degraded local
policy, another configured relay, another board, user-mediated import, or a
future adapter task.

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

The exact attachment bytes are fixed by the accepted machine-readable profile
and selected transport binding. The relay attachment contract must not require a
relay account, global username, or project-operated directory lookup.

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

The executable beta federation slice uses a bounded static WSS peer-relay list
configured by the operator. A relay may probe a configured peer relay with the
same draft `LOOKUP`, `RENDEZVOUS`, and `ENVELOPE` frames used by clients, and
may expose the result to its local hub only as short-lived federated presence.
This does not add a new published frame type, does not advertise a new
mandatory capability, does not create a global presence directory, and does not
authorize store-and-forward. A local sender receives `relay.forwarded` only
after the remote relay accepted the live forward; otherwise it receives a
transient error and keeps retry state locally.

### Path migration boundary

A session is bound to authenticated peer identity and session state, not to a
particular relay. Either peer may propose a new path. During migration, old and
new paths may overlap briefly, and delivery identifiers provide deduplication.
Relays participate only as live paths; they do not decide conversation
continuity.

## Carrier hopping

A peer session is bound to authenticated peer identity and session state, not to
a socket or relay. Either peer may propose another path. Both paths may overlap
briefly, and delivery identifiers provide deduplication during migration.

Example:

```text
GitHub board -> relay A -> direct QUIC -> relay B
```

## Mirror migration boundary

PWA mirror origins distribute client code; they are not protocol identities, as
recorded in D-BRANCH-022. Changing mirrors does not change the user's
B.R.A.N.C.H. identity, peer trust relationships, or Connectivity Protocol
version. It does change the browser origin that owns IndexedDB, service
workers, caches, and local key access, so migration is an explicit export/import
or device-transfer protocol outside the wire session.

The portable identity export format is versioned and encrypted before it leaves
the source origin. It may carry identity keys, device keys, contacts, local
trust history, known routes, outbox metadata, and encrypted message history
according to user choice. It must not depend on a relay, board, mirror, or
project-operated backup service. A receiving mirror validates the release it is
running according to local trust policy before importing sensitive material.

QR or local device transfer is a short-lived encrypted transfer between
user-present devices. It requires explicit user confirmation and does not grant
a web origin ambient access to another origin's storage.

No protocol behaviour assumes that JavaScript can verify a malicious copy of
itself. Release signatures, reproducible builds, and service-worker update
control are distribution safeguards; they do not replace user choice, external
verification, or an already trusted installation.

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
