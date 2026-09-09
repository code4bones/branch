package v0

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateBootstrapBeaconWrapperRequiresRelayOwnedSigner(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	wrapper, err := CreateBootstrapBeaconWrapper(BootstrapBeaconOptions{
		NowUnix:         time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC).Unix(),
		ExpiresAtUnix:   time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix(),
		SenderPublicKey: publicKey,
		RelayEndpoints: []BootstrapRelayEndpoint{{
			Transport: "wss",
			URI:       "wss://branch.undoo.ru:443/relay/v0",
			Priority:  0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, message), nil
		},
	})
	if err != nil {
		t.Fatalf("create wrapper: %v", err)
	}
	if !strings.HasPrefix(wrapper, BranchTextWrapperPrefix) {
		t.Fatalf("wrapper = %q", wrapper)
	}
}

func TestCreateBootstrapBeaconWrapperRejectsInvalidWSSURI(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	_, err = CreateBootstrapBeaconWrapper(BootstrapBeaconOptions{
		NowUnix:         time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC).Unix(),
		ExpiresAtUnix:   time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix(),
		SenderPublicKey: publicKey,
		RelayEndpoints: []BootstrapRelayEndpoint{{
			Transport: "wss",
			URI:       "wss://branch.undoo.ru/relay/v0",
			Priority:  0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, message), nil
		},
	})
	if !errors.Is(err, ErrInvalidBootstrapBeacon) {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateBranchTextBootstrapBeaconAcceptsSharedVector(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", "bootstrap-beacon-vectors.json"))
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	var fixture struct {
		Valid struct {
			Now     int64  `json:"now"`
			Wrapper string `json:"wrapper"`
		} `json:"valid"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode vector: %v", err)
	}
	result := ValidateBranchTextBootstrapBeacon(fixture.Valid.Wrapper, BootstrapBeaconValidationOptions{NowUnix: fixture.Valid.Now})
	if !result.Accepted || result.Beacon == nil {
		t.Fatalf("result = %+v", result)
	}
	if result.Beacon.Payload.Sequence != 1 || len(result.Beacon.Payload.RelayEndpoints) != 1 {
		t.Fatalf("payload = %+v", result.Beacon.Payload)
	}
}

func TestValidateBranchTextBootstrapBeaconRejectsSignatureAndAdmissionFailures(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	const now = int64(1_789_000_000)
	create := func(capabilities []string) string {
		t.Helper()
		wrapper, err := CreateBootstrapBeaconWrapper(BootstrapBeaconOptions{
			NowUnix:         now,
			ExpiresAtUnix:   now + 3600,
			SenderPublicKey: publicKey,
			RelayEndpoints: []BootstrapRelayEndpoint{{
				Transport: "wss",
				URI:       "wss://relay.example.test:443/relay/v0",
				Priority:  0,
			}},
			RelayCapabilities: capabilities,
			Sign: func(message []byte) ([]byte, error) {
				return ed25519.Sign(privateKey, message), nil
			},
		})
		if err != nil {
			t.Fatalf("create wrapper: %v", err)
		}
		return wrapper
	}

	valid := create(nil)
	encoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(valid, BranchTextWrapperPrefix))
	if err != nil {
		t.Fatalf("decode wrapper: %v", err)
	}
	decoded, err := decodeDeterministicCBOR(encoded)
	if err != nil {
		t.Fatalf("decode cbor: %v", err)
	}
	envelopeMap, err := cborMap(decoded, "signed_event")
	if err != nil {
		t.Fatalf("read envelope: %v", err)
	}
	envelope, reason := readBootstrapBeaconEnvelope(envelopeMap)
	if reason != BootstrapBeaconAccepted {
		t.Fatalf("read envelope reason = %q", reason)
	}
	envelope.Signature[0] ^= 0x01
	tamperedBytes, err := encodeCborMap(bootstrapBeaconSignedEnvelopeEntries(envelope))
	if err != nil {
		t.Fatalf("encode tampered envelope: %v", err)
	}
	tampered := BranchTextWrapperPrefix + base64.RawURLEncoding.EncodeToString(tamperedBytes)
	if result := ValidateBranchTextBootstrapBeacon(tampered, BootstrapBeaconValidationOptions{NowUnix: now}); result.Reason != BootstrapBeaconSignatureInvalid {
		t.Fatalf("tampered reason = %q", result.Reason)
	}
	if result := ValidateBranchTextBootstrapBeacon(valid, BootstrapBeaconValidationOptions{NowUnix: now + 3601}); result.Reason != BootstrapBeaconExpired {
		t.Fatalf("expired reason = %q", result.Reason)
	}
	withoutLiveForward := create([]string{"route.relay.wss/0"})
	if result := ValidateBranchTextBootstrapBeacon(withoutLiveForward, BootstrapBeaconValidationOptions{NowUnix: now}); result.Reason != BootstrapBeaconPayloadInvalid {
		t.Fatalf("missing live-forward reason = %q", result.Reason)
	}
}
