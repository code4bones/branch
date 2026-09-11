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
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/code4bones/branch/internal/discovery"
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

// StaticPeerRouterConfig is retained as a bounded test adapter for pinned WSS
// fixtures. The branch-node composition root does not expose it as deployment
// configuration; discovered federation uses DiscoveredPeerRouter instead.
type StaticPeerRouterConfig struct {
	Peers            []FederationPeer
	LocalHub         *relay.Hub
	EndpointPolicy   FederationEndpointPolicy
	Random           io.Reader
	Now              func() time.Time
	MaxFrameBytes    int64
	DialTimeout      time.Duration
	WriteTimeout     time.Duration
	MaxPeerEndpoints int
}

// FederationPeer is an operator-pinned relay candidate. Its key and profile
// are mandatory because a TLS endpoint is route material, never relay identity.
type FederationPeer struct {
	Endpoint         string
	RelayPublicKey   string
	ProfileMultihash string
}

// FederationEndpointPolicy controls development-only transport exceptions.
// Production defaults are WSS-only and reject private/special destinations.
type FederationEndpointPolicy struct {
	AllowInsecureWS       bool
	AllowPrivateAddresses bool
}

// StaticPeerRouter probes a bounded fixture peer set for tests and keeps no
// durable route catalog. It is not the production discovery topology.
type StaticPeerRouter struct {
	peers          []federationCandidate
	localHub       *relay.Hub
	endpointPolicy FederationEndpointPolicy
	random         io.Reader
	now            func() time.Time
	maxFrameBytes  int64
	dialTimeout    time.Duration
	writeTimeout   time.Duration
	diagMu         sync.Mutex
	diagnostics    map[string]FederationPeerObservation
	nextPeerRef    uint64
}

type federationCandidate struct {
	endpoint         string
	relayPublicKey   []byte
	profileMultihash string
	priority         int64
	identityKey      string
	expiresAt        time.Time
}

// FederationPeerObservation is a bounded operator snapshot of one relay peer
// probe. PeerRef is process-local and intentionally does not expose a public
// endpoint URL, key, BranchID, route, session, or payload.
type FederationPeerObservation struct {
	PeerRef      string
	State        string
	LastLookupAt time.Time
	LastReason   string
	LookupCount  uint64
	BridgeCount  int
	FreshUntil   time.Time
}

// NewStaticPeerRouter creates the bounded fixture adapter.
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
	peers, err := cleanFederationPeers(config.Peers, maxEndpoints, config.EndpointPolicy)
	if err != nil {
		return nil, err
	}
	router := &StaticPeerRouter{
		peers:          peers,
		localHub:       config.LocalHub,
		endpointPolicy: config.EndpointPolicy,
		random:         config.Random,
		now:            config.Now,
		maxFrameBytes:  config.MaxFrameBytes,
		dialTimeout:    config.DialTimeout,
		writeTimeout:   config.WriteTimeout,
		diagnostics:    make(map[string]FederationPeerObservation, len(peers)),
	}
	for _, peer := range peers {
		router.nextPeerRef++
		router.diagnostics[peer.endpoint] = FederationPeerObservation{
			PeerRef: "peer-" + strconv.FormatUint(router.nextPeerRef, 10),
			State:   "configured",
		}
	}
	return router, nil
}

// ID returns the bounded source identifier used in operator lookup traces.
func (router *StaticPeerRouter) ID() string {
	return "relay_mesh"
}

// LookupFederatedPeer probes configured peers for one currently reachable peer.
func (router *StaticPeerRouter) LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) (relay.FederatedForwarder, bool) {
	// Attachment-frame hints are carrier-controlled bytes. They are never used
	// as federation candidates until a future profile defines signed provenance.
	_ = hints
	for _, candidate := range router.staticFederationCandidates() {
		if err := ctx.Err(); err != nil {
			return nil, false
		}
		available, reason := router.remotePeerAvailable(ctx, candidate, peerID)
		state := "unreachable"
		bridgeCount := 0
		if available {
			state = "reachable"
			bridgeCount = 1
		}
		router.recordPeerObservation(candidate.endpoint, state, reason, bridgeCount, now)
		if available {
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

// LookupIdentityContact asks configured peer relays for exact signed
// identity.announce source records. Peer requests use hop_limit=0 to avoid
// recursive mesh loops.
func (router *StaticPeerRouter) LookupIdentityContact(ctx context.Context, branchID string) ([]discovery.IdentityContactCandidate, error) {
	if err := protocol.ParseBranchID(branchID); err != nil {
		return nil, ErrInvalidFrame
	}
	var candidates []discovery.IdentityContactCandidate
	now := router.now()
	for _, candidate := range router.staticFederationCandidates() {
		if err := ctx.Err(); err != nil {
			return candidates, err
		}
		client, err := router.dial(ctx, candidate)
		if err != nil {
			router.recordPeerObservation(candidate.endpoint, "unreachable", "identity_dial_failed", 0, now)
			continue
		}
		records, err := client.lookupIdentityContact(ctx, branchID)
		client.close()
		if err != nil {
			router.recordPeerObservation(candidate.endpoint, "unreachable", "identity_unavailable", 0, now)
			continue
		}
		router.recordPeerObservation(candidate.endpoint, "reachable", "identity_lookup_ok", 0, now)
		for _, record := range records {
			candidates = append(candidates, discovery.IdentityContactCandidate{
				Wrapper: record,
				Source:  candidate.endpoint,
			})
			if len(candidates) >= maxFederationResponses {
				return candidates, nil
			}
		}
	}
	return candidates, nil
}

// FederationSnapshot returns a detached bounded view of relay mesh probes for
// the protected operator monitor plane.
func (router *StaticPeerRouter) FederationSnapshot() []FederationPeerObservation {
	router.diagMu.Lock()
	defer router.diagMu.Unlock()

	router.prunePeerObservationsLocked(router.now())
	observations := make([]FederationPeerObservation, 0, len(router.peers)+len(router.diagnostics))
	included := make(map[string]struct{}, len(router.peers)+len(router.diagnostics))
	for _, peer := range router.peers {
		endpoint := peer.endpoint
		observation, ok := router.diagnostics[endpoint]
		if !ok {
			observation = FederationPeerObservation{
				PeerRef: router.nextPeerReferenceLocked(),
				State:   "configured",
			}
			router.diagnostics[endpoint] = observation
		}
		observations = append(observations, observation)
		included[endpoint] = struct{}{}
	}
	for endpoint, observation := range router.diagnostics {
		if _, ok := included[endpoint]; ok {
			continue
		}
		observations = append(observations, observation)
	}
	slices.SortFunc(observations, func(left, right FederationPeerObservation) int {
		return strings.Compare(left.PeerRef, right.PeerRef)
	})
	if len(observations) > maxFederationPeers {
		return observations[:maxFederationPeers]
	}
	return observations
}

func (router *StaticPeerRouter) staticFederationCandidates() []federationCandidate {
	return append([]federationCandidate(nil), router.peers...)
}

func (router *StaticPeerRouter) remotePeerAvailable(ctx context.Context, candidate federationCandidate, peerID relay.PeerID) (bool, string) {
	client, err := router.dial(ctx, candidate)
	if err != nil {
		return false, "dial_failed"
	}
	defer client.close()
	if err := client.lookup(ctx, peerID); err != nil {
		return false, "peer_unavailable"
	}
	return true, "lookup_ok"
}

func (router *StaticPeerRouter) recordPeerObservation(endpoint string, state string, reason string, bridgeCount int, now time.Time) {
	router.recordPeerObservationUntil(endpoint, state, reason, bridgeCount, now, now.Add(router.localHub.PresenceTTL()))
}

func (router *StaticPeerRouter) recordPeerObservationUntil(endpoint string, state string, reason string, bridgeCount int, now time.Time, freshUntil time.Time) {
	router.diagMu.Lock()
	defer router.diagMu.Unlock()

	router.prunePeerObservationsLocked(now)
	observation := router.diagnostics[endpoint]
	if observation.PeerRef == "" {
		if len(router.diagnostics) >= maxFederationPeers {
			router.evictOldestPeerObservationLocked()
		}
		observation.PeerRef = router.nextPeerReferenceLocked()
	}
	observation.State = state
	observation.LastLookupAt = now.UTC()
	observation.LastReason = reason
	observation.LookupCount++
	observation.BridgeCount = bridgeCount
	observation.FreshUntil = freshUntil.UTC()
	router.diagnostics[endpoint] = observation
}

func (router *StaticPeerRouter) prunePeerObservationsLocked(now time.Time) {
	for endpoint, observation := range router.diagnostics {
		if !observation.FreshUntil.IsZero() && !observation.FreshUntil.After(now) {
			delete(router.diagnostics, endpoint)
		}
	}
}

func (router *StaticPeerRouter) evictOldestPeerObservationLocked() {
	var oldestEndpoint string
	var oldest time.Time
	for endpoint, observation := range router.diagnostics {
		if oldestEndpoint == "" || observation.LastLookupAt.Before(oldest) {
			oldestEndpoint, oldest = endpoint, observation.LastLookupAt
		}
	}
	if oldestEndpoint != "" {
		delete(router.diagnostics, oldestEndpoint)
	}
}

func (router *StaticPeerRouter) nextPeerReferenceLocked() string {
	router.nextPeerRef++
	return "peer-" + strconv.FormatUint(router.nextPeerRef, 10)
}

func (router *StaticPeerRouter) dial(parent context.Context, candidate federationCandidate) (*federationClient, error) {
	ctx, cancel := context.WithTimeout(parent, router.dialTimeout)
	defer cancel()
	httpClient, err := router.federationHTTPClient(ctx, candidate.endpoint)
	if err != nil {
		return nil, err
	}
	conn, _, err := websocket.Dial(ctx, candidate.endpoint, &websocket.DialOptions{HTTPClient: httpClient})
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
		expectedProfile:        candidate.profileMultihash,
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
	dial           func(context.Context, federationCandidate) (*federationClient, error)
	mu             sync.Mutex
	client         *federationClient
	routeID        relay.RouteID
	closed         bool
	observer       FederationObserver
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
	forwardStarted := time.Now()
	if err := client.forwardEnvelope(ctx, routeID, payload, senderPeerID); err != nil {
		forwarder.observe(ctx, FederationForwardFailed, federationFailureReason(err), time.Since(forwardStarted))
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
	started := time.Now()
	dial := forwarder.dial
	if dial == nil {
		dial = forwarder.router.dial
	}
	client, err := dial(ctx, federationCandidate{
		endpoint:         forwarder.endpoint,
		relayPublicKey:   forwarder.relayPublicKey,
		profileMultihash: protocol.DevelopmentProfileMultihash,
	})
	if err != nil {
		forwarder.observe(ctx, FederationBridgeFailed, federationFailureReason(err), time.Since(started))
		return nil, err
	}
	lookup := client.writeLookup
	if client.requestedRole == protocol.RelayFederationLiveRole {
		lookup = client.lookup
	}
	if err := lookup(ctx, forwarder.peerID); err != nil {
		client.close()
		forwarder.observe(ctx, FederationBridgeFailed, federationFailureReason(err), time.Since(started))
		return nil, err
	}
	if err := client.writeRendezvous(ctx, routeID, forwarder.peerID); err != nil {
		client.close()
		forwarder.observe(ctx, FederationBridgeFailed, federationFailureReason(err), time.Since(started))
		return nil, err
	}
	client.startReadLoop(forwarder.router.localHub, routeID)
	forwarder.client = client
	forwarder.routeID = routeID
	forwarder.observe(ctx, FederationBridgeEstablished, "success", time.Since(started))
	return client, nil
}

func (forwarder *federatedWSSForwarder) observe(ctx context.Context, kind FederationObservationKind, reason string, duration time.Duration) {
	federationObserverOrNoop(forwarder.observer).ObserveFederation(ctx, FederationObservation{Kind: kind, Reason: reason, Duration: duration})
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
	expectedProfile        string
	requestedRole          string
	relayBeacon            string
	clientPublicKey        ed25519.PublicKey
	clientSign             func([]byte) []byte
}

func (client *federationClient) attach(ctx context.Context) error {
	clientNonce, err := randomBytes(client.random, 32)
	if err != nil {
		return err
	}
	requestedRole := client.requestedRole
	if requestedRole == "" {
		requestedRole = protocol.RelayForwardLiveRole
	}
	hello := map[string]any{
		"type":            "HELLO",
		"client_nonce":    base64URL(clientNonce),
		"client_time":     client.now().Unix(),
		"requested_role":  requestedRole,
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
	if requestedRole == protocol.RelayFederationLiveRole {
		if client.relayBeacon == "" || len(client.clientPublicKey) != ed25519.PublicKeySize || client.clientSign == nil {
			return ErrInvalidFrame
		}
		hello["relay_beacon"] = client.relayBeacon
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
	if err := verifyFederationChallenge(helloRaw, challenge, client.expectedRelayPublicKey, client.expectedProfile); err != nil {
		return err
	}
	clientPublicKey := client.clientPublicKey
	clientSign := client.clientSign
	if len(clientPublicKey) == 0 {
		generatedPublicKey, clientPrivateKey, err := ed25519.GenerateKey(client.random)
		if err != nil {
			return err
		}
		clientPublicKey = generatedPublicKey
		clientSign = func(input []byte) []byte { return ed25519.Sign(clientPrivateKey, input) }
	}
	transcriptHash, err := decodeBase64(challenge["transcript_hash"].(string), 32)
	if err != nil {
		return err
	}
	clientProof := clientSign(proofInput(transcriptHash))
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
	if client.requestedRole == protocol.RelayFederationLiveRole {
		return client.expectFederationLookupAck(ctx)
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

func (client *federationClient) lookupIdentityContact(ctx context.Context, branchID string) ([]string, error) {
	if err := client.writeTyped(ctx, map[string]any{
		"type":       "IDENTITY_WANT",
		"session_id": client.sessionID,
		"branch_id":  branchID,
		"sequence":   1,
		"hop_limit":  0,
	}); err != nil {
		return nil, err
	}
	responseCtx, cancel := context.WithTimeout(ctx, client.writeTimeout)
	defer cancel()
	raw, err := readFederationRaw(responseCtx, client.conn)
	if err != nil {
		return nil, err
	}
	response, err := readFederationObject(raw)
	if err != nil {
		return nil, err
	}
	switch response["type"] {
	case "IDENTITY_HAVE":
		if response["branch_id"] != branchID {
			return nil, ErrInvalidFrame
		}
		return identityRecordStringsFromFrame(response)
	case "ERROR":
		return nil, relayErrorFromFrame(response)
	default:
		return nil, ErrInvalidFrame
	}
}

func (client *federationClient) lookupFederatedIdentityContact(ctx context.Context, branchID string) ([]string, error) {
	if client.requestedRole != protocol.RelayFederationLiveRole || len(client.clientPublicKey) != ed25519.PublicKeySize {
		return nil, ErrInvalidFrame
	}
	requestID, err := randomBytes(client.random, 16)
	if err != nil {
		return nil, err
	}
	if err := client.writeTyped(ctx, map[string]any{
		"type":             "IDENTITY_WANT",
		"session_id":       client.sessionID,
		"branch_id":        branchID,
		"sequence":         1,
		"request_id":       base64URL(requestID),
		"origin_relay_key": base64URL(client.clientPublicKey),
		"hop_limit":        1,
	}); err != nil {
		return nil, err
	}
	responseCtx, cancel := context.WithTimeout(ctx, client.writeTimeout)
	defer cancel()
	raw, err := readFederationRaw(responseCtx, client.conn)
	if err != nil {
		return nil, err
	}
	response, err := readFederationObject(raw)
	if err != nil {
		return nil, err
	}
	switch response["type"] {
	case "IDENTITY_HAVE":
		if response["branch_id"] != branchID {
			return nil, ErrInvalidFrame
		}
		return identityRecordStringsFromFrame(response)
	case "ERROR":
		return nil, relayErrorFromFrame(response)
	default:
		return nil, ErrInvalidFrame
	}
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

func (client *federationClient) expectFederationLookupAck(ctx context.Context) error {
	responseCtx, cancel := context.WithTimeout(ctx, client.writeTimeout)
	defer cancel()
	raw, err := readFederationRaw(responseCtx, client.conn)
	if err != nil {
		return relay.ErrPeerUnavailable
	}
	frame, err := readFederationObject(raw)
	if err != nil {
		return err
	}
	switch frame["type"] {
	case "ACK":
		if frame["ack_type"] == "relay.accepted" && frame["durable"] == false {
			return nil
		}
		return ErrInvalidFrame
	case "ERROR":
		return relayErrorFromFrame(frame)
	default:
		return ErrInvalidFrame
	}
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

func verifyFederationChallenge(helloRaw []byte, challenge map[string]any, expectedRelayPublicKey []byte, expectedProfile string) error {
	if len(expectedRelayPublicKey) != ed25519.PublicKeySize || expectedProfile == "" {
		return ErrInvalidFrame
	}
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
	if !bytes.Equal(relayPublicKey, expectedRelayPublicKey) {
		return ErrInvalidFrame
	}
	profileMultihash, ok := selected["profile_multihash"].(string)
	if !ok || profileMultihash != expectedProfile {
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

func cleanFederationPeers(raw []FederationPeer, maxEndpoints int, policy FederationEndpointPolicy) ([]federationCandidate, error) {
	if len(raw) > maxEndpoints {
		return nil, fmt.Errorf("%w: too many federation peers", ErrInvalidConfig)
	}
	peers := make([]federationCandidate, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for index, peer := range raw {
		cleaned, err := cleanFederationEndpoint(peer.Endpoint, policy)
		if err != nil {
			return nil, err
		}
		if cleaned == "" || peer.ProfileMultihash != protocol.DevelopmentProfileMultihash {
			return nil, fmt.Errorf("%w: invalid federation peer profile", ErrInvalidConfig)
		}
		if _, exists := seen[cleaned]; exists {
			return nil, fmt.Errorf("%w: duplicate federation peer endpoint", ErrInvalidConfig)
		}
		key, err := decodeBase64(strings.TrimSpace(peer.RelayPublicKey), ed25519.PublicKeySize)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid federation relay public key", ErrInvalidConfig)
		}
		seen[cleaned] = struct{}{}
		peers = append(peers, federationCandidate{
			endpoint:         cleaned,
			relayPublicKey:   key,
			profileMultihash: peer.ProfileMultihash,
			priority:         int64(index),
		})
	}
	return peers, nil
}

func cleanFederationEndpoint(raw string, policy FederationEndpointPolicy) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%w: missing federation peer endpoint", ErrInvalidConfig)
	}
	if len([]byte(value)) > maxFederationEndpointBytes || strings.ContainsAny(value, " \t\r\n") {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	if parsed.Scheme != "wss" && !(policy.AllowInsecureWS && parsed.Scheme == "ws") {
		return "", fmt.Errorf("%w: invalid federation peer endpoint", ErrInvalidConfig)
	}
	if parsed.Path != Path || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil || parsed.Port() == "" {
		return "", fmt.Errorf("%w: invalid federation peer path", ErrInvalidConfig)
	}
	if address, err := netip.ParseAddr(parsed.Hostname()); err == nil && !policy.AllowPrivateAddresses && privateOrSpecialAddress(address) {
		return "", fmt.Errorf("%w: federation peer address is not public", ErrInvalidConfig)
	}
	return parsed.String(), nil
}

func (router *StaticPeerRouter) federationHTTPClient(ctx context.Context, endpoint string) (*http.Client, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	addresses, err := resolveFederationAddresses(ctx, parsed.Hostname(), router.endpointPolicy)
	if err != nil {
		return nil, err
	}
	port := parsed.Port()
	dialer := net.Dialer{}
	transport := &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     false,
		TLSHandshakeTimeout:   router.dialTimeout,
		ResponseHeaderTimeout: router.dialTimeout,
		DialContext: func(dialCtx context.Context, network string, _ string) (net.Conn, error) {
			var lastErr error
			for _, address := range addresses {
				connection, err := dialer.DialContext(dialCtx, network, net.JoinHostPort(address.String(), port))
				if err == nil {
					return connection, nil
				}
				lastErr = err
			}
			if lastErr == nil {
				lastErr = ErrInvalidConfig
			}
			return nil, lastErr
		},
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("federation redirect forbidden")
		},
	}, nil
}

func resolveFederationAddresses(ctx context.Context, host string, policy FederationEndpointPolicy) ([]netip.Addr, error) {
	if address, err := netip.ParseAddr(host); err == nil {
		address = address.Unmap()
		if !policy.AllowPrivateAddresses && privateOrSpecialAddress(address) {
			return nil, ErrInvalidConfig
		}
		return []netip.Addr{address}, nil
	}
	resolved, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(resolved) == 0 || len(resolved) > maxFederationPeers {
		return nil, ErrInvalidConfig
	}
	addresses := make([]netip.Addr, 0, len(resolved))
	seen := make(map[netip.Addr]struct{}, len(resolved))
	for _, address := range resolved {
		address = address.Unmap()
		if !policy.AllowPrivateAddresses && privateOrSpecialAddress(address) {
			return nil, ErrInvalidConfig
		}
		if _, ok := seen[address]; ok {
			continue
		}
		seen[address] = struct{}{}
		addresses = append(addresses, address)
	}
	if len(addresses) == 0 {
		return nil, ErrInvalidConfig
	}
	return addresses, nil
}

func privateOrSpecialAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified() {
		return true
	}
	if address.Is4() {
		return netip.MustParsePrefix("100.64.0.0/10").Contains(address) ||
			netip.MustParsePrefix("192.0.0.0/24").Contains(address) ||
			netip.MustParsePrefix("192.0.2.0/24").Contains(address) ||
			netip.MustParsePrefix("198.18.0.0/15").Contains(address) ||
			netip.MustParsePrefix("198.51.100.0/24").Contains(address) ||
			netip.MustParsePrefix("203.0.113.0/24").Contains(address)
	}
	return netip.MustParsePrefix("2001:db8::/32").Contains(address)
}
