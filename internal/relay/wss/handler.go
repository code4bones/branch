package wss

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

const (
	// Path is the public same-relay WSS attachment endpoint.
	Path = "/relay/v0"
)

var (
	ErrInvalidConfig = errors.New("wss relay invalid config")
	ErrInvalidFrame  = errors.New("wss relay invalid frame")
)

// Config defines explicit adapter bounds and dependencies.
type Config struct {
	Hub              *relay.Hub
	Identity         *identity.NodeIdentity
	PeerRouter       PeerRouter
	Random           io.Reader
	Now              func() time.Time
	OriginPatterns   []string
	MaxFrameBytes    int64
	HandshakeTimeout time.Duration
	WriteTimeout     time.Duration
}

// PeerRouter locates a live remote relay path for one peer lookup. It is an
// adapter boundary for beta federation, not a global presence directory.
type PeerRouter interface {
	LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, now time.Time) (relay.FederatedForwarder, bool)
}

// Handler adapts a live non-durable relay Hub to the /relay/v0 WebSocket
// attachment surface.
type Handler struct {
	hub              *relay.Hub
	identity         *identity.NodeIdentity
	peerRouter       PeerRouter
	random           io.Reader
	now              func() time.Time
	originPatterns   []string
	maxFrameBytes    int64
	handshakeTimeout time.Duration
	writeTimeout     time.Duration
}

// NewHandler creates a WSS relay adapter with explicit bounds.
func NewHandler(config Config) (*Handler, error) {
	if config.Hub == nil || config.Identity == nil {
		return nil, ErrInvalidConfig
	}
	if config.Random == nil {
		config.Random = rand.Reader
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.MaxFrameBytes <= 0 {
		config.MaxFrameBytes = 49_152
	}
	if config.HandshakeTimeout <= 0 {
		config.HandshakeTimeout = 10 * time.Second
	}
	if config.WriteTimeout <= 0 {
		config.WriteTimeout = 5 * time.Second
	}
	originPatterns, err := cleanOriginPatterns(config.OriginPatterns)
	if err != nil {
		return nil, err
	}
	return &Handler{
		hub:              config.Hub,
		identity:         config.Identity,
		peerRouter:       config.PeerRouter,
		random:           config.Random,
		now:              config.Now,
		originPatterns:   originPatterns,
		maxFrameBytes:    config.MaxFrameBytes,
		handshakeTimeout: config.HandshakeTimeout,
		writeTimeout:     config.WriteTimeout,
	}, nil
}

// ServeHTTP accepts /relay/v0 WebSocket upgrades and runs one bounded
// attachment state machine per connection.
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != Path {
		http.NotFound(response, request)
		return
	}
	conn, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		OriginPatterns: handler.originPatterns,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(handler.maxFrameBytes)
	defer conn.Close(websocket.StatusNormalClosure, "")

	attachment := &connection{conn: conn}
	if err := handler.run(request.Context(), attachment); err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
	}
}

func cleanOriginPatterns(patterns []string) ([]string, error) {
	const (
		maxOriginPatterns = 16
		maxOriginPattern  = 256
	)
	if len(patterns) > maxOriginPatterns {
		return nil, fmt.Errorf("%w: too many origin patterns", ErrInvalidConfig)
	}
	cleaned := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		if pattern == "*" || len(pattern) > maxOriginPattern || strings.ContainsAny(pattern, " \t\r\n") {
			return nil, fmt.Errorf("%w: invalid origin pattern", ErrInvalidConfig)
		}
		cleaned = append(cleaned, pattern)
	}
	return cleaned, nil
}

type connection struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (handler *Handler) run(parent context.Context, conn *connection) error {
	ctx, cancel := context.WithTimeout(parent, handler.handshakeTimeout)
	defer cancel()

	helloRaw, err := readFrame(ctx, conn)
	if err != nil {
		return err
	}
	hello, err := decodeHello(helloRaw)
	if err != nil {
		return err
	}

	relayNonce, err := randomBytes(handler.random, 32)
	if err != nil {
		return err
	}
	transcriptHash := challengeTranscriptHash(helloRaw, hello.SelectedOffer, hello.ClientNonce, relayNonce, handler.identity.PublicKey())
	relayProof := handler.identity.Sign(proofInput(transcriptHash))
	issuedAt := handler.now().Unix()
	challenge := map[string]any{
		"type":             "CHALLENGE",
		"client_nonce":     base64URL(hello.ClientNonce),
		"relay_nonce":      base64URL(relayNonce),
		"issued_at":        issuedAt,
		"expires_at":       issuedAt + 60,
		"relay_public_key": handler.identity.PublicKeyString(),
		"selected":         hello.SelectedOffer,
		"transcript_hash":  base64URL(transcriptHash),
		"relay_proof":      base64URL(relayProof),
	}
	if err := writeJSON(parent, conn, handler.writeTimeout, challenge); err != nil {
		return err
	}

	authRaw, err := readFrame(ctx, conn)
	if err != nil {
		return err
	}
	if err := validateAuth(authRaw, hello.ClientNonce, relayNonce, transcriptHash); err != nil {
		return err
	}

	sessionID, err := randomID(handler.random, 32)
	if err != nil {
		return err
	}
	routeID, err := randomID(handler.random, 16)
	if err != nil {
		return err
	}
	session, err := handler.hub.Attach(relay.SessionID(sessionID))
	if err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidFrame, mapRelayError(err))
	}
	defer session.Close()

	ready := map[string]any{
		"type":                       "READY",
		"session_id":                 sessionID,
		"route_id":                   routeID,
		"presence_ttl_seconds":       30,
		"heartbeat_interval_seconds": 10,
		"accepted_limits": map[string]any{
			"max_frame_bytes":        handler.maxFrameBytes,
			"max_queue_depth":        32,
			"max_frames_per_session": 1 << 20,
			"max_bytes_per_session":  1 << 30,
		},
	}
	if err := writeJSON(parent, conn, handler.writeTimeout, ready); err != nil {
		return err
	}

	runCtx, stop := context.WithCancel(parent)
	defer stop()
	errs := make(chan error, 2)
	go handler.writeLoop(runCtx, conn, session, errs)
	go handler.readLoop(runCtx, conn, session, relay.SessionID(sessionID), errs)
	err = <-errs
	stop()
	return err
}

func (handler *Handler) readLoop(ctx context.Context, conn *connection, session *relay.Session, sessionID relay.SessionID, errs chan<- error) {
	for {
		raw, err := readFrame(ctx, conn)
		if err != nil {
			errs <- err
			return
		}
		if err := handler.handleFrame(ctx, conn, session, sessionID, raw); err != nil {
			if writeErr := handler.writeError(ctx, conn, mapRelayError(err)); writeErr != nil {
				errs <- writeErr
				return
			}
			if isFatal(err) {
				errs <- err
				return
			}
		}
	}
}

func (handler *Handler) writeLoop(ctx context.Context, conn *connection, session *relay.Session, errs chan<- error) {
	for {
		frame, err := session.Receive(ctx)
		if err != nil {
			errs <- err
			return
		}
		if err := writeRaw(ctx, conn, handler.writeTimeout, frame.Payload); err != nil {
			errs <- err
			return
		}
	}
}

func (handler *Handler) handleFrame(ctx context.Context, conn *connection, session *relay.Session, sessionID relay.SessionID, raw []byte) error {
	frame, err := decodeTypedFrame(raw)
	if err != nil {
		return err
	}
	if sid, ok := frame["session_id"].(string); ok && relay.SessionID(sid) != sessionID {
		return ErrInvalidFrame
	}

	switch frame["type"] {
	case "PRESENCE":
		return session.AnnouncePresence(relay.PeerID(frame["peer_id"].(string)), handler.now())
	case "HEARTBEAT":
		return session.Heartbeat(handler.now())
	case "LOOKUP":
		peerID := relay.PeerID(frame["peer_id"].(string))
		now := handler.now()
		if _, ok := handler.hub.Lookup(peerID, now); ok {
			return nil
		}
		if forwarder, ok := handler.lookupFederatedPeer(ctx, peerID, now); ok {
			closeFederatedForwarder(forwarder)
			return nil
		}
		return relay.ErrPeerUnavailable
	case "RENDEZVOUS":
		routeID := relay.RouteID(frame["route_id"].(string))
		peerID := relay.PeerID(frame["peer_id"].(string))
		now := handler.now()
		if err := session.Rendezvous(routeID, peerID, now); err != nil {
			if !errors.Is(err, relay.ErrPeerUnavailable) {
				return err
			}
			if federatedErr := handler.announceFederatedPeer(ctx, peerID, now); federatedErr != nil {
				return err
			}
			return session.Rendezvous(routeID, peerID, now)
		}
		return nil
	case "ENVELOPE":
		routeID := relay.RouteID(frame["route_id"].(string))
		if err := session.Send(ctx, routeID, raw); err != nil {
			return err
		}
		if ackRequested, _ := frame["ack_requested"].(bool); ackRequested {
			return handler.writeAck(ctx, conn, string(sessionID), frame["delivery_id"].(string), "relay.forwarded")
		}
		return nil
	default:
		return nil
	}
}

func (handler *Handler) announceFederatedPeer(ctx context.Context, peerID relay.PeerID, now time.Time) error {
	forwarder, ok := handler.lookupFederatedPeer(ctx, peerID, now)
	if !ok {
		return relay.ErrPeerUnavailable
	}
	return handler.hub.AnnounceFederatedPresence(peerID, forwarder, now)
}

func (handler *Handler) lookupFederatedPeer(ctx context.Context, peerID relay.PeerID, now time.Time) (relay.FederatedForwarder, bool) {
	if handler.peerRouter == nil {
		return nil, false
	}
	forwarder, ok := handler.peerRouter.LookupFederatedPeer(ctx, peerID, now)
	if !ok {
		return nil, false
	}
	return forwarder, true
}

func closeFederatedForwarder(forwarder relay.FederatedForwarder) {
	if closer, ok := forwarder.(interface{ Close() }); ok {
		closer.Close()
	}
}

func (handler *Handler) writeAck(ctx context.Context, conn *connection, sessionID string, deliveryID string, ackType string) error {
	ack := map[string]any{
		"type":        "ACK",
		"session_id":  sessionID,
		"delivery_id": deliveryID,
		"ack_type":    ackType,
		"durable":     false,
	}
	return writeJSON(ctx, conn, handler.writeTimeout, ack)
}

func (handler *Handler) writeError(ctx context.Context, conn *connection, code string) error {
	return writeJSON(ctx, conn, handler.writeTimeout, map[string]any{
		"type":      "ERROR",
		"code":      code,
		"retryable": code == "peer_unavailable" || code == "route_unavailable" || code == "timeout",
		"detail":    "transient relay failure",
	})
}

func readFrame(ctx context.Context, conn *connection) ([]byte, error) {
	messageType, data, err := conn.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
		return nil, ErrInvalidFrame
	}
	return data, nil
}

func writeJSON(parent context.Context, conn *connection, timeout time.Duration, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeRaw(parent, conn, timeout, data)
}

func writeRaw(parent context.Context, conn *connection, timeout time.Duration, data []byte) error {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	conn.writeMu.Lock()
	defer conn.writeMu.Unlock()
	return conn.conn.Write(ctx, websocket.MessageText, data)
}

type helloFrame struct {
	ClientNonce   []byte
	SelectedOffer map[string]any
}

func decodeHello(raw []byte) (helloFrame, error) {
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(raw); err != nil {
		return helloFrame{}, err
	}
	frame, err := decodeTypedFrame(raw)
	if err != nil {
		return helloFrame{}, err
	}
	if frame["type"] != "HELLO" {
		return helloFrame{}, ErrInvalidFrame
	}
	clientNonce, err := decodeBase64(frame["client_nonce"].(string), 32)
	if err != nil {
		return helloFrame{}, err
	}
	offers, ok := frame["offers"].([]any)
	if !ok || len(offers) == 0 {
		return helloFrame{}, ErrInvalidFrame
	}
	selected, ok := offers[0].(map[string]any)
	if !ok {
		return helloFrame{}, ErrInvalidFrame
	}
	return helloFrame{
		ClientNonce:   clientNonce,
		SelectedOffer: selected,
	}, nil
}

func validateAuth(raw []byte, clientNonce []byte, relayNonce []byte, transcriptHash []byte) error {
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(raw); err != nil {
		return err
	}
	frame, err := decodeTypedFrame(raw)
	if err != nil {
		return err
	}
	if frame["type"] != "AUTH" {
		return ErrInvalidFrame
	}
	for _, field := range []struct {
		key   string
		value []byte
	}{
		{key: "client_nonce", value: clientNonce},
		{key: "relay_nonce", value: relayNonce},
		{key: "transcript_hash", value: transcriptHash},
	} {
		actual, err := decodeBase64(frame[field.key].(string), len(field.value))
		if err != nil {
			return err
		}
		if !bytes.Equal(actual, field.value) {
			return ErrInvalidFrame
		}
	}
	return nil
}

func decodeTypedFrame(raw []byte) (map[string]any, error) {
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(raw); err != nil {
		return nil, err
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, ErrInvalidFrame
	}
	return frame, nil
}

func challengeTranscriptHash(helloRaw []byte, selected map[string]any, clientNonce []byte, relayNonce []byte, relayPublicKey []byte) []byte {
	selectedBytes, _ := json.Marshal(selected)
	hash := sha256.New()
	hash.Write(helloRaw)
	hash.Write(selectedBytes)
	hash.Write(clientNonce)
	hash.Write(relayNonce)
	hash.Write(relayPublicKey)
	return hash.Sum(nil)
}

func proofInput(transcriptHash []byte) []byte {
	input := []byte(protocol.RelayProofDomain)
	input = append(input, transcriptHash...)
	return input
}

func randomID(random io.Reader, size int) (string, error) {
	data, err := randomBytes(random, size)
	if err != nil {
		return "", err
	}
	return base64URL(data), nil
}

func randomBytes(random io.Reader, size int) ([]byte, error) {
	data := make([]byte, size)
	if _, err := io.ReadFull(random, data); err != nil {
		return nil, fmt.Errorf("read random bytes: %w", err)
	}
	return data, nil
}

func decodeBase64(value string, size int) ([]byte, error) {
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(data) != size {
		return nil, ErrInvalidFrame
	}
	return data, nil
}

func base64URL(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func mapRelayError(err error) string {
	switch {
	case errors.Is(err, relay.ErrPeerUnavailable):
		return "peer_unavailable"
	case errors.Is(err, relay.ErrFrameTooLarge):
		return "frame_too_large"
	case errors.Is(err, relay.ErrQuotaExceeded):
		return "quota_exceeded"
	case errors.Is(err, relay.ErrBackpressure):
		return "rate_limited"
	case errors.Is(err, relay.ErrNoRoute), errors.Is(err, relay.ErrSessionClosed), errors.Is(err, relay.ErrSessionNotFound):
		return "peer_unavailable"
	default:
		return "frame_malformed"
	}
}

func isFatal(err error) bool {
	return !errors.Is(err, relay.ErrPeerUnavailable) && !errors.Is(err, relay.ErrNoRoute)
}
