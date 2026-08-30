package observability

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNewEnvelopeRejectsUnknownAttribute(t *testing.T) {
	_, err := NewEnvelope(
		EventRouteSelected,
		LevelInfo,
		WithAttribute(Attribute{Key: AttributeKey("peer_id"), Value: "peer-123"}),
	)
	if !errors.Is(err, ErrUnknownAttribute) {
		t.Fatalf("expected ErrUnknownAttribute, got %v", err)
	}
}

func TestNewEnvelopeRejectsForbiddenValues(t *testing.T) {
	_, err := NewEnvelope(
		EventRelayFrameRejected,
		LevelWarn,
		WithAttribute(Attribute{Key: AttributeResult, Value: "payload leaked"}),
	)
	if !errors.Is(err, ErrForbiddenField) {
		t.Fatalf("expected ErrForbiddenField, got %v", err)
	}
}

func TestNewEnvelopeClipsAttributeValues(t *testing.T) {
	envelope, err := NewEnvelope(
		EventCarrierSearchFailed,
		LevelWarn,
		WithAttribute(Attribute{Key: AttributeCarrier, Value: strings.Repeat("x", MaxAttributeValueBytes+1)}),
	)
	if err != nil {
		t.Fatalf("expected clipped attribute value: %v", err)
	}
	if got := len(envelope.Attributes[AttributeCarrier]); got != MaxAttributeValueBytes {
		t.Fatalf("attribute length = %d, want %d", got, MaxAttributeValueBytes)
	}
}

func TestNoopSinkReturnsImmediately(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	envelope, err := NewEnvelope(EventProcessStarted, LevelInfo)
	if err != nil {
		t.Fatalf("new envelope: %v", err)
	}

	if err := (NoopSink{}).Emit(ctx, envelope); err != nil {
		t.Fatalf("noop emit: %v", err)
	}
}

func TestKnownReasonIncludesInitialTaxonomy(t *testing.T) {
	reasons := []ReasonCode{
		ReasonConfigInvalid,
		ReasonCarrierUnavailable,
		ReasonCarrierTimeout,
		ReasonBeaconExpired,
		ReasonBeaconMalformed,
		ReasonBeaconSignatureInvalid,
		ReasonProtocolVersionUnsupported,
		ReasonCapabilityUnsupported,
		ReasonPeerUnreachable,
		ReasonHandshakeTimeout,
		ReasonHandshakeProtocolError,
		ReasonRouteNoCandidate,
		ReasonRouteDegraded,
		ReasonRelayUnavailable,
		ReasonQueueHighWatermark,
		ReasonQueueOverflow,
		ReasonFrameOversized,
		ReasonFrameMalformed,
		ReasonFrameUnauthenticated,
		ReasonRateLimitExceeded,
		ReasonExporterUnavailable,
		ReasonDiagnosticExpired,
	}

	for _, reason := range reasons {
		if !KnownReason(reason) {
			t.Fatalf("reason %q is not registered", reason)
		}
	}
}
