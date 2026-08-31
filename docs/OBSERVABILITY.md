# B.R.A.N.C.H. Observability Contract

Status: normative foundation draft, 2026-08-30.
Tracks: T-BRANCH-014.

Observability is required for developing and operating the reference
implementation, but it is not part of the B.R.A.N.C.H. Connectivity Protocol
and is never required for network participation.

A development team may centralize telemetry for infrastructure it controls.
Independent production operators own their own telemetry and choose whether to
retain or export it. No project-operated collector or dashboard is authoritative
or mandatory.

## 1. Invariants

- Connectivity works when every telemetry exporter and backend is disabled.
- Telemetry never changes protocol state or delivery decisions.
- Instrumentation failure is contained and cannot crash or block relay traffic.
- Message bodies, files, keys, recovery material, capability tokens, portable
  identity exports, and authentication secrets are never collected.
- Permanent user identifiers and cryptographic identity fingerprints are never
  telemetry identifiers.
- Metrics never contain unbounded labels such as session IDs, peer IDs, IP
  addresses, URLs, message IDs, or error strings.
- Production telemetry does not create a mandatory global correlation surface
  across independently operated relays.
- Every buffer, exporter queue, retry, diagnostic journal, and retention policy
  is bounded.
- Operator administration and telemetry endpoints are not exposed on the public
  client listener by default.

## 2. Modes

### Off

Only process-fatal output required to explain failure to start is written to
stderr. No metrics or traces are exported.

### Operator

The production default. Emits structured operational logs, health/readiness,
bounded-cardinality metrics, and locally scoped traces where useful. Raw remote
addresses and stable peer identifiers are excluded by default.

### Development

For nodes, browsers, carriers, and relays controlled by the project. Enables
verbose lifecycle events, detailed reason codes, test-node addresses, and
end-to-end tracing across the controlled environment. Payload and secret
prohibitions still apply.

### Diagnostic session

A time-boxed and explicitly enabled investigation for one local component or
ephemeral session. It has an expiration time, a narrow scope, and a bounded
buffer. Any additional correlation ID is random and temporary. Diagnostic mode
does not weaken encryption or capture payloads.

## 3. Signals and ownership

### Logs

Go uses log/slog structured JSON at process and adapter boundaries. A domain
failure is logged once. Internal layers return typed errors and emit typed
domain events rather than repeating free-form log messages.

The reference slog sink accepts only validated observability envelopes. Off mode
is a no-op. Operator logs omit trace, span, session, service-instance, peer,
address, and identity correlation fields by default; development-only
correlation belongs to a separate trace adapter or explicit diagnostic session.

Exporter adapters sit behind a bounded asynchronous sink. Full queues and
exporter errors are counted and dropped locally instead of blocking or failing
connectivity work. The reference core therefore has no OTLP runtime dependency;
an OTLP adapter can implement the same sink interface in deployment code.

### Metrics

Metrics describe aggregate health, volume, latency, resource pressure, and
outcomes. Labels use small controlled enumerations.

### Traces

Traces explain causality and latency across carrier search, beacon validation,
connection, handshake, route selection, relay use, and route migration.
Production traces are local to an operator boundary unless an explicit
diagnostic session enables temporary correlation.

### PWA diagnostic journal

The PWA records a bounded local sequence of state transitions and outcomes. It
supports manual redacted export. It is not analytics, presence reporting, or a
hidden upload channel.

## 4. Common event envelope

Every structured event uses the same stable envelope where applicable:

~~~json
{
  "timestamp": "RFC3339Nano",
  "event": "route.migration.completed",
  "level": "info",
  "service_name": "branch-node",
  "service_version": "0.2.1",
  "service_instance_id": "random-process-instance",
  "deployment_environment": "development",
  "node_role": "relay",
  "protocol_version": "branch/connectivity/0",
  "trace_id": "optional-local-trace",
  "span_id": "optional-local-span",
  "session_ref": "optional-ephemeral-reference",
  "reason_code": "peer_unreachable",
  "attributes": {}
}
~~~

service_instance_id is operational and random; it is not the signed Node ID.
session_ref is ephemeral, mode-dependent, and never a metric label. Attributes
are controlled by the event schema rather than arbitrary maps supplied by
network input.

Free-form remote error text may be logged only after length limiting and
sanitization. Aggregation uses stable reason_code values.

## 5. Event taxonomy

Initial stable event families:

- process.started, process.ready, process.stopping, process.stopped;
- config.rejected;
- carrier.search.started, carrier.search.completed, carrier.search.failed;
- beacon.validation.accepted, beacon.validation.rejected;
- connection.accepted, connection.established, connection.closed;
- handshake.started, handshake.completed, handshake.failed;
- route.candidate.accepted, route.candidate.rejected, route.selected;
- route.migration.started, route.migration.completed, route.migration.failed;
- relay.peer.connected, relay.peer.disconnected;
- relay.frame.rejected;
- queue.high_watermark, queue.overflow;
- gossip.record.accepted, gossip.record.rejected, gossip.exchange.completed;
- rate_limit.applied;
- admin.authentication.failed, admin.configuration.changed;
- diagnostic.export.created, diagnostic.mode.expired.

Ordinary successful frames do not produce one log event per frame. Their volume
is represented by metrics and optionally sampled traces. This avoids log floods
and metadata leakage.

Each event defines:

- responsible component;
- required and optional fields;
- allowed modes;
- severity;
- controlled reason codes;
- fields that must be redacted or forbidden;
- metric or trace relationship;
- test evidence.

## 6. Initial metrics

~~~text
branch_build_info
branch_process_uptime_seconds
branch_sessions_active
branch_connections_total
branch_connection_duration_seconds
branch_handshakes_total
branch_handshake_duration_seconds
branch_route_selections_total
branch_route_migrations_total
branch_frames_forwarded_total
branch_frames_rejected_total
branch_queue_depth
branch_queue_dropped_total
branch_carrier_queries_total
branch_carrier_query_duration_seconds
branch_beacons_validated_total
branch_gossip_records_total
branch_protocol_errors_total
branch_exporter_dropped_total
~~~

Allowed label examples:

- transport: direct_ipv6, ice_udp, ice_tcp, relay_wss;
- carrier: github, npm, git, image, manual;
- direction: inbound, outbound;
- result: success, rejected, timeout, unavailable;
- reason: a controlled bounded enumeration;
- protocol_version: one of the versions implemented by the build;
- capability: a registered bounded capability name.

Forbidden metric labels include user IDs, public keys, identity fingerprints,
session IDs, message IDs, IP addresses, hostnames, repository URLs, relay URLs,
arbitrary error text, user agents, or other unbounded values.

Metrics exposed by the node are available only through the protected admin
listener or a separately configured monitoring listener.

The reference implementation keeps metrics in an in-memory registry when no
exporter is attached. Metric names must come from the initial registry above.
Labels are accepted only from the bounded label allowlists; protocol versions
and capabilities must be registered by the local build. The protected admin
surface may render those samples as Prometheus text, but that endpoint is an
operator API and not a public connectivity endpoint.

## 7. Trace boundaries

The development environment may trace:

~~~text
carrier.search
  -> beacon.validate
  -> relay.connect
  -> handshake.negotiate
  -> route.select
  -> session.established
  -> route.migrate
~~~

Trace context is not a required B.R.A.N.C.H. wire field. An independently
operated production relay starts or continues only its local trace according to
operator policy. It does not have to preserve a correlation ID supplied by a
peer.

Time-boxed diagnostic correlation uses random identifiers unrelated to user,
device, node, message, or conversation identity. The diagnostic capability
expires automatically.

## 8. Address and identity treatment

Development nodes controlled by the project may record exact test-node
addresses. Production operator mode defaults to one of:

- omit the address;
- retain only address family and network class;
- truncate according to documented operator policy;
- keep the raw address only in a short-lived local security log explicitly
  enabled by the operator.

Telemetry must never derive a stable identifier by hashing a public key, IP
address, capability, message, or conversation ID. Hashing a stable identifier
does not make it anonymous.

Geolocation and third-party enrichment are absent from the reference baseline.

## 9. Health and readiness

The protected administrative listener provides:

- liveness: the process event loop is alive;
- readiness: configuration and node identity are valid and the node can accept
  its declared roles;
- metrics: scrape endpoint when enabled;
- diagnostics: a bounded in-memory snapshot of recent event names, reason
  counts, and allowed low-cardinality attributes;
- build and supported protocol/capability information;
- bounded current resource pressure without peer enumeration.

A carrier outage or empty relay mesh may degrade readiness details without
making the process falsely dead. Public health responses reveal no topology,
peer identities, addresses, or configuration secrets.

Go pprof and equivalent debug endpoints are development-only, disabled by
default, and bound to loopback or an explicitly protected listener.

## 10. PWA local diagnostic journal

The PWA records a bounded ring of events such as:

- application.started and version;
- discovery.started and carrier outcomes;
- beacon accepted or rejected with a controlled reason;
- relay connection outcome;
- handshake outcome;
- route selection and migration;
- local queue state transitions;
- acknowledgement timing;
- storage migration failure;
- service-worker update lifecycle.

The journal has configurable count and age limits. Its default export excludes
message text, contact names, keys, signatures, capabilities, full URLs, exact IP
addresses, IndexedDB contents, and browser authentication state.

Export is a deliberate user action. The preview shows included categories and
the generated bundle is redacted before it leaves the browser. Automatic upload
is absent from the baseline.

Frontend monitoring views derive from the local journal or a manually supplied
redacted export. They may show event counts, reason counts, newest event time,
recent sanitized events, and export categories. They do not upload diagnostics
automatically, create permanent user identifiers, or reinterpret protocol
state.

## 11. Development stack

The optional reference profile is:

~~~text
Go node and PWA
       |
       v
OpenTelemetry Collector
       |-- Prometheus: metrics
       |-- Loki: logs
       |-- Tempo: traces
       '-- Grafana: dashboards
~~~

It is started explicitly, for example through a compose observability profile.
The normal node binary and PWA have no runtime dependency on this stack.
OpenTelemetry is an adapter and OTLP is an optional export path.

Collector processors apply allowlists, length limits, attribute removal,
sampling, batching, memory limits, and bounded retry before export. Credentials
for exporters remain outside repository configuration.

## 12. Initial dashboards and alerts

The development dashboard answers:

- Which node and build handled the failing path?
- Which carrier found or failed to find the beacon?
- Which protocol version and capabilities were negotiated?
- Where did handshake stop?
- Which route was selected and why?
- When and why did route migration happen?
- Did a queue reach its high-water mark or drop work?
- Did a relay restart, lose peers, or reject malformed traffic?
- Are failures isolated to one transport, carrier, build, or environment?

Initial alerts cover process unavailability, readiness degradation, sustained
handshake failures, carrier failure concentration, queue drops, exporter drops,
and abnormal route-migration rate. Thresholds are deployment policy, not
protocol constants.

## 13. Testing

Tests must prove:

- telemetry off and exporter failure do not change protocol behaviour;
- all metric labels come from bounded enumerations;
- forbidden fields are rejected or redacted by the event builder;
- malformed remote values cannot inject attributes or unbounded log text;
- route selection, carrier failure, handshake failure, queue overflow, route
  hopping, and relay restart emit expected diagnostic evidence;
- production traces do not require cross-relay propagation;
- diagnostic sessions expire and release buffers;
- PWA export contains the required state timeline and none of the forbidden
  material;
- admin, metrics, pprof, and diagnostic endpoints are not accidentally public.

Golden telemetry fixtures may validate event names and required fields, but
timestamps, random IDs, and scheduling-dependent values are normalized.

## 14. Retention and operator policy

The reference project specifies safe defaults and bounded rotation, but does not
create a global retention policy for independent operators. Operators document
their collection mode, retention, access control, exporter destination, and
whether raw network addresses are locally retained.

Development telemetry uses short retention appropriate to active diagnosis.
Diagnostic-session data expires automatically. Deletion of telemetry does not
delete or alter protocol state because telemetry never owns that state.

## 15. References

- OpenTelemetry Collector:
  https://opentelemetry.io/docs/collector/
- OpenTelemetry handling sensitive data:
  https://opentelemetry.io/docs/security/handling-sensitive-data/
- Prometheus metric and label naming:
  https://prometheus.io/docs/practices/naming/
- Prometheus instrumentation practices:
  https://prometheus.io/docs/practices/instrumentation/
- Go structured logging with log/slog:
  https://go.dev/blog/slog
