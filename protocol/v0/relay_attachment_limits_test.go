package v0

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestDraftRelayAttachmentEnvelopeCiphertextUsesDedicatedBound(t *testing.T) {
	frame := map[string]any{
		"type":            "ENVELOPE",
		"session_id":      base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		"route_id":        base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		"origin_route_id": base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		"path_epoch":      0,
		"stream_id":       0,
		"delivery_id":     base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		"ciphertext":      strings.Repeat("A", MaxDraftRelayCiphertextBytes),
		"ack_requested":   true,
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal ciphertext at dedicated bound: %v", err)
	}
	if _, err := DecodeDraftRelayAttachmentFrame(encoded); err != nil {
		t.Fatalf("ciphertext at dedicated bound rejected: %v", err)
	}
	frame["ciphertext"] = strings.Repeat("A", MaxDraftRelayCiphertextBytes+1)
	encoded, err = json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal ciphertext above dedicated bound: %v", err)
	}
	if _, err := DecodeDraftRelayAttachmentFrame(encoded); err == nil {
		t.Fatal("ciphertext above dedicated bound accepted")
	}
}
