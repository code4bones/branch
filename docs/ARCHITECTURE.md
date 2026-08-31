# B.R.A.N.C.H. Architecture

Status: initial design draft, updated 2026-08-31.

## Objective

Allow two people to discover each other and establish communication without a
mandatory B.R.A.N.C.H.-owned service. Use public Internet surfaces for
rendezvous, direct connections when possible, and interchangeable
community-operated relays when direct connectivity is unavailable.

## System layers

### 1. Portable identity

The canonical user identity is rooted in a cryptographic key, not an email
address, platform handle, relay hostname, or B.R.A.N.C.H. account.

Human-readable aliases are optional discovery aids. Losing a carrier, mirror, or
relay must not change identity. User-owned identity, contacts, messages, outbox,
and trust history are persisted locally by the client, with portable encrypted
export and import.

### 2. Public rendezvous fabric

A SearchCarrier is an adapter capable of finding signed BootstrapBeacon records
on a publicly searchable surface. Search bootstrap is slow, redundant, and
eventual; it is not live rendezvous, presence, delivery, or authority. A
RendezvousBoard is an optional adapter capable of publishing and observing
signed rendezvous events.

Candidate surfaces include:

- GitHub repositories, Issues, Discussions, and other indexed Git surfaces;
- npm and other package registries;
- forums and public feeds;
- a minimal open HTTP bulletin board;
- Nostr or a DHT;
- human-carried Ribbon Images;
- email as a non-privileged fallback adapter.

Carriers are untrusted. They may delay, reorder, duplicate, rewrite, hide,
transform, or delete records. Authenticity comes from signatures;
confidentiality comes from recipient encryption.

Initial SearchCarrier profiles are GitHub public repository/search surfaces, npm
package registry search, and crates.io package search. Equivalent future
profiles may be added, but multiple frontends over the same underlying platform
count as one failure domain. Credentialed or CORS-blocked search, such as some
GitLab API modes, can be optional adapter plumbing but not the only bootstrap
path.

Any public repository may also Carry the Ribbon by adding a vendored Blue Ribbon
badge, public search markers, and a local `.branch` directory containing exact
signed bootstrap records. This is a voluntary SearchCarrier publication profile:
the repository helps discovery, but repository ownership, CI status, badges,
topics, and mirrors never replace issuer signatures or relay liveness probes.

First contact uses this fabric only as a rendezvous control plane. A sender
discovers a recipient's signed bootstrap material, selects one or more public
boards allowed by both sides, publishes a sealed signed offer, and accepts a
sealed signed answer from the recipient through the same or another board. Once
an authenticated direct or relayed session is established, the original board is
no longer required for ordinary message transport.

### 3. Connectivity

After discovery or rendezvous, clients attempt connectivity according to policy
and capability:

1. an existing authenticated direct route;
2. direct IPv6;
3. ICE-assisted UDP or TCP;
4. a relay shared by both peers;
5. relay-to-relay routing through the community mesh.

The active path may change without changing peer identity or conversation
state. Connectivity Protocol versions are independent of node and PWA release
versions. A published numbered wire version is immutable.

### 4. Community relay mesh

Any person or organization can operate an independent node. The reference node
serves a PWA mirror and can provide:

- SearchCarrier proxying required by browser CORS boundaries;
- rendezvous and connectivity assistance;
- live encrypted byte forwarding;
- relay-to-relay gossip and forwarding;
- bounded in-memory peer views, rate limits, and short-lived search caches;
- a local or separately protected operator administration surface.

The relay is a live conduit, not a database. It must not persist user accounts,
messages, files, delivery queues, conversation indexes, or user-owned state.
After restart, only node identity, operator configuration, and TLS material may
remain. Redis, PostgreSQL, and other external data services are not part of the
reference baseline.

A relay is never an identity authority. Clients may use several relays and move
between them. Relay access is capability-controlled rather than dependent on a
global account system.

The minimal relay contract is intentionally narrow: attach authenticated peers,
admit traffic only through bounded capabilities, forward opaque encrypted frames
while both sides have live routes, apply explicit quotas and backpressure, and
forget traffic/session state on disconnect, expiry, or restart. Relay-to-relay
behaviour is limited to live forwarding and signed control-plane gossip; it is
not a durable mailbox, global presence directory, or custody layer.

### 5. Local conversation state

Conversation history belongs to user devices. The PWA stores identity,
contacts, messages, outbox, trust history, and known routes locally, preferably
in IndexedDB behind an explicit storage boundary. Mirrors and relays do not own
canonical conversation state.

## Control plane and data plane

Public search carriers, rendezvous events, signed BootstrapBeacons, and
Ribbon Bearer HAVE/WANT gossip form the control plane. Gossip carries exact
signed source records or bounded summaries after authentication; it is not a
directory, mailbox, relay, or new authority.

Authenticated P2P routes and live relay paths form the data plane. Once a
session is established, its original discovery carrier is not required for
ordinary exchange. Clients can carry signed relay beacons between otherwise
disconnected relay islands.

## No global presence directory

The design deliberately avoids a global query such as which relay currently
hosts this identity. Route information is signed and exchanged by its subject.
A mandatory directory would create an observation, enumeration, abuse, and
control point.

## Mobile and browser reality

Mobile-to-mobile communication commonly requires a relay because of CGNAT,
sleeping applications, network changes, browser restrictions, and operating
system background limits. B.R.A.N.C.H. treats relays as normal infrastructure;
mandatory ownership of the relay is the failure.

The PWA and relay may be served by the same independently operated node origin.
A mirror is an independent distributor, not a member of a centrally
administered application. Wake-up signaling remains separate from message
transport and must not become a mandatory GCM/APNs dependency.

Browser-native discovery has two gates: the carrier API must allow browser
reads, and the serving mirror's Content Security Policy must allow the selected
carrier and relay endpoints. A restrictive default such as `connect-src 'self'`
is appropriate for a static shell before adapters exist, but a functional PWA
must generate a bounded `connect-src` policy from configured SearchCarrier,
RendezvousBoard, WSS relay, and WebRTC/STUN/TURN policy. Expanding CSP is an
explicit operator/client configuration step; it must not introduce a mandatory
project-operated proxy or global allowlist.

Closed-app and resume behavior is measured separately from discovery. Browsers
may suspend timers, WebSocket connections, service workers, and WebRTC ICE
state while an app is backgrounded. The client therefore treats resume as a
fresh local reconciliation: inspect user-owned pending attempts, revalidate
unexpired carrier observations, probe relay liveness, and re-establish or migrate
routes without asking a relay to restore messages or session state.

## PWA mirror trust and migration

PWA mirrors improve availability but do not remove first-install trust, as
recorded in D-BRANCH-022. Browser storage, service workers, and installed PWA
state are origin-scoped, so a mirror change is a migration between application
instances, not transparent roaming inside one shared app. Protocol identity
therefore never includes the mirror origin.

A pure PWA cannot securely prove that malicious JavaScript served by its own
origin is honest. Release signatures, reproducible builds, Subresource
Integrity for static subresources, restrictive Content Security Policy, pinned
build manifests, and transparency logs can help users and external tools verify
what was intended to ship, but a compromised first-loaded application can lie
about its own checks. Strong verification requires either a trusted existing
installation, browser or operating-system assistance, an external verifier, or
manual comparison of signed release material.

First install records the chosen mirror, release version, build manifest hash,
release signature set, and supported protocol versions in local user-owned
state. The client treats updates as explicit state transitions: download the
candidate manifest, verify release signatures and reproducible-build metadata
where available, stage service-worker and asset changes, preserve the previous
working cache until the new version activates, and provide rollback or reinstall
guidance when verification fails. Service workers cache and launch the app; they
do not own keys, plaintext history, capabilities, or protocol state.

Offline execution uses a bounded cache of the verified application shell and
static assets for the current origin. Cached code keeps the client available
when its mirror disappears, but it cannot receive security fixes or new
capabilities until an update source is reachable and verified.

Identity migration between mirrors is explicit. The old origin cannot silently
grant the new origin access to IndexedDB, service-worker state, or keys. A user
exports a portable encrypted identity bundle, imports it at the new mirror, and
confirms the target release or mirror trust state before activation. QR device
transfer is a short-lived encrypted handoff between two user-present devices and
requires an authenticated confirmation code or equivalent ceremony.

The portable bundle may contain identity keys, device keys, contacts, trust
history, known routes, outbox metadata, and encrypted conversation history
according to user choice. It is encrypted before leaving the origin, bound to a
versioned export format, protected by a user secret or receiving-device key
agreement, and never uploaded automatically. Relays, mirrors, and public
carriers do not become backup authorities.

History recovery is user-owned. If no encrypted export, synced personal device,
or user-chosen storage carrier exists, a new mirror can recover network identity
only by importing keys or establishing a new identity. It cannot reconstruct
conversation history from relays because the reference relay baseline is
non-durable live transit.

## Source architecture and dependency direction

The reference implementation follows protocol-core plus ports and adapters.

- Versioned protocol schemas and shared test vectors are normative.
- Go and TypeScript protocol implementations depend on those specifications.
- Pure protocol code owns wire types, canonical encoding rules, validation,
  signature bytes, error codes, and deterministic state transitions.
- Relay, gossip, discovery, browser connectivity, storage, HTTP, WebSocket, and
  SearchCarrier integrations are adapters around that core.
- UI depends on the client core; the client core never depends on React.
- Command packages are thin composition roots.
- Cross-cutting catch-all packages such as utils, common, managers, and services
  are prohibited.

The complete repository layout, coding rules, concurrency model, testing
strategy, and CI gates are normative in docs/ENGINEERING.md.

## Observability plane

Observability is a separate operator plane, not part of the control or data
plane. During development it is rendered by the project-owned observation-front
from protected relay/admin endpoints. Production operators independently choose
whether to keep local telemetry for their own nodes.

The reference implementation exposes structured events, bounded-cardinality
metrics, health/readiness state, and optional traces through a protected
administrative boundary. The PWA maintains a bounded local diagnostic journal
and can produce a manually exported redacted diagnostic bundle.

No external collector, dashboard product, monitoring account, or
project-operated backend is required for protocol operation. Removing the
observation-front or disabling exporters must not change discovery, handshake,
routing, carrier hopping, or message transport.

Cross-relay trace correlation is permitted inside an explicitly controlled
development environment. It is not propagated as a mandatory wire field in
production. Telemetry never contains plaintext payloads, cryptographic keys,
capability tokens, portable identity material, or permanent user identifiers.

The normative modes, schemas, event taxonomy, metrics, redaction rules, and
observation-front boundary are defined in docs/OBSERVABILITY.md.

## Trust boundaries

- Identity keys authenticate people, devices, nodes, and signed announcements.
- Public carriers are not trusted for integrity or availability.
- Relays are not trusted with plaintext.
- Transport security does not replace end-to-end session security.
- All network and persisted inputs are bounded and validated before use.
- First-contact verification and identity recovery remain explicit user-facing
  problems.
- Logs and metrics exclude message bodies, secrets, capability tokens, and
  portable identity material.

## Defining proof

The architecture is proven at v0 when:

1. two clients with no B.R.A.N.C.H. account discover each other through a public
   carrier;
2. they establish a direct or community-relayed encrypted session;
3. the public carrier is disabled and communication continues;
4. the active relay is disabled and the session migrates to another path;
5. no B.R.A.N.C.H.-owned server is required;
6. the Go and TypeScript implementations pass the same protocol vectors;
7. restarting relays restores no user messages, files, or conversation state;
8. route selection, carrier failure, relay hopping, queue overflow, and restart
   can be diagnosed without recording message contents or permanent user
   identifiers.
