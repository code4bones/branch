package observability

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRecorderKeepsBoundedRecentEventsAndCountsDrops(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	recorder := NewRecorder(RecorderOptions{
		RecentLimit: 2,
		Now:         func() time.Time { return now },
	})

	events := []EventName{
		EventProcessStarted,
		EventRouteSelected,
		EventQueueOverflow,
	}
	for _, event := range events {
		envelope, err := NewEnvelope(event, LevelInfo)
		if err != nil {
			t.Fatalf("new envelope: %v", err)
		}
		if err := recorder.Emit(context.Background(), envelope); err != nil {
			t.Fatalf("emit %s: %v", event, err)
		}
	}

	snapshot := recorder.Snapshot()

	if snapshot.TotalEvents != 3 {
		t.Fatalf("total events = %d, want 3", snapshot.TotalEvents)
	}
	if snapshot.DroppedEvents != 1 {
		t.Fatalf("dropped events = %d, want 1", snapshot.DroppedEvents)
	}
	if got := len(snapshot.RecentEvents); got != 2 {
		t.Fatalf("recent events = %d, want 2", got)
	}
	if snapshot.RecentEvents[0].Event != EventRouteSelected {
		t.Fatalf("oldest retained event = %q", snapshot.RecentEvents[0].Event)
	}
}

func TestRecorderSnapshotOmitsCorrelationFields(t *testing.T) {
	recorder := NewRecorder(RecorderOptions{RecentLimit: 4})
	envelope, err := NewEnvelope(
		EventHandshakeFailed,
		LevelWarn,
		WithProtocolVersion("branch/connectivity/0"),
		WithReason(ReasonHandshakeTimeout),
		WithAttribute(Attribute{Key: AttributeTransport, Value: "relay_wss"}),
	)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}
	envelope.TraceID = "trace-1"
	envelope.SpanID = "span-1"
	envelope.SessionRef = "session-1"
	envelope.ServiceInstanceID = "process-1"

	if err := recorder.Emit(context.Background(), envelope); err != nil {
		t.Fatalf("emit: %v", err)
	}

	snapshot := recorder.Snapshot()
	event := snapshot.RecentEvents[0]
	if event.ProtocolVersion != "branch/connectivity/0" {
		t.Fatalf("protocol version = %q", event.ProtocolVersion)
	}
	if event.ReasonCode != ReasonHandshakeTimeout {
		t.Fatalf("reason = %q", event.ReasonCode)
	}
	if event.Attributes[AttributeTransport] != "relay_wss" {
		t.Fatalf("transport attribute = %q", event.Attributes[AttributeTransport])
	}
}

func TestRecorderRejectsInvalidEvent(t *testing.T) {
	recorder := NewRecorder(RecorderOptions{})
	err := recorder.Emit(context.Background(), Envelope{Event: "unknown", Level: LevelInfo})
	if !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("emit err = %v, want ErrInvalidEvent", err)
	}
}

func TestRecorderHonorsContextCancellation(t *testing.T) {
	recorder := NewRecorder(RecorderOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}

	if err := recorder.Emit(ctx, envelope); err != nil {
		t.Fatalf("cancelled emit must be a no-op, got %v", err)
	}
	if recorder.Snapshot().TotalEvents != 0 {
		t.Fatal("cancelled emit must not be recorded")
	}
}
