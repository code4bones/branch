package v0

import (
	"errors"
	"fmt"
)

const (
	// ApplicationCapabilitiesControlKind is an endpoint-only signed
	// application-control kind. It is neither a relay nor connectivity capability.
	ApplicationCapabilitiesControlKind    = "branch.application.capabilities/0.draft"
	MaxApplicationCapabilitiesBytes       = 2048
	MaxApplicationCapabilityIdentifiers   = 16
	MaxApplicationCapabilityIdentifierLen = 96
)

var ErrInvalidApplicationCapabilities = errors.New("invalid application capabilities")

// ApplicationCapabilities is the canonical deterministic-CBOR body of the
// endpoint-only branch.application.capabilities/0.draft control.
type ApplicationCapabilities struct {
	ApplicationVersions      []string
	Kinds                    []string
	MaxInlineBytes           uint64
	AttachmentMode           string
	MaxRelayAttachmentBytes  uint64
	MaxDirectAttachmentBytes uint64
}

// EncodeApplicationCapabilities returns the canonical signed-control body. It
// does not sign, send, retain, or interpret the advertised values as a relay
// authorization.
func EncodeApplicationCapabilities(capabilities ApplicationCapabilities) ([]byte, error) {
	if err := capabilities.Validate(); err != nil {
		return nil, err
	}
	encoded, err := encodeCbor(applicationCapabilitiesMap(capabilities))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	if len(encoded) > MaxApplicationCapabilitiesBytes {
		return nil, ErrInvalidApplicationCapabilities
	}
	return encoded, nil
}

// DecodeApplicationCapabilities accepts only bounded canonical CBOR bodies.
func DecodeApplicationCapabilities(data []byte) (ApplicationCapabilities, error) {
	if len(data) == 0 || len(data) > MaxApplicationCapabilitiesBytes {
		return ApplicationCapabilities{}, ErrInvalidApplicationCapabilities
	}
	value, err := decodeDeterministicCBOR(data)
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	mapValue, err := cborMap(value, "application_capabilities")
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	if err := cborRejectUnknown(mapValue, []string{"application_versions", "kinds", "max_inline_bytes", "attachment_mode", "max_relay_attachment_bytes", "max_direct_attachment_bytes"}); err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	applicationVersions, err := applicationCapabilityIdentifiers(mapValue, "application_versions")
	if err != nil {
		return ApplicationCapabilities{}, err
	}
	kinds, err := applicationCapabilityIdentifiers(mapValue, "kinds")
	if err != nil {
		return ApplicationCapabilities{}, err
	}
	maxInlineBytes, err := cborUint(mapValue, "max_inline_bytes")
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	attachmentMode, err := cborText(mapValue, "attachment_mode")
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	maxRelayAttachmentBytes, err := cborUint(mapValue, "max_relay_attachment_bytes")
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	maxDirectAttachmentBytes, err := cborUint(mapValue, "max_direct_attachment_bytes")
	if err != nil {
		return ApplicationCapabilities{}, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	capabilities := ApplicationCapabilities{
		ApplicationVersions:      applicationVersions,
		Kinds:                    kinds,
		MaxInlineBytes:           maxInlineBytes,
		AttachmentMode:           attachmentMode,
		MaxRelayAttachmentBytes:  maxRelayAttachmentBytes,
		MaxDirectAttachmentBytes: maxDirectAttachmentBytes,
	}
	if err := capabilities.Validate(); err != nil {
		return ApplicationCapabilities{}, err
	}
	return capabilities, nil
}

// Validate checks the clock-free structural requirements of one advertised
// body. Its numeric values are upper bounds, not forwarding promises.
func (capabilities ApplicationCapabilities) Validate() error {
	if err := validateApplicationCapabilityIdentifiers(capabilities.ApplicationVersions); err != nil {
		return err
	}
	if err := validateApplicationCapabilityIdentifiers(capabilities.Kinds); err != nil {
		return err
	}
	if capabilities.MaxInlineBytes > MaxInlineBinaryBytes ||
		capabilities.AttachmentMode != "none" && capabilities.AttachmentMode != "receiver-accept" ||
		capabilities.MaxRelayAttachmentBytes > MaxRelayAttachmentBytes ||
		capabilities.MaxDirectAttachmentBytes > MaxDirectAttachmentBytes {
		return ErrInvalidApplicationCapabilities
	}
	return nil
}

func applicationCapabilitiesMap(capabilities ApplicationCapabilities) cborMapValue {
	return cborMapValue{entries: []cborEntry{
		{key: "application_versions", value: stringArrayValue(capabilities.ApplicationVersions)},
		{key: "kinds", value: stringArrayValue(capabilities.Kinds)},
		{key: "max_inline_bytes", value: capabilities.MaxInlineBytes},
		{key: "attachment_mode", value: capabilities.AttachmentMode},
		{key: "max_relay_attachment_bytes", value: capabilities.MaxRelayAttachmentBytes},
		{key: "max_direct_attachment_bytes", value: capabilities.MaxDirectAttachmentBytes},
	}}
}

func applicationCapabilityIdentifiers(mapValue cborMapValue, key string) ([]string, error) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidApplicationCapabilities, err)
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) > MaxApplicationCapabilityIdentifiers {
		return nil, ErrInvalidApplicationCapabilities
	}
	identifiers := make([]string, 0, len(array.values))
	for _, item := range array.values {
		identifier, ok := item.(string)
		if !ok {
			return nil, ErrInvalidApplicationCapabilities
		}
		identifiers = append(identifiers, identifier)
	}
	if err := validateApplicationCapabilityIdentifiers(identifiers); err != nil {
		return nil, err
	}
	return identifiers, nil
}

func validateApplicationCapabilityIdentifiers(identifiers []string) error {
	if len(identifiers) > MaxApplicationCapabilityIdentifiers {
		return ErrInvalidApplicationCapabilities
	}
	previous := ""
	for index, identifier := range identifiers {
		if !applicationCapabilityIdentifier(identifier) || index > 0 && identifier <= previous {
			return ErrInvalidApplicationCapabilities
		}
		previous = identifier
	}
	return nil
}

func applicationCapabilityIdentifier(value string) bool {
	if len(value) == 0 || len(value) > MaxApplicationCapabilityIdentifierLen {
		return false
	}
	for _, character := range []byte(value) {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}
