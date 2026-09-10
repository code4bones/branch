package wss

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

const (
	// Path is the public same-relay WSS attachment endpoint.
	Path = "/relay/v0"

	maxIdentityHaveRecords      = 4
	maxFederationRequestEntries = 64
	federationRequestLifetime   = time.Minute
)

var (
	ErrInvalidConfig        = errors.New("wss relay invalid config")
	ErrInvalidFrame         = errors.New("wss relay invalid frame")
	ErrAuthenticationFailed = errors.New("wss relay authentication failed")
	ErrFrameReplayed        = errors.New("wss relay frame replayed")
)

// Config defines explicit adapter bounds and dependencies.
type Config struct {
	Hub              *relay.Hub
	Identity         *identity.NodeIdentity
	IdentityContacts *discovery.IdentityContactCache
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
	LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) (relay.FederatedForwarder, bool)
}

// FederationRouteHint is a client-discovered relay endpoint candidate for one
// concrete route attempt. It is not cached as a relay directory.
type FederationRouteHint struct {
	Endpoint       string
	RelayPublicKey []byte
	Priority       int64
}

// Handler adapts a live non-durable relay Hub to the /relay/v0 WebSocket
// attachment surface.
type Handler struct {
	hub                *relay.Hub
	identity           *identity.NodeIdentity
	identityContacts   *discovery.IdentityContactCache
	peerRouter         PeerRouter
	random             io.Reader
	now                func() time.Time
	originPatterns     []string
	maxFrameBytes      int64
	handshakeTimeout   time.Duration
	writeTimeout       time.Duration
	federationRequests federationRequestWindow
	contactDiscovery   contactDiscovery
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
		hub:                config.Hub,
		identity:           config.Identity,
		identityContacts:   config.IdentityContacts,
		peerRouter:         config.PeerRouter,
		random:             config.Random,
		now:                config.Now,
		originPatterns:     originPatterns,
		maxFrameBytes:      config.MaxFrameBytes,
		handshakeTimeout:   config.HandshakeTimeout,
		writeTimeout:       config.WriteTimeout,
		federationRequests: federationRequestWindow{entries: make(map[federationRequestKey]time.Time, maxFederationRequestEntries)},
		contactDiscovery:   newContactDiscovery(),
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
	hello, err := decodeHello(helloRaw, handler.now().Unix())
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
	authenticatedPeerID, err := validateAuth(authRaw, hello.ClientNonce, relayNonce, transcriptHash, hello.FederationPublicKey)
	if err != nil {
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
	defer handler.contactDiscovery.remove(relay.SessionID(sessionID))

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
	go handler.readLoop(runCtx, conn, session, relay.SessionID(sessionID), authenticatedPeerID, len(hello.FederationPublicKey) > 0, offerHasExtension(hello.SelectedOffer, protocol.ContactDiscoveryLiveExtension), errs)
	err = <-errs
	stop()
	return err
}

func (handler *Handler) readLoop(ctx context.Context, conn *connection, session *relay.Session, sessionID relay.SessionID, authenticatedPeerID relay.PeerID, federationAttachment bool, contactDiscoveryEnabled bool, errs chan<- error) {
	sequences := sequenceTracker{}
	for {
		raw, err := readFrame(ctx, conn)
		if err != nil {
			errs <- err
			return
		}
		if err := handler.handleFrame(ctx, conn, session, sessionID, authenticatedPeerID, federationAttachment, contactDiscoveryEnabled, &sequences, raw); err != nil {
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
		payload, err := deliveryPayload(frame)
		if err != nil {
			errs <- err
			return
		}
		if err := writeRaw(ctx, conn, handler.writeTimeout, payload); err != nil {
			errs <- err
			return
		}
	}
}

func (handler *Handler) handleFrame(ctx context.Context, conn *connection, session *relay.Session, sessionID relay.SessionID, authenticatedPeerID relay.PeerID, federationAttachment bool, contactDiscoveryEnabled bool, sequences *sequenceTracker, raw []byte) error {
	frame, err := decodeTypedFrame(raw)
	if err != nil {
		return err
	}
	if sid, ok := frame["session_id"].(string); ok && relay.SessionID(sid) != sessionID {
		return ErrInvalidFrame
	}
	if err := sequences.accept(frame); err != nil {
		return err
	}

	switch frame["type"] {
	case "CONTACT_ANNOUNCE":
		if federationAttachment || !contactDiscoveryEnabled {
			return ErrInvalidFrame
		}
		key, err := decodeBase64(string(authenticatedPeerID), 32)
		if err != nil {
			return ErrAuthenticationFailed
		}
		branchID, err := protocol.BranchIDFromPublicKey(key)
		if err != nil {
			return ErrAuthenticationFailed
		}
		discoverable, ok := frame["discoverable"].(bool)
		if !ok {
			return ErrInvalidFrame
		}
		handler.contactDiscovery.announce(sessionID, branchID, authenticatedPeerID, conn, discoverable)
		return nil
	case "CONTACT_LOOKUP":
		if federationAttachment || !contactDiscoveryEnabled {
			return ErrInvalidFrame
		}
		issued, ok := numericField(frame["issued_at"])
		if !ok {
			return ErrInvalidFrame
		}
		expires, ok := numericField(frame["expires_at"])
		if !ok {
			return ErrInvalidFrame
		}
		now := handler.now()
		issuedAt, expiresAt := time.UnixMilli(issued), time.UnixMilli(expires)
		if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > contactDiscoveryWindow || !expiresAt.After(now) || issuedAt.After(now.Add(contactDiscoveryWindow)) {
			return ErrFrameReplayed
		}
		target, ok := handler.contactDiscovery.reserve(sessionID, frame["request_id"].(string), frame["branch_id"].(string), now, expiresAt)
		if !ok {
			return nil
		}
		probe := map[string]any{"type": "CONTACT_PROBE", "session_id": string(target.sessionID), "request_id": frame["request_id"], "branch_id": frame["branch_id"], "requester_peer_id": string(authenticatedPeerID), "requester_hpke_public_key": frame["requester_hpke_public_key"], "issued_at": issued, "expires_at": expires}
		if err := writeJSON(ctx, target.conn, handler.writeTimeout, probe); err != nil {
			handler.contactDiscovery.remove(target.sessionID)
		}
		return nil
	case "CONTACT_PROBE":
		return ErrInvalidFrame
	case "PRESENCE":
		if relay.PeerID(frame["peer_id"].(string)) != authenticatedPeerID {
			return ErrAuthenticationFailed
		}
		return session.AnnouncePresence(authenticatedPeerID, handler.now())
	case "HEARTBEAT":
		return session.Heartbeat(handler.now())
	case "LOOKUP":
		peerID := relay.PeerID(frame["peer_id"].(string))
		now := handler.now()
		if _, ok := handler.hub.Lookup(peerID, now); ok {
			if federationAttachment {
				return handler.writeFederationLookupAck(ctx, conn, string(sessionID))
			}
			return nil
		}
		if !federationAttachment {
			if forwarder, ok := handler.lookupFederatedPeer(ctx, peerID, nil, now); ok {
				closeFederatedForwarder(forwarder)
				return nil
			}
		}
		return relay.ErrPeerUnavailable
	case "IDENTITY_WANT":
		return handler.handleIdentityWant(ctx, conn, frame, authenticatedPeerID, federationAttachment)
	case "IDENTITY_HAVE":
		return handler.handleIdentityHave(frame)
	case "RENDEZVOUS":
		routeID := relay.RouteID(frame["route_id"].(string))
		peerID := relay.PeerID(frame["peer_id"].(string))
		hints, err := routeHintsFromFrame(frame)
		if err != nil {
			return err
		}
		now := handler.now()
		if err := session.Rendezvous(routeID, peerID, now); err != nil {
			if !errors.Is(err, relay.ErrPeerUnavailable) {
				return err
			}
			if federationAttachment {
				return relay.ErrPeerUnavailable
			}
			if federatedErr := handler.announceFederatedPeer(ctx, peerID, hints, now); federatedErr != nil {
				return err
			}
			return session.Rendezvous(routeID, peerID, now)
		}
		return nil
	case "ENVELOPE":
		routeID := relay.RouteID(frame["route_id"].(string))
		delivery, err := deliveryFromFrame(frame)
		if err != nil {
			return err
		}
		err = session.SendDelivery(ctx, routeID, raw, delivery, handler.now())
		if err != nil && !errors.Is(err, relay.ErrDuplicateDelivery) {
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

func offerHasExtension(offer map[string]any, extension string) bool {
	values, ok := offer["extensions"].([]any)
	if !ok {
		return false
	}
	for _, value := range values {
		if value == extension {
			return true
		}
	}
	return false
}

type sequenceTracker struct {
	set  bool
	last uint64
}

func (tracker *sequenceTracker) accept(frame map[string]any) error {
	switch frame["type"] {
	case "PRESENCE", "HEARTBEAT", "LOOKUP", "IDENTITY_WANT", "IDENTITY_HAVE", "RENDEZVOUS":
		sequence, ok := numericField(frame["sequence"])
		if !ok {
			return ErrInvalidFrame
		}
		value := uint64(sequence)
		if tracker.set && value <= tracker.last {
			return ErrFrameReplayed
		}
		tracker.set = true
		tracker.last = value
	}
	return nil
}

func deliveryFromFrame(frame map[string]any) (relay.Delivery, error) {
	streamID, ok := numericField(frame["stream_id"])
	if !ok {
		return relay.Delivery{}, ErrInvalidFrame
	}
	deliveryID, ok := frame["delivery_id"].(string)
	if !ok || deliveryID == "" {
		return relay.Delivery{}, ErrInvalidFrame
	}
	canonical, err := json.Marshal(frame)
	if err != nil {
		return relay.Delivery{}, ErrInvalidFrame
	}
	return relay.Delivery{
		StreamID: uint64(streamID),
		ID:       deliveryID,
		Digest:   sha256.Sum256(canonical),
	}, nil
}

func (handler *Handler) handleIdentityWant(ctx context.Context, conn *connection, frame map[string]any, authenticatedPeerID relay.PeerID, federationAttachment bool) error {
	branchID := frame["branch_id"].(string)
	sequence, ok := numericField(frame["sequence"])
	if !ok {
		return ErrInvalidFrame
	}
	hopLimit, ok := numericField(frame["hop_limit"])
	if !ok {
		return ErrInvalidFrame
	}
	if federationAttachment {
		origin, ok := frame["origin_relay_key"].(string)
		if !ok || origin != string(authenticatedPeerID) {
			return ErrAuthenticationFailed
		}
		requestID, ok := frame["request_id"].(string)
		if !ok || hopLimit > 1 {
			return ErrInvalidFrame
		}
		if !handler.federationRequests.reserve(authenticatedPeerID, requestID, handler.now()) {
			return ErrFrameReplayed
		}
		// A federated request is consumed here. It may read its own volatile
		// cache, but can never invoke carrier or relay discovery recursively.
		hopLimit = 0
	} else if _, hasFederationContext := frame["request_id"]; hasFederationContext {
		return ErrInvalidFrame
	}
	records := handler.identityRecordsForBranchID(ctx, branchID, int(hopLimit))
	response := map[string]any{
		"type":       "IDENTITY_HAVE",
		"session_id": frame["session_id"].(string),
		"branch_id":  branchID,
		"sequence":   sequence,
		"records":    records,
	}
	return writeJSON(ctx, conn, handler.writeTimeout, response)
}

type federationRequestKey struct {
	origin    relay.PeerID
	requestID string
}

// federationRequestWindow is deliberately process-local. It suppresses a
// repeated one-hop federation request without retaining identity records,
// topology, presence, or request state across restart.
type federationRequestWindow struct {
	mu      sync.Mutex
	entries map[federationRequestKey]time.Time
}

func (window *federationRequestWindow) reserve(origin relay.PeerID, requestID string, now time.Time) bool {
	window.mu.Lock()
	defer window.mu.Unlock()

	for key, expiresAt := range window.entries {
		if !expiresAt.After(now) {
			delete(window.entries, key)
		}
	}
	key := federationRequestKey{origin: origin, requestID: requestID}
	if _, exists := window.entries[key]; exists {
		return false
	}
	if len(window.entries) >= maxFederationRequestEntries {
		var oldest federationRequestKey
		var oldestExpiry time.Time
		for existing, expiresAt := range window.entries {
			if oldestExpiry.IsZero() || expiresAt.Before(oldestExpiry) {
				oldest, oldestExpiry = existing, expiresAt
			}
		}
		delete(window.entries, oldest)
	}
	window.entries[key] = now.Add(federationRequestLifetime)
	return true
}

func (handler *Handler) handleIdentityHave(frame map[string]any) error {
	if handler.identityContacts == nil {
		return nil
	}
	branchID := frame["branch_id"].(string)
	records, err := identityRecordStringsFromFrame(frame)
	if err != nil {
		return err
	}
	nowUnix := handler.now().Unix()
	for _, record := range records {
		result := protocol.ValidateBranchTextIdentityContact(record, protocol.IdentityContactValidationOptions{NowUnix: nowUnix})
		if !result.Accepted || result.Contact == nil {
			return ErrInvalidFrame
		}
		if result.Contact.Payload.BranchID != branchID {
			return ErrInvalidFrame
		}
		cacheResult := handler.identityContacts.Accept(record, "wss.identity_have", protocol.IdentityContactValidationOptions{NowUnix: nowUnix})
		if !cacheResult.Accepted {
			return ErrInvalidFrame
		}
	}
	return nil
}

func (handler *Handler) identityRecordsForBranchID(ctx context.Context, branchID string, hopLimit int) []string {
	if handler.identityContacts == nil {
		return []string{}
	}
	if observation, ok := handler.identityContacts.Lookup(branchID); ok {
		return []string{observation.Wrapper}
	}
	if hopLimit <= 0 {
		return []string{}
	}
	source, ok := handler.peerRouter.(interface {
		LookupIdentityContact(context.Context, string) ([]discovery.IdentityContactCandidate, error)
	})
	if !ok {
		return []string{}
	}
	candidates, err := source.LookupIdentityContact(ctx, branchID)
	if err != nil {
		return []string{}
	}
	records := make([]string, 0, min(len(candidates), maxIdentityHaveRecords))
	nowUnix := handler.now().Unix()
	for _, candidate := range candidates {
		if len(records) >= maxIdentityHaveRecords {
			break
		}
		result := protocol.ValidateBranchTextIdentityContact(candidate.Wrapper, protocol.IdentityContactValidationOptions{NowUnix: nowUnix})
		if !result.Accepted || result.Contact == nil || result.Contact.Payload.BranchID != branchID {
			continue
		}
		cacheResult := handler.identityContacts.Accept(candidate.Wrapper, candidate.Source, protocol.IdentityContactValidationOptions{NowUnix: nowUnix})
		if !cacheResult.Accepted {
			continue
		}
		records = append(records, candidate.Wrapper)
	}
	return records
}

func identityRecordStringsFromFrame(frame map[string]any) ([]string, error) {
	raw, ok := frame["records"].([]any)
	if !ok || len(raw) > maxIdentityHaveRecords {
		return nil, ErrInvalidFrame
	}
	records := make([]string, 0, len(raw))
	for _, item := range raw {
		record, ok := item.(string)
		if !ok || record == "" {
			return nil, ErrInvalidFrame
		}
		records = append(records, record)
	}
	return records, nil
}

func deliveryPayload(frame relay.Frame) ([]byte, error) {
	if frame.SenderPeerID == "" {
		return frame.Payload, nil
	}
	var object map[string]any
	if err := json.Unmarshal(frame.Payload, &object); err != nil {
		return nil, ErrInvalidFrame
	}
	if object["type"] != string(protocol.RelayFrameEnvelope) {
		return frame.Payload, nil
	}
	object["sender_peer_id"] = string(frame.SenderPeerID)
	payload, err := json.Marshal(object)
	if err != nil {
		return nil, ErrInvalidFrame
	}
	return payload, nil
}

func senderPeerIDFromFrame(payload []byte) relay.PeerID {
	var object map[string]any
	if err := json.Unmarshal(payload, &object); err != nil {
		return ""
	}
	value, ok := object["sender_peer_id"].(string)
	if !ok {
		return ""
	}
	return relay.PeerID(value)
}

func (handler *Handler) announceFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) error {
	forwarder, ok := handler.lookupFederatedPeer(ctx, peerID, hints, now)
	if !ok {
		return relay.ErrPeerUnavailable
	}
	return handler.hub.AnnounceFederatedPresence(peerID, forwarder, now)
}

func (handler *Handler) lookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) (relay.FederatedForwarder, bool) {
	if handler.peerRouter == nil {
		return nil, false
	}
	forwarder, ok := handler.peerRouter.LookupFederatedPeer(ctx, peerID, hints, now)
	if !ok {
		return nil, false
	}
	return forwarder, true
}

func routeHintsFromFrame(frame map[string]any) ([]FederationRouteHint, error) {
	if _, ok := frame["route_hints"]; ok {
		return nil, ErrInvalidFrame
	}
	return nil, nil
}

func numericField(value any) (int64, bool) {
	number, ok := value.(float64)
	if !ok || math.Trunc(number) != number || number < 0 || number > float64(protocol.MaxDraftTimestamp) {
		return 0, false
	}
	return int64(number), true
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

func (handler *Handler) writeFederationLookupAck(ctx context.Context, conn *connection, sessionID string) error {
	ackToken, err := randomID(handler.random, 16)
	if err != nil {
		return err
	}
	return handler.writeAck(ctx, conn, sessionID, ackToken, "relay.accepted")
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
	ClientNonce         []byte
	SelectedOffer       map[string]any
	FederationPublicKey []byte
}

func decodeHello(raw []byte, nowUnix int64) (helloFrame, error) {
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
	var federationPublicKey []byte
	if frame["requested_role"] == protocol.RelayFederationLiveRole {
		beaconWrapper, ok := frame["relay_beacon"].(string)
		if !ok {
			return helloFrame{}, ErrInvalidFrame
		}
		result := protocol.ValidateBranchTextBootstrapBeacon(beaconWrapper, protocol.BootstrapBeaconValidationOptions{NowUnix: nowUnix})
		if !result.Accepted || result.Beacon == nil || !slices.Contains(result.Beacon.Payload.RelayCapabilities, protocol.RelayFederationLiveRole) {
			return helloFrame{}, ErrAuthenticationFailed
		}
		federationPublicKey = append([]byte(nil), result.Beacon.Envelope.Sender.PublicKey...)
	}
	return helloFrame{
		ClientNonce:         clientNonce,
		SelectedOffer:       selected,
		FederationPublicKey: federationPublicKey,
	}, nil
}

func validateAuth(raw []byte, clientNonce []byte, relayNonce []byte, transcriptHash []byte, expectedFederationPublicKey []byte) (relay.PeerID, error) {
	if _, err := protocol.DecodeDraftRelayAttachmentFrame(raw); err != nil {
		return "", err
	}
	frame, err := decodeTypedFrame(raw)
	if err != nil {
		return "", err
	}
	if frame["type"] != "AUTH" {
		return "", ErrAuthenticationFailed
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
			return "", ErrAuthenticationFailed
		}
		if !bytes.Equal(actual, field.value) {
			return "", ErrAuthenticationFailed
		}
	}
	clientPublicKey, err := decodeBase64(frame["client_public_key"].(string), ed25519.PublicKeySize)
	if err != nil {
		return "", ErrAuthenticationFailed
	}
	clientProof, err := decodeBase64(frame["client_proof"].(string), ed25519.SignatureSize)
	if err != nil {
		return "", ErrAuthenticationFailed
	}
	if !ed25519.Verify(ed25519.PublicKey(clientPublicKey), proofInput(transcriptHash), clientProof) {
		return "", ErrAuthenticationFailed
	}
	if len(expectedFederationPublicKey) > 0 && !bytes.Equal(clientPublicKey, expectedFederationPublicKey) {
		return "", ErrAuthenticationFailed
	}
	return relay.PeerID(base64URL(clientPublicKey)), nil
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
	case errors.Is(err, ErrAuthenticationFailed):
		return "authentication_failed"
	case errors.Is(err, ErrFrameReplayed), errors.Is(err, relay.ErrDeliveryConflict):
		return "frame_replayed"
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
	return !errors.Is(err, relay.ErrPeerUnavailable) &&
		!errors.Is(err, relay.ErrNoRoute) &&
		!errors.Is(err, ErrFrameReplayed) &&
		!errors.Is(err, relay.ErrDeliveryConflict)
}
