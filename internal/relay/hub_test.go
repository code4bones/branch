package relay

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHubForwardsOpaqueFramesAcrossLiveRoute(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       8,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  16,
		PresenceTTL:         time.Second,
	})
	alice := attach(t, hub, "alice")
	bob := attach(t, hub, "bob")
	if err := hub.Pair("route-1", alice.ID(), bob.ID()); err != nil {
		t.Fatalf("pair route: %v", err)
	}

	payload := []byte("hello")
	if err := alice.Send(context.Background(), "route-1", payload); err != nil {
		t.Fatalf("send: %v", err)
	}
	payload[0] = 'x'

	frame := receive(t, bob)
	if frame.RouteID != "route-1" {
		t.Fatalf("route id = %q", frame.RouteID)
	}
	if string(frame.Payload) != "hello" {
		t.Fatalf("payload = %q", frame.Payload)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 2 || snapshot.RoutesActive != 1 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	if snapshot.ForwardedFrames != 1 || snapshot.ForwardedBytes != 5 || snapshot.DroppedFrames != 0 {
		t.Fatalf("unexpected counters: %+v", snapshot)
	}
}

func TestHubAppliesAdmissionFrameBackpressureAndQuotaBounds(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       1,
		MaxFrameBytes:       4,
		MaxFramesPerSession: 2,
		MaxBytesPerSession:  12,
		PresenceTTL:         time.Second,
	})
	alice := attach(t, hub, "alice")
	bob := attach(t, hub, "bob")

	if _, err := hub.Attach("charlie"); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("third attach error = %v", err)
	}
	if err := hub.Pair("route-1", "alice", "bob"); err != nil {
		t.Fatalf("pair route: %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("large")); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("large frame error = %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("one")); err != nil {
		t.Fatalf("first send: %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("two")); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("backpressure error = %v", err)
	}
	_ = receive(t, bob)
	if err := alice.Send(context.Background(), "route-1", []byte("two")); err != nil {
		t.Fatalf("second accepted send: %v", err)
	}
	_ = receive(t, bob)
	if err := alice.Send(context.Background(), "route-1", []byte("tri")); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("quota error = %v", err)
	}

	snapshot := hub.Snapshot()
	if snapshot.QueueDepth != 0 || snapshot.ForwardedFrames != 2 || snapshot.DroppedFrames != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestHubCloseDropsRoutesAndQueuedFramesWithoutRestore(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         time.Second,
	})
	alice := attach(t, hub, "alice")
	bob := attach(t, hub, "bob")
	if err := hub.Pair("route-1", "alice", "bob"); err != nil {
		t.Fatalf("pair route: %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("queued")); err != nil {
		t.Fatalf("send: %v", err)
	}

	bob.Close()
	if _, err := bob.Receive(context.Background()); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("receive after close error = %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("after")); !errors.Is(err, ErrNoRoute) {
		t.Fatalf("send after peer close error = %v", err)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 1 || snapshot.RoutesActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected snapshot after close: %+v", snapshot)
	}

	restarted := newTestHub(t, hub.config)
	restartedSnapshot := restarted.Snapshot()
	if restartedSnapshot.SessionsActive != 0 || restartedSnapshot.RoutesActive != 0 || restartedSnapshot.QueueDepth != 0 {
		t.Fatalf("new hub restored state: %+v", restartedSnapshot)
	}
}

func TestHubPresenceHeartbeatLookupAndRendezvousAreEphemeral(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	now := time.Unix(1_789_000_000, 0)
	alice := attach(t, hub, "alice-session")
	bob := attach(t, hub, "bob-session")

	if err := bob.AnnouncePresence("bob-peer", now); err != nil {
		t.Fatalf("announce presence: %v", err)
	}
	presence, ok := hub.Lookup("bob-peer", now.Add(9*time.Second))
	if !ok {
		t.Fatal("expected live presence before expiry")
	}
	if presence.PeerID != "bob-peer" || presence.SessionID != "bob-session" {
		t.Fatalf("unexpected presence: %+v", presence)
	}

	if err := bob.Heartbeat(now.Add(9 * time.Second)); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if _, ok := hub.Lookup("bob-peer", now.Add(18*time.Second)); !ok {
		t.Fatal("expected heartbeat to renew presence")
	}
	if err := alice.Rendezvous("route-1", "bob-peer", now.Add(18*time.Second)); err != nil {
		t.Fatalf("rendezvous: %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("online")); err != nil {
		t.Fatalf("send after rendezvous: %v", err)
	}
	if got := receive(t, bob); string(got.Payload) != "online" {
		t.Fatalf("rendezvous payload = %q", got.Payload)
	}

	if removed := hub.SweepExpired(now.Add(20 * time.Second)); removed != 1 {
		t.Fatalf("removed presence = %d", removed)
	}
	if _, ok := hub.Lookup("bob-peer", now.Add(20*time.Second)); ok {
		t.Fatal("presence survived expiry")
	}
	if err := alice.Rendezvous("route-expired", "bob-peer", now.Add(20*time.Second)); !errors.Is(err, ErrPeerUnavailable) {
		t.Fatalf("expired peer rendezvous error = %v", err)
	}
	if snapshot := hub.Snapshot(); snapshot.PresenceActive != 0 || snapshot.RoutesActive != 1 {
		t.Fatalf("unexpected snapshot after expiry: %+v", snapshot)
	}
}

func TestHubShutdownDetachesAllSessions(t *testing.T) {
	hub := newTestHub(t, DefaultConfig())
	alice := attach(t, hub, "alice")
	_ = attach(t, hub, "bob")
	if err := hub.Pair("route-1", "alice", "bob"); err != nil {
		t.Fatalf("pair route: %v", err)
	}

	hub.Close()
	if _, err := hub.Attach("charlie"); !errors.Is(err, ErrClosed) {
		t.Fatalf("attach after close error = %v", err)
	}
	if err := alice.Send(context.Background(), "route-1", []byte("after")); !errors.Is(err, ErrClosed) {
		t.Fatalf("send after hub close error = %v", err)
	}
	if snapshot := hub.Snapshot(); snapshot.SessionsActive != 0 || snapshot.RoutesActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("closed hub snapshot: %+v", snapshot)
	}
}

func TestHubRejectsInvalidConfigAndIDs(t *testing.T) {
	if _, err := NewHub(Config{}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("empty config error = %v", err)
	}
	hub := newTestHub(t, DefaultConfig())
	if _, err := hub.Attach(""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("empty session id error = %v", err)
	}
	if _, err := hub.Attach("alice"); err != nil {
		t.Fatalf("attach alice: %v", err)
	}
	if _, err := hub.Attach("alice"); !errors.Is(err, ErrSessionExists) {
		t.Fatalf("duplicate session error = %v", err)
	}
	if err := hub.Pair("", "alice", "alice"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("empty route id error = %v", err)
	}
	if err := hub.Pair("self", "alice", "alice"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("self route error = %v", err)
	}
	if err := hub.Pair("missing", "alice", "missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing peer error = %v", err)
	}
}

func newTestHub(t *testing.T, config Config) *Hub {
	t.Helper()
	hub, err := NewHub(config)
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	return hub
}

func attach(t *testing.T, hub *Hub, id SessionID) *Session {
	t.Helper()
	session, err := hub.Attach(id)
	if err != nil {
		t.Fatalf("attach %q: %v", id, err)
	}
	return session
}

func receive(t *testing.T, session *Session) Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	frame, err := session.Receive(ctx)
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	return frame
}
