package v0

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type applicationPayloadVectors struct {
	Schema string `json:"schema"`
	Valid  struct {
		Text struct {
			Kind      string `json:"kind"`
			MessageID string `json:"message_id"`
			Body      string `json:"body"`
		} `json:"text"`
		Manifest struct {
			TransferID string `json:"transfer_id"`
			ManifestID string `json:"manifest_id"`
			IssuedAt   uint64 `json:"issued_at"`
			ExpiresAt  uint64 `json:"expires_at"`
			FileName   string `json:"file_name"`
			MediaType  string `json:"media_type"`
			ByteCount  uint64 `json:"byte_count"`
			ChunkBytes uint64 `json:"chunk_bytes"`
			ChunkCount uint64 `json:"chunk_count"`
			SHA256     string `json:"sha256"`
			Signature  string `json:"signature"`
		} `json:"manifest"`
	} `json:"valid"`
}

func TestApplicationPayloadSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "protocol-v0", "application-payload-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors applicationPayloadVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Schema != "branch.application-payload-vectors/0.draft" {
		t.Fatalf("schema = %q", vectors.Schema)
	}
	id, err := base64.RawURLEncoding.DecodeString(vectors.Valid.Text.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := base64.RawURLEncoding.DecodeString(vectors.Valid.Text.Body)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeApplicationPayload(ApplicationPayload{Version: ApplicationPayloadVersion, Kind: vectors.Valid.Text.Kind, MessageID: id, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeApplicationPayload(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Kind != vectors.Valid.Text.Kind || string(decoded.Body) != "hello" {
		t.Fatal("application payload vector changed")
	}
	m := vectors.Valid.Manifest
	manifest := AttachmentManifest{Version: AttachmentVersion, TransferID: m.TransferID, ManifestID: m.ManifestID, IssuedAt: m.IssuedAt, ExpiresAt: m.ExpiresAt, FileName: m.FileName, MediaType: m.MediaType, ByteCount: m.ByteCount, ChunkBytes: m.ChunkBytes, ChunkCount: m.ChunkCount, SHA256: m.SHA256, Signature: m.Signature}
	if err := manifest.Validate(); err != nil {
		t.Fatalf("manifest vector: %v", err)
	}
	if err := (AttachmentChunk{Version: AttachmentVersion, TransferID: manifest.TransferID, ManifestID: manifest.ManifestID, Index: 0, Bytes: make([]byte, manifest.ChunkBytes)}).ValidateFor(manifest); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	if err := (AttachmentChunk{Version: AttachmentVersion, TransferID: manifest.TransferID, ManifestID: manifest.ManifestID, Index: 1, Bytes: make([]byte, 1025)}).ValidateFor(manifest); err != nil {
		t.Fatalf("last chunk: %v", err)
	}
}
