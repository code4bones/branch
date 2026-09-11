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
}

func TestFederationObservabilityMapsForwardFailureToRouteFailure(t *testing.T) {
	event, level, result := federationEvent(wss.FederationForwardFailed)
	if event != observability.EventRouteMigrationFailed || level != observability.LevelWarn || result != "unavailable" {
		t.Fatalf("forward failure mapping = %q %q %q", event, level, result)
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
