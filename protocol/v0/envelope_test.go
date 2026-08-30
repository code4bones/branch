package v0

import (
	"errors"
	"strings"
	"testing"
)

func TestDecodeDraftEnvelopeRejectsOversizedInput(t *testing.T) {
	data := []byte(strings.Repeat("x", MaxDraftEnvelopeBytes+1))

	_, err := DecodeDraftEnvelope(data)
	if !errors.Is(err, ErrOversizedEnvelope) {
		t.Fatalf("expected ErrOversizedEnvelope, got %v", err)
	}
}

func TestKnownEventType(t *testing.T) {
	tests := []struct {
		name      string
		eventType EventType
		want      bool
	}{
		{name: "rendezvous offer", eventType: EventRendezvousOffer, want: true},
		{name: "unknown", eventType: EventType("unknown.event"), want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := KnownEventType(test.eventType); got != test.want {
				t.Fatalf("KnownEventType(%q) = %v, want %v", test.eventType, got, test.want)
			}
		})
	}
}
