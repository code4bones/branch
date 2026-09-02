package wss

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

const (
	defaultFederationDialTimeout = 2 * time.Second
	maxFederationPeers           = 8
	maxFederationEndpointBytes   = 512
	maxFederationResponses       = 4
)

// StaticPeerRouterConfig configures an optional beta relay-to-relay probe path.
type StaticPeerRouterConfig struct {
	Endpoints        []string
	LocalHub         *relay.Hub
	Random           io.Reader
	Now              func() time.Time
	MaxFrameBytes    int64
	DialTimeout      time.Duration
	WriteTimeout     time.Duration
	MaxPeerEndpoints int
}

// StaticPeerRouter probes a bounded static peer relay set for live peers. It is
// disabled when no endpoints are configured and keeps no durable route catalog.
type StaticPeerRouter struct {
	endpoints     []string
	localHub      *relay.Hub
	random        io.Reader
	now           func() time.Time
	maxFrameBytes int64
	dialTimeout   time.Duration
	writeTimeout  time.Duration
}

type federationCandidate struct {
	endpoint       string
	relayPublicKey []byte
	priority       int64
}

// NewStaticPeerRouter creates a beta static relay federation adapter.
func NewStaticPeerRouter(config StaticPeerRouterConfig) (*StaticPeerRouter, error) {
	if config.LocalHub == nil {
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
	if config.DialTimeout <= 0 {
		config.DialTimeout = defaultFederationDialTimeout
	}
	if config.WriteTimeout <= 0 {
		config.WriteTimeout = 5 * time.Second
	}
	maxEndpoints := config.MaxPeerEndpoints
	if maxEndpoints <= 0 {
		maxEndpoints = maxFederationPeers
	}
	endpoints, err := cleanFederationEndpoints(config.Endpoints, maxEndpoints)
	if err != nil {
		return nil, err
	}
	return &StaticPeerRouter{
		endpoints:     endpoints,
		localHub:      config.LocalHub,
		random:        config.Random,
		now:           config.Now,
		maxFrameBytes: config.MaxFrameBytes,
		dialTimeout:   config.DialTimeout,
		writeTimeout:  config.WriteTimeout,
	}, nil
}

// LookupFederatedPeer probes configured peers for one currently reachable peer.
func (router *StaticPeerRouter) LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, _ time.Time) (relay.FederatedForwarder, bool) {
	var candidates []federationCandidate
	if len(hints) > 0 {
		candidates = federationCandidatesFromHints(hints)
	} else {
		candidates = router.staticFederationCandidates()
	}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return nil, false
		}
		if router.remotePeerAvailable(ctx, candidate, peerID) {
			return &federatedWSSForwarder{
				router:         router,
				endpoint:       candidate.endpoint,
				relayPublicKey: candidate.relayPublicKey,
				peerID:         peerID,
			}, true
		}
	}
	return nil, false
}

func (router *StaticPeerRouter) staticFederationCandidates() []federationCandidate {
	candidates := make([]federationCandidate, 0, len(router.endpoints))
	for index, endpoint := range router.endpoints {
		candidates = append(candidates, federationCandidate{
			endpoint: endpoint,
			priority: int64(index),
		})
	}
	return candidates
}

func federationCandidatesFromHints(hints []FederationRouteHint) []federationCandidate {
	candidates := make([]federationCandidate, 0, len(hints))
	for _, hint := range hints {
		if hint.Endpoint == "" || len(hint.RelayPublicKey) != ed25519.PublicKeySize {
			continue
		}
		endpoint, err := cleanFederationEndpoint(hint.Endpoint)
		if err != nil {
			continue
		}
		candidates = append(candidates, federationCandidate{
			endpoint:       endpoint,
			relayPublicKey: append([]byte(nil), hint.RelayPublicKey...),
			priority:       hint.Priority,
		})
	}
	slices.SortFunc(candidates, func(left, right federationCandidate) int {
		if left.priority != right.priority {
			if left.priority < right.priority {
				return -1
			}
			return 1
		}
		return strings.Compare(left.endpoint, right.endpoint)
	})
	return candidates
}

func (router *StaticPeerRouter) remotePeerAvailable(ctx context.Context, candidate federationCandidate, peerID relay.PeerID) bool {
	client, err := router.dial(ctx, candidate)
	if err != nil {
		return false
	}
	defer client.close()
	return client.lookup(ctx, peerID) == nil
}

func (router *StaticPeerRouter) dial(parent context.Context, candidate federationCandidate) (*federationClient, error) {
	ctx, cancel := context.WithTimeout(parent, router.dialTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, candidate.endpoint, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(router.maxFrameBytes)
	client := &federationClient{
		conn:                   &connection{conn: conn},
		writeTimeout:           router.writeTimeout,
		random:                 router.random,
		now:                    router.now,
		maxFrameBytes:          router.maxFrameBytes,
		responses:              make(chan map[string]any, maxFederationResponses),
		expectedRelayPublicKey: append([]byte(nil), candidate.relayPublicKey...),
	}
	if err := client.attach(ctx); err != nil {
		client.close()
		return nil, err
	}
	return client, nil
}

type federatedWSSForwarder struct {
	router         *StaticPeerRouter
	endpoint       string
	relayPublicKey []byte
	peerID         relay.PeerID
	mu             sync.Mutex
	client         *federationClient
	routeID        relay.RouteID
	closed         bool
}

func (forwarder *federatedWSSForwarder) Forward(ctx context.Context, routeID relay.RouteID, payload []byte, senderPeerID relay.PeerID) error {
	forwarder.mu.Lock()
	defer forwarder.mu.Unlock()

	if forwarder.closed {
		return relay.ErrPeerUnavailable
	}
	client, err := forwarder.liveClientLocked(ctx, routeID)
	if err != nil {
		forwarder.closeLocked()
		return relay.ErrPeerUnavailable
	}
	if err := client.forwardEnvelope(ctx, routeID, payload, senderPeerID); err != nil {
		forwarder.closeLocked()
		return normalizeFederationError(err)
	}
	return nil
}

// Close tears down the live beta WSS bridge without preserving route state.
func (forwarder *federatedWSSForwarder) Close() {
	forwarder.mu.Lock()
	defer forwarder.mu.Unlock()

	forwarder.closeLocked()
}

func (forwarder *federatedWSSForwarder) liveClientLocked(ctx context.Context, routeID relay.RouteID) (*federationClient, error) {
	if forwarder.client != nil {
		if forwarder.routeID != routeID {
			return nil, relay.ErrRouteExists
		}
		return forwarder.client, nil
	}
	client, err := forwarder.router.dial(ctx, federationCandidate{
		endpoint:       forwarder.endpoint,
		relayPublicKey: forwarder.relayPublicKey,
	})
	if err != nil {
		return nil, err
	}
	if err := client.writeLookup(ctx, forwarder.peerID); err != nil {
		client.close()
		return nil, err
	}
	if err := client.writeRendezvous(ctx, routeID, forwarder.peerID); err != nil {
		client.close()
		return nil, err
	}
	client.startReadLoop(forwarder.router.localHub, routeID)
	forwarder.client = client
	forwarder.routeID = routeID
	return client, nil
}

func (forwarder *federatedWSSForwarder) closeLocked() {
	if forwarder.closed {
		return
	}
	forwarder.closed = true
	if forwarder.client != nil {
		forwarder.client.close()
		forwarder.client = nil
	}
}

type federationClient struct {
	conn                   *connection
	sessionID              string
	writeTimeout           time.Duration
	random                 io.Reader
	now                    func() time.Time
	maxFrameBytes          int64
	responses              chan map[string]any
	closeOnce              sync.Once
	expectedRelayPublicKey []byte
}

func (client *federationClient) attach(ctx context.Context) error {
	clientNonce, err := randomBytes(client.random, 32)
	if err != nil {
		return err
	}
	hello := map[string]any{
		"type":            "HELLO",
		"client_nonce":    base64URL(clientNonce),
		"client_time":     client.now().Unix(),
		"requested_role":  "relay.forward.live/0",
		"max_frame_bytes": client.maxFrameBytes,
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
	helloRaw, err := json.Marshal(hello)
	if err != nil {
		return err
	}
	if err := writeRaw(ctx, client.conn, client.writeTimeout, helloRaw); err != nil {
		return err
	}
	challengeRaw, err := readFederationRaw(ctx, client.conn)
	if err != nil {
		return err
	}
	challenge, err := readFederationObject(challengeRaw)
	if err != nil {
		return err
	}
	if err := verifyFederationChallenge(helloRaw, challenge, client.expectedRelayPublicKey); err != nil {
		return err
	}
	clientPublicKey, err := randomBytes(client.random, 32)
	if err != nil {
		return err
	}
	clientProof, err := randomBytes(client.random, 64)
	if err != nil {
		return err
	}
	auth := map[string]any{
		"type":              "AUTH",
		"client_public_key": base64URL(clientPublicKey),
		"client_nonce":      challenge["client_nonce"],
		"relay_nonce":       challenge["relay_nonce"],
		"transcript_hash":   challenge["transcript_hash"],
		"client_proof":      base64URL(clientProof),
	}
	if err := writeJSON(ctx, client.conn, client.writeTimeout, auth); err != nil {
		return err
	}
	readyRaw, err := readFederationRaw(ctx, client.conn)
	if err != nil {
		return err
	}
	ready, err := readFederationObject(readyRaw)
	if err != nil {
		return err
	}
	sessionID, ok := ready["session_id"].(string)
	if !ok || sessionID == "" {
		return ErrInvalidFrame
	}
	client.sessionID = sessionID
	return nil
}

func (client *federationClient) lookup(ctx context.Context, peerID relay.PeerID) error {
	if err := client.writeLookup(ctx, peerID); err != nil {
		return err
	}
	return client.expectNoErrorFrame(ctx)
}

func (client *federationClient) writeLookup(ctx context.Context, peerID relay.PeerID) error {
	return client.writeTyped(ctx, map[string]any{
		"type":       "LOOKUP",
		"session_id": client.sessionID,
		"peer_id":    string(peerID),
		"sequence":   1,
	})
}

func (client *federationClient) writeRendezvous(ctx context.Context, routeID relay.RouteID, peerID relay.PeerID) error {
	return client.writeTyped(ctx, map[string]any{
		"type":       "RENDEZVOUS",
		"session_id": client.sessionID,
		"route_id":   string(routeID),
		"peer_id":    string(peerID),
		"sequence":   2,
	})
}

func (client *federationClient) forwardEnvelope(ctx context.Context, routeID relay.RouteID, payload []byte, senderPeerID relay.PeerID) error {
	frame, err := readFederationObject(payload)
	if err != nil {
		return err
	}
	frame["session_id"] = client.sessionID
	frame["route_id"] = string(routeID)
	frame["ack_requested"] = true
	if senderPeerID != "" {
		frame["sender_peer_id"] = string(senderPeerID)
	}
	if err := client.writeTyped(ctx, frame); err != nil {
		return err
	}
	responseCtx, cancel := context.WithTimeout(ctx, client.writeTimeout)
	defer cancel()
	response, err := client.readResponse(responseCtx)
	if err != nil {
		return err
	}
	switch response["type"] {
	case "ACK":
		if response["ack_type"] == "relay.forwarded" && response["durable"] == false {
			return nil
		}
		return ErrInvalidFrame
	case "ERROR":
		return relayErrorFromFrame(response)
	default:
		return ErrInvalidFrame
	}
}

func (client *federationClient) startReadLoop(localHub *relay.Hub, routeID relay.RouteID) {
	go func() {
		for {
			raw, err := readFederationRaw(context.Background(), client.conn)
			if err != nil {
				return
			}
			frame, err := readFederationObject(raw)
			if err != nil {
				return
			}
			switch frame["type"] {
			case "ACK", "ERROR":
				select {
				case client.responses <- frame:
				default:
					return
				}
			case "ENVELOPE":
				if err := localHub.DeliverFromFederated(context.Background(), routeID, raw, senderPeerIDFromFrame(raw)); err != nil {
					return
				}
			default:
				return
			}
		}
	}()
}

func (client *federationClient) readResponse(ctx context.Context) (map[string]any, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case response := <-client.responses:
		return response, nil
	}
}

func (client *federationClient) writeTyped(ctx context.Context, frame map[string]any) error {
	return writeJSON(ctx, client.conn, client.writeTimeout, frame)
}

func (client *federationClient) expectNoErrorFrame(ctx context.Context) error {
	readCtx, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	raw, err := readFederationRaw(readCtx, client.conn)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil
		}
		return relay.ErrPeerUnavailable
	}
	frame, err := readFederationObject(raw)
	if err != nil {
		return err
	}
	if frame["type"] == "ERROR" {
		return relayErrorFromFrame(frame)
	}
	return ErrInvalidFrame
}

func (client *federationClient) close() {
	client.closeOnce.Do(func() {
		_ = client.conn.conn.Close(websocket.StatusNormalClosure, "")
	})
}

func readFederationRaw(ctx context.Context, conn *connection) ([]byte, error) {
	messageType, data, err := conn.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
		return nil, ErrInvalidFrame
	}
	return data, nil
}

func readFederationObject(data []byte) (map[string]any, error) {
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(data); err != nil {
		return nil, err
	}
	var frame map[string]any
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil, ErrInvalidFrame
	}
	return frame, nil
}

func verifyFederationChallenge(helloRaw []byte, challenge map[string]any, expectedRelayPublicKey []byte) error {
	selected, ok := challenge["selected"].(map[string]any)
	if !ok {
		return ErrInvalidFrame
	}
	clientNonce, err := decodeBase64(challenge["client_nonce"].(string), 32)
	if err != nil {
		return err
	}
	relayNonce, err := decodeBase64(challenge["relay_nonce"].(string), 32)
	if err != nil {
		return err
	}
	relayPublicKey, err := decodeBase64(challenge["relay_public_key"].(string), 32)
	if err != nil {
		return err
	}
	if len(expectedRelayPublicKey) > 0 && !bytes.Equal(relayPublicKey, expectedRelayPublicKey) {
		return ErrInvalidFrame
	}
	transcriptHash := challengeTranscriptHash(helloRaw, selected, clientNonce, relayNonce, relayPublicKey)
	encodedHash, ok := challenge["transcript_hash"].(string)
	if !ok {
		return ErrInvalidFrame
	}
	if encodedHash != base64URL(transcriptHash) {
		return ErrInvalidFrame
	}
	proof, err := decodeBase64(challenge["relay_proof"].(string), 64)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(relayPublicKey), proofInput(transcriptHash), proof) {
		return ErrInvalidFrame
	}
	return nil
}

func relayErrorFromFrame(frame map[string]any) error {
	switch frame["code"] {
	case "peer_unavailable", "route_unavailable", "timeout":
		return relay.ErrPeerUnavailable
	case "frame_too_large":
		return relay.ErrFrameTooLarge
	case "quota_exceeded":
		return relay.ErrQuotaExceeded
	case "rate_limited":
		return relay.ErrBackpressure
	default:
		return ErrInvalidFrame
	}
}

func normalizeFederationError(err error) error {
	switch {
	case errors.Is(err, relay.ErrPeerUnavailable),
		errors.Is(err, relay.ErrNoRoute),
		errors.Is(err, relay.ErrSessionClosed),
		errors.Is(err, relay.ErrSessionNotFound),
		errors.Is(err, context.Canceled),
		errors.Is(err, context.DeadlineExceeded):
		return relay.ErrPeerUnavailable
	case errors.Is(err, relay.ErrFrameTooLarge):
		return relay.ErrFrameTooLarge
	case errors.Is(err, relay.ErrQuotaExceeded):
		return relay.ErrQuotaExceeded
	case errors.Is(err, relay.ErrBackpressure):
		return relay.ErrBackpressure
	default:
		return relay.ErrPeerUnavailable
	}
}

func cleanFederationEndpoints(raw []string, maxEndpoints int) ([]string, error) {
	if len(raw) > maxEndpoints {
		return nil, fmt.Errorf("%w: too many federation peers", ErrInvalidConfig)
	}
	endpoints := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, endpoint := range raw {
		cleaned, err := cleanFederationEndpoint(endpoint)
		if err != nil {
			return nil, err
		}
		if cleaned == "" {
			continue
		}
		if _, exists := seen[cleaned]; exists {
			continue
		}
		seen[cleaned] = struct{}{}
		endpoints = append(endpoints, cleaned)
	}
	return endpoints, nil
}

func cleanFederationEndpoint(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if len([]byte(value)) > maxFederationEndpointBytes || strings.ContainsAny(value, " \t\r\n") {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	if parsed.Path == "" {
		parsed.Path = Path
	}
	if parsed.Path != Path {
		return "", fmt.Errorf("%w: invalid federation peer path", ErrInvalidConfig)
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}
