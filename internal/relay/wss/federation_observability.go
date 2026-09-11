package wss

import (
	"context"
	"time"
)

// FederationObservationKind identifies a bounded relay-side federation stage.
// It deliberately has no endpoint, peer, session, route, payload, or key
// fields: those values must never cross the operator-observability boundary.
type FederationObservationKind string

const (
	FederationCarrierLookupStarted   FederationObservationKind = "carrier_lookup_started"
	FederationCarrierLookupCompleted FederationObservationKind = "carrier_lookup_completed"
	FederationCarrierLookupFailed    FederationObservationKind = "carrier_lookup_failed"
	FederationCandidateRejected      FederationObservationKind = "candidate_rejected"
	FederationRouteSelected          FederationObservationKind = "route_selected"
	FederationBridgeEstablished      FederationObservationKind = "bridge_established"
	FederationBridgeFailed           FederationObservationKind = "bridge_failed"
	// FederationForwardFailed is emitted only when an already-established
	// bridge cannot obtain the remote relay.forwarded outcome. Successful
	// ordinary ENVELOPE forwarding remains intentionally unobserved.
	FederationForwardFailed    FederationObservationKind = "forward_failed"
	FederationRouteUnavailable FederationObservationKind = "route_unavailable"
)

// FederationObservation is an optional diagnostic signal emitted after a
// federation stage. It is observational only; callers ignore observer errors
// and no outcome may affect discovery, routing, or forwarding.
type FederationObservation struct {
	Kind     FederationObservationKind
	Reason   string
	Duration time.Duration
}

// FederationObserver is a consuming-package port for optional relay operator
// diagnostics. Implementations must treat Observation as redacted metadata.
type FederationObserver interface {
	ObserveFederation(context.Context, FederationObservation)
}

type noopFederationObserver struct{}

func (noopFederationObserver) ObserveFederation(context.Context, FederationObservation) {}
