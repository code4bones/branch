# B.R.A.N.C.H. Engineering Contract

Status: normative foundation draft, 2026-08-30.
Tracks: T-BRANCH-013.

This document defines how the reference B.R.A.N.C.H. implementation is
structured, reviewed, tested, and evolved. It complements
docs/ARCHITECTURE.md and the versioned protocol specifications.

## 1. Design approach

Use protocol-core plus ports and adapters. Apply SOLID idiomatically:

- one package owns one domain capability;
- extend behaviour through adapters and capability negotiation;
- verify substitutability with conformance tests rather than inheritance;
- declare small interfaces at the consuming package;
- make the core depend on ports while adapters depend on the core.

Do not reproduce class-heavy Java architecture in Go. Prefer composition,
explicit constructors, concrete return types, and obvious control flow. An
interface is introduced when a consumer needs a behavioural boundary, not merely
because a concrete type exists.

Organize by capability: relay, gossip, discovery, identity, carrier, protocol.
Do not organize the repository around generic controllers, services,
repositories, managers, helpers, or utils.

## 2. Normative sources and versioning

The order of authority is:

1. versioned protocol specification and schemas;
2. shared canonical and invalid test vectors;
3. conformance tests;
4. implementation code;
5. explanatory examples.

The implementation version and wire version are independent. For example, a
branch-node 0.7 release may support branch/connectivity/0 and
branch/gossip/0. An existing numbered protocol version is never reinterpreted.
Incompatible semantics require a new version. Compatible optional behaviour is
advertised through explicit capabilities.

Canonical serialization and the exact bytes covered by signatures must be
specified. Decoding and re-encoding must not silently change the signed object.
Unknown fields, capability negotiation, version mismatch, and protocol errors
must have defined behaviour.

## 3. Repository layout

~~~text
branch/
├── cmd/
│   └── branch-node/          # thin composition and process lifecycle
├── protocol/
│   └── v0/                   # Go wire model, canonical codec, validation
├── internal/
│   ├── node/                 # dependency assembly and lifecycle
│   ├── relay/                # live sessions, routing, backpressure
│   ├── gossip/               # Beacon, HAVE, WANT and freshness
│   ├── discovery/            # discovery orchestration and result merging
│   ├── carrier/              # consumer port and concrete adapters
│   │   ├── github/
│   │   ├── npm/
│   │   └── image/
│   ├── identity/             # node identity, signer and verification
│   └── admin/                # protected operator API
├── web/
│   └── src/
│       ├── core/             # framework-independent client domain
│       ├── protocol/         # TypeScript codec and validation
│       ├── connectivity/     # path negotiation and relay hopping
│       ├── discovery/        # SearchCarrier orchestration
│       ├── identity/         # local identity operations
│       ├── storage/          # IndexedDB boundary
│       ├── visual/           # Ribbon Image codec and workers
│       ├── client/           # messenger React application
│       └── admin/            # operator React application
├── spec/
│   ├── protocol-v0.cddl
│   └── connectivity-v0.md
└── testdata/
    └── vectors/              # shared Go and TypeScript fixtures
~~~

Avoid a generic pkg directory. protocol/v0 may be importable for independent Go
implementations, but the specification and vectors remain authoritative. All
reference-node implementation packages are internal.

The Go node may embed built PWA assets for a self-contained deployment. The
public client surface and operator administration surface must remain separate
security boundaries even if delivered by one binary. Administration binds to
loopback or a separately protected listener by default.

## 4. Pure core and explicit boundaries

Protocol parsing, validation, signature input construction, capability
selection, and state transitions must be deterministic and free of hidden I/O.
They must not read the network, filesystem, wall clock, random source, or global
configuration.

Time and randomness are passed only where required. Inject Clock or random
sources when deterministic testing needs them; do not abstract every standard
library call.

Adapters own:

- HTTP and WebSocket;
- SearchCarrier APIs and CORS proxying;
- filesystem access for node identity and configuration;
- browser IndexedDB;
- timers, retries, and network discovery;
- image import/export;
- metrics and logging.

Configuration is parsed and validated at startup, then treated as immutable.
There is no service locator or mutable global dependency container.

## 5. Go rules

- gofmt and goimports are mandatory.
- Context is the first parameter of request-scoped I/O functions and is not
  stored in structs.
- Constructors make required dependencies explicit and reject invalid
  configuration.
- Declare interfaces in the package that consumes them.
- Prefer one-to-three method interfaces.
- Return concrete types unless callers need an abstraction.
- Wrap errors with context using %w.
- Use typed or sentinel errors only when callers can take a meaningful action.
- Log errors at process or adapter boundaries, not repeatedly at every layer.
- Error text is lowercase and does not contain punctuation intended for UI.
- Exported API has Go doc comments; comments explain contracts, invariants, and
  non-obvious reasons rather than translating syntax.
- Network input never causes panic.
- Do not use naked returns in non-trivial functions.
- Dependencies are intentionally few; prefer the standard library.

Use log/slog for structured logs. Events have stable names and useful fields,
but never include plaintext messages, keys, tokens, identity exports, image
payloads, or authentication material. IP addresses and stable identifiers are
recorded only when operationally necessary and with explicit retention policy.

## 6. Concurrency and resource ownership

Prefer actor-like ownership over shared mutable maps:

- one goroutine owns a connection or session state machine;
- other components communicate through bounded messages;
- every goroutine has an owner, cancellation path, and documented lifetime;
- every channel and queue has a capacity and overflow policy;
- every network operation has a deadline or inherited cancellation;
- slow consumers are disconnected or degraded according to protocol policy;
- retries use bounded exponential backoff with jitter;
- process shutdown stops admission, drains bounded work, then cancels remaining
  sessions.

Avoid mutex forests. A mutex may protect a small local invariant, but ownership
and message passing are preferred for session state. The race detector is a
required gate, not an occasional diagnostic.

## 7. Hostile-input and relay invariants

Before allocating based on remote input, enforce hard limits for frame size,
nesting, collection counts, string lengths, decompressed size, image dimensions,
and processing time.

The relay baseline has:

- no message or file database;
- no durable delivery queue;
- no user account database;
- no canonical presence or conversation index;
- no external Redis or PostgreSQL dependency;
- bounded in-memory sessions, peer view, rate limits, and short search cache;
- explicit restart semantics that forget user traffic and session state.

Protocol error codes are typed and stable. Malformed, oversized, non-canonical,
or unauthenticated frames are rejected before entering routing state. Fuzz tests
must cover every network, CBOR, text-carrier, and image-carrier decoder.

## 8. TypeScript and PWA rules

- TypeScript strict mode is mandatory.
- Enable noUncheckedIndexedAccess and exactOptionalPropertyTypes unless a
  documented compiler limitation prevents it.
- any is forbidden in protocol, connectivity, identity, and storage core.
- External data begins as unknown and passes runtime validation.
- Frames, state machines, and results use discriminated unions rather than
  boolean combinations.
- React components depend on the client core; protocol and connectivity code do
  not import React.
- Zustand holds presentation and ephemeral UI state, not keys, messages, tokens,
  or canonical protocol state.
- User-owned persistent state lives behind an IndexedDB storage port.
- Cryptography and expensive Ribbon Image processing run in Web Workers where
  practical.
- The service worker caches and launches the application; it does not own keys,
  protocol state, or plaintext conversation history.
- Do not load executable code from third-party CDNs. Use a restrictive Content
  Security Policy and bundled assets.
- Format and lint mechanically; avoid disabling rules without a local reason.

Sensitive values must not appear in browser logs, crash reports, devtools state,
URLs, query strings, or analytics.

## 9. Tests

### Unit tests

Pure protocol and state-machine code uses table-driven tests. Test names describe
behaviour and failures show the relevant input and expected invariant.

### Shared protocol vectors

testdata/vectors contains:

- canonical valid frames;
- signature input bytes and expected signatures;
- boundary values;
- invalid and non-canonical encodings;
- unknown capability and version cases;
- replay, duplication, reordering, and expiry cases.

The same fixtures must pass in Go and TypeScript. A vector change that alters
published v0 semantics is forbidden; add a new protocol version instead.

### Fuzz and property tests

Fuzz all decoders and parsers. Important properties include:

- decoding never panics;
- rejected input cannot allocate unbounded memory;
- canonical encode-decode-encode is stable;
- mutations invalidate signatures when required;
- arbitrary event order cannot violate session invariants.

Keep seed corpora in the repository. Run bounded fuzzing in pull requests and
longer campaigns on a schedule.

### Integration tests

Use real in-process or local nodes, not mocks, for the defining paths:

- two clients discover and establish a session;
- the discovery carrier disappears;
- a relay disappears and connectivity hops;
- two relay islands exchange signed beacons;
- slow consumer and queue overflow behaviour;
- relay restart restores no user state;
- mixed compatible application versions negotiate one immutable wire version.

SearchCarrier adapter tests use recorded fixtures and local HTTP servers. Live
GitHub, npm, Pinterest, or other public-service tests are opt-in smoke tests and
must not make ordinary CI flaky or consume user credentials.

### Browser end-to-end tests

Use Playwright for PWA startup, local identity creation, encrypted export/import,
mirror migration, relay hopping, offline shell behaviour, and admin/client
security separation.

## 10. Quality gates

Every pull request must pass the applicable checks:

~~~text
go test ./...
go test -race ./...
go vet ./...
staticcheck ./...
govulncheck ./...

tsc --noEmit
eslint
unit tests
shared protocol vector tests
integration tests
Playwright critical-path tests
~~~

Prefer explicit tools over a large opaque lint aggregator. Formatting is checked
in CI. Generated files are reproducible and CI fails on an uncommitted generated
diff.

Long fuzz campaigns, cross-platform builds, dependency review, and extended E2E
may run on a schedule, but a bounded security-relevant subset remains in pull
requests.

## 11. Review checklist

A change is not ready when any answer below is unknown:

- Does it change wire semantics or signed bytes?
- Is the change backward compatible with every published supported version?
- Are all remote sizes, queues, retries, and lifetimes bounded?
- Can a relay restart without restoring user data?
- Can an independent implementation reproduce behaviour from spec and vectors?
- Is new abstraction required by a consumer, or merely speculative?
- Is sensitive material excluded from logs and UI state?
- Do Go and TypeScript agree on the same vectors?
- Does the change introduce a mandatory platform, mirror, carrier, relay, or
  project-operated service?
- Is there a focused test that fails without the change?

## 12. Release discipline

Pin and review dependencies. Keep the Go toolchain and dependencies on supported
security-patched releases. Produce checksums and signed release metadata.
Generate an SBOM for release artifacts. At minimum build Linux amd64 and arm64
node binaries plus static PWA assets.

Maintain SECURITY.md, the threat model, supported protocol/capability matrix, and
operator upgrade notes. Security fixes may remove unsafe capabilities, but must
not silently reinterpret an immutable protocol version.

Readable, boring code is a feature. Prefer explicit duplication at two small
call sites over a premature abstraction; extract shared behaviour when a stable
domain concept has emerged.
