# B.R.A.N.C.H. Open Questions

This file is intentionally a living notebook. Decisions should be recorded with
their reasoning rather than silently replacing earlier assumptions.

## Identity

- Which reviewed identity and session-key constructions should be adopted?
- How are additional devices authorised and removed?
- How can a person recover from key loss without creating a central authority?
- Should human-readable names exist in the protocol or only in optional layers?
- What user-verifiable first-contact ceremony confirms that a cryptographic
  identity belongs to the intended person?

## Public boards

- How does a recipient find its events without scanning an entire public feed?
- How are rendezvous topics rotated after first contact?
- How do adapters handle surfaces that rewrite, truncate, moderate, or reorder
  content?
- Should one event be redundantly published to several boards by default?
- Is `recipient_tag` stable enough for board filtering, or must the signed
  event envelope define stricter privacy and rotation rules first?
- What is the maximum rendezvous event size for v0 across browser-native
  boards?
- Are delete and replace operations part of a board adapter contract, or do
  expiry and revocation remain entirely in signed protocol events?
- How many independent boards must a client try before rendezvous is considered
  degraded?
- Should every board adapter support recent `search`, or may live-only adapters
  satisfy publish and observe with an explicit `unsupported` search result?
- Which shared fixture format is normative: raw carrier payloads with expected
  extracted candidates, or adapter-level operation transcripts?

## Bootstrap search

- What default BootstrapBeacon expiry window and republish cadence should v0
  publish for operators?
- Is `bootstrap.beacon` always one subject per beacon, or can one subject issue
  a bounded multi-subject bundle directly?
- How do sequence numbers work when an operator rotates keys or delegates
  publication to several devices?
- Should revocation address exact `beacon_id` values, sequence ranges, or both?
- What minimum independent failure-domain count should default clients require
  before treating bootstrap as healthy rather than degraded?
- Which carrier-specific query profiles become normative fixtures first beyond
  GitHub, npm, and crates.io?

## Relays and mesh routing

- Should relay-to-relay routing exist in v0, or should senders know the final
  recipient relay directly?
- How does a relay behind NAT participate through an upstream relay?
- Which resource limits make volunteer operation safe by default?
- How are capability grants revoked without a global revocation service?
- If durable offline delivery is introduced outside the relay baseline, what
  user-chosen storage-carrier contract owns it?

## Abuse resistance

- How does first contact work without creating an open spam mailbox?
- Are proof-of-work, invitations, local trust, quotas, or combinations useful?
- How can operators prevent the relay from becoming a generic open proxy?
- What information may an operator retain for reliability and abuse control?
- What invitation or introduction proof format can be checked before revealing
  richer route hints?

## Connectivity

- Which direct transport should the first prototype use?
- How should a live session migrate between direct and relayed paths?
- What is the minimum interoperable relay protocol?
- How should duplicate messages be reconciled during overlapping paths?
- What default first-contact expiry, retry, and accepted clock-skew values
  should v0 publish in conformance fixtures?

## Mobile

- How can clients wake reliably while keeping platform push payload-free?
- What remains possible without Google or Apple push infrastructure?
- Should a user's home relay act as the durable mobile mailbox?
- How should delivery behave when every recipient device is offline?

## PWA distribution and migration

- Which release-signing threshold and key-rotation process should mirrors and
  clients require before importing identity material?
- Which reproducible-build environment and transparency log format should make
  mirror builds independently auditable?
- What exact service-worker update policy balances security fixes, rollback,
  and user control?
- What encrypted export format and KDF parameters protect portable identity
  bundles across browsers?
- What QR transfer ceremony prevents wrong-device import without becoming
  unusable on mobile?
- Which history fields are included by default in portable export, and which
  require explicit user selection?
- What external verifier UX is acceptable for first install from an unfamiliar
  mirror?

## Governance and heritage

- Which open-source license best protects independent implementation and
  interoperability?
- How should protocol changes be proposed and ratified without a permanent
  central owner?
- How do we preserve the Blue Ribbon historical attribution in implementations
  without implying EFF affiliation?
- Should conformance require the full name and heritage notice, or should that
  remain a strong brand guideline?
