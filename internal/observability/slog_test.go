package observability

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestSlogSinkEmitsStructuredEvent(t *testing.T) {
	var output bytes.Buffer
	sink := NewSlogSink(slog.New(slog.NewJSONHandler(&output, nil)), ModeOperator)
	envelope, err := NewEnvelope(
		EventRouteMigrationCompleted,
		LevelInfo,
		WithService("branch-node", "0.0.0", "instance-secret", "operator", "relay"),
		WithProtocolVersion("branch/connectivity/0"),
		WithReason(ReasonRouteDegraded),
		WithAttribute(Attribute{Key: AttributeTransport, Value: "relay_wss"}),
	)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}
	envelope.TraceID = "trace-1"
	envelope.SpanID = "span-1"
	envelope.SessionRef = "session-1"

	if err := sink.Emit(context.Background(), envelope); err != nil {
		t.Fatalf("emit: %v", err)
	}

	logged := output.String()
	for _, expected := range []string{
		`"event":"route.migration.completed"`,
		`"service_name":"branch-node"`,
		`"protocol_version":"branch/connectivity/0"`,
		`"reason_code":"route_degraded"`,
		`"attribute_transport":"relay_wss"`,
	} {
		if !strings.Contains(logged, expected) {
			t.Fatalf("log missing %s in %s", expected, logged)
		}
	}
	for _, forbidden := range []string{"trace-1", "span-1", "session-1", "instance-secret"} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("log exposed forbidden value %q in %s", forbidden, logged)
		}
	}
}

func TestSlogSinkOffModeDoesNotWrite(t *testing.T) {
	var output bytes.Buffer
	sink := NewSlogSink(slog.New(slog.NewJSONHandler(&output, nil)), ModeOff)
	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}

	if err := sink.Emit(context.Background(), envelope); err != nil {
		t.Fatalf("emit: %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("off mode wrote log: %s", output.String())
	}
}

func TestSlogSinkRejectsInvalidEnvelope(t *testing.T) {
	sink := NewSlogSink(slog.Default(), ModeOperator)
	err := sink.Emit(context.Background(), Envelope{Event: "unknown", Level: LevelInfo})
	if !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("err = %v, want ErrInvalidEvent", err)
	}
}
