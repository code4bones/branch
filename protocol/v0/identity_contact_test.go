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

func rawBase64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}
