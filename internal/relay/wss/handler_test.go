package wss

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

const (
	testB64x32 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	testB64x16 = "AAECAwQFBgcICQoLDA0ODw"
	testB64x64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw"
)

var (
	testAlicePrivateKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))
	testPeerPrivateKey  = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{2}, ed25519.SeedSize))
	testAlicePeerID     = testPublicKeyID(testAlicePrivateKey)
	testPeerID          = testPublicKeyID(testPeerPrivateKey)
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

func TestHandlerRejectsInvalidClientProofBeforeSessionAttach(t *testing.T) {
	hub, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+Path, nil)
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

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
	writeRawTest(t, conn, mustMarshal(t, hello))
	challenge := readObject(t, conn)
	sendJSON(t, conn, map[string]any{
		"type":              "AUTH",
		"client_public_key": testPeerID,
		"client_nonce":      challenge["client_nonce"],
		"relay_nonce":       challenge["relay_nonce"],
		"transcript_hash":   challenge["transcript_hash"],
		"client_proof":      testB64x64,
	})

	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("invalid client proof unexpectedly reached READY")
	}
	if snapshot := hub.Snapshot(); snapshot.SessionsActive != 0 || snapshot.PresenceActive != 0 {
		t.Fatalf("invalid AUTH left relay state: %+v", snapshot)
	}
}

func TestHandlerRejectsPresenceForDifferentAuthenticatedPeer(t *testing.T) {
	hub, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	client := dialAndReady(t, server.URL)
	defer client.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, client.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  client.Ready.SessionID,
		"route_id":    client.Ready.RouteID,
		"peer_id":     testAlicePeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	errFrame := readObject(t, client.Conn)
	if errFrame["type"] != "ERROR" || errFrame["code"] != "authentication_failed" {
		t.Fatalf("unexpected identity binding error: %+v", errFrame)
	}
	if snapshot := hub.Snapshot(); snapshot.PresenceActive != 0 {
		t.Fatalf("mismatched presence was accepted: %+v", snapshot)
	}
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

	alice := dialAndReadyAs(t, server.URL, testAlicePrivateKey)
	defer alice.Close(websocket.StatusNormalClosure, "")
	aliceReady := alice.Ready
	sendJSON(t, alice.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  aliceReady.SessionID,
		"route_id":    aliceReady.RouteID,
		"peer_id":     testAlicePeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})
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
	if envelope["sender_peer_id"] != testAlicePeerID {
		t.Fatalf("sender peer id missing from forwarded envelope: %+v", envelope)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 2 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 2 || snapshot.ForwardedFrames != 1 {
		t.Fatalf("unexpected hub snapshot: %+v", snapshot)
	}
}

func TestHandlerForwardsSelfAddressedEnvelopeOnLoopbackRoute(t *testing.T) {
	hub, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	alice := dialAndReadyAs(t, server.URL, testAlicePrivateKey)
	defer alice.Close(websocket.StatusNormalClosure, "")
	aliceReady := alice.Ready
	sendJSON(t, alice.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  aliceReady.SessionID,
		"route_id":    aliceReady.RouteID,
		"peer_id":     testAlicePeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": aliceReady.SessionID,
		"route_id":   aliceReady.RouteID,
		"peer_id":    testAlicePeerID,
		"sequence":   2,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    aliceReady.SessionID,
		"route_id":      aliceReady.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("self-addressed opaque bytes")),
		"ack_requested": true,
	})

	frames := []map[string]any{readObject(t, alice.Conn), readObject(t, alice.Conn)}
	var ack map[string]any
	var envelope map[string]any
	for _, frame := range frames {
		switch frame["type"] {
		case "ACK":
			ack = frame
		case "ENVELOPE":
			envelope = frame
		}
	}
	if ack == nil || ack["ack_type"] != "relay.forwarded" || ack["durable"] != false {
		t.Fatalf("unexpected ack frames: %+v", frames)
	}
	if envelope == nil || envelope["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("self-addressed opaque bytes")) {
		t.Fatalf("unexpected loopback envelope frames: %+v", frames)
	}
	if envelope["sender_peer_id"] != testAlicePeerID {
		t.Fatalf("sender peer id missing from loopback envelope: %+v", envelope)
	}
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(mustMarshal(t, envelope)); err != nil {
		t.Fatalf("loopback envelope does not match shared schema: %v", err)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 1 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 1 || snapshot.ForwardedFrames != 1 {
		t.Fatalf("unexpected hub snapshot: %+v", snapshot)
	}
}

func TestHandlerSkipsRelayAckWhenEnvelopeDoesNotRequestIt(t *testing.T) {
	_, handler := newTestHubAndHandler(t)
	server := httptest.NewServer(handler)
	defer server.Close()

	bob := dialAndReady(t, server.URL)
	defer bob.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bob.Ready.SessionID,
		"route_id":    bob.Ready.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	alice := dialAndReady(t, server.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    alice.Ready.SessionID,
		"route_id":      alice.Ready.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("opaque no ack")),
		"ack_requested": false,
	})

	envelope := readObject(t, bob.Conn)
	if envelope["type"] != "ENVELOPE" || envelope["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("opaque no ack")) {
		t.Fatalf("unexpected forwarded envelope: %+v", envelope)
	}
	assertNoImmediateFrame(t, alice.Conn)
}

func TestHandlerFederatesLivePeerAcrossTwoRelays(t *testing.T) {
	rightHub, rightHandler := newTestHubAndHandler(t)
	rightServer := httptest.NewServer(rightHandler)
	defer rightServer.Close()
	rightBridge := attachBridgeSession(t, rightHub, "bridge-right")

	bob := dialAndReady(t, rightServer.URL)
	defer bob.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bob.Ready.SessionID,
		"route_id":    bob.Ready.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	leftHub, leftHandler := newTestHubAndHandlerWithPeerRouter(t, testFederationRouter{
		targetHub: rightHub,
		bridge:    rightBridge,
		now:       time.Unix(1_789_000_000, 0),
	})
	leftServer := httptest.NewServer(leftHandler)
	defer leftServer.Close()

	alice := dialAndReady(t, leftServer.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "LOOKUP",
		"session_id": alice.Ready.SessionID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   3,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    alice.Ready.SessionID,
		"route_id":      alice.Ready.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("opaque federated bytes")),
		"ack_requested": true,
	})

	ack := readObject(t, alice.Conn)
	if ack["type"] != "ACK" || ack["ack_type"] != "relay.forwarded" || ack["durable"] != false {
		t.Fatalf("unexpected federated ack: %+v", ack)
	}
	envelope := readObject(t, bob.Conn)
	if envelope["type"] != "ENVELOPE" || envelope["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("opaque federated bytes")) {
		t.Fatalf("unexpected federated envelope: %+v", envelope)
	}

	leftSnapshot := leftHub.Snapshot()
	if leftSnapshot.SessionsActive != 1 || leftSnapshot.RoutesActive != 1 || leftSnapshot.PresenceActive != 1 || leftSnapshot.QueueDepth != 0 {
		t.Fatalf("unexpected left hub snapshot: %+v", leftSnapshot)
	}
	rightSnapshot := rightHub.Snapshot()
	if rightSnapshot.SessionsActive != 2 || rightSnapshot.RoutesActive != 1 || rightSnapshot.PresenceActive != 1 || rightSnapshot.QueueDepth != 0 {
		t.Fatalf("unexpected right hub snapshot: %+v", rightSnapshot)
	}
}

func TestStaticPeerRouterFederatesThroughRemoteWSS(t *testing.T) {
	rightHub, rightIdentity, rightHandler := newTestHubIdentityAndHandler(t)
	rightServer := httptest.NewServer(rightHandler)
	defer rightServer.Close()

	bob := dialAndReady(t, rightServer.URL)
	defer bob.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bob.Ready.SessionID,
		"route_id":    bob.Ready.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	leftHub, leftHandler := newTestHubAndHandlerWithStaticFederation(t, FederationPeer{
		Endpoint:         wssURL(rightServer.URL),
		RelayPublicKey:   rightIdentity.PublicKeyString(),
		ProfileMultihash: protocol.DevelopmentProfileMultihash,
	})
	leftServer := httptest.NewServer(leftHandler)
	defer leftServer.Close()

	alice := dialAndReady(t, leftServer.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    alice.Ready.SessionID,
		"route_id":      alice.Ready.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("static federation bytes")),
		"ack_requested": true,
	})

	ack := readObject(t, alice.Conn)
	if ack["type"] != "ACK" || ack["ack_type"] != "relay.forwarded" || ack["durable"] != false {
		t.Fatalf("unexpected static federation ack: %+v", ack)
	}
	envelope := readObject(t, bob.Conn)
	if envelope["type"] != "ENVELOPE" || envelope["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("static federation bytes")) {
		t.Fatalf("unexpected static federation envelope: %+v", envelope)
	}
	federatedRouteID, ok := envelope["route_id"].(string)
	if !ok || federatedRouteID == "" {
		t.Fatalf("forwarded envelope missing route id: %+v", envelope)
	}
	sendJSON(t, bob.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    bob.Ready.SessionID,
		"route_id":      federatedRouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("static federation reply")),
		"ack_requested": true,
	})
	bobAck := readObject(t, bob.Conn)
	if bobAck["type"] != "ACK" || bobAck["ack_type"] != "relay.forwarded" || bobAck["durable"] != false {
		t.Fatalf("unexpected static federation reply ack: %+v", bobAck)
	}
	reply := readObject(t, alice.Conn)
	if reply["type"] != "ENVELOPE" || reply["ciphertext"] != base64.RawURLEncoding.EncodeToString([]byte("static federation reply")) {
		t.Fatalf("unexpected static federation reply: %+v", reply)
	}
	if snapshot := leftHub.Snapshot(); snapshot.SessionsActive != 1 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 1 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected left hub snapshot: %+v", snapshot)
	}
	if snapshot := rightHub.Snapshot(); snapshot.PresenceActive != 1 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected right hub snapshot: %+v", snapshot)
	}
}

func TestHandlerRejectsClientRouteHintsBeforeFederationDial(t *testing.T) {
	rightHub, rightIdentity, rightHandler := newTestHubIdentityAndHandler(t)
	rightServer := httptest.NewServer(rightHandler)
	defer rightServer.Close()

	bob := dialAndReady(t, rightServer.URL)
	defer bob.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bob.Ready.SessionID,
		"route_id":    bob.Ready.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})
	waitForPresence(t, rightHub, 1)

	leftHub, leftHandler := newTestHubAndHandlerWithRouteHintRouter(t)
	leftServer := httptest.NewServer(leftHandler)
	defer leftServer.Close()

	alice := dialAndReady(t, leftServer.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
		"route_hints": []map[string]any{{
			"transport":        "ws",
			"uri":              wssURL(rightServer.URL),
			"relay_public_key": rightIdentity.PublicKeyString(),
			"priority":         0,
		}},
	})
	errFrame := readObject(t, alice.Conn)
	if errFrame["type"] != "ERROR" || errFrame["code"] != "frame_malformed" {
		t.Fatalf("unexpected client route-hint rejection: %+v", errFrame)
	}
	if snapshot := leftHub.Snapshot(); snapshot.RoutesActive != 0 || snapshot.PresenceActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("left hub retained client route hint state: %+v", snapshot)
	}
	if snapshot := rightHub.Snapshot(); snapshot.PresenceActive != 1 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected right hub snapshot: %+v", snapshot)
	}
}

func TestStaticPeerRouterRejectsMismatchedRelayKey(t *testing.T) {
	_, _, rightHandler := newTestHubIdentityAndHandler(t)
	rightServer := httptest.NewServer(rightHandler)
	defer rightServer.Close()

	leftHub, leftHandler := newTestHubAndHandlerWithStaticFederation(t, FederationPeer{
		Endpoint:         wssURL(rightServer.URL),
		RelayPublicKey:   testB64x32,
		ProfileMultihash: protocol.DevelopmentProfileMultihash,
	})
	leftServer := httptest.NewServer(leftHandler)
	defer leftServer.Close()

	alice := dialAndReady(t, leftServer.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})

	errFrame := readObject(t, alice.Conn)
	if errFrame["type"] != "ERROR" || errFrame["code"] != "peer_unavailable" || errFrame["retryable"] != true {
		t.Fatalf("unexpected static federation key mismatch frame: %+v", errFrame)
	}
	if snapshot := leftHub.Snapshot(); snapshot.RoutesActive != 0 || snapshot.PresenceActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("left hub stored rejected static candidate route: %+v", snapshot)
	}
}

func TestHandlerFederatedRouteReturnsUnavailableWithoutAckOrMailbox(t *testing.T) {
	rightHub, rightHandler := newTestHubAndHandler(t)
	rightServer := httptest.NewServer(rightHandler)
	defer rightServer.Close()
	rightBridge := attachBridgeSession(t, rightHub, "bridge-right")

	bob := dialAndReady(t, rightServer.URL)
	sendJSON(t, bob.Conn, map[string]any{
		"type":        "PRESENCE",
		"session_id":  bob.Ready.SessionID,
		"route_id":    bob.Ready.RouteID,
		"peer_id":     testPeerID,
		"sequence":    1,
		"ttl_seconds": 30,
		"sent_at":     1_789_000_001,
	})

	leftHub, leftHandler := newTestHubAndHandlerWithPeerRouter(t, testFederationRouter{
		targetHub: rightHub,
		bridge:    rightBridge,
		now:       time.Unix(1_789_000_000, 0),
	})
	leftServer := httptest.NewServer(leftHandler)
	defer leftServer.Close()
	alice := dialAndReady(t, leftServer.URL)
	defer alice.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "LOOKUP",
		"session_id": alice.Ready.SessionID,
		"peer_id":    testPeerID,
		"sequence":   2,
	})
	sendJSON(t, alice.Conn, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": alice.Ready.SessionID,
		"route_id":   alice.Ready.RouteID,
		"peer_id":    testPeerID,
		"sequence":   3,
	})

	bob.Close(websocket.StatusNormalClosure, "")
	waitForDetachedPeer(t, rightHub)
	sendJSON(t, alice.Conn, map[string]any{
		"type":          "ENVELOPE",
		"session_id":    alice.Ready.SessionID,
		"route_id":      alice.Ready.RouteID,
		"path_epoch":    0,
		"stream_id":     0,
		"delivery_id":   testB64x16,
		"ciphertext":    base64.RawURLEncoding.EncodeToString([]byte("not queued")),
		"ack_requested": true,
	})

	errFrame := readObject(t, alice.Conn)
	if errFrame["type"] != "ERROR" || errFrame["code"] != "peer_unavailable" || errFrame["retryable"] != true {
		t.Fatalf("unexpected federated unavailable frame: %+v", errFrame)
	}
	leftSnapshot := leftHub.Snapshot()
	if leftSnapshot.QueueDepth != 0 || leftSnapshot.ForwardedFrames != 0 || leftSnapshot.ForwardedBytes != 0 {
		t.Fatalf("left hub stored unavailable frame: %+v", leftSnapshot)
	}
	rightSnapshot := rightHub.Snapshot()
	if rightSnapshot.QueueDepth != 0 || rightSnapshot.ForwardedFrames != 0 || rightSnapshot.ForwardedBytes != 0 {
		t.Fatalf("right hub stored unavailable frame: %+v", rightSnapshot)
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

func TestHandlerAcceptsAndReturnsIdentityContactRecords(t *testing.T) {
	now := time.Unix(1_789_000_000, 0)
	cache := newTestIdentityContactCache(t, now)
	_, _, handler := newTestHubIdentityAndHandlerWithIdentityContacts(t, nil, nil, cache)
	server := httptest.NewServer(handler)
	defer server.Close()

	wrapper, branchID := createTestIdentityContactWrapper(t, now)
	client := dialAndReady(t, server.URL)
	defer client.Close(websocket.StatusNormalClosure, "")

	sendJSON(t, client.Conn, map[string]any{
		"type":       "IDENTITY_HAVE",
		"session_id": client.Ready.SessionID,
		"branch_id":  branchID,
		"sequence":   1,
		"records":    []string{wrapper},
	})

	sendJSON(t, client.Conn, map[string]any{
		"type":       "IDENTITY_WANT",
		"session_id": client.Ready.SessionID,
		"branch_id":  branchID,
		"sequence":   2,
		"hop_limit":  0,
	})
	response := readObject(t, client.Conn)
	if response["type"] != "IDENTITY_HAVE" || response["branch_id"] != branchID {
		t.Fatalf("unexpected identity response: %+v", response)
	}
	records, err := identityRecordStringsFromFrame(response)
	if err != nil {
		t.Fatalf("read records: %v", err)
	}
	if len(records) != 1 || records[0] != wrapper {
		t.Fatalf("records = %+v", records)
	}
}

func TestHandlerFederatesIdentityContactWantToPeerRelay(t *testing.T) {
	now := time.Unix(1_789_000_000, 0)
	wrapper, branchID := createTestIdentityContactWrapper(t, now)
	remoteCache := newTestIdentityContactCache(t, now)
	if result := remoteCache.Accept(wrapper, "test", protocol.IdentityContactValidationOptions{NowUnix: now.Unix()}); !result.Accepted {
		t.Fatalf("seed remote cache = %+v", result)
	}
	_, remoteIdentity, remoteHandler := newTestHubIdentityAndHandlerWithIdentityContacts(t, nil, nil, remoteCache)
	remoteServer := httptest.NewServer(remoteHandler)
	defer remoteServer.Close()

	localHub, err := relay.NewHub(relay.Config{
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
	router, err := NewStaticPeerRouter(StaticPeerRouterConfig{
		Peers: []FederationPeer{{
			Endpoint:         wssURL(remoteServer.URL),
			RelayPublicKey:   remoteIdentity.PublicKeyString(),
			ProfileMultihash: protocol.DevelopmentProfileMultihash,
		}},
		LocalHub: localHub,
		EndpointPolicy: FederationEndpointPolicy{
			AllowInsecureWS:       true,
			AllowPrivateAddresses: true,
		},
		Random:        bytes.NewReader(countingBytes(4096)),
		Now:           func() time.Time { return now },
		MaxFrameBytes: 49_152,
		DialTimeout:   time.Second,
		WriteTimeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("new static peer router: %v", err)
	}
	localCache := newTestIdentityContactCache(t, now)
	nodeIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	localHandler, err := NewHandler(Config{
		Hub:              localHub,
		Identity:         nodeIdentity,
		IdentityContacts: localCache,
		PeerRouter:       router,
		Random:           bytes.NewReader(countingBytes(512)),
		Now:              func() time.Time { return now },
		MaxFrameBytes:    49_152,
		HandshakeTimeout: time.Second,
		WriteTimeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	localServer := httptest.NewServer(localHandler)
	defer localServer.Close()

	client := dialAndReady(t, localServer.URL)
	defer client.Close(websocket.StatusNormalClosure, "")
	sendJSON(t, client.Conn, map[string]any{
		"type":       "IDENTITY_WANT",
		"session_id": client.Ready.SessionID,
		"branch_id":  branchID,
		"sequence":   1,
		"hop_limit":  1,
	})
	response := readObject(t, client.Conn)
	if response["type"] != "IDENTITY_HAVE" {
		t.Fatalf("unexpected identity response: %+v", response)
	}
	records, err := identityRecordStringsFromFrame(response)
	if err != nil {
		t.Fatalf("read records: %v", err)
	}
	if len(records) != 1 || records[0] != wrapper {
		t.Fatalf("records = %+v", records)
	}
	if _, ok := localCache.Lookup(branchID); !ok {
		t.Fatal("federated record was not cached locally")
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

func waitForPresence(t *testing.T, hub *relay.Hub, want int) {
	t.Helper()
	deadline := time.After(time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		snapshot := hub.Snapshot()
		if snapshot.PresenceActive == want {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("presence count = %d, want %d; snapshot: %+v", snapshot.PresenceActive, want, snapshot)
		case <-ticker.C:
		}
	}
}

type readyFrame struct {
	SessionID string `json:"session_id"`
	RouteID   string `json:"route_id"`
}

type testClient struct {
	Conn   *websocket.Conn
	Ready  readyFrame
	PeerID string
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
	return newTestHubAndHandlerWithOptions(t, originPatterns, nil)
}

func newTestHubAndHandlerWithPeerRouter(t *testing.T, peerRouter PeerRouter) (*relay.Hub, http.Handler) {
	t.Helper()
	return newTestHubAndHandlerWithOptions(t, nil, peerRouter)
}

func newTestHubAndHandlerWithStaticFederation(t *testing.T, peer FederationPeer) (*relay.Hub, http.Handler) {
	t.Helper()
	hub, handler := newTestHubAndHandlerWithRouteHintRouter(t, peer)
	return hub, handler
}

func newTestHubAndHandlerWithRouteHintRouter(t *testing.T, peers ...FederationPeer) (*relay.Hub, http.Handler) {
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
	peerRouter, err := NewStaticPeerRouter(StaticPeerRouterConfig{
		Peers:    peers,
		LocalHub: hub,
		EndpointPolicy: FederationEndpointPolicy{
			AllowInsecureWS:       true,
			AllowPrivateAddresses: true,
		},
		Random:        bytes.NewReader(countingBytes(4096)),
		Now:           func() time.Time { return time.Unix(1_789_000_000, 0) },
		MaxFrameBytes: 49_152,
		DialTimeout:   time.Second,
		WriteTimeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("new static peer router: %v", err)
	}
	nodeIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	handler, err := NewHandler(Config{
		Hub:              hub,
		Identity:         nodeIdentity,
		PeerRouter:       peerRouter,
		Random:           bytes.NewReader(countingBytes(512)),
		Now:              func() time.Time { return time.Unix(1_789_000_000, 0) },
		MaxFrameBytes:    49_152,
		HandshakeTimeout: time.Second,
		WriteTimeout:     time.Second,
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	return hub, handler
}

func newTestHubAndHandlerWithOptions(t *testing.T, originPatterns []string, peerRouter PeerRouter) (*relay.Hub, http.Handler) {
	t.Helper()
	hub, _, handler := newTestHubIdentityAndHandlerWithOptions(t, originPatterns, peerRouter)
	return hub, handler
}

func newTestHubIdentityAndHandler(t *testing.T) (*relay.Hub, *identity.NodeIdentity, http.Handler) {
	t.Helper()
	return newTestHubIdentityAndHandlerWithOptions(t, nil, nil)
}

func newTestHubIdentityAndHandlerWithOptions(t *testing.T, originPatterns []string, peerRouter PeerRouter) (*relay.Hub, *identity.NodeIdentity, http.Handler) {
	t.Helper()
	return newTestHubIdentityAndHandlerWithIdentityContacts(t, originPatterns, peerRouter, nil)
}

func newTestHubIdentityAndHandlerWithIdentityContacts(t *testing.T, originPatterns []string, peerRouter PeerRouter, identityContacts *discovery.IdentityContactCache) (*relay.Hub, *identity.NodeIdentity, http.Handler) {
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
		IdentityContacts: identityContacts,
		PeerRouter:       peerRouter,
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
	return hub, nodeIdentity, handler
}

func newTestIdentityContactCache(t *testing.T, now time.Time) *discovery.IdentityContactCache {
	t.Helper()
	cache, err := discovery.NewIdentityContactCache(discovery.IdentityContactCacheConfig{
		MaxEntries: 8,
		Now: func() time.Time {
			return now
		},
	})
	if err != nil {
		t.Fatalf("identity contact cache: %v", err)
	}
	return cache
}

func createTestIdentityContactWrapper(t *testing.T, now time.Time) (string, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity key: %v", err)
	}
	relayPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate relay key: %v", err)
	}
	branchID, err := protocol.BranchIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatalf("branch id: %v", err)
	}
	wrapper, err := protocol.CreateIdentityContactWrapper(protocol.IdentityContactOptions{
		NowUnix:         now.Unix(),
		ExpiresAtUnix:   now.Add(time.Hour).Unix(),
		Sequence:        1,
		SenderPublicKey: publicKey,
		Aliases:         []string{"alice"},
		RouteHints: []protocol.IdentityContactRouteHint{{
			Transport:        "wss",
			URI:              "wss://relay01.undoo.ru:443/relay/v0",
			RelayPublicKey:   base64.RawURLEncoding.EncodeToString(relayPublicKey),
			ProfileMultihash: protocol.DevelopmentProfileMultihash,
			Priority:         0,
		}},
		Sign: func(message []byte) ([]byte, error) {
			return ed25519.Sign(privateKey, message), nil
		},
	})
	if err != nil {
		t.Fatalf("create identity contact: %v", err)
	}
	return wrapper, branchID
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
	return dialAndReadyAs(t, serverURL, testPeerPrivateKey)
}

func dialAndReadyAs(t *testing.T, serverURL string, privateKey ed25519.PrivateKey) testClient {
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
	transcriptHash, err := decodeTestBase64(challenge["transcript_hash"].(string))
	if err != nil {
		t.Fatalf("decode transcript hash: %v", err)
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)

	sendJSON(t, conn, map[string]any{
		"type":              "AUTH",
		"client_public_key": base64.RawURLEncoding.EncodeToString(publicKey),
		"client_nonce":      challenge["client_nonce"],
		"relay_nonce":       challenge["relay_nonce"],
		"transcript_hash":   challenge["transcript_hash"],
		"client_proof":      base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, proofInput(transcriptHash))),
	})

	readyRaw := readRaw(t, conn)
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(readyRaw); err != nil {
		t.Fatalf("ready does not match shared schema: %v", err)
	}
	var ready readyFrame
	if err := json.Unmarshal(readyRaw, &ready); err != nil {
		t.Fatalf("decode ready: %v", err)
	}
	return testClient{Conn: conn, Ready: ready, PeerID: base64.RawURLEncoding.EncodeToString(publicKey)}
}

func testPublicKeyID(privateKey ed25519.PrivateKey) string {
	return base64.RawURLEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey))
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
	if frame, ok := value.(map[string]any); ok && frame["type"] == "ENVELOPE" && frame["origin_route_id"] == nil {
		frame = maps.Clone(frame)
		frame["origin_route_id"] = frame["route_id"]
		value = frame
	}
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

func assertNoImmediateFrame(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("unexpected websocket frame")
	}
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

func wssURL(serverURL string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http") + Path
}

func attachBridgeSession(t *testing.T, hub *relay.Hub, sessionID relay.SessionID) *relay.Session {
	t.Helper()
	session, err := hub.Attach(sessionID)
	if err != nil {
		t.Fatalf("attach bridge session: %v", err)
	}
	return session
}

type testFederationRouter struct {
	targetHub *relay.Hub
	bridge    *relay.Session
	now       time.Time
}

func (router testFederationRouter) LookupFederatedPeer(_ context.Context, peerID relay.PeerID, _ []FederationRouteHint, _ time.Time) (relay.FederatedForwarder, bool) {
	if _, ok := router.targetHub.Lookup(peerID, router.now); !ok {
		return nil, false
	}
	return testFederationForwarder{
		target:     router.bridge,
		targetPeer: peerID,
		now:        router.now,
	}, true
}

type testFederationForwarder struct {
	target     *relay.Session
	targetPeer relay.PeerID
	now        time.Time
}

func (forwarder testFederationForwarder) Forward(ctx context.Context, routeID relay.RouteID, payload []byte, _ relay.PeerID) error {
	err := forwarder.target.Rendezvous(routeID, forwarder.targetPeer, forwarder.now)
	if err != nil && !errors.Is(err, relay.ErrRouteExists) {
		return err
	}
	// This fixture deliberately operates on its handler's injected clock. The
	// live delivery path has the same explicit time parameter, so don't let the
	// host wall clock make a static test presence expire years later.
	return forwarder.target.SendDelivery(ctx, routeID, payload, relay.Delivery{
		ID:     string(routeID),
		Digest: sha256.Sum256(payload),
	}, forwarder.now)
}
