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

All exposed ports are bound to `127.0.0.1` by default. Exporter credentials and
remote destinations do not belong in repository configuration.

