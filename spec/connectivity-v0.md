# B.R.A.N.C.H. Connectivity v0

Status: scaffold draft. This file is not a published immutable wire version.

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
- relay-side store-and-forward, mailbox, or offline delivery queues;
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

## Draft Profile Artifact

The current development profile artifact is:

```text
spec/connectivity-profile-v0.draft.json
```

It is exact-byte UTF-8 JSON for scaffold testing. Published v0 still requires a
deterministic CBOR profile artifact and accepted vector manifest. The current
development multihash is:

```text
uEiAsgRWhrZFSEDiQjTDP1jrQ4elBW8uK0Q_Cg1_rKK06qw
```

The current shared vector manifest is
`testdata/vectors/protocol-v0/manifest.json`. Its transcript bundle is
development conformance input for Go and TypeScript tests; it does not complete
the independent two-client and two-relay proof required for published v0.

## Open Decisions Before Publication

- identity and session cryptographic constructions;
- direct transport mandatory-to-implement policy;
- relay frame byte encoding and key schedule;
- path migration retry limits, timers, and fallback policy defaults;
- capability token format and revocation semantics;
- final protocol error registry included in the published profile.
