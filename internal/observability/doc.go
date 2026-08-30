// Package observability defines the operator-owned diagnostic boundary for the
// reference implementation.
//
// The package is intentionally exporter-agnostic. Protocol and connectivity
// behaviour must not depend on whether any Sink is attached.
package observability
