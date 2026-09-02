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

const defaultIdentityContactMaxFutureSkew = 5 * time.Minute

// IdentityContactValidationReason is a stable rejection code for public
// identity.announce source records.
type IdentityContactValidationReason string

const (
	IdentityContactAccepted                 IdentityContactValidationReason = "accepted"
	IdentityContactMalformedWrapper         IdentityContactValidationReason = "malformed_wrapper"
	IdentityContactEnvelopeOversized        IdentityContactValidationReason = "envelope_oversized"
	IdentityContactInvalidBase64URL         IdentityContactValidationReason = "invalid_base64url"
	IdentityContactInvalidCBOR              IdentityContactValidationReason = "invalid_cbor"
	IdentityContactNonCanonicalCBOR         IdentityContactValidationReason = "non_canonical_cbor"
	IdentityContactUnknownField             IdentityContactValidationReason = "unknown_field"
	IdentityContactUnsupportedProtocol      IdentityContactValidationReason = "unsupported_protocol"
	IdentityContactUnsupportedEventType     IdentityContactValidationReason = "unsupported_event_type"
	IdentityContactRecipientTagPresent      IdentityContactValidationReason = "recipient_tag_present"
	IdentityContactInvalidPayloadMode       IdentityContactValidationReason = "invalid_payload_mode"
	IdentityContactInvalidSender            IdentityContactValidationReason = "invalid_sender"
	IdentityContactInvalidSignatureAlg      IdentityContactValidationReason = "invalid_signature_alg"
	IdentityContactSignatureInvalid         IdentityContactValidationReason = "signature_invalid"
	IdentityContactExpired                  IdentityContactValidationReason = "expired"
	IdentityContactCreatedInFuture          IdentityContactValidationReason = "created_in_future"
	IdentityContactPayloadOversized         IdentityContactValidationReason = "payload_oversized"
	IdentityContactPayloadInvalid           IdentityContactValidationReason = "payload_invalid"
	IdentityContactPayloadExpiryMismatch    IdentityContactValidationReason = "payload_expiry_mismatch"
	IdentityContactPayloadIssuedAfterCreate IdentityContactValidationReason = "payload_issued_after_created"
	IdentityContactInvalidBranchID          IdentityContactValidationReason = "invalid_branch_id"
	IdentityContactBranchIDMismatch         IdentityContactValidationReason = "branch_id_mismatch"
	IdentityContactLowerSequence            IdentityContactValidationReason = "lower_sequence"
)

// SignedIdentityContact is a validated identity.announce source record.
type SignedIdentityContact struct {
	Wrapper             string
	SignedEventBytes    []byte
	SignatureInputBytes []byte
	Envelope            IdentityContactEnvelope
	Payload             IdentityContactPayload
}

// IdentityContactEnvelope is the validated signed-event envelope around an
// IdentityContact public payload.
type IdentityContactEnvelope struct {
	Protocol     string
	EventID      []byte
	Type         EventType
	Sender       IdentityContactSender
	CreatedAt    int64
	ExpiresAt    int64
	PayloadMode  PayloadMode
	PayloadBytes []byte
	SignatureAlg string
	Signature    []byte
}

// IdentityContactSender identifies the root identity key that signed the
// contact record.
type IdentityContactSender struct {
	KeyAlg    string
	PublicKey []byte
}

// IdentityContactPayload is the public payload inside an identity.announce
// record. It contains no private keys, bearer tokens, user messages, or account
// ownership claims.
type IdentityContactPayload struct {
	ContactID          []byte
	BranchID           string
	Sequence           uint64
	IssuedAt           int64
	ExpiresAt          int64
	DisplayName        string
	Aliases            []string
	ProtocolVersions   []string
	ProfileMultihashes []string
	RouteHints         []IdentityContactRouteHint
}

// IdentityContactValidationOptions controls deterministic validation. Wall
// clock policy is passed in by callers so protocol-core remains testable.
type IdentityContactValidationOptions struct {
	NowUnix                     int64
	MaxFutureSkew               time.Duration
	SupportedProfileMultihashes []string
	MinimumSequence             uint64
}

// IdentityContactValidationResult returns either a validated contact or a
// stable rejection reason.
type IdentityContactValidationResult struct {
	Accepted bool
	Reason   IdentityContactValidationReason
	Contact  *SignedIdentityContact
}

// ValidateBranchTextIdentityContact validates one BRANCH0. identity.announce
// wrapper and verifies the Ed25519 signature over the deterministic unsigned
// CBOR envelope.
func ValidateBranchTextIdentityContact(wrapper string, options IdentityContactValidationOptions) IdentityContactValidationResult {
	now := options.NowUnix
	if now == 0 {
		now = time.Now().Unix()
	}
	maxFutureSkew := options.MaxFutureSkew
	if maxFutureSkew == 0 {
		maxFutureSkew = defaultIdentityContactMaxFutureSkew
	}
	supportedProfiles := options.SupportedProfileMultihashes
	if len(supportedProfiles) == 0 {
		supportedProfiles = []string{DevelopmentProfileMultihash}
	}

	if !strings.HasPrefix(wrapper, BranchTextWrapperPrefix) {
		return rejectIdentityContact(IdentityContactMalformedWrapper)
	}
	signedEventBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(wrapper, BranchTextWrapperPrefix))
	if err != nil {
		return rejectIdentityContact(IdentityContactInvalidBase64URL)
	}
	if len(signedEventBytes) > MaxDraftEnvelopeBytes {
		return rejectIdentityContact(IdentityContactEnvelopeOversized)
	}

	decoded, err := decodeDeterministicCBOR(signedEventBytes)
	if err != nil {
		return rejectIdentityContact(reasonFromCBORDecodeError(err))
	}
	envelopeMap, err := cborMap(decoded, "signed_event")
	if err != nil {
		return rejectIdentityContact(IdentityContactInvalidCBOR)
	}
	envelope, reason := readIdentityContactEnvelope(envelopeMap)
	if reason != IdentityContactAccepted {
		return rejectIdentityContact(reason)
	}
	canonicalSigned, err := encodeCborMap(identitySignedEnvelopeEntries(envelope))
	if err != nil || !bytes.Equal(canonicalSigned, signedEventBytes) {
		return rejectIdentityContact(IdentityContactNonCanonicalCBOR)
	}

	unsignedBytes, err := encodeCborMap(identityUnsignedEnvelopeEntries(envelope))
	if err != nil {
		return rejectIdentityContact(IdentityContactInvalidCBOR)
	}
	signatureInput := append([]byte(BootstrapSignatureDomain), unsignedBytes...)
	if !ed25519.Verify(ed25519.PublicKey(envelope.Sender.PublicKey), signatureInput, envelope.Signature) {
		return rejectIdentityContact(IdentityContactSignatureInvalid)
	}
	if envelope.ExpiresAt <= now {
		return rejectIdentityContact(IdentityContactExpired)
	}
	if envelope.CreatedAt > now+int64(maxFutureSkew.Seconds()) {
		return rejectIdentityContact(IdentityContactCreatedInFuture)
	}

	payload, reason := readIdentityContactPayload(envelope.PayloadBytes, supportedProfiles)
	if reason != IdentityContactAccepted {
		return rejectIdentityContact(reason)
	}
	if payload.ExpiresAt != envelope.ExpiresAt {
		return rejectIdentityContact(IdentityContactPayloadExpiryMismatch)
	}
	if payload.IssuedAt > envelope.CreatedAt {
		return rejectIdentityContact(IdentityContactPayloadIssuedAfterCreate)
	}
	if options.MinimumSequence > 0 && payload.Sequence < options.MinimumSequence {
		return rejectIdentityContact(IdentityContactLowerSequence)
	}
	expectedBranchID, err := BranchIDFromPublicKey(envelope.Sender.PublicKey)
	if err != nil {
		return rejectIdentityContact(IdentityContactInvalidSender)
	}
	if payload.BranchID != expectedBranchID {
		return rejectIdentityContact(IdentityContactBranchIDMismatch)
	}

	contact := &SignedIdentityContact{
		Wrapper:             wrapper,
		SignedEventBytes:    append([]byte(nil), signedEventBytes...),
		SignatureInputBytes: append([]byte(nil), signatureInput...),
		Envelope:            cloneIdentityEnvelope(envelope),
		Payload:             cloneIdentityPayload(payload),
	}
	return IdentityContactValidationResult{
		Accepted: true,
		Reason:   IdentityContactAccepted,
		Contact:  contact,
	}
}

func readIdentityContactEnvelope(mapValue cborMapValue) (IdentityContactEnvelope, IdentityContactValidationReason) {
	if err := cborRejectUnknown(mapValue, []string{
		"protocol",
		"event_id",
		"type",
		"sender",
		"recipient_tag",
		"created_at",
		"expires_at",
		"payload_mode",
		"payload",
		"signature_alg",
		"signature",
	}); err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if cborHas(mapValue, "recipient_tag") {
		return IdentityContactEnvelope{}, IdentityContactRecipientTagPresent
	}
	protocol, err := cborText(mapValue, "protocol")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if protocol != ProtocolID {
		return IdentityContactEnvelope{}, IdentityContactUnsupportedProtocol
	}
	typeText, err := cborText(mapValue, "type")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if typeText != string(IdentityContactEventType) {
		return IdentityContactEnvelope{}, IdentityContactUnsupportedEventType
	}
	payloadMode, err := cborText(mapValue, "payload_mode")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if payloadMode != string(PayloadModePublic) {
		return IdentityContactEnvelope{}, IdentityContactInvalidPayloadMode
	}
	signatureAlg, err := cborText(mapValue, "signature_alg")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if signatureAlg != "ed25519" {
		return IdentityContactEnvelope{}, IdentityContactInvalidSignatureAlg
	}
	senderValue, err := cborRequired(mapValue, "sender")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	senderMap, err := cborMap(senderValue, "sender")
	if err != nil {
		return IdentityContactEnvelope{}, IdentityContactInvalidSender
	}
	sender, reason := readIdentityContactSender(senderMap)
	if reason != IdentityContactAccepted {
		return IdentityContactEnvelope{}, reason
	}
	createdAt, err := cborUint(mapValue, "created_at")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	expiresAt, err := cborUint(mapValue, "expires_at")
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	if expiresAt <= createdAt {
		return IdentityContactEnvelope{}, IdentityContactExpired
	}
	eventID, err := cborBytes(mapValue, "event_id", 32)
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	payloadBytes, err := cborBytes(mapValue, "payload", 0)
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	signature, err := cborBytes(mapValue, "signature", 64)
	if err != nil {
		return IdentityContactEnvelope{}, reasonFromCBORReadError(err)
	}
	return IdentityContactEnvelope{
		Protocol:     protocol,
		EventID:      eventID,
		Type:         EventType(typeText),
		Sender:       sender,
		CreatedAt:    int64(createdAt),
		ExpiresAt:    int64(expiresAt),
		PayloadMode:  PayloadMode(payloadMode),
		PayloadBytes: payloadBytes,
		SignatureAlg: signatureAlg,
		Signature:    signature,
	}, IdentityContactAccepted
}

func readIdentityContactSender(mapValue cborMapValue) (IdentityContactSender, IdentityContactValidationReason) {
	if err := cborRejectUnknown(mapValue, []string{"key_alg", "public_key"}); err != nil {
		return IdentityContactSender{}, reasonFromCBORReadError(err)
	}
	keyAlg, err := cborText(mapValue, "key_alg")
	if err != nil || keyAlg != "ed25519" {
		return IdentityContactSender{}, IdentityContactInvalidSender
	}
	publicKey, err := cborBytes(mapValue, "public_key", 32)
	if err != nil {
		return IdentityContactSender{}, IdentityContactInvalidSender
	}
	return IdentityContactSender{KeyAlg: keyAlg, PublicKey: publicKey}, IdentityContactAccepted
}

func readIdentityContactPayload(bytesValue []byte, supportedProfiles []string) (IdentityContactPayload, IdentityContactValidationReason) {
	if len(bytesValue) > maxDecodedCBORBytes {
		return IdentityContactPayload{}, IdentityContactPayloadOversized
	}
	decoded, err := decodeDeterministicCBOR(bytesValue)
	if err != nil {
		if errors.Is(err, errNonCanonicalCBOR) {
			return IdentityContactPayload{}, IdentityContactNonCanonicalCBOR
		}
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	mapValue, err := cborMap(decoded, "identity_contact_payload")
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	if err := cborRejectUnknown(mapValue, []string{
		"contact_id",
		"branch_id",
		"sequence",
		"issued_at",
		"expires_at",
		"display_name",
		"aliases",
		"protocol_versions",
		"profile_multihashes",
		"route_hints",
	}); err != nil {
		return IdentityContactPayload{}, reasonFromPayloadReadError(err)
	}
	branchID, err := cborText(mapValue, "branch_id")
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	if err := ParseBranchID(branchID); err != nil {
		return IdentityContactPayload{}, IdentityContactInvalidBranchID
	}
	protocolVersions, reason := readIdentityOrderedTextSet(mapValue, "protocol_versions", 8)
	if reason != IdentityContactAccepted {
		return IdentityContactPayload{}, reason
	}
	profileMultihashes, reason := readIdentityOrderedTextSet(mapValue, "profile_multihashes", 8)
	if reason != IdentityContactAccepted {
		return IdentityContactPayload{}, reason
	}
	if !slices.Contains(protocolVersions, ProtocolID) || !hasSupportedIdentityProfile(profileMultihashes, supportedProfiles) {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	contactID, err := cborBytes(mapValue, "contact_id", 32)
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	sequence, err := cborUint(mapValue, "sequence")
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	issuedAt, err := cborUint(mapValue, "issued_at")
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	expiresAt, err := cborUint(mapValue, "expires_at")
	if err != nil {
		return IdentityContactPayload{}, IdentityContactPayloadInvalid
	}
	displayName := ""
	if cborHas(mapValue, "display_name") {
		displayName, err = cborText(mapValue, "display_name")
		if err != nil || len([]byte(displayName)) > 96 {
			return IdentityContactPayload{}, IdentityContactPayloadInvalid
		}
	}
	aliases, reason := readIdentityAliases(mapValue)
	if reason != IdentityContactAccepted {
		return IdentityContactPayload{}, reason
	}
	routeHints, reason := readIdentityRouteHints(mapValue)
	if reason != IdentityContactAccepted {
		return IdentityContactPayload{}, reason
	}
	return IdentityContactPayload{
		ContactID:          contactID,
		BranchID:           branchID,
		Sequence:           sequence,
		IssuedAt:           int64(issuedAt),
		ExpiresAt:          int64(expiresAt),
		DisplayName:        displayName,
		Aliases:            aliases,
		ProtocolVersions:   protocolVersions,
		ProfileMultihashes: profileMultihashes,
		RouteHints:         routeHints,
	}, IdentityContactAccepted
}

func readIdentityOrderedTextSet(mapValue cborMapValue, key string, maxItems int) ([]string, IdentityContactValidationReason) {
	value, err := cborRequired(mapValue, key)
	if err != nil {
		return nil, IdentityContactPayloadInvalid
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) == 0 || len(array.values) > maxItems {
		return nil, IdentityContactPayloadInvalid
	}
	values := make([]string, 0, len(array.values))
	seen := make(map[string]struct{}, len(array.values))
	previous := ""
	for _, item := range array.values {
		text, ok := item.(string)
		if !ok || text == "" || len([]byte(text)) > 128 {
			return nil, IdentityContactPayloadInvalid
		}
		if _, ok := seen[text]; ok || text < previous {
			return nil, IdentityContactPayloadInvalid
		}
		seen[text] = struct{}{}
		previous = text
		values = append(values, text)
	}
	return values, IdentityContactAccepted
}

func readIdentityAliases(mapValue cborMapValue) ([]string, IdentityContactValidationReason) {
	value, err := cborRequired(mapValue, "aliases")
	if err != nil {
		return nil, IdentityContactPayloadInvalid
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) > 8 {
		return nil, IdentityContactPayloadInvalid
	}
	values := make([]string, 0, len(array.values))
	seen := make(map[string]struct{}, len(array.values))
	previous := ""
	for _, item := range array.values {
		text, ok := item.(string)
		normalized := strings.ToLower(strings.TrimSpace(text))
		if !ok || len(normalized) < 2 || len([]byte(normalized)) > 64 || !identityAliasPattern.MatchString(normalized) {
			return nil, IdentityContactPayloadInvalid
		}
		if _, ok := seen[normalized]; ok || normalized < previous {
			return nil, IdentityContactPayloadInvalid
		}
		seen[normalized] = struct{}{}
		previous = normalized
		values = append(values, normalized)
	}
	return values, IdentityContactAccepted
}

func readIdentityRouteHints(mapValue cborMapValue) ([]IdentityContactRouteHint, IdentityContactValidationReason) {
	value, err := cborRequired(mapValue, "route_hints")
	if err != nil {
		return nil, IdentityContactPayloadInvalid
	}
	array, ok := value.(cborArrayValue)
	if !ok || len(array.values) > MaxIdentityContactRouteHint {
		return nil, IdentityContactPayloadInvalid
	}
	routeHints := make([]IdentityContactRouteHint, 0, len(array.values))
	seen := make(map[string]struct{}, len(array.values))
	var previousPriority uint64
	for index, item := range array.values {
		hintMap, err := cborMap(item, "route_hint")
		if err != nil {
			return nil, IdentityContactPayloadInvalid
		}
		if err := cborRejectUnknown(hintMap, []string{"transport", "uri", "relay_public_key", "profile_multihash", "priority"}); err != nil {
			return nil, IdentityContactPayloadInvalid
		}
		transport, err := cborText(hintMap, "transport")
		if err != nil || len([]byte(transport)) > 32 || !transportPattern.MatchString(transport) {
			return nil, IdentityContactPayloadInvalid
		}
		uri, err := cborText(hintMap, "uri")
		if err != nil || len([]byte(uri)) > 512 {
			return nil, IdentityContactPayloadInvalid
		}
		if transport == "wss" {
			if err := validateBootstrapWSSURI(uri); err != nil {
				return nil, IdentityContactPayloadInvalid
			}
		}
		relayPublicKey, err := cborText(hintMap, "relay_public_key")
		if err != nil {
			return nil, IdentityContactPayloadInvalid
		}
		relayKeyBytes, err := base64.RawURLEncoding.DecodeString(relayPublicKey)
		if err != nil || len(relayKeyBytes) != 32 {
			return nil, IdentityContactPayloadInvalid
		}
		profileMultihash, err := cborText(hintMap, "profile_multihash")
		if err != nil || len([]byte(profileMultihash)) > 128 {
			return nil, IdentityContactPayloadInvalid
		}
		priority, err := cborUint(hintMap, "priority")
		if err != nil {
			return nil, IdentityContactPayloadInvalid
		}
		if index > 0 && priority < previousPriority {
			return nil, IdentityContactPayloadInvalid
		}
		previousPriority = priority
		duplicateKey := transport + "\x00" + uri + "\x00" + relayPublicKey
		if _, ok := seen[duplicateKey]; ok {
			return nil, IdentityContactPayloadInvalid
		}
		seen[duplicateKey] = struct{}{}
		routeHints = append(routeHints, IdentityContactRouteHint{
			Transport:        transport,
			URI:              uri,
			RelayPublicKey:   relayPublicKey,
			ProfileMultihash: profileMultihash,
			Priority:         priority,
		})
	}
	return routeHints, IdentityContactAccepted
}

func hasSupportedIdentityProfile(values []string, supported []string) bool {
	for _, value := range values {
		if slices.Contains(supported, value) {
			return true
		}
	}
	return false
}

func identitySignedEnvelopeEntries(envelope IdentityContactEnvelope) []cborEntry {
	return append(identityUnsignedEnvelopeEntries(envelope), cborEntry{key: "signature", value: envelope.Signature})
}

func identityUnsignedEnvelopeEntries(envelope IdentityContactEnvelope) []cborEntry {
	return []cborEntry{
		{key: "protocol", value: envelope.Protocol},
		{key: "event_id", value: envelope.EventID},
		{key: "type", value: string(envelope.Type)},
		{key: "sender", value: cborMapValue{entries: []cborEntry{
			{key: "key_alg", value: envelope.Sender.KeyAlg},
			{key: "public_key", value: envelope.Sender.PublicKey},
		}}},
		{key: "created_at", value: uint64(envelope.CreatedAt)},
		{key: "expires_at", value: uint64(envelope.ExpiresAt)},
		{key: "payload_mode", value: string(envelope.PayloadMode)},
		{key: "payload", value: envelope.PayloadBytes},
		{key: "signature_alg", value: envelope.SignatureAlg},
	}
}

func reasonFromCBORDecodeError(err error) IdentityContactValidationReason {
	if errors.Is(err, errNonCanonicalCBOR) {
		return IdentityContactNonCanonicalCBOR
	}
	return IdentityContactInvalidCBOR
}

func reasonFromCBORReadError(err error) IdentityContactValidationReason {
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "unknown_"):
		return IdentityContactUnknownField
	case strings.HasPrefix(message, "missing_"), strings.HasPrefix(message, "invalid_"):
		return IdentityContactInvalidCBOR
	default:
		return IdentityContactInvalidCBOR
	}
}

func reasonFromPayloadReadError(err error) IdentityContactValidationReason {
	if strings.HasPrefix(err.Error(), "unknown_") {
		return IdentityContactUnknownField
	}
	return IdentityContactPayloadInvalid
}

func rejectIdentityContact(reason IdentityContactValidationReason) IdentityContactValidationResult {
	return IdentityContactValidationResult{Reason: reason}
}

func cloneIdentityEnvelope(envelope IdentityContactEnvelope) IdentityContactEnvelope {
	return IdentityContactEnvelope{
		Protocol:     envelope.Protocol,
		EventID:      append([]byte(nil), envelope.EventID...),
		Type:         envelope.Type,
		Sender:       IdentityContactSender{KeyAlg: envelope.Sender.KeyAlg, PublicKey: append([]byte(nil), envelope.Sender.PublicKey...)},
		CreatedAt:    envelope.CreatedAt,
		ExpiresAt:    envelope.ExpiresAt,
		PayloadMode:  envelope.PayloadMode,
		PayloadBytes: append([]byte(nil), envelope.PayloadBytes...),
		SignatureAlg: envelope.SignatureAlg,
		Signature:    append([]byte(nil), envelope.Signature...),
	}
}

func cloneIdentityPayload(payload IdentityContactPayload) IdentityContactPayload {
	return IdentityContactPayload{
		ContactID:          append([]byte(nil), payload.ContactID...),
		BranchID:           payload.BranchID,
		Sequence:           payload.Sequence,
		IssuedAt:           payload.IssuedAt,
		ExpiresAt:          payload.ExpiresAt,
		DisplayName:        payload.DisplayName,
		Aliases:            append([]string(nil), payload.Aliases...),
		ProtocolVersions:   append([]string(nil), payload.ProtocolVersions...),
		ProfileMultihashes: append([]string(nil), payload.ProfileMultihashes...),
		RouteHints:         append([]IdentityContactRouteHint(nil), payload.RouteHints...),
	}
}
