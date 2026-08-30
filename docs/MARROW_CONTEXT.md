# B.R.A.N.C.H. Marrow Context

This file is a local working index of current Marrow records that affect
implementation order. Marrow remains the source of truth.

## Blocking priority

### T-BRANCH-013 — Зафиксировать инженерную архитектуру, codestyle и quality gates

- Status: todo.
- Milestone: Foundation.
- Priority: 1.
- Scope: foundation/source-architecture.
- Allowed files: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/ENGINEERING.md`,
  `protocol/`, `testdata/vectors/`, `.github/workflows/`, `go.mod`, `web/`.
- Acceptance: before implementation, accept protocol-core/ports/adapters
  dependency direction, Go and PWA source layout, independent wire-protocol
  versioning, small consumer-side interfaces, explicit dependencies,
  non-persistent relay boundary, concurrency/backpressure/error/logging/security
  invariants, Go and TypeScript codestyle, shared Go/TypeScript protocol
  vectors, unit/race/fuzz/integration/PWA E2E checks, and CI gates.
- Note: do not start production relay or PWA implementation until this task is
  complete. Work inside this task may create only the foundation and conformance
  scaffold.

### T-BRANCH-014 — Реализовать безопасный observability plane для dev и операторов

- Status: todo.
- Milestone: Foundation.
- Priority: 2.
- Scope: foundation/observability.
- Depends on: `T-BRANCH-013`.
- Allowed files: `AGENTS.md`, `docs/ARCHITECTURE.md`,
  `docs/ENGINEERING.md`, `docs/OBSERVABILITY.md`,
  `internal/observability/`, `internal/admin/`, `web/src/diagnostics/`,
  `deployments/observability/`, `compose.yaml`, `compose.observability.yaml`.
- Acceptance: stable event taxonomy and schema; structured slog events,
  health/readiness and bounded-cardinality metrics on a protected admin
  listener; optional OpenTelemetry/OTLP exporter; dev profile with Collector,
  Prometheus, Loki, Tempo and Grafana; bounded PWA diagnostic journal with
  manual redacted export; separated development, operator-production and
  time-boxed diagnostic modes; no payloads, keys, capability tokens, portable
  identity or permanent user identifiers in telemetry; monitoring disabled must
  not affect connectivity.

### T-BRANCH-005 — Build the two-client carrier-hopping proof of concept

- Status: todo.
- Milestone: Proof of concept.
- Priority: 60.
- Current constraint: PoC relay/PWA work waits behind T-BRANCH-013, and the PoC
  is not diagnosable until T-BRANCH-014 is complete.

## Accepted architecture decisions

### D-BRANCH-016 — Reference implementation uses protocol-core and ports/adapters

The reference implementation is protocol-core plus ports/adapters. Versioned
protocol specs, schemas, and shared Go/TypeScript vectors are normative. Go and
TypeScript are independent implementations. Packages are capability-oriented;
interfaces are small and declared by consumers; dependencies are explicit; UI is
outside protocol core. Relay is a non-persistent live conduit without a
database. Foundation task T-BRANCH-013 and `docs/ENGINEERING.md` are required
before production implementation.

### D-BRANCH-017 — Observability is centralized in dev, operator-owned in production

Controlled development environments may centralize logs, metrics and traces
through an optional OpenTelemetry stack. In production, each operator owns their
telemetry and may disable it. Monitoring is not part of the Connectivity
Protocol, discovery root or data plane. Node telemetry uses structured events,
bounded-cardinality metrics and local traces; PWA telemetry is a bounded local
diagnostic journal with manual redacted export. Payloads, keys, capabilities,
portable identity and permanent user identifiers are never collected.

### D-BRANCH-015 — Relays are non-durable transit

The relay baseline is live transit only: SearchCarrier proxying, rendezvous or
signaling, and forwarding end-to-end encrypted bytes while endpoints are
connected. It must not durably store messages, files, conversation history,
contacts, or offline mailboxes.

### D-BRANCH-014 — Connectivity protocol is the stable constitution

A numbered wire version is immutable after publication. Evolution happens
through explicit extensions, capability negotiation, and new version identifiers.

### D-BRANCH-013 — Mirrors are independently owned

Any enthusiast may deploy and own a PWA mirror without registration or central
administration. Mirror ownership is operational, not protocol authority.

### D-BRANCH-005 — Public search is the bootstrap root

Fresh clients discover signed expiring BootstrapBeacon records through multiple
public SearchCarriers, not through a mandatory repository, raw URL, project
domain, directory server, or relay address.

## Current implementation notes

- I-BRANCH-025: engineering contract is already recorded in Marrow; next step is
  repository/conformance scaffold and CI gates for T-BRANCH-013.
- I-BRANCH-026: observability contract is recorded in Marrow; implementation
  starts with typed event schema/reason codes and no-op sink, then metrics and
  optional exporters.
- I-BRANCH-027: after T-BRANCH-013 and before the two-client PoC is considered
  ready, complete T-BRANCH-014 so carrier search, beacon validation, handshake,
  route selection, relay hopping, queue overflow and restart are diagnosable.
- I-BRANCH-024: production relay/PWA implementation is blocked until
  T-BRANCH-013 is complete.
- I-BRANCH-022: reference Go node uses process memory for live routing, bounded
  buffers, peer-beacon view, token-bucket limits, and short SearchCarrier cache;
  it requires no PostgreSQL, Redis, or external cache.
- I-BRANCH-013: relay mesh anti-entropy must not rely on manually maintained
  global relay lists.
- I-BRANCH-012: reference deployment is a self-contained node serving same-origin
  PWA and companion relay/search bridge.
- I-BRANCH-010: PoC must close the first-relay bootstrap loop via an explicit
  mirror-local first-hop rule.
