package v0

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	BranchTextWrapperPrefix  = "BRANCH0."
	BootstrapSignatureDomain = "BRANCH signed event v0\n"

	DefaultBootstrapLifetime = 7 * 24 * time.Hour
	MaxBootstrapLifetime     = 7 * 24 * time.Hour
	MaxBootstrapEndpoints    = 8
)

var (
	ErrInvalidBootstrapBeacon = errors.New("invalid bootstrap beacon")
	transportPattern          = regexp.MustCompile(`^[a-z][a-z0-9.+-]*$`)
)

type BootstrapRelayEndpoint struct {
	Transport string `json:"transport"`
	URI       string `json:"uri"`
	Priority  uint64 `json:"priority"`
}

type BootstrapBeaconOptions struct {
	NowUnix            int64
	ExpiresAtUnix      int64
	Sequence           uint64
	BeaconID           []byte
	EventID            []byte
	SenderPublicKey    []byte
	RelayEndpoints     []BootstrapRelayEndpoint
	ProtocolVersions   []string
	ProfileMultihashes []string
	RelayCapabilities  []string
	Sign               func([]byte) ([]byte, error)
}

func CreateBootstrapBeaconWrapper(options BootstrapBeaconOptions) (string, error) {
	if options.Sign == nil {
		return "", fmt.Errorf("%w: missing signer", ErrInvalidBootstrapBeacon)
	}
	if len(options.SenderPublicKey) != 32 {
		return "", fmt.Errorf("%w: invalid sender public key", ErrInvalidBootstrapBeacon)
	}
	now := options.NowUnix
	if now == 0 {
		now = time.Now().Unix()
	}
	expiresAt := options.ExpiresAtUnix
	if expiresAt == 0 {
		expiresAt = now + int64(DefaultBootstrapLifetime.Seconds())
	}
	if now < 0 || expiresAt <= now || expiresAt > MaxDraftTimestamp {
		return "", fmt.Errorf("%w: invalid timestamps", ErrInvalidBootstrapBeacon)
	}
	if time.Duration(expiresAt-now)*time.Second > MaxBootstrapLifetime {
		return "", fmt.Errorf("%w: lifetime too large", ErrInvalidBootstrapBeacon)
	}

	beaconID, err := fixedOrRandom(options.BeaconID, 32)
	if err != nil {
		return "", fmt.Errorf("%w: invalid beacon id", ErrInvalidBootstrapBeacon)
	}
	eventID, err := fixedOrRandom(options.EventID, 32)
	if err != nil {
		return "", fmt.Errorf("%w: invalid event id", ErrInvalidBootstrapBeacon)
	}
	endpoints, err := normalizeBootstrapEndpoints(options.RelayEndpoints)
	if err != nil {
		return "", err
	}
	protocolVersions, err := normalizeOrderedTextSet(defaulted(options.ProtocolVersions, []string{ProtocolID}), "protocol_versions")
	if err != nil {
		return "", err
	}
	profileMultihashes, err := normalizeOrderedTextSet(defaulted(options.ProfileMultihashes, []string{DevelopmentProfileMultihash}), "profile_multihashes")
	if err != nil {
		return "", err
	}
	relayCapabilities, err := normalizeOrderedTextSet(defaulted(options.RelayCapabilities, []string{"relay.forward.live/0", "route.relay.wss/0"}), "relay_capabilities")
	if err != nil {
		return "", err
	}

	sequence := options.Sequence
	if sequence == 0 {
		sequence = 1
	}
	payload, err := encodeCborMap([]cborEntry{
		{key: "beacon_id", value: beaconID},
		{key: "sequence", value: sequence},
		{key: "issued_at", value: uint64(now)},
		{key: "expires_at", value: uint64(expiresAt)},
		{key: "protocol_versions", value: stringArrayValue(protocolVersions)},
		{key: "profile_multihashes", value: stringArrayValue(profileMultihashes)},
		{key: "relay_capabilities", value: stringArrayValue(relayCapabilities)},
		{key: "relay_endpoints", value: endpointArrayValue(endpoints)},
	})
	if err != nil {
		return "", err
	}

	unsignedEntries := []cborEntry{
		{key: "protocol", value: ProtocolID},
		{key: "event_id", value: eventID},
		{key: "type", value: string(EventBootstrapBeacon)},
		{key: "sender", value: cborMapValue{entries: []cborEntry{
			{key: "key_alg", value: "ed25519"},
			{key: "public_key", value: append([]byte(nil), options.SenderPublicKey...)},
		}}},
		{key: "created_at", value: uint64(now)},
		{key: "expires_at", value: uint64(expiresAt)},
		{key: "payload_mode", value: string(PayloadModePublic)},
		{key: "payload", value: payload},
		{key: "signature_alg", value: "ed25519"},
	}
	unsigned, err := encodeCborMap(unsignedEntries)
	if err != nil {
		return "", err
	}
	signature, err := options.Sign(append([]byte(BootstrapSignatureDomain), unsigned...))
	if err != nil {
		return "", fmt.Errorf("sign bootstrap beacon: %w", err)
	}
	if len(signature) != 64 {
		return "", fmt.Errorf("%w: invalid signature", ErrInvalidBootstrapBeacon)
	}
	signed, err := encodeCborMap(append(unsignedEntries, cborEntry{key: "signature", value: append([]byte(nil), signature...)}))
	if err != nil {
		return "", err
	}
	if len(signed) > MaxDraftEnvelopeBytes {
		return "", ErrOversizedEnvelope
	}
	return BranchTextWrapperPrefix + base64.RawURLEncoding.EncodeToString(signed), nil
}

func normalizeBootstrapEndpoints(endpoints []BootstrapRelayEndpoint) ([]BootstrapRelayEndpoint, error) {
	if len(endpoints) == 0 || len(endpoints) > MaxBootstrapEndpoints {
		return nil, fmt.Errorf("%w: invalid relay endpoints", ErrInvalidBootstrapBeacon)
	}
	ordered := append([]BootstrapRelayEndpoint(nil), endpoints...)
	slices.SortFunc(ordered, func(left, right BootstrapRelayEndpoint) int {
		if left.Priority != right.Priority {
			if left.Priority < right.Priority {
				return -1
			}
			return 1
		}
		if result := strings.Compare(left.Transport, right.Transport); result != 0 {
			return result
		}
		return strings.Compare(left.URI, right.URI)
	})

	seen := make(map[string]struct{}, len(ordered))
	wssCount := 0
	for _, endpoint := range ordered {
		if len(endpoint.Transport) == 0 || len(endpoint.Transport) > 32 || !transportPattern.MatchString(endpoint.Transport) {
			return nil, fmt.Errorf("%w: invalid relay endpoint transport", ErrInvalidBootstrapBeacon)
		}
		if len(endpoint.URI) == 0 || len([]byte(endpoint.URI)) > 512 {
			return nil, fmt.Errorf("%w: invalid relay endpoint uri", ErrInvalidBootstrapBeacon)
		}
		key := endpoint.Transport + "\x00" + endpoint.URI
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("%w: duplicate relay endpoint", ErrInvalidBootstrapBeacon)
		}
		seen[key] = struct{}{}
		if endpoint.Transport == "wss" {
			if err := validateBootstrapWSSURI(endpoint.URI); err != nil {
				return nil, err
			}
			wssCount++
		}
	}
	if wssCount == 0 {
		return nil, fmt.Errorf("%w: missing wss endpoint", ErrInvalidBootstrapBeacon)
	}
	return ordered, nil
}

func validateBootstrapWSSURI(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "wss" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return fmt.Errorf("%w: invalid wss uri", ErrInvalidBootstrapBeacon)
	}
	portText := parsed.Port()
	port, err := strconv.Atoi(portText)
	if portText == "" || err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("%w: invalid wss port", ErrInvalidBootstrapBeacon)
	}
	return nil
}

func normalizeOrderedTextSet(values []string, name string) ([]string, error) {
	ordered := append([]string(nil), values...)
	slices.Sort(ordered)
	seen := make(map[string]struct{}, len(ordered))
	for _, value := range ordered {
		if len(value) == 0 || len([]byte(value)) > 128 {
			return nil, fmt.Errorf("%w: invalid %s", ErrInvalidBootstrapBeacon, name)
		}
		if _, ok := seen[value]; ok {
			return nil, fmt.Errorf("%w: duplicate %s", ErrInvalidBootstrapBeacon, name)
		}
		seen[value] = struct{}{}
	}
	return ordered, nil
}

func fixedOrRandom(value []byte, size int) ([]byte, error) {
	if value != nil {
		if len(value) != size {
			return nil, ErrInvalidBootstrapBeacon
		}
		return append([]byte(nil), value...), nil
	}
	output := make([]byte, size)
	if _, err := rand.Read(output); err != nil {
		return nil, err
	}
	return output, nil
}

func defaulted(values []string, defaults []string) []string {
	if len(values) == 0 {
		return defaults
	}
	return values
}

type cborEntry struct {
	key   string
	value any
}

type cborMapValue struct {
	entries []cborEntry
}

type cborArrayValue struct {
	values []any
}

func encodeCbor(value any) ([]byte, error) {
	switch typed := value.(type) {
	case bool:
		if typed {
			return []byte{0xf5}, nil
		}
		return []byte{0xf4}, nil
	case uint64:
		return encodeCborHeader(0, typed), nil
	case string:
		return encodeCborBytes(3, []byte(typed)), nil
	case []byte:
		return encodeCborBytes(2, typed), nil
	case cborMapValue:
		return encodeCborMap(typed.entries)
	case cborArrayValue:
		chunks := [][]byte{encodeCborHeader(4, uint64(len(typed.values)))}
		for _, entry := range typed.values {
			encoded, err := encodeCbor(entry)
			if err != nil {
				return nil, err
			}
			chunks = append(chunks, encoded)
		}
		return bytes.Join(chunks, nil), nil
	default:
		return nil, fmt.Errorf("%w: unsupported cbor value", ErrInvalidBootstrapBeacon)
	}
}

func encodeCborMap(entries []cborEntry) ([]byte, error) {
	encoded := make([]encodedCborEntry, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if _, ok := seen[entry.key]; ok {
			return nil, fmt.Errorf("%w: duplicate cbor key", ErrInvalidBootstrapBeacon)
		}
		seen[entry.key] = struct{}{}
		key := encodeCborBytes(3, []byte(entry.key))
		value, err := encodeCbor(entry.value)
		if err != nil {
			return nil, err
		}
		encoded = append(encoded, encodedCborEntry{key: key, value: value})
	}
	slices.SortFunc(encoded, func(left, right encodedCborEntry) int {
		return bytes.Compare(left.key, right.key)
	})
	chunks := [][]byte{encodeCborHeader(5, uint64(len(encoded)))}
	for _, entry := range encoded {
		chunks = append(chunks, entry.key, entry.value)
	}
	return bytes.Join(chunks, nil), nil
}

type encodedCborEntry struct {
	key   []byte
	value []byte
}

func encodeCborBytes(major byte, data []byte) []byte {
	header := encodeCborHeader(major, uint64(len(data)))
	output := make([]byte, 0, len(header)+len(data))
	output = append(output, header...)
	output = append(output, data...)
	return output
}

func encodeCborHeader(major byte, value uint64) []byte {
	prefix := major << 5
	switch {
	case value < 24:
		return []byte{prefix | byte(value)}
	case value <= 0xff:
		return []byte{prefix | 24, byte(value)}
	case value <= 0xffff:
		return []byte{prefix | 25, byte(value >> 8), byte(value)}
	case value <= 0xffffffff:
		return []byte{prefix | 26, byte(value >> 24), byte(value >> 16), byte(value >> 8), byte(value)}
	default:
		return []byte{prefix | 27, byte(value >> 56), byte(value >> 48), byte(value >> 40), byte(value >> 32), byte(value >> 24), byte(value >> 16), byte(value >> 8), byte(value)}
	}
}

func stringArrayValue(values []string) cborArrayValue {
	array := make([]any, 0, len(values))
	for _, value := range values {
		array = append(array, value)
	}
	return cborArrayValue{values: array}
}

func endpointArrayValue(endpoints []BootstrapRelayEndpoint) cborArrayValue {
	array := make([]any, 0, len(endpoints))
	for _, endpoint := range endpoints {
		array = append(array, cborMapValue{entries: []cborEntry{
			{key: "transport", value: endpoint.Transport},
			{key: "uri", value: endpoint.URI},
			{key: "priority", value: endpoint.Priority},
		}})
	}
	return cborArrayValue{values: array}
}
