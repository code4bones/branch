# AGENTS.md — B.R.A.N.C.H.

## Project identity

The official first mention is:

**B.R.A.N.C.H. — Blue Ribbon Autonomous Network for Carrier Hopping**

The project is an independent technical tribute to the Blue Ribbon Online Free
Speech Campaign. Never omit this heritage from foundational project material,
and never imply affiliation with or endorsement by the Electronic Frontier
Foundation.

Canonical lines:

- The Blue Ribbon is alive again.
- From symbol to protocol.
- The ribbon no longer merely hangs on the Web. It becomes a route through it.

## Mandatory start-of-work gate

Before claiming or implementing a task:

1. Load the current Marrow project context for branch.
2. Read this file, docs/ARCHITECTURE.md, docs/ENGINEERING.md, and the relevant
   protocol specification.
3. Read the task, linked decisions, implementation notes, and failed attempts.
4. Confirm that proposed work preserves the immutable Connectivity Protocol and
   the non-durable relay boundary.

T-BRANCH-013 is the blocking engineering-foundation task. Production relay or
PWA implementation must not begin until its architecture, repository scaffold,
shared protocol vectors, and quality gates are accepted. Work performed inside
T-BRANCH-013 may create only the foundation and conformance scaffold described
by that task.

Do not silently invent protocol semantics while writing code. If the
specification is incomplete, update the specification or record an open
question before implementation.

## Working model

- docs/ARCHITECTURE.md is the stable system architecture.
- docs/ENGINEERING.md is the normative source architecture, code-style, testing,
  and quality-gate contract.
- docs/PROTOCOL_V0.md and protocol schemas define wire behaviour.
- Versioned protocol schemas and shared test vectors are normative; Go and
  TypeScript code are implementations of them.
- New product or protocol choices are recorded as Marrow Decisions with context,
  rationale, alternatives, and consequences.
- Concrete implementation work is represented as Marrow Tasks linked to the
  relevant decisions and artifacts.
- Open questions remain open until evidence or an explicit decision resolves
  them. Do not silently turn speculation into architecture.

## Non-negotiable principles

- Identity belongs to the person, not to a server or platform account.
- No project-operated server, relay, board, or directory may be mandatory.
- Public writable surfaces are interchangeable rendezvous carriers, not trust
  authorities.
- Direct peer-to-peer communication is preferred when available.
- Any enthusiast must be able to operate a compatible relay and PWA mirror.
- Relays are replaceable, capability-controlled, and never plaintext owners.
- A reference relay is live transit only: no message database, file storage,
  durable delivery queue, user account database, or canonical conversation
  state.
- Existing reviewed cryptographic constructions must be used. Do not invent
  custom cryptography.
- The network must remain usable by independent implementations if the original
  project disappears.
- A published numbered wire version is immutable. Application releases negotiate
  supported protocol versions and capabilities; they do not reinterpret an old
  version.

## Engineering shape

Use protocol-core plus ports and adapters, expressed idiomatically in Go:

- organize packages by domain capability, not controllers/services/repositories;
- keep protocol parsing, validation, signatures, and state transitions
  deterministic and independent of network, filesystem, clock, and UI;
- declare small interfaces at the consuming package;
- prefer composition and explicit constructors;
- return concrete implementations unless callers need polymorphism;
- do not create an interface for every type;
- avoid global service locators and catch-all utils, common, manager, or service
  packages;
- keep cmd packages as thin composition roots;
- keep React outside the TypeScript protocol and connectivity core.

Every network or storage input is hostile until bounded, decoded, and validated.
Every queue, frame, cache, goroutine, retry, and timeout must have an explicit
limit or lifecycle.

## Scope discipline

The first proof is two-party communication. Do not prioritize groups, calls,
public channels, token incentives, perfect anonymity, or polished UI until the
carrier-hopping path works end to end.

The defining v0 test is:

1. Two clients discover each other through a public carrier.
2. They establish an authenticated direct or community-relayed session.
3. The carrier is disabled and communication continues.
4. The active relay is disabled and the session migrates to another path.
5. No B.R.A.N.C.H.-owned service is required.
6. Restarting a relay restores no user messages, files, or conversation state.

## Safety and interoperability

- Treat carriers as untrusted and unreliable.
- Treat relays as untrusted with message content.
- Expect duplication, delay, reordering, deletion, corruption, and replay.
- Keep wake-up signaling separate from encrypted message transport.
- Specify wire behaviour before coupling it to a framework.
- Prefer shared test vectors and interoperability fixtures over
  implementation-specific assumptions.
- Never log plaintext payloads, keys, capabilities, identity exports, or
  authentication material.
- A malformed remote packet must return a bounded protocol error or close the
  session; it must never panic the process.
