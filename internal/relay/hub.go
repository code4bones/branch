package relay

import (
	"context"
	"errors"
	"sync"
	"time"
)

const maxIDBytes = 128

var (
	ErrBackpressure    = errors.New("relay backpressure")
	ErrClosed          = errors.New("relay closed")
	ErrFrameTooLarge   = errors.New("relay frame too large")
	ErrInvalidConfig   = errors.New("relay invalid config")
	ErrInvalidID       = errors.New("relay invalid id")
	ErrNoRoute         = errors.New("relay route not found")
	ErrPeerUnavailable = errors.New("relay peer unavailable")
	ErrQuotaExceeded   = errors.New("relay quota exceeded")
	ErrRouteExists     = errors.New("relay route exists")
	ErrSessionClosed   = errors.New("relay session closed")
	ErrSessionExists   = errors.New("relay session exists")
	ErrSessionLimit    = errors.New("relay session limit")
	ErrSessionNotFound = errors.New("relay session not found")
)

// Config sets explicit relay memory, frame, and quota bounds.
type Config struct {
	MaxSessions         int
	MaxQueueDepth       int
	MaxFrameBytes       int
	MaxFramesPerSession uint64
	MaxBytesPerSession  uint64
	PresenceTTL         time.Duration
}

// DefaultConfig returns conservative non-zero limits for a development relay.
func DefaultConfig() Config {
	return Config{
		MaxSessions:         1024,
		MaxQueueDepth:       32,
		MaxFrameBytes:       49_152,
		MaxFramesPerSession: 1 << 20,
		MaxBytesPerSession:  1 << 30,
		PresenceTTL:         30 * time.Second,
	}
}

// SessionID identifies one live adapter-owned connection inside one relay
// process. It is not a user identity or a protocol address.
type SessionID string

// RouteID identifies one live paired route inside one relay process.
type RouteID string

// PeerID identifies one authenticated live peer within this relay process.
// It is transient routing metadata, not a public identity directory.
type PeerID string

// Frame is an opaque encrypted payload plus its live route hint.
type Frame struct {
	RouteID      RouteID
	SenderPeerID PeerID
	Payload      []byte
}

// Presence is a detached view of one live authenticated peer.
type Presence struct {
	PeerID    PeerID
	SessionID SessionID
	ExpiresAt time.Time
	Federated bool
}

// FederatedForwarder synchronously forwards one opaque frame to a live remote
// relay route. It must be bounded and return transient relay errors instead of
// storing frames when the remote side is unavailable.
type FederatedForwarder interface {
	Forward(ctx context.Context, routeID RouteID, payload []byte, senderPeerID PeerID) error
}

// Snapshot is a detached bounded operator view of in-memory relay state.
type Snapshot struct {
	SessionsActive  int
	RoutesActive    int
	PresenceActive  int
	QueueDepth      int
	ForwardedFrames uint64
	ForwardedBytes  uint64
	DroppedFrames   uint64
}

// Hub owns all live relay sessions and routes for one process.
type Hub struct {
	mu                sync.Mutex
	config            Config
	closed            bool
	sessions          map[SessionID]*sessionState
	routes            map[RouteID]routeState
	presence          map[PeerID]presenceState
	federatedPresence map[PeerID]federatedPresenceState
	stats             Snapshot
}

// Session is one live relay attachment handle.
type Session struct {
	hub  *Hub
	id   SessionID
	done chan struct{}
}

type sessionState struct {
	handle *Session
	inbox  chan Frame
	once   sync.Once
	frames uint64
	bytes  uint64
	peerID PeerID
}

type routeState struct {
	left  routeEndpoint
	right routeEndpoint
}

type routeEndpoint struct {
	sessionID SessionID
	forwarder FederatedForwarder
}

type presenceState struct {
	sessionID SessionID
	expiresAt time.Time
}

type federatedPresenceState struct {
	forwarder FederatedForwarder
	expiresAt time.Time
}

// NewHub creates a relay core with explicit non-zero bounds.
func NewHub(config Config) (*Hub, error) {
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	return &Hub{
		config:            config,
		sessions:          make(map[SessionID]*sessionState),
		routes:            make(map[RouteID]routeState),
		presence:          make(map[PeerID]presenceState),
		federatedPresence: make(map[PeerID]federatedPresenceState),
	}, nil
}

// Attach admits one live session to the in-memory relay.
func (hub *Hub) Attach(id SessionID) (*Session, error) {
	if err := validateID(string(id)); err != nil {
		return nil, err
	}

	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return nil, ErrClosed
	}
	if _, exists := hub.sessions[id]; exists {
		return nil, ErrSessionExists
	}
	if len(hub.sessions) >= hub.config.MaxSessions {
		return nil, ErrSessionLimit
	}

	handle := &Session{
		hub:  hub,
		id:   id,
		done: make(chan struct{}),
	}
	hub.sessions[id] = &sessionState{
		handle: handle,
		inbox:  make(chan Frame, hub.config.MaxQueueDepth),
	}
	return handle, nil
}

// Pair creates a live route between two attached sessions.
func (hub *Hub) Pair(routeID RouteID, left SessionID, right SessionID) error {
	if err := validateID(string(routeID)); err != nil {
		return err
	}
	if left == right {
		return ErrInvalidID
	}

	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return ErrClosed
	}
	if _, exists := hub.routes[routeID]; exists {
		return ErrRouteExists
	}
	if _, exists := hub.sessions[left]; !exists {
		return ErrSessionNotFound
	}
	if _, exists := hub.sessions[right]; !exists {
		return ErrSessionNotFound
	}
	hub.routes[routeID] = routeState{
		left:  routeEndpoint{sessionID: left},
		right: routeEndpoint{sessionID: right},
	}
	return nil
}

// AnnounceFederatedPresence marks a peer as reachable through a live remote
// relay bridge. This is memory-only routing state and expires like local
// presence; it is not a searchable directory or durable route catalog.
func (hub *Hub) AnnounceFederatedPresence(peerID PeerID, forwarder FederatedForwarder, now time.Time) error {
	if err := validateID(string(peerID)); err != nil {
		return err
	}
	if forwarder == nil {
		return ErrInvalidConfig
	}

	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return ErrClosed
	}
	hub.federatedPresence[peerID] = federatedPresenceState{
		forwarder: forwarder,
		expiresAt: now.Add(hub.config.PresenceTTL),
	}
	return nil
}

// AnnouncePresence marks this authenticated session as currently reachable.
func (session *Session) AnnouncePresence(peerID PeerID, now time.Time) error {
	if err := validateID(string(peerID)); err != nil {
		return err
	}
	return session.hub.announcePresence(session.id, peerID, now)
}

// Heartbeat renews the session's current live presence TTL.
func (session *Session) Heartbeat(now time.Time) error {
	return session.hub.heartbeat(session.id, now)
}

// Lookup returns a live peer presence if it has not expired.
func (hub *Hub) Lookup(peerID PeerID, now time.Time) (Presence, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	return hub.lookupLocked(peerID, now)
}

// Rendezvous pairs requester with the currently live target peer.
func (session *Session) Rendezvous(routeID RouteID, peerID PeerID, now time.Time) error {
	return session.hub.rendezvous(session.id, routeID, peerID, now)
}

// SweepExpired removes expired live presence records and returns the count.
func (hub *Hub) SweepExpired(now time.Time) int {
	hub.mu.Lock()
	removed, closers := hub.sweepExpiredLocked(now)
	hub.mu.Unlock()
	closeForwarders(closers)
	return removed
}

// ID returns the local relay session identifier.
func (session *Session) ID() SessionID {
	return session.id
}

// Send forwards one opaque frame to the other live side of routeID.
func (session *Session) Send(ctx context.Context, routeID RouteID, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return session.hub.forward(ctx, session.id, routeID, payload)
}

// Receive waits for one inbound frame or the session lifecycle to end.
func (session *Session) Receive(ctx context.Context) (Frame, error) {
	if session.isClosed() {
		return Frame{}, ErrSessionClosed
	}

	state, err := session.hub.sessionState(session.id)
	if err != nil {
		return Frame{}, err
	}

	select {
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	case <-session.done:
		return Frame{}, ErrSessionClosed
	case frame := <-state.inbox:
		if session.isClosed() {
			return Frame{}, ErrSessionClosed
		}
		return frame, nil
	}
}

// Close detaches the session and removes every live route that used it.
func (session *Session) Close() {
	session.hub.detach(session.id)
}

// Close detaches every session and drops all in-memory routes and queued frames.
func (hub *Hub) Close() {
	hub.mu.Lock()

	if hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.closed = true
	closers := hub.federatedForwardersLocked()
	for _, state := range hub.sessions {
		state.close()
	}
	hub.sessions = make(map[SessionID]*sessionState)
	hub.routes = make(map[RouteID]routeState)
	hub.presence = make(map[PeerID]presenceState)
	hub.federatedPresence = make(map[PeerID]federatedPresenceState)
	hub.mu.Unlock()
	closeForwarders(closers)
}

// Snapshot returns a detached view of live state and aggregate counters.
func (hub *Hub) Snapshot() Snapshot {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	snapshot := hub.stats
	snapshot.SessionsActive = len(hub.sessions)
	snapshot.RoutesActive = len(hub.routes)
	snapshot.PresenceActive = len(hub.presence) + len(hub.federatedPresence)
	for _, state := range hub.sessions {
		snapshot.QueueDepth += len(state.inbox)
	}
	return snapshot
}

func (hub *Hub) forward(ctx context.Context, from SessionID, routeID RouteID, payload []byte) error {
	if len(payload) > hub.config.MaxFrameBytes {
		return ErrFrameTooLarge
	}

	framePayload := append([]byte(nil), payload...)

	hub.mu.Lock()
	if err := ctx.Err(); err != nil {
		hub.mu.Unlock()
		return err
	}
	if hub.closed {
		hub.mu.Unlock()
		return ErrClosed
	}

	source, exists := hub.sessions[from]
	if !exists || source.handle.isClosed() {
		hub.mu.Unlock()
		return ErrSessionClosed
	}

	route, exists := hub.routes[routeID]
	if !exists {
		hub.mu.Unlock()
		return ErrNoRoute
	}
	to, ok := route.peer(from)
	if !ok {
		hub.mu.Unlock()
		return ErrNoRoute
	}

	nextFrames := source.frames + 1
	nextBytes := source.bytes + uint64(len(payload))
	if nextFrames > hub.config.MaxFramesPerSession || nextBytes > hub.config.MaxBytesPerSession {
		hub.mu.Unlock()
		return ErrQuotaExceeded
	}

	senderPeerID := source.peerID
	frame := Frame{RouteID: routeID, SenderPeerID: senderPeerID, Payload: framePayload}
	if to.sessionID != "" {
		destination, exists := hub.sessions[to.sessionID]
		if !exists || destination.handle.isClosed() {
			delete(hub.routes, routeID)
			hub.mu.Unlock()
			return ErrSessionClosed
		}
		select {
		case destination.inbox <- frame:
			source.frames = nextFrames
			source.bytes = nextBytes
			hub.stats.ForwardedFrames++
			hub.stats.ForwardedBytes += uint64(len(payload))
			hub.mu.Unlock()
			return nil
		default:
			hub.stats.DroppedFrames++
			hub.mu.Unlock()
			return ErrBackpressure
		}
	}
	if to.forwarder == nil {
		hub.mu.Unlock()
		return ErrNoRoute
	}
	source.frames = nextFrames
	source.bytes = nextBytes
	sourceState := source
	hub.mu.Unlock()

	err := to.forwarder.Forward(ctx, routeID, framePayload, senderPeerID)

	hub.mu.Lock()
	if err != nil {
		hub.rollbackUsageLocked(from, sourceState, len(payload))
		var closers []FederatedForwarder
		if isRouteFailure(err) {
			if failedRoute, exists := hub.routes[routeID]; exists {
				closers = failedRoute.federatedForwarders()
				delete(hub.routes, routeID)
			}
		}
		hub.mu.Unlock()
		closeForwarders(closers)
		return err
	}
	hub.stats.ForwardedFrames++
	hub.stats.ForwardedBytes += uint64(len(payload))
	hub.mu.Unlock()
	return nil
}

// DeliverFromFederated injects one frame arriving from a remote relay bridge
// into an existing live federated route. The hub accepts it only while the local
// destination session and route are still present.
func (hub *Hub) DeliverFromFederated(ctx context.Context, routeID RouteID, payload []byte, senderPeerID PeerID) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(payload) > hub.config.MaxFrameBytes {
		return ErrFrameTooLarge
	}
	framePayload := append([]byte(nil), payload...)

	hub.mu.Lock()
	if err := ctx.Err(); err != nil {
		hub.mu.Unlock()
		return err
	}
	if hub.closed {
		hub.mu.Unlock()
		return ErrClosed
	}
	route, exists := hub.routes[routeID]
	if !exists {
		hub.mu.Unlock()
		return ErrNoRoute
	}
	to, ok := route.localPeerOfFederated()
	if !ok {
		hub.mu.Unlock()
		return ErrNoRoute
	}
	destination, exists := hub.sessions[to]
	if !exists || destination.handle.isClosed() {
		closers := route.federatedForwarders()
		delete(hub.routes, routeID)
		hub.mu.Unlock()
		closeForwarders(closers)
		return ErrSessionClosed
	}
	select {
	case destination.inbox <- Frame{RouteID: routeID, SenderPeerID: senderPeerID, Payload: framePayload}:
		hub.stats.ForwardedFrames++
		hub.stats.ForwardedBytes += uint64(len(payload))
		hub.mu.Unlock()
		return nil
	default:
		hub.stats.DroppedFrames++
		hub.mu.Unlock()
		return ErrBackpressure
	}
}

func (hub *Hub) sessionState(id SessionID) (*sessionState, error) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return nil, ErrClosed
	}
	state, exists := hub.sessions[id]
	if !exists || state.handle.isClosed() {
		return nil, ErrSessionClosed
	}
	return state, nil
}

func (hub *Hub) announcePresence(id SessionID, peerID PeerID, now time.Time) error {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return ErrClosed
	}
	state, exists := hub.sessions[id]
	if !exists || state.handle.isClosed() {
		return ErrSessionClosed
	}
	if state.peerID != "" && state.peerID != peerID {
		delete(hub.presence, state.peerID)
	}
	state.peerID = peerID
	hub.presence[peerID] = presenceState{
		sessionID: id,
		expiresAt: now.Add(hub.config.PresenceTTL),
	}
	return nil
}

func (hub *Hub) heartbeat(id SessionID, now time.Time) error {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return ErrClosed
	}
	state, exists := hub.sessions[id]
	if !exists || state.handle.isClosed() {
		return ErrSessionClosed
	}
	if state.peerID == "" {
		return ErrPeerUnavailable
	}
	hub.presence[state.peerID] = presenceState{
		sessionID: id,
		expiresAt: now.Add(hub.config.PresenceTTL),
	}
	return nil
}

func (hub *Hub) rendezvous(from SessionID, routeID RouteID, peerID PeerID, now time.Time) error {
	if err := validateID(string(routeID)); err != nil {
		return err
	}
	if err := validateID(string(peerID)); err != nil {
		return err
	}

	hub.mu.Lock()
	defer hub.mu.Unlock()

	if hub.closed {
		return ErrClosed
	}
	if _, exists := hub.sessions[from]; !exists {
		return ErrSessionClosed
	}
	if _, exists := hub.routes[routeID]; exists {
		return ErrRouteExists
	}

	localPresence, ok := hub.lookupLocalLocked(peerID, now)
	if ok {
		hub.routes[routeID] = routeState{
			left:  routeEndpoint{sessionID: from},
			right: routeEndpoint{sessionID: localPresence.SessionID},
		}
		return nil
	}

	federatedPresence, ok := hub.lookupFederatedLocked(peerID, now)
	if !ok {
		return ErrPeerUnavailable
	}
	delete(hub.federatedPresence, peerID)
	hub.routes[routeID] = routeState{
		left:  routeEndpoint{sessionID: from},
		right: routeEndpoint{forwarder: federatedPresence.forwarder},
	}
	return nil
}

func (hub *Hub) lookupLocked(peerID PeerID, now time.Time) (Presence, bool) {
	if presence, ok := hub.lookupLocalLocked(peerID, now); ok {
		return presence, true
	}
	state, ok := hub.lookupFederatedLocked(peerID, now)
	if !ok {
		return Presence{}, false
	}
	return Presence{
		PeerID:    peerID,
		ExpiresAt: state.expiresAt,
		Federated: true,
	}, true
}

func (hub *Hub) lookupLocalLocked(peerID PeerID, now time.Time) (Presence, bool) {
	state, exists := hub.presence[peerID]
	if !exists {
		return Presence{}, false
	}
	if !state.expiresAt.After(now) {
		delete(hub.presence, peerID)
		return Presence{}, false
	}
	session, exists := hub.sessions[state.sessionID]
	if !exists || session.handle.isClosed() {
		delete(hub.presence, peerID)
		return Presence{}, false
	}
	return Presence{
		PeerID:    peerID,
		SessionID: state.sessionID,
		ExpiresAt: state.expiresAt,
	}, true
}

func (hub *Hub) lookupFederatedLocked(peerID PeerID, now time.Time) (federatedPresenceState, bool) {
	state, exists := hub.federatedPresence[peerID]
	if !exists {
		return federatedPresenceState{}, false
	}
	if !state.expiresAt.After(now) {
		delete(hub.federatedPresence, peerID)
		return federatedPresenceState{}, false
	}
	if state.forwarder == nil {
		delete(hub.federatedPresence, peerID)
		return federatedPresenceState{}, false
	}
	return state, true
}

func (hub *Hub) sweepExpiredLocked(now time.Time) (int, []FederatedForwarder) {
	removed := 0
	var closers []FederatedForwarder
	for peerID, state := range hub.presence {
		session, sessionExists := hub.sessions[state.sessionID]
		if !sessionExists || session.handle.isClosed() || !state.expiresAt.After(now) {
			delete(hub.presence, peerID)
			removed++
		}
	}
	for peerID, state := range hub.federatedPresence {
		if state.forwarder == nil || !state.expiresAt.After(now) {
			if state.forwarder != nil {
				closers = append(closers, state.forwarder)
			}
			delete(hub.federatedPresence, peerID)
			removed++
		}
	}
	return removed, closers
}

func (hub *Hub) rollbackUsageLocked(sessionID SessionID, expected *sessionState, payloadBytes int) {
	state, exists := hub.sessions[sessionID]
	if !exists || state != expected {
		return
	}
	if state.frames > 0 {
		state.frames--
	}
	if state.bytes >= uint64(payloadBytes) {
		state.bytes -= uint64(payloadBytes)
	} else {
		state.bytes = 0
	}
}

func isRouteFailure(err error) bool {
	return errors.Is(err, ErrPeerUnavailable) ||
		errors.Is(err, ErrNoRoute) ||
		errors.Is(err, ErrSessionClosed) ||
		errors.Is(err, ErrSessionNotFound)
}

func (hub *Hub) detach(id SessionID) {
	hub.mu.Lock()

	state, exists := hub.sessions[id]
	if !exists {
		hub.mu.Unlock()
		return
	}
	state.close()
	if state.peerID != "" {
		delete(hub.presence, state.peerID)
	}
	delete(hub.sessions, id)
	var closers []FederatedForwarder
	for routeID, route := range hub.routes {
		if route.containsSession(id) {
			closers = append(closers, route.federatedForwarders()...)
			delete(hub.routes, routeID)
		}
	}
	hub.mu.Unlock()
	closeForwarders(closers)
}

func (hub *Hub) federatedForwardersLocked() []FederatedForwarder {
	closers := []FederatedForwarder{}
	for _, route := range hub.routes {
		closers = append(closers, route.federatedForwarders()...)
	}
	for _, presence := range hub.federatedPresence {
		if presence.forwarder != nil {
			closers = append(closers, presence.forwarder)
		}
	}
	return closers
}

func closeForwarders(forwarders []FederatedForwarder) {
	for _, forwarder := range forwarders {
		if closer, ok := forwarder.(interface{ Close() }); ok {
			closer.Close()
		}
	}
}

func (state *sessionState) close() {
	state.once.Do(func() {
		close(state.handle.done)
	})
}

func (session *Session) isClosed() bool {
	select {
	case <-session.done:
		return true
	default:
		return false
	}
}

func (route routeState) peer(id SessionID) (routeEndpoint, bool) {
	switch id {
	case route.left.sessionID:
		return route.right, true
	case route.right.sessionID:
		return route.left, true
	default:
		return routeEndpoint{}, false
	}
}

func (route routeState) containsSession(id SessionID) bool {
	return route.left.sessionID == id || route.right.sessionID == id
}

func (route routeState) federatedForwarders() []FederatedForwarder {
	forwarders := []FederatedForwarder{}
	if route.left.forwarder != nil {
		forwarders = append(forwarders, route.left.forwarder)
	}
	if route.right.forwarder != nil {
		forwarders = append(forwarders, route.right.forwarder)
	}
	return forwarders
}

func (route routeState) localPeerOfFederated() (SessionID, bool) {
	if route.left.forwarder != nil && route.right.sessionID != "" {
		return route.right.sessionID, true
	}
	if route.right.forwarder != nil && route.left.sessionID != "" {
		return route.left.sessionID, true
	}
	return "", false
}

func validateConfig(config Config) error {
	if config.MaxSessions <= 0 ||
		config.MaxQueueDepth <= 0 ||
		config.MaxFrameBytes <= 0 ||
		config.MaxFramesPerSession == 0 ||
		config.MaxBytesPerSession == 0 ||
		config.PresenceTTL <= 0 {
		return ErrInvalidConfig
	}
	return nil
}

func validateID(id string) error {
	if id == "" || len([]byte(id)) > maxIDBytes {
		return ErrInvalidID
	}
	return nil
}
