package node

import (
	"context"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/observability"
	"github.com/code4bones/branch/internal/relay/wss"
)

func TestFederationObservabilityRecordsRedactedBridgeOutcome(t *testing.T) {
	recorder := observability.NewRecorder(observability.RecorderOptions{})
	observer := federationObservability{
		sink:    observationFanout{recorder: recorder},
		version: "0.0.0-test",
	}

	observer.ObserveFederation(context.Background(), wss.FederationObservation{
		Kind:     wss.FederationBridgeEstablished,
		Reason:   "success",
		Duration: 42 * time.Millisecond,
	})

	snapshot := recorder.Snapshot()
	if snapshot.TotalEvents != 1 || len(snapshot.RecentEvents) != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	event := snapshot.RecentEvents[0]
	if event.Event != observability.EventRouteMigrationCompleted || event.DurationMillis != 42 {
		t.Fatalf("unexpected bridge event: %+v", event)
	}
	if event.Attributes[observability.AttributeTransport] != "relay_wss" || event.Attributes[observability.AttributeCarrier] != "github" {
		t.Fatalf("missing bounded routing attributes: %+v", event.Attributes)
	}
}

func TestFederationObservabilityClassifiesCarrierAndHandshakeTimeouts(t *testing.T) {
	if reason := federationReason(wss.FederationCarrierLookupFailed, "timeout"); reason != observability.ReasonCarrierTimeout {
		t.Fatalf("carrier timeout reason = %q", reason)
	}
	if reason := federationReason(wss.FederationBridgeFailed, "timeout"); reason != observability.ReasonHandshakeTimeout {
		t.Fatalf("bridge timeout reason = %q", reason)
	}
	if reason := federationReason(wss.FederationCarrierLookupFailed, "rate_limited"); reason != observability.ReasonRateLimitExceeded {
		t.Fatalf("carrier rate limit reason = %q", reason)
	}
}

func TestFederationObservabilityMapsForwardFailureToRouteFailure(t *testing.T) {
	for kind, wantResult := range map[wss.FederationObservationKind]string{
		wss.FederationForwardFailed:        "forward_failed",
		wss.FederationRendezvousRejected:   "rendezvous_rejected",
		wss.FederationInboundForwardFailed: "inbound_forward_failed",
	} {
		event, level, result := federationEvent(kind)
		if event != observability.EventRouteMigrationFailed || level != observability.LevelWarn || result != wantResult {
			t.Fatalf("%s mapping = %q %q %q", kind, event, level, result)
		}
	}
}

func TestOffFederationObservabilityDoesNotRecordEvents(t *testing.T) {
	recorder := observability.NewRecorder(observability.RecorderOptions{})
	observer, fanout := newFederationObserver(observability.ModeOff, recorder, "0.0.0-test")
	if fanout != nil {
		t.Fatal("off mode created a logging fanout")
	}
	observer.ObserveFederation(context.Background(), wss.FederationObservation{Kind: wss.FederationBridgeFailed, Reason: "timeout"})
	if total := recorder.Snapshot().TotalEvents; total != 0 {
		t.Fatalf("off mode recorded %d events", total)
	}
}
