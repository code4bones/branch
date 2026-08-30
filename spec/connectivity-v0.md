# B.R.A.N.C.H. Connectivity v0

Status: scaffold draft for T-BRANCH-013. This file is not a published immutable
wire version.

The Connectivity Protocol is the interoperability kernel described by
D-BRANCH-014. It must remain smaller than the product and independent of the
reference implementation, PWA UI, storage, specific SearchCarrier adapters, and
observability backends.

## Scope

Connectivity v0 is expected to define:

- protocol and algorithm identifiers;
- version negotiation;
- offer and answer envelopes;
- capability negotiation;
- direct and relayed route candidates;
- relay attachment and admission;
- secure session framing;
- delivery identifiers and deduplication during path overlap;
- path migration;
- typed protocol errors.

## Non-Goals

- UI semantics;
- persistent message history;
- relay store-and-forward;
- global presence directories;
- monitoring, tracing, dashboard, or exporter protocols;
- carrier-specific APIs;
- group, call, channel, or token-incentive features.

## Required Invariants

- A numbered wire version is immutable once published.
- Unknown versions and capabilities have explicit negotiation behaviour.
- Relays are live conduits only and do not restore user messages, files, queues,
  or conversation state after restart.
- Direct connectivity is preferred when policy and network reality allow it.
- Public carriers and relays are untrusted with integrity and plaintext.
- Observability is not a required wire field and disabling telemetry does not
  change connectivity behaviour.

## Open Decisions Before Publication

- canonical encoding and signature input bytes;
- identity and session cryptographic constructions;
- direct transport baseline;
- relay frame format and maximum sizes;
- path migration state machine;
- capability token format and revocation semantics;
- exact protocol error code registry.

