# B.R.A.N.C.H. Internal Observability

This directory records the project-owned observability boundary for
T-BRANCH-014.

It is not required for protocol operation, node startup, PWA startup, tests, or
network participation. Production operators own their own local telemetry and
may run with every exporter disabled.

The foundation baseline does not provision external monitoring products.
Development monitoring is rendered by the B.R.A.N.C.H. observation-front from
protected relay/admin endpoints:

- `/livez`
- `/readyz`
- `/diagnostics`
- `/metrics`

Those endpoints are protected operator surfaces, not public connectivity
surfaces. They expose bounded snapshots only and do not contain payloads, keys,
capability tokens, identity exports, permanent user identifiers, peer
enumeration, or relay mailbox state.
