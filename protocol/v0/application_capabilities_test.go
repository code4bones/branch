package v0

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type applicationCapabilitiesVectorFile struct {
	Valid struct {
		ApplicationCapabilities applicationCapabilitiesVector `json:"application_capabilities"`
	} `json:"valid"`
	InvalidApplicationCapabilities []applicationCapabilitiesVector `json:"invalid_application_capabilities"`
}

type applicationCapabilitiesVector struct {
	Name                     string   `json:"name"`
	ApplicationVersions      []string `json:"application_versions"`
	Kinds                    []string `json:"kinds"`
	MaxInlineBytes           uint64   `json:"max_inline_bytes"`
	AttachmentMode           string   `json:"attachment_mode"`
	MaxRelayAttachmentBytes  uint64   `json:"max_relay_attachment_bytes"`
	MaxDirectAttachmentBytes uint64   `json:"max_direct_attachment_bytes"`
	CanonicalBody            string   `json:"canonical_body"`
}

func TestApplicationCapabilitiesSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", "application-payload-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors applicationCapabilitiesVectorFile
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	capabilities := applicationCapabilitiesFromVector(vectors.Valid.ApplicationCapabilities)
	encoded, err := EncodeApplicationCapabilities(capabilities)
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(encoded); got != vectors.Valid.ApplicationCapabilities.CanonicalBody {
		t.Fatalf("canonical body = %q", got)
	}
	decoded, err := DecodeApplicationCapabilities(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.AttachmentMode != capabilities.AttachmentMode || decoded.MaxInlineBytes != capabilities.MaxInlineBytes || len(decoded.ApplicationVersions) != len(capabilities.ApplicationVersions) {
		t.Fatal("application capabilities vector changed")
	}
	for _, invalid := range vectors.InvalidApplicationCapabilities {
		if _, err := EncodeApplicationCapabilities(applicationCapabilitiesFromVector(invalid)); !errors.Is(err, ErrInvalidApplicationCapabilities) {
			t.Fatalf("%s: %v", invalid.Name, err)
		}
	}
}

func TestDecodeApplicationCapabilitiesRejectsUnknownAndNonCanonicalBodies(t *testing.T) {
	unknown, err := encodeCbor(cborMapValue{entries: []cborEntry{
		{key: "application_versions", value: stringArrayValue(nil)},
		{key: "kinds", value: stringArrayValue(nil)},
		{key: "max_inline_bytes", value: uint64(0)},
		{key: "attachment_mode", value: "none"},
		{key: "max_relay_attachment_bytes", value: uint64(0)},
		{key: "max_direct_attachment_bytes", value: uint64(0)},
		{key: "relay_authorization", value: "forbidden"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeApplicationCapabilities(unknown); !errors.Is(err, ErrInvalidApplicationCapabilities) {
		t.Fatalf("unknown field: %v", err)
	}
	if _, err := DecodeApplicationCapabilities([]byte{0xb8, 0x00}); !errors.Is(err, ErrInvalidApplicationCapabilities) {
		t.Fatalf("non-canonical body: %v", err)
	}
}

func applicationCapabilitiesFromVector(vector applicationCapabilitiesVector) ApplicationCapabilities {
	return ApplicationCapabilities{
		ApplicationVersions:      vector.ApplicationVersions,
		Kinds:                    vector.Kinds,
		MaxInlineBytes:           vector.MaxInlineBytes,
		AttachmentMode:           vector.AttachmentMode,
		MaxRelayAttachmentBytes:  vector.MaxRelayAttachmentBytes,
		MaxDirectAttachmentBytes: vector.MaxDirectAttachmentBytes,
	}
}
