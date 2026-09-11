package node

import (
	"context"

	"github.com/code4bones/branch/internal/observability"
	"github.com/code4bones/branch/internal/relay/wss"
	protocol "github.com/code4bones/branch/protocol/v0"
)

// federationObservability adapts redacted WSS federation stages to the
// optional operator observation plane. It must never receive relay endpoints,
// peer IDs, route IDs, session IDs, payloads, or authentication material.
type federationObservability struct {
	sink    observability.Sink
	version string
}

func newFederationObserver(mode observability.Mode, recorder *observability.Recorder, version string) (wss.FederationObserver, *observationFanout) {
	if mode == observability.ModeOff {
		return noopNodeFederationObserver{}, nil
	}
	fanout := &observationFanout{recorder: recorder}
	return federationObservability{sink: fanout, version: version}, fanout
}

func (observer federationObservability) ObserveFederation(ctx context.Context, observation wss.FederationObservation) {
	event, level, result := federationEvent(observation.Kind)
	options := []observability.Option{
		observability.WithService("branch-node", observer.version, "", "", "relay"),
		observability.WithProtocolVersion(protocol.ProtocolID),
		observability.WithAttribute(observability.Attribute{Key: observability.AttributeCarrier, Value: "github"}),
		observability.WithAttribute(observability.Attribute{Key: observability.AttributeTransport, Value: "relay_wss"}),
		observability.WithAttribute(observability.Attribute{Key: observability.AttributeDirection, Value: "outbound"}),
		observability.WithAttribute(observability.Attribute{Key: observability.AttributeResult, Value: result}),
		observability.WithDuration(observation.Duration),
	}
	if reason := federationReason(observation.Kind, observation.Reason); reason != "" {
		options = append(options, observability.WithReason(reason))
	}
	envelope, err := observability.NewEnvelope(event, level, options...)
	if err != nil {
		return
	}
	_ = observer.sink.Emit(ctx, envelope)
}

func federationEvent(kind wss.FederationObservationKind) (observability.EventName, observability.Level, string) {
	switch kind {
	case wss.FederationCarrierLookupStarted:
		return observability.EventCarrierSearchStarted, observability.LevelDebug, "started"
	case wss.FederationCarrierLookupCompleted:
		return observability.EventCarrierSearchCompleted, observability.LevelInfo, "success"
	case wss.FederationCarrierLookupFailed:
		return observability.EventCarrierSearchFailed, observability.LevelWarn, "unavailable"
	case wss.FederationCandidateRejected:
		return observability.EventRouteCandidateRejected, observability.LevelInfo, "rejected"
	case wss.FederationRouteSelected:
		return observability.EventRouteSelected, observability.LevelInfo, "success"
	case wss.FederationBridgeEstablished:
		return observability.EventRouteMigrationCompleted, observability.LevelInfo, "success"
	case wss.FederationBridgeFailed, wss.FederationForwardFailed, wss.FederationRouteUnavailable:
		return observability.EventRouteMigrationFailed, observability.LevelWarn, "unavailable"
	default:
		return observability.EventRouteMigrationFailed, observability.LevelWarn, "unavailable"
	}
}

func federationReason(kind wss.FederationObservationKind, reason string) observability.ReasonCode {
	switch reason {
	case "peer_unavailable":
		return observability.ReasonPeerUnreachable
	case "timeout":
		if kind == wss.FederationCarrierLookupFailed {
			return observability.ReasonCarrierTimeout
		}
		return observability.ReasonHandshakeTimeout
	case "no_candidate":
		return observability.ReasonRouteNoCandidate
	case "relay_backoff":
		return observability.ReasonRouteDegraded
	case "carrier_unavailable":
		return observability.ReasonCarrierUnavailable
	case "relay_unavailable":
		return observability.ReasonRelayUnavailable
	default:
		return ""
	}
}

type observationFanout struct {
	recorder *observability.Recorder
	slog     observability.Sink
}

func (fanout observationFanout) Emit(ctx context.Context, envelope observability.Envelope) error {
	if fanout.recorder != nil {
		_ = fanout.recorder.Emit(ctx, envelope)
	}
	if fanout.slog != nil {
		_ = fanout.slog.Emit(ctx, envelope)
	}
	return nil
}
