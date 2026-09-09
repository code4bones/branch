package v0

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	// RelayAttachmentSchema names the executable draft JSON shape used by the
	// shared same-relay WSS attachment fixtures.
	RelayAttachmentSchema = "branch.relay-attachment/0.draft"

	// RelayProofDomain separates relay attachment proof bytes from signed event
	// envelope signatures. The draft fixtures validate shape only.
	RelayProofDomain = "BRANCH relay attachment v0\n"

	// MaxDraftRelayAttachmentFrameBytes bounds one diagnostic relay frame.
	MaxDraftRelayAttachmentFrameBytes = 64 * 1024

	// MaxDraftRelayCiphertextBytes bounds the base64url beta HPKE sealed
	// payload carried by ENVELOPE. Other attachment strings retain the shared
	// smaller MaxDraftStringBytes bound.
	MaxDraftRelayCiphertextBytes = 8 * 1024

	maxDraftIdentityRecords = 4
	maxDraftIdentityWrapper = 8192

	// RelayForwardLiveRole is the ordinary client attachment role.
	RelayForwardLiveRole = "relay.forward.live/0"
	// RelayFederationLiveRole is the draft relay-to-relay attachment role from
	// D-BRANCH-048. Its HELLO supplies a signed BootstrapBeacon wrapper.
	RelayFederationLiveRole = "relay.federate.live/0.draft"
)

// RelayFrameType names same-relay WSS attachment and live delivery frames.
type RelayFrameType string

const (
	RelayFrameHello        RelayFrameType = "HELLO"
	RelayFrameChallenge    RelayFrameType = "CHALLENGE"
	RelayFrameAuth         RelayFrameType = "AUTH"
	RelayFrameReady        RelayFrameType = "READY"
	RelayFramePresence     RelayFrameType = "PRESENCE"
	RelayFrameHeartbeat    RelayFrameType = "HEARTBEAT"
	RelayFrameLookup       RelayFrameType = "LOOKUP"
	RelayFrameIdentityWant RelayFrameType = "IDENTITY_WANT"
	RelayFrameIdentityHave RelayFrameType = "IDENTITY_HAVE"
	RelayFrameRendezvous   RelayFrameType = "RENDEZVOUS"
	RelayFrameEnvelope     RelayFrameType = "ENVELOPE"
	RelayFrameAck          RelayFrameType = "ACK"
	RelayFrameError        RelayFrameType = "ERROR"
)

var (
	// ErrInvalidRelayAttachmentFrame reports a structurally invalid draft relay
	// attachment frame.
	ErrInvalidRelayAttachmentFrame = errors.New("invalid draft relay attachment frame")

	// ErrOversizedRelayAttachmentFrame reports a draft relay attachment fixture
	// that exceeds the local parsing limit.
	ErrOversizedRelayAttachmentFrame = errors.New("oversized draft relay attachment frame")
)

// DraftRelayAttachmentFrame is the validated envelope returned by the draft
// relay attachment JSON checker.
type DraftRelayAttachmentFrame struct {
	Type RelayFrameType
}

// DecodeDraftRelayAttachmentFrame decodes and validates one executable draft
// JSON frame for the D-BRANCH-034 same-relay WSS vertical slice.
func DecodeDraftRelayAttachmentFrame(data []byte) (DraftRelayAttachmentFrame, error) {
	if len(data) > MaxDraftRelayAttachmentFrameBytes {
		return DraftRelayAttachmentFrame{}, ErrOversizedRelayAttachmentFrame
	}

	frame, err := decodeRawObject(data)
	if err != nil {
		return DraftRelayAttachmentFrame{}, err
	}
	frameType, err := readFrameType(frame)
	if err != nil {
		return DraftRelayAttachmentFrame{}, err
	}
	if err := validateRelayFrame(frameType, frame); err != nil {
		return DraftRelayAttachmentFrame{}, err
	}
	return DraftRelayAttachmentFrame{Type: frameType}, nil
}

// KnownRelayFrameType reports whether frameType is currently listed in the
// executable same-relay WSS draft profile.
func KnownRelayFrameType(frameType RelayFrameType) bool {
	switch frameType {
	case RelayFrameHello,
		RelayFrameChallenge,
		RelayFrameAuth,
		RelayFrameReady,
		RelayFramePresence,
		RelayFrameHeartbeat,
		RelayFrameLookup,
		RelayFrameIdentityWant,
		RelayFrameIdentityHave,
		RelayFrameRendezvous,
		RelayFrameEnvelope,
		RelayFrameAck,
		RelayFrameError:
		return true
	default:
		return false
	}
}

func validateRelayFrame(frameType RelayFrameType, frame map[string]json.RawMessage) error {
	switch frameType {
	case RelayFrameHello:
		return validateHelloFrame(frame)
	case RelayFrameChallenge:
		return validateChallengeFrame(frame)
	case RelayFrameAuth:
		return validateAuthFrame(frame)
	case RelayFrameReady:
		return validateReadyFrame(frame)
	case RelayFramePresence:
		return validatePresenceFrame(frame)
	case RelayFrameHeartbeat:
		return validateHeartbeatFrame(frame)
	case RelayFrameLookup:
		return validateLookupFrame(frame)
	case RelayFrameIdentityWant:
		return validateIdentityWantFrame(frame)
	case RelayFrameIdentityHave:
		return validateIdentityHaveFrame(frame)
	case RelayFrameRendezvous:
		return validateRendezvousFrame(frame)
	case RelayFrameEnvelope:
		return validateEnvelopeFrame(frame)
	case RelayFrameAck:
		return validateAckFrame(frame)
	case RelayFrameError:
		return validateErrorFrame(frame)
	default:
		return fmt.Errorf("%w: unsupported frame type", ErrInvalidRelayAttachmentFrame)
	}
}

func validateHelloFrame(frame map[string]json.RawMessage) error {
	if err := readBase64Field(frame, "client_nonce", 32); err != nil {
		return err
	}
	if _, err := readTimestampField(frame, "client_time"); err != nil {
		return err
	}
	role, err := readStringField(frame, "requested_role")
	if err != nil {
		return err
	}
	switch role {
	case RelayForwardLiveRole:
		if err := rejectUnknownRawKeys(frame, "type", "client_nonce", "client_time", "requested_role", "max_frame_bytes", "offers"); err != nil {
			return err
		}
	case RelayFederationLiveRole:
		if err := rejectUnknownRawKeys(frame, "type", "client_nonce", "client_time", "requested_role", "relay_beacon", "max_frame_bytes", "offers"); err != nil {
			return err
		}
		if err := readBootstrapWrapperField(frame, "relay_beacon"); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: unsupported requested_role", ErrInvalidRelayAttachmentFrame)
	}
	if value, err := readBoundedUintField(frame, "max_frame_bytes", 1, 49152); err != nil {
		return err
	} else if value == 0 {
		return fmt.Errorf("%w: invalid max_frame_bytes", ErrInvalidRelayAttachmentFrame)
	}
	return validateVersionOffers(frame, "offers")
}

func validateChallengeFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "client_nonce", "relay_nonce", "issued_at", "expires_at", "relay_public_key", "selected", "transcript_hash", "relay_proof"); err != nil {
		return err
	}
	for _, key := range []string{"client_nonce", "relay_nonce", "transcript_hash"} {
		if err := readBase64Field(frame, key, 32); err != nil {
			return err
		}
	}
	issuedAt, err := readTimestampField(frame, "issued_at")
	if err != nil {
		return err
	}
	expiresAt, err := readTimestampField(frame, "expires_at")
	if err != nil {
		return err
	}
	if expiresAt <= issuedAt || expiresAt-issuedAt > 60 {
		return fmt.Errorf("%w: frame_replayed", ErrInvalidRelayAttachmentFrame)
	}
	if err := readBase64Field(frame, "relay_public_key", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "relay_proof", 64); err != nil {
		return err
	}
	return validateVersionOffer(readObjectField(frame, "selected"))
}

func validateAuthFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "client_public_key", "client_nonce", "relay_nonce", "transcript_hash", "client_proof"); err != nil {
		return err
	}
	for _, key := range []string{"client_public_key", "client_nonce", "relay_nonce", "transcript_hash"} {
		if err := readBase64Field(frame, key, 32); err != nil {
			return err
		}
	}
	return readBase64Field(frame, "client_proof", 64)
}

func validateReadyFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "route_id", "presence_ttl_seconds", "heartbeat_interval_seconds", "accepted_limits"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "route_id", 16); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "presence_ttl_seconds", 1, 300); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "heartbeat_interval_seconds", 1, 60); err != nil {
		return err
	}
	return validateAcceptedLimits(readObjectField(frame, "accepted_limits"))
}

func validatePresenceFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "route_id", "peer_id", "sequence", "ttl_seconds", "sent_at"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "route_id", 16); err != nil {
		return err
	}
	if err := readBase64Field(frame, "peer_id", 32); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "ttl_seconds", 1, 300); err != nil {
		return err
	}
	_, err := readTimestampField(frame, "sent_at")
	return err
}

func validateHeartbeatFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "sequence", "sent_at"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	_, err := readTimestampField(frame, "sent_at")
	return err
}

func validateLookupFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "peer_id", "sequence"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "peer_id", 32); err != nil {
		return err
	}
	_, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp)
	return err
}

func validateIdentityWantFrame(frame map[string]json.RawMessage) error {
	_, hasRequestID := frame["request_id"]
	_, hasOriginKey := frame["origin_relay_key"]
	if hasRequestID != hasOriginKey {
		return fmt.Errorf("%w: incomplete federation request context", ErrInvalidRelayAttachmentFrame)
	}
	if hasRequestID {
		if err := rejectUnknownRawKeys(frame, "type", "session_id", "branch_id", "sequence", "request_id", "origin_relay_key", "hop_limit"); err != nil {
			return err
		}
		if err := readBase64Field(frame, "request_id", 16); err != nil {
			return err
		}
		if err := readBase64Field(frame, "origin_relay_key", 32); err != nil {
			return err
		}
	} else if err := rejectUnknownRawKeys(frame, "type", "session_id", "branch_id", "sequence", "hop_limit"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	branchID, err := readStringField(frame, "branch_id")
	if err != nil {
		return err
	}
	if err := ParseBranchID(branchID); err != nil {
		return fmt.Errorf("%w: invalid branch_id", ErrInvalidRelayAttachmentFrame)
	}
	if _, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	maxHopLimit := int64(4)
	if hasRequestID {
		maxHopLimit = 1
	}
	_, err = readBoundedUintField(frame, "hop_limit", 0, maxHopLimit)
	return err
}

func validateIdentityHaveFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "branch_id", "sequence", "records"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	branchID, err := readStringField(frame, "branch_id")
	if err != nil {
		return err
	}
	if err := ParseBranchID(branchID); err != nil {
		return fmt.Errorf("%w: invalid branch_id", ErrInvalidRelayAttachmentFrame)
	}
	if _, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	return readIdentityRecordsField(frame, "records")
}

func validateRendezvousFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "route_id", "peer_id", "sequence"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "route_id", 16); err != nil {
		return err
	}
	if err := readBase64Field(frame, "peer_id", 32); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "sequence", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	return nil
}

func validateEnvelopeFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeysOptional(frame, []string{"type", "session_id", "route_id", "origin_route_id", "path_epoch", "stream_id", "delivery_id", "ciphertext", "ack_requested"}, []string{"sender_peer_id"}); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "route_id", 16); err != nil {
		return err
	}
	if err := readBase64Field(frame, "origin_route_id", 16); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "path_epoch", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	if _, err := readBoundedUintField(frame, "stream_id", 0, MaxDraftTimestamp); err != nil {
		return err
	}
	if err := readBase64Field(frame, "delivery_id", 16); err != nil {
		return err
	}
	if err := readBase64StringFieldBounded(frame, "ciphertext", MaxDraftRelayCiphertextBytes); err != nil {
		return err
	}
	if _, ok := frame["sender_peer_id"]; ok {
		if err := readBase64Field(frame, "sender_peer_id", 32); err != nil {
			return err
		}
	}
	_, err := readBoolField(frame, "ack_requested")
	return err
}

func validateAckFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "session_id", "delivery_id", "ack_type", "durable"); err != nil {
		return err
	}
	if err := readBase64Field(frame, "session_id", 32); err != nil {
		return err
	}
	if err := readBase64Field(frame, "delivery_id", 16); err != nil {
		return err
	}
	ackType, err := readStringField(frame, "ack_type")
	if err != nil {
		return err
	}
	switch ackType {
	case "relay.accepted", "relay.forwarded", "peer.received":
	default:
		return fmt.Errorf("%w: invalid ack_type", ErrInvalidRelayAttachmentFrame)
	}
	durable, err := readBoolField(frame, "durable")
	if err != nil {
		return err
	}
	if durable {
		return fmt.Errorf("%w: durable ack forbidden", ErrInvalidRelayAttachmentFrame)
	}
	return nil
}

func validateErrorFrame(frame map[string]json.RawMessage) error {
	if err := rejectUnknownRawKeys(frame, "type", "code", "retryable", "detail"); err != nil {
		return err
	}
	code, err := readStringField(frame, "code")
	if err != nil {
		return err
	}
	if !knownProtocolErrorCode(code) {
		return fmt.Errorf("%w: unknown error code", ErrInvalidRelayAttachmentFrame)
	}
	if _, err := readBoolField(frame, "retryable"); err != nil {
		return err
	}
	if _, ok := frame["detail"]; ok {
		detail, err := readStringField(frame, "detail")
		if err != nil {
			return err
		}
		if len(detail) > 256 {
			return fmt.Errorf("%w: detail too large", ErrInvalidRelayAttachmentFrame)
		}
	}
	return nil
}

func validateVersionOffers(frame map[string]json.RawMessage, key string) error {
	raw, ok := frame[key]
	if !ok {
		return fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var values []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || len(values) == 0 || len(values) > 8 {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	for _, value := range values {
		if err := validateVersionOffer(value); err != nil {
			return err
		}
	}
	return nil
}

func validateVersionOffer(offer map[string]json.RawMessage) error {
	if offer == nil {
		return fmt.Errorf("%w: missing version offer", ErrInvalidRelayAttachmentFrame)
	}
	if err := rejectUnknownRawKeys(offer, "wire_version", "protocol", "profile_multihash", "capabilities", "required_capabilities", "extensions", "required_extensions"); err != nil {
		return err
	}
	if value, err := readBoundedUintField(offer, "wire_version", 0, MaxDraftTimestamp); err != nil {
		return err
	} else if value != 0 {
		return fmt.Errorf("%w: unsupported_version", ErrInvalidRelayAttachmentFrame)
	}
	if protocol, err := readStringField(offer, "protocol"); err != nil {
		return err
	} else if protocol != ProtocolID {
		return fmt.Errorf("%w: unsupported_protocol", ErrInvalidRelayAttachmentFrame)
	}
	profileMultihash, err := readStringField(offer, "profile_multihash")
	if err != nil {
		return err
	}
	if profileMultihash != DevelopmentProfileMultihash {
		return fmt.Errorf("%w: profile_hash_mismatch", ErrInvalidRelayAttachmentFrame)
	}
	capabilities, err := readOrderedUniqueStringArray(offer, "capabilities", 32)
	if err != nil {
		return err
	}
	if !containsString(capabilities, "relay.forward.live/0") {
		return fmt.Errorf("%w: capability_required", ErrInvalidRelayAttachmentFrame)
	}
	for _, key := range []string{"required_capabilities", "extensions", "required_extensions"} {
		if _, err := readOrderedUniqueStringArray(offer, key, 32); err != nil {
			return err
		}
	}
	return nil
}

func validateAcceptedLimits(limits map[string]json.RawMessage) error {
	if limits == nil {
		return fmt.Errorf("%w: missing accepted_limits", ErrInvalidRelayAttachmentFrame)
	}
	if err := rejectUnknownRawKeys(limits, "max_frame_bytes", "max_queue_depth", "max_frames_per_session", "max_bytes_per_session"); err != nil {
		return err
	}
	if _, err := readBoundedUintField(limits, "max_frame_bytes", 1, 49152); err != nil {
		return err
	}
	if _, err := readBoundedUintField(limits, "max_queue_depth", 1, 1024); err != nil {
		return err
	}
	if _, err := readBoundedUintField(limits, "max_frames_per_session", 1, MaxDraftTimestamp); err != nil {
		return err
	}
	_, err := readBoundedUintField(limits, "max_bytes_per_session", 1, MaxDraftTimestamp)
	return err
}

func decodeRawObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidRelayAttachmentFrame, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing data", ErrInvalidRelayAttachmentFrame)
	}
	if value == nil {
		return nil, fmt.Errorf("%w: missing frame", ErrInvalidRelayAttachmentFrame)
	}
	return value, nil
}

func rejectUnknownRawKeys(frame map[string]json.RawMessage, keys ...string) error {
	known := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		known[key] = struct{}{}
		if _, ok := frame[key]; !ok {
			return fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
		}
	}
	for key := range frame {
		if _, ok := known[key]; !ok {
			return fmt.Errorf("%w: unknown %s", ErrInvalidRelayAttachmentFrame, key)
		}
	}
	return nil
}

func rejectUnknownRawKeysOptional(frame map[string]json.RawMessage, required []string, optional []string) error {
	known := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		known[key] = struct{}{}
		if _, ok := frame[key]; !ok {
			return fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
		}
	}
	for _, key := range optional {
		known[key] = struct{}{}
	}
	for key := range frame {
		if _, ok := known[key]; !ok {
			return fmt.Errorf("%w: unknown %s", ErrInvalidRelayAttachmentFrame, key)
		}
	}
	return nil
}

func readFrameType(frame map[string]json.RawMessage) (RelayFrameType, error) {
	value, err := readStringField(frame, "type")
	if err != nil {
		return "", err
	}
	frameType := RelayFrameType(value)
	if !KnownRelayFrameType(frameType) {
		return "", fmt.Errorf("%w: unsupported frame type", ErrInvalidRelayAttachmentFrame)
	}
	return frameType, nil
}

func readObjectField(frame map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw, ok := frame[key]
	if !ok {
		return nil
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func readStringField(frame map[string]json.RawMessage, key string) (string, error) {
	raw, ok := frame[key]
	if !ok {
		return "", fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" || len(value) > MaxDraftStringBytes {
		return "", fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return value, nil
}

func readBoolField(frame map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := frame[key]
	if !ok {
		return false, fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return value, nil
}

func readTimestampField(frame map[string]json.RawMessage, key string) (int64, error) {
	return readBoundedUintField(frame, key, 0, MaxDraftTimestamp)
}

func readBoundedUintField(frame map[string]json.RawMessage, key string, minValue int64, maxValue int64) (int64, error) {
	raw, ok := frame[key]
	if !ok {
		return 0, fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value < minValue || value > maxValue {
		return 0, fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return value, nil
}

func readBase64Field(frame map[string]json.RawMessage, key string, size int) error {
	value, err := readStringField(frame, key)
	if err != nil {
		return err
	}
	if !validBase64URLBytes(value, size) {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return nil
}

func readIdentityRecordsField(frame map[string]json.RawMessage, key string) error {
	raw, ok := frame[key]
	if !ok {
		return fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var records []string
	if err := json.Unmarshal(raw, &records); err != nil || len(records) > maxDraftIdentityRecords {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	for _, record := range records {
		if len(record) == 0 || len([]byte(record)) > maxDraftIdentityWrapper || !strings.HasPrefix(record, BranchTextWrapperPrefix) {
			return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
		}
	}
	return nil
}

func readBootstrapWrapperField(frame map[string]json.RawMessage, key string) error {
	value, err := readStringField(frame, key)
	if err != nil {
		return err
	}
	if len([]byte(value)) > maxDraftIdentityWrapper || !strings.HasPrefix(value, BranchTextWrapperPrefix) {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return nil
}

func readBase64StringField(frame map[string]json.RawMessage, key string) error {
	value, err := readStringField(frame, key)
	if err != nil {
		return err
	}
	if !validBase64URLString(value) {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return nil
}

func readBase64StringFieldBounded(frame map[string]json.RawMessage, key string, maxBytes int) error {
	raw, ok := frame[key]
	if !ok {
		return fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" || len([]byte(value)) > maxBytes {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	if _, err := base64.RawURLEncoding.DecodeString(value); err != nil {
		return fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	return nil
}

func readOrderedUniqueStringArray(frame map[string]json.RawMessage, key string, maxItems int) ([]string, error) {
	raw, ok := frame[key]
	if !ok {
		return nil, fmt.Errorf("%w: missing %s", ErrInvalidRelayAttachmentFrame, key)
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil || len(values) > maxItems {
		return nil, fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
	}
	seen := map[string]struct{}{}
	previous := ""
	for _, value := range values {
		if value == "" || len(value) > MaxDraftStringBytes {
			return nil, fmt.Errorf("%w: invalid %s", ErrInvalidRelayAttachmentFrame, key)
		}
		if _, ok := seen[value]; ok {
			return nil, fmt.Errorf("%w: duplicate %s", ErrInvalidRelayAttachmentFrame, key)
		}
		if value < previous {
			return nil, fmt.Errorf("%w: unordered %s", ErrInvalidRelayAttachmentFrame, key)
		}
		seen[value] = struct{}{}
		previous = value
	}
	return values, nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func knownProtocolErrorCode(code string) bool {
	switch code {
	case "unsupported_version",
		"unsupported_profile",
		"profile_hash_mismatch",
		"required_capability_missing",
		"required_extension_missing",
		"malformed_envelope",
		"signature_invalid",
		"payload_decrypt_failed",
		"frame_too_large",
		"frame_malformed",
		"frame_replayed",
		"authentication_failed",
		"capability_required",
		"capability_expired",
		"capability_revoked",
		"quota_exceeded",
		"peer_unavailable",
		"route_unavailable",
		"migration_rejected",
		"rate_limited",
		"timeout",
		"internal_unavailable":
		return true
	default:
		return false
	}
}
