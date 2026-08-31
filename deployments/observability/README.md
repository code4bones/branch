# B.R.A.N.C.H. Observability Development Profile

This directory contains the optional local development observability stack for
T-BRANCH-014.

It is not required for protocol operation, node startup, PWA startup, tests, or
network participation. Production operators own their own telemetry and may run
with every exporter disabled.

Start explicitly:

```sh
docker compose -f compose.observability.yaml --profile observability up
```

Local endpoints:

- Grafana: http://127.0.0.1:3000
- Prometheus: http://127.0.0.1:9090
- Loki: http://127.0.0.1:3100
- Tempo: http://127.0.0.1:3200
- OTLP gRPC: 127.0.0.1:4317
- OTLP HTTP: http://127.0.0.1:4318

Grafana provisions Prometheus, Loki, and Tempo datasources plus the
`B.R.A.N.C.H. Development` dashboard. The dashboard uses only bounded metric
names and labels from docs/OBSERVABILITY.md.

All exposed ports are bound to `127.0.0.1` by default. Exporter credentials and
remote destinations do not belong in repository configuration.
