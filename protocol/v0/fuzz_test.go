package v0

import (
	"os"
	"path/filepath"
	"testing"
)

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
		_, _ = DecodeDraftEnvelope(data)
	})
}
