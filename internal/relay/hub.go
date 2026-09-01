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
		MaxFrameBytes:       64 * 1024,
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
	RouteID RouteID
	Payload []byte
}

// Presence is a detached view of one live authenticated peer.
type Presence struct {
	PeerID    PeerID
	SessionID SessionID
	ExpiresAt time.Time
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
	mu       sync.Mutex
	config   Config
	closed   bool
	sessions map[SessionID]*sessionState
	routes   map[RouteID]routeState
	presence map[PeerID]presenceState
	stats    Snapshot
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
	left  SessionID
	right SessionID
}

type presenceState struct {
	sessionID SessionID
	expiresAt time.Time
}

// NewHub creates a relay core with explicit non-zero bounds.
func NewHub(config Config) (*Hub, error) {
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	return &Hub{
		config:   config,
		sessions: make(map[SessionID]*sessionState),
		routes:   make(map[RouteID]routeState),
		presence: make(map[PeerID]presenceState),
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
	hub.routes[routeID] = routeState{left: left, right: right}
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
	defer hub.mu.Unlock()

	return hub.sweepExpiredLocked(now)
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
	defer hub.mu.Unlock()

	if hub.closed {
		return
	}
	hub.closed = true
	for _, state := range hub.sessions {
		state.close()
	}
	hub.sessions = make(map[SessionID]*sessionState)
	hub.routes = make(map[RouteID]routeState)
	hub.presence = make(map[PeerID]presenceState)
}

// Snapshot returns a detached view of live state and aggregate counters.
func (hub *Hub) Snapshot() Snapshot {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	snapshot := hub.stats
	snapshot.SessionsActive = len(hub.sessions)
	snapshot.RoutesActive = len(hub.routes)
	snapshot.PresenceActive = len(hub.presence)
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
	defer hub.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if hub.closed {
		return ErrClosed
	}

	source, exists := hub.sessions[from]
	if !exists || source.handle.isClosed() {
		return ErrSessionClosed
	}

	route, exists := hub.routes[routeID]
	if !exists {
		return ErrNoRoute
	}
	to, ok := route.peer(from)
	if !ok {
		return ErrNoRoute
	}

	destination, exists := hub.sessions[to]
	if !exists || destination.handle.isClosed() {
		delete(hub.routes, routeID)
		return ErrSessionClosed
	}

	nextFrames := source.frames + 1
	nextBytes := source.bytes + uint64(len(payload))
	if nextFrames > hub.config.MaxFramesPerSession || nextBytes > hub.config.MaxBytesPerSession {
		return ErrQuotaExceeded
	}

	frame := Frame{RouteID: routeID, Payload: framePayload}
	select {
	case destination.inbox <- frame:
		source.frames = nextFrames
		source.bytes = nextBytes
		hub.stats.ForwardedFrames++
		hub.stats.ForwardedBytes += uint64(len(payload))
		return nil
	default:
		hub.stats.DroppedFrames++
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
	presence, ok := hub.lookupLocked(peerID, now)
	if !ok {
		return ErrPeerUnavailable
	}
	if from == presence.SessionID {
		return ErrInvalidID
	}
	if _, exists := hub.routes[routeID]; exists {
		return ErrRouteExists
	}
	hub.routes[routeID] = routeState{left: from, right: presence.SessionID}
	return nil
}

func (hub *Hub) lookupLocked(peerID PeerID, now time.Time) (Presence, bool) {
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

func (hub *Hub) sweepExpiredLocked(now time.Time) int {
	removed := 0
	for peerID, state := range hub.presence {
		session, sessionExists := hub.sessions[state.sessionID]
		if !sessionExists || session.handle.isClosed() || !state.expiresAt.After(now) {
			delete(hub.presence, peerID)
			removed++
		}
	}
	return removed
}

func (hub *Hub) detach(id SessionID) {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	state, exists := hub.sessions[id]
	if !exists {
		return
	}
	state.close()
	if state.peerID != "" {
		delete(hub.presence, state.peerID)
	}
	delete(hub.sessions, id)
	for routeID, route := range hub.routes {
		if route.left == id || route.right == id {
			delete(hub.routes, routeID)
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

func (route routeState) peer(id SessionID) (SessionID, bool) {
	switch id {
	case route.left:
		return route.right, true
	case route.right:
		return route.left, true
	default:
		return "", false
	}
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
