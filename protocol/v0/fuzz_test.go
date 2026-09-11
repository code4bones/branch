package v0

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

var maxFuzzBranchTextWrapperBytes = len(BranchTextWrapperPrefix) + base64.RawURLEncoding.EncodedLen(MaxDraftEnvelopeBytes)

func FuzzDecodeDraftEnvelope(f *testing.F) {
	root := filepath.Join("..", "..", "testdata", "vectors", "protocol-v0")
	fixtures := []string{
		"valid-rendezvous-offer-envelope.json",
		"invalid-protocol-envelope.json",
		filepath.Join("invalid", "unknown-field-envelope.json"),
		filepath.Join("invalid", "missing-recipient-tag-envelope.json"),
		filepath.Join("invalid", "expired-envelope.json"),
		filepath.Join("invalid", "negative-created-at-envelope.json"),
		filepath.Join("invalid", "unsafe-expires-at-envelope.json"),
		filepath.Join("invalid", "trailing-json-envelope.json"),
	}

	for _, fixture := range fixtures {
		data, err := os.ReadFile(filepath.Join(root, fixture))
		if err != nil {
			f.Fatalf("read fixture %s: %v", fixture, err)
		}
		f.Add(data)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxDraftEnvelopeBytes {
			return
		}
		_, _ = DecodeDraftEnvelope(data)
	})
}

func FuzzDecodeDeterministicCBOR(f *testing.F) {
	for _, depth := range []int{MaxDeterministicCBORNestingDepth - 1, MaxDeterministicCBORNestingDepth, MaxDeterministicCBORNestingDepth + 1} {
		encoded, err := encodeCbor(nestedCBORArray(depth))
		if err != nil {
			f.Fatalf("encode nesting seed %d: %v", depth, err)
		}
		f.Add(encoded)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxDraftEnvelopeBytes {
			return
		}
		_, _ = decodeDeterministicCBOR(data)
	})
}

func FuzzValidateBranchTextBootstrapBeacon(f *testing.F) {
	var vector struct {
		Valid struct {
			Wrapper string `json:"wrapper"`
		} `json:"valid"`
	}
	readFuzzJSONFixture(f, "bootstrap-beacon-vectors.json", &vector)
	addFuzzBoundedWrapper(f, vector.Valid.Wrapper)
	addFuzzBoundedWrapper(f, "BRANCH0.invalid=")

	f.Fuzz(func(t *testing.T, wrapper string) {
		if len(wrapper) > maxFuzzBranchTextWrapperBytes {
			return
		}
		_ = ValidateBranchTextBootstrapBeacon(wrapper, BootstrapBeaconValidationOptions{NowUnix: 1_789_000_000})
	})
}

func FuzzValidateBranchTextIdentityContact(f *testing.F) {
	addFuzzBoundedWrapper(f, fuzzIdentityContactWrapper(f))
	addFuzzBoundedWrapper(f, "BRANCH0.invalid=")

	f.Fuzz(func(t *testing.T, wrapper string) {
		if len(wrapper) > maxFuzzBranchTextWrapperBytes {
			return
		}
		_ = ValidateBranchTextIdentityContact(wrapper, IdentityContactValidationOptions{NowUnix: 1_789_000_000})
	})
}

func FuzzDecodeDraftRelayAttachmentFrame(f *testing.F) {
	var vector struct {
		Valid []struct {
			Frame json.RawMessage `json:"frame"`
		} `json:"valid"`
	}
	readFuzzJSONFixture(f, "relay-attachment-vectors.json", &vector)
	for _, entry := range vector.Valid {
		if len(entry.Frame) == 0 || len(entry.Frame) > MaxDraftRelayAttachmentFrameBytes {
			f.Fatalf("relay attachment fuzz seed exceeds frame bound")
		}
		f.Add([]byte(entry.Frame))
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxDraftRelayAttachmentFrameBytes {
			return
		}
		_, _ = DecodeDraftRelayAttachmentFrame(data)
	})
}

func FuzzDecodeContactCard(f *testing.F) {
	var vector struct {
		Valid struct {
			ContactCard struct {
				CanonicalBody string `json:"canonical_body"`
			} `json:"contact_card"`
		} `json:"valid"`
	}
	readFuzzJSONFixture(f, "application-payload-vectors.json", &vector)
	seed, err := base64.RawURLEncoding.DecodeString(vector.Valid.ContactCard.CanonicalBody)
	if err != nil || len(seed) == 0 || len(seed) > MaxContactCardBytes {
		f.Fatalf("invalid bounded contact-card fuzz seed")
	}
	f.Add(seed)
	f.Add(seed[:len(seed)-1])

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxContactCardBytes {
			return
		}
		_, _ = DecodeContactCard(data)
	})
}

func readFuzzJSONFixture(f *testing.F, name string, destination any) {
	f.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", name))
	if err != nil {
		f.Fatalf("read fuzz fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(data, destination); err != nil {
		f.Fatalf("decode fuzz fixture %s: %v", name, err)
	}
}

func addFuzzBoundedWrapper(f *testing.F, wrapper string) {
	f.Helper()
	if len(wrapper) == 0 || len(wrapper) > maxFuzzBranchTextWrapperBytes {
		f.Fatalf("branch text fuzz seed exceeds wrapper bound")
	}
	f.Add(wrapper)
}

func fuzzIdentityContactWrapper(f *testing.F) string {
	f.Helper()
	identitySeed := make([]byte, ed25519.SeedSize)
	relaySeed := make([]byte, ed25519.SeedSize)
	for index := range identitySeed {
		identitySeed[index] = byte(index)
		relaySeed[index] = byte(index + 32)
	}
	privateKey := ed25519.NewKeyFromSeed(identitySeed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	relayPublicKey := ed25519.NewKeyFromSeed(relaySeed).Public().(ed25519.PublicKey)
	wrapper, err := CreateIdentityContactWrapper(IdentityContactOptions{
		NowUnix:         1_789_000_000,
		ExpiresAtUnix:   1_789_003_600,
		SenderPublicKey: publicKey,
		Aliases:         []string{"alice"},
		RouteHints: []IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay.example.test:443/relay/v0",
			RelayPublicKey:   base64.RawURLEncoding.EncodeToString(relayPublicKey),
			ProfileMultihash: DevelopmentProfileMultihash,
			Priority:         0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, message), nil
		},
	})
	if err != nil {
		f.Fatalf("create bounded identity-contact fuzz seed: %v", err)
	}
	return wrapper
}
