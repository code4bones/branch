package v0

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"time"
)

const defaultBootstrapBeaconMaxFutureSkew = 5 * time.Minute

// BootstrapBeaconValidationReason is a stable rejection code for public
// bootstrap.beacon records. Carriers are discovery inputs, never trust
// authorities; callers admit a relay candidate only after Accepted is true.
type BootstrapBeaconValidationReason string

const (
	BootstrapBeaconAccepted                 BootstrapBeaconValidationReason = "accepted"
	BootstrapBeaconMalformedWrapper         BootstrapBeaconValidationReason = "malformed_wrapper"
	BootstrapBeaconEnvelopeOversized        BootstrapBeaconValidationReason = "envelope_oversized"
	BootstrapBeaconInvalidBase64URL         BootstrapBeaconValidationReason = "invalid_base64url"
	BootstrapBeaconInvalidCBOR              BootstrapBeaconValidationReason = "invalid_cbor"
	BootstrapBeaconNonCanonicalCBOR         BootstrapBeaconValidationReason = "non_canonical_cbor"
	BootstrapBeaconUnknownField             BootstrapBeaconValidationReason = "unknown_field"
	BootstrapBeaconUnsupportedProtocol      BootstrapBeaconValidationReason = "unsupported_protocol"
	BootstrapBeaconUnsupportedEventType     BootstrapBeaconValidationReason = "unsupported_event_type"
	BootstrapBeaconRecipientTagPresent      BootstrapBeaconValidationReason = "recipient_tag_present"
	BootstrapBeaconInvalidPayloadMode       BootstrapBeaconValidationReason = "invalid_payload_mode"
	BootstrapBeaconInvalidSender            BootstrapBeaconValidationReason = "invalid_sender"
	BootstrapBeaconInvalidSignatureAlg      BootstrapBeaconValidationReason = "invalid_signature_alg"
	BootstrapBeaconSignatureInvalid         BootstrapBeaconValidationReason = "signature_invalid"
	BootstrapBeaconExpired                  BootstrapBeaconValidationReason = "expired"
	BootstrapBeaconCreatedInFuture          BootstrapBeaconValidationReason = "created_in_future"
	BootstrapBeaconPayloadOversized         BootstrapBeaconValidationReason = "payload_oversized"
	BootstrapBeaconPayloadInvalid           BootstrapBeaconValidationReason = "payload_invalid"
	BootstrapBeaconPayloadExpiryMismatch    BootstrapBeaconValidationReason = "payload_expiry_mismatch"
	BootstrapBeaconPayloadIssuedAfterCreate BootstrapBeaconValidationReason = "payload_issued_after_created"
)

// SignedBootstrapBeacon is a validated, public relay provenance record. It is
// not a directory entry and carries no authority over identities or routes.
type SignedBootstrapBeacon struct {
	Wrapper             string
	SignedEventBytes    []byte
	SignatureInputBytes []byte
	Envelope            BootstrapBeaconEnvelope
	Payload             BootstrapBeaconPayload
}

type BootstrapBeaconEnvelope struct {
	Protocol     string
	EventID      []byte
	Type         EventType
	Sender       BootstrapBeaconSender
	CreatedAt    int64
	ExpiresAt    int64
	PayloadMode  PayloadMode
	PayloadBytes []byte
	SignatureAlg string
	Signature    []byte
}

type BootstrapBeaconSender struct {
	KeyAlg    string
	PublicKey []byte
}

type BootstrapBeaconPayload struct {
	BeaconID           []byte
	Sequence           uint64
	IssuedAt           int64
	ExpiresAt          int64
	PreviousBeaconID   []byte
	ProtocolVersions   []string
	ProfileMultihashes []string
	RelayCapabilities  []string
	RelayEndpoints     []BootstrapRelayEndpoint
}

// BootstrapBeaconValidationOptions keeps clock and profile policy outside the
// protocol core. An empty supported-profile list means the development profile.
type BootstrapBeaconValidationOptions struct {
	NowUnix                     int64
	MaxFutureSkew               time.Duration
	SupportedProfileMultihashes []string
}

type BootstrapBeaconValidationResult struct {
	Accepted bool
	Reason   BootstrapBeaconValidationReason
	Beacon   *SignedBootstrapBeacon
}

// ValidateBranchTextBootstrapBeacon validates a BRANCH0 bootstrap.beacon
// wrapper, including deterministic CBOR and its Ed25519 signature.
func ValidateBranchTextBootstrapBeacon(wrapper string, options BootstrapBeaconValidationOptions) BootstrapBeaconValidationResult {
	now := options.NowUnix
	if now == 0 {
		now = time.Now().Unix()
	}
	maxFutureSkew := options.MaxFutureSkew
	if maxFutureSkew == 0 {
		maxFutureSkew = defaultBootstrapBeaconMaxFutureSkew
	}
	supportedProfiles := options.SupportedProfileMultihashes
	if len(supportedProfiles) == 0 {
		supportedProfiles = []string{DevelopmentProfileMultihash}
	}

	if !validBootstrapBranchTextWrapper(wrapper) {
		return rejectBootstrapBeacon(BootstrapBeaconMalformedWrapper)
	}
	signedEventBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(wrapper, BranchTextWrapperPrefix))
	if err != nil {
		return rejectBootstrapBeacon(BootstrapBeaconInvalidBase64URL)
	}
	if len(signedEventBytes) > MaxDraftEnvelopeBytes {
		return rejectBootstrapBeacon(BootstrapBeaconEnvelopeOversized)
	}
	decoded, err := decodeDeterministicCBOR(signedEventBytes)
	if err != nil {
		return rejectBootstrapBeacon(reasonFromBootstrapCBORDecodeError(err))
	}
	envelopeMap, err := cborMap(decoded, "signed_event")
	if err != nil {
		return rejectBootstrapBeacon(BootstrapBeaconInvalidCBOR)
	}
	envelope, reason := readBootstrapBeaconEnvelope(envelopeMap)
	if reason != BootstrapBeaconAccepted {
		return rejectBootstrapBeacon(reason)
	}
	canonicalSigned, err := encodeCborMap(bootstrapBeaconSignedEnvelopeEntries(envelope))
	if err != nil || !bytes.Equal(canonicalSigned, signedEventBytes) {
		return rejectBootstrapBeacon(BootstrapBeaconNonCanonicalCBOR)
	}
	unsignedBytes, err := encodeCborMap(bootstrapBeaconUnsignedEnvelopeEntries(envelope))
	if err != nil {
		return rejectBootstrapBeacon(BootstrapBeaconInvalidCBOR)
	}
	signatureInput := append([]byte(BootstrapSignatureDomain), unsignedBytes...)
	if !ed25519.Verify(ed25519.PublicKey(envelope.Sender.PublicKey), signatureInput, envelope.Signature) {
		return rejectBootstrapBeacon(BootstrapBeaconSignatureInvalid)
	}
	if envelope.ExpiresAt <= now {
		return rejectBootstrapBeacon(BootstrapBeaconExpired)
	}
	if envelope.CreatedAt > now+int64(maxFutureSkew.Seconds()) {
		return rejectBootstrapBeacon(BootstrapBeaconCreatedInFuture)
	}
	payload, reason := readBootstrapBeaconPayload(envelope.PayloadBytes, supportedProfiles)
	if reason != BootstrapBeaconAccepted {
		return rejectBootstrapBeacon(reason)
	}
	if payload.ExpiresAt != envelope.ExpiresAt {
		return rejectBootstrapBeacon(BootstrapBeaconPayloadExpiryMismatch)
	}
	if payload.IssuedAt > envelope.CreatedAt {
		return rejectBootstrapBeacon(BootstrapBeaconPayloadIssuedAfterCreate)
	}
	return BootstrapBeaconValidationResult{
		Accepted: true,
		Reason:   BootstrapBeaconAccepted,
		Beacon: &SignedBootstrapBeacon{
			Wrapper:             wrapper,
			SignedEventBytes:    append([]byte(nil), signedEventBytes...),
			SignatureInputBytes: append([]byte(nil), signatureInput...),
			Envelope:            cloneBootstrapBeaconEnvelope(envelope),
			Payload:             cloneBootstrapBeaconPayload(payload),
		},
	}
}

func readBootstrapBeaconEnvelope(mapValue cborMapValue) (BootstrapBeaconEnvelope, BootstrapBeaconValidationReason) {
	if err := cborRejectUnknown(mapValue, []string{"protocol", "event_id", "type", "sender", "recipient_tag", "created_at", "expires_at", "payload_mode", "payload", "signature_alg", "signature"}); err != nil {
		return BootstrapBeaconEnvelope{}, reasonFromBootstrapCBORReadError(err)
	}
	if cborHas(mapValue, "recipient_tag") {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconRecipientTagPresent
	}
	protocol, err := cborText(mapValue, "protocol")
	if err != nil || protocol != ProtocolID {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconUnsupportedProtocol
	}
	typeText, err := cborText(mapValue, "type")
	if err != nil || typeText != string(EventBootstrapBeacon) {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconUnsupportedEventType
	}
	payloadMode, err := cborText(mapValue, "payload_mode")
	if err != nil || payloadMode != string(PayloadModePublic) {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidPayloadMode
	}
	signatureAlg, err := cborText(mapValue, "signature_alg")
	if err != nil || signatureAlg != "ed25519" {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidSignatureAlg
	}
	senderValue, err := cborRequired(mapValue, "sender")
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidSender
	}
	senderMap, err := cborMap(senderValue, "sender")
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidSender
	}
	sender, reason := readBootstrapBeaconSender(senderMap)
	if reason != BootstrapBeaconAccepted {
		return BootstrapBeaconEnvelope{}, reason
	}
	createdAt, err := cborUint(mapValue, "created_at")
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidCBOR
	}
	expiresAt, err := cborUint(mapValue, "expires_at")
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidCBOR
	}
	if expiresAt <= createdAt {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconExpired
	}
	eventID, err := cborBytes(mapValue, "event_id", 32)
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidCBOR
	}
	payloadBytes, err := cborBytes(mapValue, "payload", 0)
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidCBOR
	}
	signature, err := cborBytes(mapValue, "signature", 64)
	if err != nil {
		return BootstrapBeaconEnvelope{}, BootstrapBeaconInvalidCBOR
	}
	return BootstrapBeaconEnvelope{Protocol: protocol, EventID: eventID, Type: EventType(typeText), Sender: sender, CreatedAt: int64(createdAt), ExpiresAt: int64(expiresAt), PayloadMode: PayloadMode(payloadMode), PayloadBytes: payloadBytes, SignatureAlg: signatureAlg, Signature: signature}, BootstrapBeaconAccepted
}

func readBootstrapBeaconSender(mapValue cborMapValue) (BootstrapBeaconSender, BootstrapBeaconValidationReason) {
	if err := cborRejectUnknown(mapValue, []string{"key_alg", "public_key"}); err != nil {
		return BootstrapBeaconSender{}, BootstrapBeaconInvalidSender
	}
	keyAlg, err := cborText(mapValue, "key_alg")
	if err != nil || keyAlg != "ed25519" {
		return BootstrapBeaconSender{}, BootstrapBeaconInvalidSender
	}
	publicKey, err := cborBytes(mapValue, "public_key", ed25519.PublicKeySize)
	if err != nil {
		return BootstrapBeaconSender{}, BootstrapBeaconInvalidSender
	}
	return BootstrapBeaconSender{KeyAlg: keyAlg, PublicKey: publicKey}, BootstrapBeaconAccepted
}

func readBootstrapBeaconPayload(bytesValue []byte, supportedProfiles []string) (BootstrapBeaconPayload, BootstrapBeaconValidationReason) {
	if len(bytesValue) > maxDecodedCBORBytes {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadOversized
	}
	decoded, err := decodeDeterministicCBOR(bytesValue)
	if err != nil {
		if errors.Is(err, errNonCanonicalCBOR) {
			return BootstrapBeaconPayload{}, BootstrapBeaconNonCanonicalCBOR
		}
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	mapValue, err := cborMap(decoded, "bootstrap_payload")
	if err != nil {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	if err := cborRejectUnknown(mapValue, []string{"beacon_id", "sequence", "issued_at", "expires_at", "previous_beacon_id", "revokes", "protocol_versions", "profile_multihashes", "relay_capabilities", "relay_endpoints", "rendezvous_boards", "mirror_hints", "proofs"}); err != nil {
		return BootstrapBeaconPayload{}, reasonFromBootstrapPayloadReadError(err)
	}
	protocolVersions, reason := readBootstrapOrderedTextSet(mapValue, "protocol_versions", 8)
	if reason != BootstrapBeaconAccepted {
		return BootstrapBeaconPayload{}, reason
	}
	profileMultihashes, reason := readBootstrapOrderedTextSet(mapValue, "profile_multihashes", 8)
	if reason != BootstrapBeaconAccepted {
		return BootstrapBeaconPayload{}, reason
	}
	relayCapabilities, reason := readBootstrapOrderedTextSet(mapValue, "relay_capabilities", 32)
	if reason != BootstrapBeaconAccepted {
		return BootstrapBeaconPayload{}, reason
	}
	if !slices.Contains(protocolVersions, ProtocolID) || !hasSupportedBootstrapProfile(profileMultihashes, supportedProfiles) || !slices.Contains(relayCapabilities, RelayForwardLiveRole) {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	relayEndpoints, reason := readBootstrapRelayEndpoints(mapValue)
	if reason != BootstrapBeaconAccepted {
		return BootstrapBeaconPayload{}, reason
	}
	beaconID, err := cborBytes(mapValue, "beacon_id", 32)
	if err != nil {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	sequence, err := cborUint(mapValue, "sequence")
	if err != nil {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	issuedAt, err := cborUint(mapValue, "issued_at")
	if err != nil {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	expiresAt, err := cborUint(mapValue, "expires_at")
	if err != nil {
		return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
	}
	var previousBeaconID []byte
	if cborHas(mapValue, "previous_beacon_id") {
		previousBeaconID, err = cborBytes(mapValue, "previous_beacon_id", 32)
		if err != nil {
			return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
		}
	}
	for _, key := range []string{"revokes", "rendezvous_boards", "mirror_hints", "proofs"} {
		if cborHas(mapValue, key) {
			value, err := cborRequired(mapValue, key)
			if err != nil || !isBoundedBootstrapPublicValue(value, 0) {
				return BootstrapBeaconPayload{}, BootstrapBeaconPayloadInvalid
			}
		}
	}
	return BootstrapBeaconPayload{BeaconID: beaconID, Sequence: sequence, IssuedAt: int64(issuedAt), ExpiresAt: int64(expiresAt), PreviousBeaconID: previousBeaconID, ProtocolVersions: protocolVersions, ProfileMultihashes: profileMultihashes, RelayCapabilities: relayCapabilities, RelayEndpoints: relayEndpoints}, BootstrapBeaconAccepted
}

func readBootstrapOrderedTextSet(mapValue cborMapValue, key string, maxItems int) ([]string, BootstrapBeaconValidationReason) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return nil, BootstrapBeaconPayloadInvalid
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) == 0 || len(array.values) > maxItems {
		return nil, BootstrapBeaconPayloadInvalid
	}
	values := make([]string, 0, len(array.values))
	seen := make(map[string]struct{}, len(array.values))
	previous := ""
	for _, item := range array.values {
		text, ok := item.(string)
		if !ok || text == "" || len([]byte(text)) > 128 {
			return nil, BootstrapBeaconPayloadInvalid
		}
		if _, exists := seen[text]; exists || text < previous {
			return nil, BootstrapBeaconPayloadInvalid
		}
		seen[text] = struct{}{}
		previous = text
		values = append(values, text)
	}
	return values, BootstrapBeaconAccepted
}

func readBootstrapRelayEndpoints(mapValue cborMapValue) ([]BootstrapRelayEndpoint, BootstrapBeaconValidationReason) {
	value, err := cborRequired(mapValue, "relay_endpoints")
	if err != nil {
		return nil, BootstrapBeaconPayloadInvalid
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) == 0 || len(array.values) > MaxBootstrapEndpoints {
		return nil, BootstrapBeaconPayloadInvalid
	}
	endpoints := make([]BootstrapRelayEndpoint, 0, len(array.values))
	seen := make(map[string]struct{}, len(array.values))
	var previousPriority uint64
	for index, item := range array.values {
		endpointMap, err := cborMap(item, "relay_endpoint")
		if err != nil || cborRejectUnknown(endpointMap, []string{"transport", "uri", "priority"}) != nil {
			return nil, BootstrapBeaconPayloadInvalid
		}
		transport, err := cborText(endpointMap, "transport")
		if err != nil || len([]byte(transport)) > 32 || !transportPattern.MatchString(transport) {
			return nil, BootstrapBeaconPayloadInvalid
		}
		uri, err := cborText(endpointMap, "uri")
		if err != nil || len([]byte(uri)) > 512 {
			return nil, BootstrapBeaconPayloadInvalid
		}
		priority, err := cborUint(endpointMap, "priority")
		if err != nil || (index > 0 && priority < previousPriority) {
			return nil, BootstrapBeaconPayloadInvalid
		}
		previousPriority = priority
		if _, exists := seen[transport+"\x00"+uri]; exists {
			return nil, BootstrapBeaconPayloadInvalid
		}
		seen[transport+"\x00"+uri] = struct{}{}
		if transport == "wss" {
			if err := validateBootstrapWSSURI(uri); err != nil {
				return nil, BootstrapBeaconPayloadInvalid
			}
		}
		endpoints = append(endpoints, BootstrapRelayEndpoint{Transport: transport, URI: uri, Priority: priority})
	}
	if !slices.ContainsFunc(endpoints, func(endpoint BootstrapRelayEndpoint) bool { return endpoint.Transport == "wss" }) {
		return nil, BootstrapBeaconPayloadInvalid
	}
	return endpoints, BootstrapBeaconAccepted
}

func isBoundedBootstrapPublicValue(value any, depth int) bool {
	if depth > 3 {
		return false
	}
	switch typed := value.(type) {
	case uint64:
		return typed <= MaxDraftTimestamp
	case string:
		return typed != "" && len([]byte(typed)) <= MaxDraftStringBytes
	case []byte:
		return len(typed) > 0 && len(typed) <= maxDecodedCBORBytes
	case cborArrayValue:
		if len(typed.values) > 16 {
			return false
		}
		for _, item := range typed.values {
			if !isBoundedBootstrapPublicValue(item, depth+1) {
				return false
			}
		}
		return true
	case cborMapValue:
		if len(typed.entries) > 16 {
			return false
		}
		for _, entry := range typed.entries {
			if entry.key == "" || len([]byte(entry.key)) > MaxDraftStringBytes || !isBoundedBootstrapPublicValue(entry.value, depth+1) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func hasSupportedBootstrapProfile(values []string, supported []string) bool {
	for _, value := range values {
		if slices.Contains(supported, value) {
			return true
		}
	}
	return false
}

func bootstrapBeaconSignedEnvelopeEntries(envelope BootstrapBeaconEnvelope) []cborEntry {
	return append(bootstrapBeaconUnsignedEnvelopeEntries(envelope), cborEntry{key: "signature", value: envelope.Signature})
}

func bootstrapBeaconUnsignedEnvelopeEntries(envelope BootstrapBeaconEnvelope) []cborEntry {
	return []cborEntry{
		{key: "protocol", value: envelope.Protocol},
		{key: "event_id", value: envelope.EventID},
		{key: "type", value: string(envelope.Type)},
		{key: "sender", value: cborMapValue{entries: []cborEntry{{key: "key_alg", value: envelope.Sender.KeyAlg}, {key: "public_key", value: envelope.Sender.PublicKey}}}},
		{key: "created_at", value: uint64(envelope.CreatedAt)},
		{key: "expires_at", value: uint64(envelope.ExpiresAt)},
		{key: "payload_mode", value: string(envelope.PayloadMode)},
		{key: "payload", value: envelope.PayloadBytes},
		{key: "signature_alg", value: envelope.SignatureAlg},
	}
}

func reasonFromBootstrapCBORDecodeError(err error) BootstrapBeaconValidationReason {
	if errors.Is(err, errNonCanonicalCBOR) {
		return BootstrapBeaconNonCanonicalCBOR
	}
	return BootstrapBeaconInvalidCBOR
}

func reasonFromBootstrapCBORReadError(err error) BootstrapBeaconValidationReason {
	if strings.HasPrefix(err.Error(), "unknown_") {
		return BootstrapBeaconUnknownField
	}
	return BootstrapBeaconInvalidCBOR
}

func reasonFromBootstrapPayloadReadError(err error) BootstrapBeaconValidationReason {
	if strings.HasPrefix(err.Error(), "unknown_") {
		return BootstrapBeaconUnknownField
	}
	return BootstrapBeaconPayloadInvalid
}

func rejectBootstrapBeacon(reason BootstrapBeaconValidationReason) BootstrapBeaconValidationResult {
	return BootstrapBeaconValidationResult{Reason: reason}
}

func validBootstrapBranchTextWrapper(value string) bool {
	if !strings.HasPrefix(value, BranchTextWrapperPrefix) || len([]byte(value)) > MaxDraftEnvelopeBytes {
		return false
	}
	encoded := strings.TrimPrefix(value, BranchTextWrapperPrefix)
	if encoded == "" {
		return false
	}
	for _, character := range encoded {
		if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' || character == '_') {
			return false
		}
	}
	return true
}

func cloneBootstrapBeaconEnvelope(envelope BootstrapBeaconEnvelope) BootstrapBeaconEnvelope {
	return BootstrapBeaconEnvelope{Protocol: envelope.Protocol, EventID: append([]byte(nil), envelope.EventID...), Type: envelope.Type, Sender: BootstrapBeaconSender{KeyAlg: envelope.Sender.KeyAlg, PublicKey: append([]byte(nil), envelope.Sender.PublicKey...)}, CreatedAt: envelope.CreatedAt, ExpiresAt: envelope.ExpiresAt, PayloadMode: envelope.PayloadMode, PayloadBytes: append([]byte(nil), envelope.PayloadBytes...), SignatureAlg: envelope.SignatureAlg, Signature: append([]byte(nil), envelope.Signature...)}
}

func cloneBootstrapBeaconPayload(payload BootstrapBeaconPayload) BootstrapBeaconPayload {
	return BootstrapBeaconPayload{BeaconID: append([]byte(nil), payload.BeaconID...), Sequence: payload.Sequence, IssuedAt: payload.IssuedAt, ExpiresAt: payload.ExpiresAt, PreviousBeaconID: append([]byte(nil), payload.PreviousBeaconID...), ProtocolVersions: append([]string(nil), payload.ProtocolVersions...), ProfileMultihashes: append([]string(nil), payload.ProfileMultihashes...), RelayCapabilities: append([]string(nil), payload.RelayCapabilities...), RelayEndpoints: append([]BootstrapRelayEndpoint(nil), payload.RelayEndpoints...)}
}
