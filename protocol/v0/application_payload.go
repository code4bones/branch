package v0

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

const (
	ApplicationPayloadVersion  = "branch.application-payload/0.draft"
	AttachmentVersion          = "branch.attachment/0.draft"
	AttachmentSignatureDomain  = "branch.attachment.signature/0.draft\x00"
	MaxApplicationPayloadBytes = 4096
	MaxInlineBinaryBytes       = 3000
	MaxAttachmentChunkBytes    = 3072
	MaxRelayAttachmentBytes    = 4 * 1024 * 1024
	MaxDirectAttachmentBytes   = 16 * 1024 * 1024
	MaxAttachmentTTLMillis     = 15 * 60 * 1000
	MaxAttachmentChunks        = 8192
)

var ErrInvalidApplicationPayload = errors.New("invalid application payload")

// ApplicationPayload is the canonical application-only plaintext inside one
// existing HPKE ENVELOPE. It is not a relay frame.
type ApplicationPayload struct {
	Version   string
	Kind      string
	MessageID []byte
	Body      []byte
}

func EncodeApplicationPayload(payload ApplicationPayload) ([]byte, error) {
	if err := payload.Validate(); err != nil {
		return nil, err
	}
	return encodeCbor(cborMapValue{entries: []cborEntry{{key: "version", value: payload.Version}, {key: "kind", value: payload.Kind}, {key: "message_id", value: payload.MessageID}, {key: "body", value: payload.Body}}})
}

func DecodeApplicationPayload(data []byte) (ApplicationPayload, error) {
	if len(data) == 0 || len(data) > MaxApplicationPayloadBytes {
		return ApplicationPayload{}, ErrInvalidApplicationPayload
	}
	value, err := decodeDeterministicCBOR(data)
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	mapValue, err := cborMap(value, "application_payload")
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	if err := cborRejectUnknown(mapValue, []string{"version", "kind", "message_id", "body"}); err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	version, err := cborText(mapValue, "version")
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	kind, err := cborText(mapValue, "kind")
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	id, err := cborBytes(mapValue, "message_id", 16)
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	body, err := cborBytes(mapValue, "body", 0)
	if err != nil {
		return ApplicationPayload{}, fmt.Errorf("%w: %v", ErrInvalidApplicationPayload, err)
	}
	payload := ApplicationPayload{Version: version, Kind: kind, MessageID: id, Body: body}
	if err := payload.Validate(); err != nil {
		return ApplicationPayload{}, err
	}
	return payload, nil
}

func (payload ApplicationPayload) Validate() error {
	if payload.Version != ApplicationPayloadVersion || len(payload.Kind) == 0 || len(payload.Kind) > 96 || len(payload.MessageID) != 16 || len(payload.Body) == 0 || len(payload.Body) > MaxApplicationPayloadBytes {
		return ErrInvalidApplicationPayload
	}
	return nil
}

// AttachmentManifest is a signed, receiver-accepted transfer offer. Both it
// and every chunk remain inside the already opaque E2EE application boundary.
type AttachmentManifest struct {
	Version, TransferID, ManifestID   string
	IssuedAt, ExpiresAt               uint64
	FileName, MediaType               string
	ByteCount, ChunkBytes, ChunkCount uint64
	SHA256, Signature                 string
}

func (manifest AttachmentManifest) Validate() error {
	if manifest.Version != AttachmentVersion || !applicationToken(manifest.TransferID, 16) || !applicationToken(manifest.ManifestID, 32) || !applicationToken(manifest.SHA256, 32) || !applicationToken(manifest.Signature, 64) || manifest.ExpiresAt <= manifest.IssuedAt || manifest.ExpiresAt-manifest.IssuedAt > MaxAttachmentTTLMillis || manifest.ByteCount == 0 || manifest.ByteCount > MaxDirectAttachmentBytes || manifest.ChunkBytes < 256 || manifest.ChunkBytes > MaxAttachmentChunkBytes || manifest.ChunkCount == 0 || manifest.ChunkCount > MaxAttachmentChunks || manifest.ChunkCount != (manifest.ByteCount+manifest.ChunkBytes-1)/manifest.ChunkBytes || len(manifest.FileName) == 0 || len(manifest.FileName) > 160 || len(manifest.MediaType) == 0 || len(manifest.MediaType) > 128 {
		return ErrInvalidApplicationPayload
	}
	return nil
}

// AttachmentChunk has no standalone signature: it is authenticated by HPKE
// and accepted only after the signed manifest is verified and accepted.
type AttachmentChunk struct {
	Version, TransferID, ManifestID string
	Index                           uint64
	Bytes                           []byte
}

func (chunk AttachmentChunk) ValidateFor(manifest AttachmentManifest) error {
	if err := manifest.Validate(); err != nil {
		return err
	}
	if chunk.Version != AttachmentVersion || !applicationToken(chunk.TransferID, 16) || !applicationToken(chunk.ManifestID, 32) || chunk.TransferID != manifest.TransferID || chunk.ManifestID != manifest.ManifestID || chunk.Index >= manifest.ChunkCount || len(chunk.Bytes) == 0 || len(chunk.Bytes) > MaxAttachmentChunkBytes || uint64(len(chunk.Bytes)) > manifest.ChunkBytes || (chunk.Index+1 < manifest.ChunkCount && uint64(len(chunk.Bytes)) != manifest.ChunkBytes) {
		return ErrInvalidApplicationPayload
	}
	return nil
}

func AttachmentSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
func applicationToken(value string, length int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == length
}
