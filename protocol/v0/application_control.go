package v0

import (
	"errors"
	"fmt"
)

const (
	// ApplicationControlVersion identifies endpoint-only controls carried as
	// plaintext by an existing HPKE ENVELOPE. It is never a relay frame.
	ApplicationControlVersion = "branch.application-control/0.draft"
	// ApplicationControlSignatureDomain separates the signed canonical control
	// representation from every other Ed25519 input.
	ApplicationControlSignatureDomain = "branch.application-control.signature/0.draft\x00"

	MaxApplicationControlBytes     = 4096
	MaxApplicationControlKindBytes = 96
	MaxApplicationControlBodyBytes = 2048
)

var ErrInvalidApplicationControl = errors.New("invalid application control")

// ApplicationControl is the canonical signed endpoint-only control envelope.
// Signing, signature verification, clocks, replay state and policy remain in
// adapters; this type only owns deterministic bytes and structural bounds.
type ApplicationControl struct {
	Version         string
	Kind            string
	ControlID       []byte
	IssuedAt        uint64
	ExpiresAt       uint64
	SenderPeerID    []byte
	RecipientPeerID []byte
	Body            []byte
	Signature       []byte
}

// EncodeApplicationControl returns the complete deterministic-CBOR envelope.
func EncodeApplicationControl(control ApplicationControl) ([]byte, error) {
	if err := control.Validate(); err != nil {
		return nil, err
	}
	encoded, err := encodeCbor(applicationControlMap(control, true))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	if len(encoded) > MaxApplicationControlBytes {
		return nil, ErrInvalidApplicationControl
	}
	return encoded, nil
}

// ApplicationControlSigningBytes returns the exact domain-separated bytes
// signed by an application-control identity key. Signature bytes themselves
// are deliberately excluded.
func ApplicationControlSigningBytes(control ApplicationControl) ([]byte, error) {
	if err := control.Validate(); err != nil {
		return nil, err
	}
	unsigned, err := encodeCbor(applicationControlMap(control, false))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	return append([]byte(ApplicationControlSignatureDomain), unsigned...), nil
}

// DecodeApplicationControl accepts only bounded canonical envelopes with the
// closed field set. It does not verify the optional signature.
func DecodeApplicationControl(data []byte) (ApplicationControl, error) {
	if len(data) == 0 || len(data) > MaxApplicationControlBytes {
		return ApplicationControl{}, ErrInvalidApplicationControl
	}
	value, err := decodeDeterministicCBOR(data)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	mapValue, err := cborMap(value, "application_control")
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	if err := cborRejectUnknown(mapValue, []string{"version", "kind", "control_id", "issued_at", "expires_at", "sender_peer_id", "recipient_peer_id", "body", "signature"}); err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	version, err := cborText(mapValue, "version")
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	kind, err := cborText(mapValue, "kind")
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	controlID, err := cborBytes(mapValue, "control_id", 16)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	issuedAt, err := cborUint(mapValue, "issued_at")
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	expiresAt, err := cborUint(mapValue, "expires_at")
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	senderPeerID, err := cborBytes(mapValue, "sender_peer_id", 32)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	recipientPeerID, err := cborBytes(mapValue, "recipient_peer_id", 32)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	body, err := cborBytes(mapValue, "body", 0)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	signature, err := applicationControlSignature(mapValue)
	if err != nil {
		return ApplicationControl{}, fmt.Errorf("%w: %v", ErrInvalidApplicationControl, err)
	}
	control := ApplicationControl{Version: version, Kind: kind, ControlID: controlID, IssuedAt: issuedAt, ExpiresAt: expiresAt, SenderPeerID: senderPeerID, RecipientPeerID: recipientPeerID, Body: body, Signature: signature}
	if err := control.Validate(); err != nil {
		return ApplicationControl{}, err
	}
	return control, nil
}

// Validate checks only clock-free structural properties. Descriptor-specific
// expiry windows, replay checks and sender policy are adapter responsibilities.
func (control ApplicationControl) Validate() error {
	if control.Version != ApplicationControlVersion || len([]byte(control.Kind)) == 0 || len([]byte(control.Kind)) > MaxApplicationControlKindBytes || len(control.ControlID) != 16 || control.ExpiresAt <= control.IssuedAt || control.ExpiresAt > MaxDraftTimestamp || len(control.SenderPeerID) != 32 || len(control.RecipientPeerID) != 32 || len(control.Body) == 0 || len(control.Body) > MaxApplicationControlBodyBytes || len(control.Signature) != 0 && len(control.Signature) != 64 {
		return ErrInvalidApplicationControl
	}
	return nil
}

func applicationControlMap(control ApplicationControl, includeSignature bool) cborMapValue {
	entries := []cborEntry{
		{key: "version", value: control.Version},
		{key: "kind", value: control.Kind},
		{key: "control_id", value: append([]byte(nil), control.ControlID...)},
		{key: "issued_at", value: control.IssuedAt},
		{key: "expires_at", value: control.ExpiresAt},
		{key: "sender_peer_id", value: append([]byte(nil), control.SenderPeerID...)},
		{key: "recipient_peer_id", value: append([]byte(nil), control.RecipientPeerID...)},
		{key: "body", value: append([]byte(nil), control.Body...)},
	}
	if includeSignature {
		entries = append(entries, cborEntry{key: "signature", value: append([]byte(nil), control.Signature...)})
	}
	return cborMapValue{entries: entries}
}

func applicationControlSignature(mapValue cborMapValue) ([]byte, error) {
	value, err := cborRequired(mapValue, "signature")
	if err != nil {
		return nil, err
	}
	signature, ok := value.([]byte)
	if !ok || len(signature) != 0 && len(signature) != 64 {
		return nil, errors.New("invalid_signature")
	}
	return append([]byte(nil), signature...), nil
}
