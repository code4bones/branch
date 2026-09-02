package v0

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	BranchIDPrefix              = "br1."
	IdentityContactEventType    = EventIdentityAnnounce
	IdentityContactIDDomain     = "BRANCH identity id v0\n"
	DefaultIdentityContactLife  = 7 * 24 * time.Hour
	MaxIdentityContactLifetime  = 7 * 24 * time.Hour
	MaxIdentityContactRouteHint = 8
)

var identityAliasPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,63}$`)

var ErrInvalidIdentityContact = errors.New("invalid identity contact")

type IdentityContactRouteHint struct {
	Transport        string `json:"transport"`
	URI              string `json:"uri"`
	RelayPublicKey   string `json:"relay_public_key"`
	ProfileMultihash string `json:"profile_multihash"`
	Priority         uint64 `json:"priority"`
}

type IdentityContactOptions struct {
	NowUnix            int64
	ExpiresAtUnix      int64
	Sequence           uint64
	ContactID          []byte
	EventID            []byte
	SenderPublicKey    []byte
	DisplayName        string
	Aliases            []string
	RouteHints         []IdentityContactRouteHint
	ProtocolVersions   []string
	ProfileMultihashes []string
	Sign               func([]byte) ([]byte, error)
}

func BranchIDFromPublicKey(publicKey []byte) (string, error) {
	if len(publicKey) != 32 {
		return "", fmt.Errorf("%w: invalid identity public key", ErrInvalidIdentityContact)
	}
	input := append([]byte(IdentityContactIDDomain), publicKey...)
	digest := sha256.Sum256(input)
	multihash := make([]byte, 0, 34)
	multihash = append(multihash, 0x12, 0x20)
	multihash = append(multihash, digest[:]...)
	return BranchIDPrefix + base64.RawURLEncoding.EncodeToString(multihash), nil
}

func ParseBranchID(value string) error {
	if !strings.HasPrefix(value, BranchIDPrefix) {
		return fmt.Errorf("%w: invalid branch id", ErrInvalidIdentityContact)
	}
	multihash, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, BranchIDPrefix))
	if err != nil || len(multihash) != 34 || multihash[0] != 0x12 || multihash[1] != 0x20 {
		return fmt.Errorf("%w: invalid branch id", ErrInvalidIdentityContact)
	}
	return nil
}

func CreateIdentityContactWrapper(options IdentityContactOptions) (string, error) {
	if options.Sign == nil {
		return "", fmt.Errorf("%w: missing signer", ErrInvalidIdentityContact)
	}
	if len(options.SenderPublicKey) != 32 {
		return "", fmt.Errorf("%w: invalid sender public key", ErrInvalidIdentityContact)
	}
	now := options.NowUnix
	if now == 0 {
		now = time.Now().Unix()
	}
	expiresAt := options.ExpiresAtUnix
	if expiresAt == 0 {
		expiresAt = now + int64(DefaultIdentityContactLife.Seconds())
	}
	if now < 0 || expiresAt <= now || expiresAt > MaxDraftTimestamp {
		return "", fmt.Errorf("%w: invalid timestamps", ErrInvalidIdentityContact)
	}
	if time.Duration(expiresAt-now)*time.Second > MaxIdentityContactLifetime {
		return "", fmt.Errorf("%w: lifetime too large", ErrInvalidIdentityContact)
	}

	contactID, err := fixedOrRandom(options.ContactID, 32)
	if err != nil {
		return "", fmt.Errorf("%w: invalid contact id", ErrInvalidIdentityContact)
	}
	eventID, err := fixedOrRandom(options.EventID, 32)
	if err != nil {
		return "", fmt.Errorf("%w: invalid event id", ErrInvalidIdentityContact)
	}
	branchID, err := BranchIDFromPublicKey(options.SenderPublicKey)
	if err != nil {
		return "", err
	}
	aliases, err := normalizeIdentityAliases(options.Aliases)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidIdentityContact, err)
	}
	routeHints, err := normalizeIdentityRouteHints(options.RouteHints)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidIdentityContact, err)
	}
	protocolVersions, err := normalizeOrderedTextSet(defaulted(options.ProtocolVersions, []string{ProtocolID}), "protocol_versions")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidIdentityContact, err)
	}
	profileMultihashes, err := normalizeOrderedTextSet(defaulted(options.ProfileMultihashes, []string{DevelopmentProfileMultihash}), "profile_multihashes")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidIdentityContact, err)
	}

	sequence := options.Sequence
	if sequence == 0 {
		sequence = 1
	}
	payloadEntries := []cborEntry{
		{key: "contact_id", value: contactID},
		{key: "branch_id", value: branchID},
		{key: "sequence", value: sequence},
		{key: "issued_at", value: uint64(now)},
		{key: "expires_at", value: uint64(expiresAt)},
		{key: "aliases", value: stringArrayValue(aliases)},
		{key: "protocol_versions", value: stringArrayValue(protocolVersions)},
		{key: "profile_multihashes", value: stringArrayValue(profileMultihashes)},
		{key: "route_hints", value: identityRouteHintArrayValue(routeHints)},
	}
	if options.DisplayName != "" {
		if len([]byte(options.DisplayName)) > 96 {
			return "", fmt.Errorf("%w: invalid display name", ErrInvalidIdentityContact)
		}
		payloadEntries = append(payloadEntries, cborEntry{key: "display_name", value: options.DisplayName})
	}
	payload, err := encodeCborMap(payloadEntries)
	if err != nil {
		return "", err
	}

	unsignedEntries := []cborEntry{
		{key: "protocol", value: ProtocolID},
		{key: "event_id", value: eventID},
		{key: "type", value: string(IdentityContactEventType)},
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
		return "", fmt.Errorf("sign identity contact: %w", err)
	}
	if len(signature) != 64 {
		return "", fmt.Errorf("%w: invalid signature", ErrInvalidIdentityContact)
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

func normalizeIdentityAliases(values []string) ([]string, error) {
	ordered := append([]string(nil), values...)
	for index, value := range ordered {
		ordered[index] = strings.ToLower(strings.TrimSpace(value))
	}
	slices.Sort(ordered)
	if len(ordered) > 8 {
		return nil, fmt.Errorf("%w: too many aliases", ErrInvalidIdentityContact)
	}
	seen := make(map[string]struct{}, len(ordered))
	for _, value := range ordered {
		if len(value) < 2 || len([]byte(value)) > 64 || !identityAliasPattern.MatchString(value) {
			return nil, fmt.Errorf("%w: invalid alias", ErrInvalidIdentityContact)
		}
		if _, ok := seen[value]; ok {
			return nil, fmt.Errorf("%w: duplicate alias", ErrInvalidIdentityContact)
		}
		seen[value] = struct{}{}
	}
	return ordered, nil
}

func normalizeIdentityRouteHints(hints []IdentityContactRouteHint) ([]IdentityContactRouteHint, error) {
	if len(hints) > MaxIdentityContactRouteHint {
		return nil, fmt.Errorf("%w: too many route hints", ErrInvalidIdentityContact)
	}
	ordered := append([]IdentityContactRouteHint(nil), hints...)
	slices.SortFunc(ordered, func(left, right IdentityContactRouteHint) int {
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
	for _, hint := range ordered {
		if len(hint.Transport) == 0 || len(hint.Transport) > 32 || !transportPattern.MatchString(hint.Transport) {
			return nil, fmt.Errorf("%w: invalid route transport", ErrInvalidIdentityContact)
		}
		if len(hint.URI) == 0 || len([]byte(hint.URI)) > 512 {
			return nil, fmt.Errorf("%w: invalid route uri", ErrInvalidIdentityContact)
		}
		if hint.Transport == "wss" {
			if err := validateBootstrapWSSURI(hint.URI); err != nil {
				return nil, err
			}
		}
		if _, err := base64.RawURLEncoding.DecodeString(hint.RelayPublicKey); err != nil {
			return nil, fmt.Errorf("%w: invalid relay public key", ErrInvalidIdentityContact)
		}
		relayPublicKey, err := base64.RawURLEncoding.DecodeString(hint.RelayPublicKey)
		if err != nil || len(relayPublicKey) != 32 {
			return nil, fmt.Errorf("%w: invalid relay public key", ErrInvalidIdentityContact)
		}
		if len(hint.ProfileMultihash) == 0 || len([]byte(hint.ProfileMultihash)) > 128 {
			return nil, fmt.Errorf("%w: invalid profile multihash", ErrInvalidIdentityContact)
		}
		key := hint.Transport + "\x00" + hint.URI + "\x00" + hint.RelayPublicKey
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("%w: duplicate route hint", ErrInvalidIdentityContact)
		}
		seen[key] = struct{}{}
	}
	return ordered, nil
}

func identityRouteHintArrayValue(hints []IdentityContactRouteHint) cborArrayValue {
	array := make([]any, 0, len(hints))
	for _, hint := range hints {
		array = append(array, cborMapValue{entries: []cborEntry{
			{key: "transport", value: hint.Transport},
			{key: "uri", value: hint.URI},
			{key: "relay_public_key", value: hint.RelayPublicKey},
			{key: "profile_multihash", value: hint.ProfileMultihash},
			{key: "priority", value: hint.Priority},
		}})
	}
	return cborArrayValue{values: array}
}
