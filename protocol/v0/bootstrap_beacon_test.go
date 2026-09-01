package v0

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
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
