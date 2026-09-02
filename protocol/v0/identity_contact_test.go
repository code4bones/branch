package v0

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBranchIDFromPublicKeyIsSelfCertifying(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	branchID, err := BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	if !strings.HasPrefix(branchID, BranchIDPrefix) {
		t.Fatalf("branch id = %q", branchID)
	}
	if err := ParseBranchID(branchID); err != nil {
		t.Fatalf("parse branch id: %v", err)
	}
}

func TestCreateIdentityContactWrapperRequiresIdentitySigner(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	relayPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate relay key: %v", err)
	}

	wrapper, err := CreateIdentityContactWrapper(IdentityContactOptions{
		NowUnix:         time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix(),
		ExpiresAtUnix:   time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC).Unix(),
		SenderPublicKey: publicKey,
		DisplayName:     "Alice Branch",
		Aliases:         []string{"alice.dev", "alice"},
		RouteHints: []IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay01.undoo.ru:443/relay/v0",
			RelayPublicKey:   rawBase64URL(relayPublicKey),
			ProfileMultihash: DevelopmentProfileMultihash,
			Priority:         0,
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

func TestCreateIdentityContactWrapperRejectsInvalidPublicFields(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	tests := []struct {
		name    string
		options IdentityContactOptions
	}{
		{
			name: "invalid alias authority-like value",
			options: IdentityContactOptions{
				Aliases: []string{"github.com/code4bones"},
			},
		},
		{
			name: "route without explicit port",
			options: IdentityContactOptions{
				RouteHints: []IdentityContactRouteHint{{
					Transport:        "wss",
					URI:              "wss://relay01.undoo.ru/relay/v0",
					RelayPublicKey:   rawBase64URL(publicKey),
					ProfileMultihash: DevelopmentProfileMultihash,
					Priority:         0,
				}},
			},
		},
		{
			name: "invalid relay key",
			options: IdentityContactOptions{
				RouteHints: []IdentityContactRouteHint{{
					Transport:        "wss",
					URI:              "wss://relay01.undoo.ru:443/relay/v0",
					RelayPublicKey:   "bad-key",
					ProfileMultihash: DevelopmentProfileMultihash,
					Priority:         0,
				}},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := test.options
			options.NowUnix = time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix()
			options.ExpiresAtUnix = time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC).Unix()
			options.SenderPublicKey = publicKey
			options.Sign = func(message []byte) ([]byte, error) {
				return ed25519.Sign(privateKey, message), nil
			}

			_, err := CreateIdentityContactWrapper(options)
			if !errors.Is(err, ErrInvalidIdentityContact) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestValidateBranchTextIdentityContactAcceptsSignedRecord(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix()
	wrapper := createTestIdentityContactWrapper(t, testIdentityContactOptions{
		now:      now,
		expires:  now + int64(time.Hour.Seconds()),
		sequence: 7,
	})

	result := ValidateBranchTextIdentityContact(wrapper, IdentityContactValidationOptions{
		NowUnix: now,
	})
	if !result.Accepted || result.Reason != IdentityContactAccepted {
		t.Fatalf("result = %+v", result)
	}
	if result.Contact == nil {
		t.Fatal("missing validated contact")
	}
	if result.Contact.Payload.Sequence != 7 {
		t.Fatalf("sequence = %d", result.Contact.Payload.Sequence)
	}
	if result.Contact.Payload.BranchID == "" {
		t.Fatal("missing branch id")
	}
	if len(result.Contact.Payload.RouteHints) != 1 {
		t.Fatalf("route hints = %d", len(result.Contact.Payload.RouteHints))
	}
}

func TestValidateBranchTextIdentityContactRejectsTamperedSignature(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix()
	wrapper := createTestIdentityContactWrapper(t, testIdentityContactOptions{
		now:     now,
		expires: now + int64(time.Hour.Seconds()),
	})
	tampered := tamperIdentityContactSignature(t, wrapper)

	result := ValidateBranchTextIdentityContact(tampered, IdentityContactValidationOptions{
		NowUnix: now,
	})
	if result.Accepted || result.Reason != IdentityContactSignatureInvalid {
		t.Fatalf("result = %+v", result)
	}
}

func TestValidateBranchTextIdentityContactRejectsTemporalAndSequenceFailures(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix()
	tests := []struct {
		name    string
		wrapper string
		options IdentityContactValidationOptions
		reason  IdentityContactValidationReason
	}{
		{
			name: "expired",
			wrapper: createTestIdentityContactWrapper(t, testIdentityContactOptions{
				now:     now - int64((2 * time.Hour).Seconds()),
				expires: now - int64(time.Hour.Seconds()),
			}),
			options: IdentityContactValidationOptions{NowUnix: now},
			reason:  IdentityContactExpired,
		},
		{
			name: "future",
			wrapper: createTestIdentityContactWrapper(t, testIdentityContactOptions{
				now:     now + int64((10 * time.Minute).Seconds()),
				expires: now + int64(time.Hour.Seconds()),
			}),
			options: IdentityContactValidationOptions{NowUnix: now},
			reason:  IdentityContactCreatedInFuture,
		},
		{
			name: "lower sequence",
			wrapper: createTestIdentityContactWrapper(t, testIdentityContactOptions{
				now:      now,
				expires:  now + int64(time.Hour.Seconds()),
				sequence: 2,
			}),
			options: IdentityContactValidationOptions{NowUnix: now, MinimumSequence: 3},
			reason:  IdentityContactLowerSequence,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := ValidateBranchTextIdentityContact(test.wrapper, test.options)
			if result.Accepted || result.Reason != test.reason {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestValidateBranchTextIdentityContactRejectsBranchIDMismatch(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC).Unix()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	wrapper := createTestIdentityContactWrapper(t, testIdentityContactOptions{
		now:        now,
		expires:    now + int64(time.Hour.Seconds()),
		publicKey:  publicKey,
		privateKey: privateKey,
	})
	otherPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate other key: %v", err)
	}
	otherBranchID, err := BranchIDFromPublicKey(otherPublicKey)
	if err != nil {
		t.Fatalf("other branch id: %v", err)
	}
	mismatched := resignIdentityContactWithBranchID(t, wrapper, privateKey, otherBranchID)

	result := ValidateBranchTextIdentityContact(mismatched, IdentityContactValidationOptions{
		NowUnix: now,
	})
	if result.Accepted || result.Reason != IdentityContactBranchIDMismatch {
		t.Fatalf("result = %+v", result)
	}
}

type testIdentityContactOptions struct {
	now        int64
	expires    int64
	sequence   uint64
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

func createTestIdentityContactWrapper(t *testing.T, options testIdentityContactOptions) string {
	t.Helper()
	publicKey := options.publicKey
	privateKey := options.privateKey
	if publicKey == nil || privateKey == nil {
		var err error
		publicKey, privateKey, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("generate identity key: %v", err)
		}
	}
	relayPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate relay key: %v", err)
	}
	sequence := options.sequence
	if sequence == 0 {
		sequence = 1
	}
	wrapper, err := CreateIdentityContactWrapper(IdentityContactOptions{
		NowUnix:         options.now,
		ExpiresAtUnix:   options.expires,
		Sequence:        sequence,
		SenderPublicKey: publicKey,
		Aliases:         []string{"alice"},
		RouteHints: []IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay01.undoo.ru:443/relay/v0",
			RelayPublicKey:   rawBase64URL(relayPublicKey),
			ProfileMultihash: DevelopmentProfileMultihash,
			Priority:         0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, message), nil
		},
	})
	if err != nil {
		t.Fatalf("create test identity contact: %v", err)
	}
	return wrapper
}

func resignIdentityContactWithBranchID(t *testing.T, wrapper string, privateKey ed25519.PrivateKey, branchID string) string {
	t.Helper()
	decoded, err := decodeDeterministicCBOR(decodeTestWrapper(t, wrapper))
	if err != nil {
		t.Fatalf("decode signed wrapper: %v", err)
	}
	envelopeMap, err := cborMap(decoded, "signed_event")
	if err != nil {
		t.Fatalf("read signed envelope: %v", err)
	}
	envelope, reason := readIdentityContactEnvelope(envelopeMap)
	if reason != IdentityContactAccepted {
		t.Fatalf("read identity envelope reason = %s", reason)
	}
	payloadDecoded, err := decodeDeterministicCBOR(envelope.PayloadBytes)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	payloadMap, err := cborMap(payloadDecoded, "payload")
	if err != nil {
		t.Fatalf("read payload map: %v", err)
	}
	payloadEntries := append([]cborEntry(nil), payloadMap.entries...)
	for index, entry := range payloadEntries {
		if entry.key == "branch_id" {
			payloadEntries[index].value = branchID
		}
	}
	envelope.PayloadBytes, err = encodeCborMap(payloadEntries)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	unsigned, err := encodeCborMap(identityUnsignedEnvelopeEntries(envelope))
	if err != nil {
		t.Fatalf("encode unsigned: %v", err)
	}
	envelope.Signature = ed25519.Sign(privateKey, append([]byte(BootstrapSignatureDomain), unsigned...))
	signed, err := encodeCborMap(identitySignedEnvelopeEntries(envelope))
	if err != nil {
		t.Fatalf("encode signed: %v", err)
	}
	return BranchTextWrapperPrefix + base64.RawURLEncoding.EncodeToString(signed)
}

func tamperIdentityContactSignature(t *testing.T, wrapper string) string {
	t.Helper()
	decoded, err := decodeDeterministicCBOR(decodeTestWrapper(t, wrapper))
	if err != nil {
		t.Fatalf("decode signed wrapper: %v", err)
	}
	envelopeMap, err := cborMap(decoded, "signed_event")
	if err != nil {
		t.Fatalf("read signed envelope: %v", err)
	}
	envelope, reason := readIdentityContactEnvelope(envelopeMap)
	if reason != IdentityContactAccepted {
		t.Fatalf("read identity envelope reason = %s", reason)
	}
	envelope.Signature[0] ^= 0x01
	signed, err := encodeCborMap(identitySignedEnvelopeEntries(envelope))
	if err != nil {
		t.Fatalf("encode signed: %v", err)
	}
	return BranchTextWrapperPrefix + base64.RawURLEncoding.EncodeToString(signed)
}

func decodeTestWrapper(t *testing.T, wrapper string) []byte {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(wrapper, BranchTextWrapperPrefix))
	if err != nil {
		t.Fatalf("decode wrapper: %v", err)
	}
	return decoded
}

func rawBase64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}
