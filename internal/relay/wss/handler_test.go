package wss

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

const (
	testPeerID = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA"
	testB64x32 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	testB64x16 = "AAECAwQFBgcICQoLDA0ODw"
	testB64x64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw"
)

func TestHandlerRejectsWrongPathAndNonUpgrade(t *testing.T) {
	handler := newTestHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/wrong", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("wrong path status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, Path, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code < 400 {
		t.Fatalf("non-upgrade status = %d", response.Code)
	}
}

func TestHandlerRejectsUnauthorizedBrowserOrigin(t *testing.T) {
	_, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+Path, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://branch.undoo.ru"}},
	})
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("expected unauthorized browser origin to be rejected")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("origin rejection response = %+v, err = %v", response, err)
	}
}

func TestHandlerAcceptsConfiguredBrowserOrigin(t *testing.T) {
	_, handler := newTestHubAndHandlerWithOrigins(t, []string{"branch.undoo.ru"})
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+Path, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://branch.undoo.ru"}},
	})
	if err != nil {
		t.Fatalf("dial with configured origin: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestHandlerRejectsWildcardOriginPattern(t *testing.T) {
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	nodeIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}

	_, err = NewHandler(Config{
		Hub:            hub,
		Identity:       nodeIdentity,
		OriginPatterns: []string{"*"},
	})
	if err == nil {
		t.Fatal("expected wildcard origin pattern to be rejected")
	}
}

func TestHandlerAttachesTwoPeersAndForwardsOpaqueEnvelope(t *testing.T) {
	hub, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	bob := dialAndReady(t, server.URL)
	defer bob.Close(websocket.StatusNormalClosure, "")
	bobReady := bob.Ready
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bobReady.SessionID,
		"route_id":    bobReady.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	alice := dialAndReady(t, server.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	aliceReady := alice.Ready
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": aliceReady.SessionID,
		"route_id":   aliceReady.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})

	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    aliceReady.SessionID,
		"route_id":      aliceReady.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("opaque encrypted test bytes")),
		"ack_requested": true,
	})

	ack := readObject(t, alice.Conn)
	if ack["type"] != "ACK" || ack["ack_type"] != "relay.forwarded" || ack["durable"] != false {
		t.Fatalf("unexpected ack: %+v", ack)
	}
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(mustMarshal(t, ack)); err != nil {
		t.Fatalf("ack does not match shared schema: %v", err)
	}

	envelope := readObject(t, bob.Conn)
	if envelope["type"] != "ENVELOPE" {
		t.Fatalf("unexpected forwarded frame: %+v", envelope)
	}
	if envelope["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("opaque encrypted test bytes")) {
		t.Fatalf("ciphertext changed: %+v", envelope)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 2 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 1 || snapshot.ForwardedFrames != 1 {
		t.Fatalf("unexpected hub snapshot: %+v", snapshot)
	}
}

func TestHandlerReturnsPeerUnavailableWithoutStoreAndForward(t *testing.T) {
	hub, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	bob := dialAndReady(t, server.URL)
	bobReady := bob.Ready
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bobReady.SessionID,
		"route_id":    bobReady.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	alice := dialAndReady(t, server.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	aliceReady := alice.Ready
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": aliceReady.SessionID,
		"route_id":   aliceReady.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})
	bob.Close(websocket.StatusNormalClosure, "")
	waitForDetachedPeer(t, hub)

	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    aliceReady.SessionID,
		"route_id":      aliceReady.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("not queued")),
		"ack_requested": true,
	})

	errFrame := readObject(t, alice.Conn)
	if errFrame["type"] != "ERROR" || errFrame["code"] != "peer_unavailable" || errFrame["retryable"] != true {
		t.Fatalf("unexpected unavailable frame: %+v", errFrame)
	}
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(mustMarshal(t, errFrame)); err != nil {
		t.Fatalf("error frame does not match shared schema: %v", err)
	}
}

func waitForDetachedPeer(t *testing.T, hub *relay.Hub) {
	t.Helper()
	deadline := time.After(time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		snapshot := hub.Snapshot()
		if snapshot.SessionsActive == 1 && snapshot.RoutesActive == 0 && snapshot.PresenceActive == 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("peer still attached: %+v", snapshot)
		case <-ticker.C:
		}
	}
}

type readyFrame struct {
	SessionID string `json:"session_id"`
	RouteID   string `json:"route_id"`
}

type testClient struct {
	Conn  *websocket.Conn
	Ready readyFrame
}

func (client testClient) Close(code websocket.StatusCode, reason string) {
	client.Conn.Close(code, reason)
}

func newTestHubAndHandler(t *testing.T) (*relay.Hub, http.Handler) {
	t.Helper()
	return newTestHubAndHandlerWithOrigins(t, nil)
}

func newTestHubAndHandlerWithOrigins(t *testing.T, originPatterns []string) (*relay.Hub, http.Handler) {
	t.Helper()
	hub, err := relay.NewHub(relay.Config{
		MaxSessions:         8,
		MaxQueueDepth:       8,
		MaxFrameBytes:       49_152,
		MaxFramesPerSession: 32,
		MaxBytesPerSession:  1 << 20,
		PresenceTTL:         30 * time.Second,
	})
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	nodeIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	handler, err := NewHandler(Config{
		Hub:              hub,
		Identity:         nodeIdentity,
		Random:           bytes.NewReader(countingBytes(512)),
		Now:              func() time.Time { return time.Unix(1_789_000_000, 0) },
		OriginPatterns:   originPatterns,
		MaxFrameBytes:    49_152,
		HandshakeTimeout: time.Second,
		WriteTimeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	return hub, handler
}

func countingBytes(size int) []byte {
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index)
	}
	return data
}

func newTestHandler(t *testing.T) http.Handler {
	t.Helper()
	_, handler := newTestHubAndHandler(t)
	return handler
}

func dialAndReady(t *testing.T, serverURL string) testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http")+Path, nil)
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	hello := map[string]any{
		"type":            "HELLO",
		"client_nonce":    testB64x32,
		"client_time":     1_789_000_000,
		"requested_role":  "relay.forward.live/0",
		"max_frame_bytes": 49_152,
		"offers": []map[string]any{{
			"wire_version":          0,
			"protocol":              protocol.ProtocolID,
			"profile_multihash":     protocol.DevelopmentProfileMultihash,
			"capabilities":          []string{"relay.forward.live/0", "route.relay.wss/0"},
			"required_capabilities": []string{"relay.forward.live/0"},
			"extensions":            []string{},
			"required_extensions":   []string{},
		}},
	}
	helloRaw := mustMarshal(t, hello)
	writeRawTest(t, conn, helloRaw)

	challengeRaw := readRaw(t, conn)
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(challengeRaw); err != nil {
		t.Fatalf("challenge does not match shared schema: %v", err)
	}
	var challenge map[string]any
	if err := json.Unmarshal(challengeRaw, &challenge); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	verifyRelayProof(t, helloRaw, challenge)

	sendJSON(t, conn, map[string]any{
		"type":              "AUTH",
		"client_public_key": testPeerID,
		"client_nonce":      challenge["client_nonce"],
		"relay_nonce":       challenge["relay_nonce"],
		"transcript_hash":   challenge["transcript_hash"],
		"client_proof":      testB64x64,
	})

	readyRaw := readRaw(t, conn)
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(readyRaw); err != nil {
		t.Fatalf("ready does not match shared schema: %v", err)
	}
	var ready readyFrame
	if err := json.Unmarshal(readyRaw, &ready); err != nil {
		t.Fatalf("decode ready: %v", err)
	}
	return testClient{Conn: conn, Ready: ready}
}

func verifyRelayProof(t *testing.T, helloRaw []byte, challenge map[string]any) {
	t.Helper()
	selected, ok := challenge["selected"].(map[string]any)
	if !ok {
		t.Fatalf("challenge missing selected offer: %+v", challenge)
	}
	clientNonce, err := decodeTestBase64(challenge["client_nonce"].(string))
	if err != nil {
		t.Fatalf("decode client nonce: %v", err)
	}
	relayNonce, err := decodeTestBase64(challenge["relay_nonce"].(string))
	if err != nil {
		t.Fatalf("decode relay nonce: %v", err)
	}
	relayPublicKey, err := decodeTestBase64(challenge["relay_public_key"].(string))
	if err != nil {
		t.Fatalf("decode relay public key: %v", err)
	}
	transcriptHash := challengeTranscriptHash(helloRaw, selected, clientNonce, relayNonce, relayPublicKey)
	if base64.RawURLEncoding.EncodeToString(transcriptHash) != challenge["transcript_hash"] {
		t.Fatalf("transcript hash mismatch")
	}
	proof, err := decodeTestBase64(challenge["relay_proof"].(string))
	if err != nil {
		t.Fatalf("decode relay proof: %v", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(relayPublicKey), proofInput(transcriptHash), proof) {
		t.Fatalf("relay proof signature did not verify")
	}
}

func sendJSON(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	writeRawTest(t, conn, mustMarshal(t, value))
}

func writeRawTest(t *testing.T, conn *websocket.Conn, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write ws: %v", err)
	}
}

func readObject(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(readRaw(t, conn), &object); err != nil {
		t.Fatalf("decode ws object: %v", err)
	}
	return object
}

func readRaw(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read ws: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v", messageType)
	}
	return data
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return data
}

func decodeTestBase64(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}
