package v0

import (
	"bytes"
	"encoding/base64"
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
	EventBootstrapBeacon  EventType = "bootstrap.beacon"
	EventRendezvousOffer  EventType = "rendezvous.offer"
	EventRendezvousAnswer EventType = "rendezvous.answer"
	EventRouteUpdate      EventType = "route.update"
	EventRelayAnnounce    EventType = "relay.announce"
	EventCapabilityGrant  EventType = "capability.grant"
	EventCapabilityRevoke EventType = "capability.revoke"
)

// PayloadMode names the draft signed event envelope payload modes.
type PayloadMode string

const (
	PayloadModePublic PayloadMode = "public"
	PayloadModeSealed PayloadMode = "sealed"
)

var (
	// ErrInvalidEnvelope reports structurally invalid draft event envelopes.
	ErrInvalidEnvelope = errors.New("invalid draft envelope")

	// ErrOversizedEnvelope reports a draft fixture that exceeds the current
	// local parsing limit.
	ErrOversizedEnvelope = errors.New("oversized draft envelope")
)

// Sender identifies the draft envelope signer.
type Sender struct {
	KeyAlg    string `json:"key_alg"`
	PublicKey string `json:"public_key"`
}

// DraftEnvelope mirrors the illustrative JSON envelope in docs/PROTOCOL_V0.md.
// The payload and signature fields are opaque strings until canonical encoding
// and cryptographic constructions are specified.
type DraftEnvelope struct {
	Protocol     string      `json:"protocol"`
	EventID      string      `json:"event_id"`
	Type         EventType   `json:"type"`
	Sender       Sender      `json:"sender"`
	RecipientTag string      `json:"recipient_tag,omitempty"`
	CreatedAt    int64       `json:"created_at"`
	ExpiresAt    int64       `json:"expires_at"`
	PayloadMode  PayloadMode `json:"payload_mode"`
	Payload      string      `json:"payload"`
	SignatureAlg string      `json:"signature_alg"`
	Signature    string      `json:"signature"`
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
	if !validBase64URLBytes(envelope.EventID, 32) {
		return fmt.Errorf("%w: invalid event id", ErrInvalidEnvelope)
	}
	if envelope.Sender.KeyAlg != "ed25519" {
		return fmt.Errorf("%w: unsupported sender key algorithm", ErrInvalidEnvelope)
	}
	if !validBase64URLBytes(envelope.Sender.PublicKey, 32) {
		return fmt.Errorf("%w: invalid sender public key", ErrInvalidEnvelope)
	}
	if requiresRecipientTag(envelope.Type) {
		if !validRecipientTag(envelope.RecipientTag) {
			return fmt.Errorf("%w: missing recipient tag", ErrInvalidEnvelope)
		}
	} else if envelope.RecipientTag != "" && !validRecipientTag(envelope.RecipientTag) {
		return fmt.Errorf("%w: invalid recipient tag", ErrInvalidEnvelope)
	}
	if envelope.ExpiresAt <= envelope.CreatedAt {
		return fmt.Errorf("%w: expiry must be after creation", ErrInvalidEnvelope)
	}
	if envelope.CreatedAt < 0 || envelope.ExpiresAt > MaxDraftTimestamp {
		return fmt.Errorf("%w: timestamp out of range", ErrInvalidEnvelope)
	}
	if !validPayloadMode(envelope.Type, envelope.PayloadMode) {
		return fmt.Errorf("%w: invalid payload mode", ErrInvalidEnvelope)
	}
	if !validBase64URLString(envelope.Payload) {
		return fmt.Errorf("%w: invalid payload", ErrInvalidEnvelope)
	}
	if envelope.SignatureAlg != "ed25519" {
		return fmt.Errorf("%w: unsupported signature algorithm", ErrInvalidEnvelope)
	}
	if !validBase64URLBytes(envelope.Signature, 64) {
		return fmt.Errorf("%w: invalid signature", ErrInvalidEnvelope)
	}
	return nil
}

// KnownEventType reports whether eventType is currently listed in the draft
// protocol sketch.
func KnownEventType(eventType EventType) bool {
	switch eventType {
	case EventIdentityAnnounce,
		EventBootstrapBeacon,
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

func requiresRecipientTag(eventType EventType) bool {
	switch eventType {
	case EventRendezvousOffer,
		EventRendezvousAnswer,
		EventRouteUpdate,
		EventCapabilityGrant,
		EventCapabilityRevoke:
		return true
	default:
		return false
	}
}

func validPayloadMode(eventType EventType, mode PayloadMode) bool {
	switch eventType {
	case EventBootstrapBeacon, EventRelayAnnounce:
		return mode == PayloadModePublic
	case EventIdentityAnnounce:
		return mode == PayloadModePublic || mode == PayloadModeSealed
	default:
		return mode == PayloadModeSealed
	}
}

func validRecipientTag(value string) bool {
	data, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && (len(data) == 16 || len(data) == 32)
}

func validBase64URLString(value string) bool {
	if len(value) == 0 || len(value) > MaxDraftStringBytes {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil
}

func validBase64URLBytes(value string, size int) bool {
	if len(value) == 0 || len(value) > MaxDraftStringBytes {
		return false
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(data) == size
}
