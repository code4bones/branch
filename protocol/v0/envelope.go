package v0

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	// ProtocolID is the accepted draft signed-event protocol identifier used by
	// the current shared fixtures.
	ProtocolID = "branch/connectivity/0"

	// MaxDraftEnvelopeBytes bounds local fixture parsing and future hostile
	// input tests. It is not a negotiated relay frame limit.
	MaxDraftEnvelopeBytes = 64 * 1024

	// MaxDraftStringBytes bounds draft string fields before the final wire
	// format defines per-field sizes.
	MaxDraftStringBytes = 1024

	// MaxDraftTimestamp is the largest integer timestamp accepted by both Go
	// and TypeScript draft conformance checks.
	MaxDraftTimestamp = 1<<53 - 1
)

// EventType names the draft signed event envelope types described in
// docs/PROTOCOL_V0.md.
type EventType string

const (
	EventIdentityAnnounce EventType = "identity.announce"
	EventRendezvousOffer  EventType = "rendezvous.offer"
	EventRendezvousAnswer EventType = "rendezvous.answer"
	EventRouteUpdate      EventType = "route.update"
	EventRelayAnnounce    EventType = "relay.announce"
	EventCapabilityGrant  EventType = "capability.grant"
	EventCapabilityRevoke EventType = "capability.revoke"
)

var (
	// ErrInvalidEnvelope reports structurally invalid draft event envelopes.
	ErrInvalidEnvelope = errors.New("invalid draft envelope")

	// ErrOversizedEnvelope reports a draft fixture that exceeds the current
	// local parsing limit.
	ErrOversizedEnvelope = errors.New("oversized draft envelope")
)

// DraftEnvelope mirrors the illustrative JSON envelope in docs/PROTOCOL_V0.md.
// The payload and signature fields are opaque strings until canonical encoding
// and cryptographic constructions are specified.
type DraftEnvelope struct {
	Protocol     string    `json:"protocol"`
	ID           string    `json:"id"`
	Type         EventType `json:"type"`
	Sender       string    `json:"sender"`
	RecipientTag string    `json:"recipient_tag"`
	CreatedAt    int64     `json:"created_at"`
	ExpiresAt    int64     `json:"expires_at"`
	Nonce        string    `json:"nonce"`
	Payload      string    `json:"payload"`
	Signature    string    `json:"signature"`
}

// DecodeDraftEnvelope decodes one draft JSON envelope with a hard byte limit.
// It intentionally performs only structural validation.
func DecodeDraftEnvelope(data []byte) (DraftEnvelope, error) {
	if len(data) > MaxDraftEnvelopeBytes {
		return DraftEnvelope{}, ErrOversizedEnvelope
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	var envelope DraftEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return DraftEnvelope{}, fmt.Errorf("%w: %v", ErrInvalidEnvelope, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return DraftEnvelope{}, fmt.Errorf("%w: trailing data", ErrInvalidEnvelope)
	}

	if err := envelope.ValidateStructure(); err != nil {
		return DraftEnvelope{}, err
	}
	return envelope, nil
}

// ValidateStructure checks deterministic draft-envelope invariants that are
// already present in the founding protocol sketch.
func (envelope DraftEnvelope) ValidateStructure() error {
	if envelope.Protocol != ProtocolID {
		return fmt.Errorf("%w: unsupported protocol %q", ErrInvalidEnvelope, envelope.Protocol)
	}
	if !KnownEventType(envelope.Type) {
		return fmt.Errorf("%w: unsupported event type %q", ErrInvalidEnvelope, envelope.Type)
	}
	if !validDraftString(envelope.ID) {
		return fmt.Errorf("%w: missing id", ErrInvalidEnvelope)
	}
	if !validDraftString(envelope.Sender) {
		return fmt.Errorf("%w: missing sender", ErrInvalidEnvelope)
	}
	if !validDraftString(envelope.RecipientTag) {
		return fmt.Errorf("%w: missing recipient tag", ErrInvalidEnvelope)
	}
	if envelope.ExpiresAt <= envelope.CreatedAt {
		return fmt.Errorf("%w: expiry must be after creation", ErrInvalidEnvelope)
	}
	if envelope.CreatedAt < 0 || envelope.ExpiresAt > MaxDraftTimestamp {
		return fmt.Errorf("%w: timestamp out of range", ErrInvalidEnvelope)
	}
	if !validDraftString(envelope.Nonce) {
		return fmt.Errorf("%w: missing nonce", ErrInvalidEnvelope)
	}
	if !validDraftString(envelope.Payload) {
		return fmt.Errorf("%w: missing payload", ErrInvalidEnvelope)
	}
	if !validDraftString(envelope.Signature) {
		return fmt.Errorf("%w: missing signature", ErrInvalidEnvelope)
	}
	return nil
}

// KnownEventType reports whether eventType is currently listed in the draft
// protocol sketch.
func KnownEventType(eventType EventType) bool {
	switch eventType {
	case EventIdentityAnnounce,
		EventRendezvousOffer,
		EventRendezvousAnswer,
		EventRouteUpdate,
		EventRelayAnnounce,
		EventCapabilityGrant,
		EventCapabilityRevoke:
		return true
	default:
		return false
	}
}

func validDraftString(value string) bool {
	return len(value) > 0 && len(value) <= MaxDraftStringBytes
}
