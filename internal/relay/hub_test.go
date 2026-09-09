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
	if err := alice.AnnouncePresence("alice-peer", time.Unix(1_789_000_000, 0)); err != nil {
		t.Fatalf("announce alice presence: %v", err)
	}
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
	if frame.SenderPeerID != "alice-peer" {
		t.Fatalf("sender peer id = %q", frame.SenderPeerID)
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
	if snapshot := hub.Snapshot(); snapshot.PresenceActive != 0 || snapshot.RoutesActive != 0 {
		t.Fatalf("unexpected snapshot after expiry: %+v", snapshot)
	}
}

func TestHubRendezvousCanLoopBackToSameLivePeer(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         1,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	now := time.Unix(1_789_000_000, 0)
	alice := attach(t, hub, "alice-session")

	if err := alice.AnnouncePresence("alice-peer", now); err != nil {
		t.Fatalf("announce presence: %v", err)
	}
	if err := alice.Rendezvous("route-loopback", "alice-peer", now); err != nil {
		t.Fatalf("self rendezvous: %v", err)
	}
	if err := alice.Send(context.Background(), "route-loopback", []byte("self echo")); err != nil {
		t.Fatalf("send loopback: %v", err)
	}

	frame := receive(t, alice)
	if frame.RouteID != "route-loopback" {
		t.Fatalf("route id = %q", frame.RouteID)
	}
	if frame.SenderPeerID != "alice-peer" {
		t.Fatalf("sender peer id = %q", frame.SenderPeerID)
	}
	if string(frame.Payload) != "self echo" {
		t.Fatalf("payload = %q", frame.Payload)
	}

	snapshot := hub.Snapshot()
	if snapshot.SessionsActive != 1 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 1 || snapshot.ForwardedFrames != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestHubRendezvousIsIdempotentOnlyForSameLiveBinding(t *testing.T) {
	hub := newTestHub(t, Config{
		MaxSessions:         3,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	now := time.Unix(1_789_000_000, 0)
	alice := attach(t, hub, "alice-session")
	bob := attach(t, hub, "bob-session")
	charlie := attach(t, hub, "charlie-session")
	if err := bob.AnnouncePresence("bob-peer", now); err != nil {
		t.Fatalf("announce bob presence: %v", err)
	}
	if err := charlie.AnnouncePresence("charlie-peer", now); err != nil {
		t.Fatalf("announce charlie presence: %v", err)
	}
	if err := alice.Rendezvous("route-recovery", "bob-peer", now); err != nil {
		t.Fatalf("initial rendezvous: %v", err)
	}
	if err := alice.Rendezvous("route-recovery", "bob-peer", now); err != nil {
		t.Fatalf("idempotent rendezvous: %v", err)
	}
	if snapshot := hub.Snapshot(); snapshot.RoutesActive != 1 {
		t.Fatalf("repeated rendezvous changed live routes: %+v", snapshot)
	}
	if err := alice.Send(context.Background(), "route-recovery", []byte("live")); err != nil {
		t.Fatalf("send after idempotent rendezvous: %v", err)
	}
	if frame := receive(t, bob); string(frame.Payload) != "live" {
		t.Fatalf("unexpected forwarded payload: %+v", frame)
	}
	if err := alice.Rendezvous("route-recovery", "charlie-peer", now); !errors.Is(err, ErrRouteExists) {
		t.Fatalf("different target reused route id: %v", err)
	}
	if err := charlie.Rendezvous("route-recovery", "bob-peer", now); !errors.Is(err, ErrRouteExists) {
		t.Fatalf("different session reused route id: %v", err)
	}
}

func TestHubFederatedPresenceForwardsAcrossLiveRelays(t *testing.T) {
	now := time.Unix(1_789_000_000, 0)
	leftHub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	rightHub := newTestHub(t, Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	alice := attach(t, leftHub, "alice-left")
	bob := attach(t, rightHub, "bob-right")
	rightBridge := attach(t, rightHub, "bridge-right")
	if err := bob.AnnouncePresence("bob-peer", now); err != nil {
		t.Fatalf("announce bob presence: %v", err)
	}
	forwarder := liveFederatedForwarder{
		target:     rightBridge,
		targetPeer: "bob-peer",
		now:        now,
	}
	if err := leftHub.AnnounceFederatedPresence("bob-peer", forwarder, now); err != nil {
		t.Fatalf("announce federated presence: %v", err)
	}
	presence, ok := leftHub.Lookup("bob-peer", now)
	if !ok || !presence.Federated || presence.SessionID != "" {
		t.Fatalf("unexpected federated presence: %+v", presence)
	}

	if err := alice.Rendezvous("route-federated", "bob-peer", now); err != nil {
		t.Fatalf("federated rendezvous: %v", err)
	}
	payload := []byte("left-to-right")
	if err := alice.Send(context.Background(), "route-federated", payload); err != nil {
		t.Fatalf("federated send: %v", err)
	}
	payload[0] = 'X'
	if frame := receive(t, bob); frame.RouteID != "route-federated" || string(frame.Payload) != "left-to-right" {
		t.Fatalf("unexpected bob frame: %+v", frame)
	}

	if err := bob.Send(context.Background(), "route-federated", []byte("right-to-left")); err != nil {
		t.Fatalf("bob reply: %v", err)
	}
	reply := receive(t, rightBridge)
	if err := leftHub.DeliverFromFederated(context.Background(), reply.RouteID, reply.Payload, reply.SenderPeerID); err != nil {
		t.Fatalf("deliver from federated: %v", err)
	}
	if frame := receive(t, alice); frame.RouteID != "route-federated" || string(frame.Payload) != "right-to-left" {
		t.Fatalf("unexpected alice frame: %+v", frame)
	}

	leftSnapshot := leftHub.Snapshot()
	if leftSnapshot.SessionsActive != 1 || leftSnapshot.RoutesActive != 1 || leftSnapshot.PresenceActive != 1 || leftSnapshot.QueueDepth != 0 {
		t.Fatalf("unexpected left snapshot: %+v", leftSnapshot)
	}
	rightSnapshot := rightHub.Snapshot()
	if rightSnapshot.SessionsActive != 2 || rightSnapshot.RoutesActive != 1 || rightSnapshot.PresenceActive != 1 || rightSnapshot.QueueDepth != 0 {
		t.Fatalf("unexpected right snapshot: %+v", rightSnapshot)
	}
}

func TestHubFederatedPresenceReturnsUnavailableWithoutMailbox(t *testing.T) {
	now := time.Unix(1_789_000_000, 0)
	leftHub := newTestHub(t, Config{
		MaxSessions:         1,
		MaxQueueDepth:       1,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	rightHub := newTestHub(t, Config{
		MaxSessions:         1,
		MaxQueueDepth:       1,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	alice := attach(t, leftHub, "alice-left")
	rightBridge := attach(t, rightHub, "bridge-right")
	if err := leftHub.AnnounceFederatedPresence("bob-peer", liveFederatedForwarder{
		target:     rightBridge,
		targetPeer: "bob-peer",
		now:        now,
	}, now); err != nil {
		t.Fatalf("announce federated presence: %v", err)
	}
	if err := alice.Rendezvous("route-federated", "bob-peer", now); err != nil {
		t.Fatalf("federated rendezvous: %v", err)
	}

	if err := alice.Send(context.Background(), "route-federated", []byte("not queued")); !errors.Is(err, ErrPeerUnavailable) {
		t.Fatalf("unavailable send error = %v", err)
	}
	leftSnapshot := leftHub.Snapshot()
	if leftSnapshot.QueueDepth != 0 || leftSnapshot.ForwardedFrames != 0 || leftSnapshot.ForwardedBytes != 0 {
		t.Fatalf("left hub stored unavailable frame: %+v", leftSnapshot)
	}
	rightSnapshot := rightHub.Snapshot()
	if rightSnapshot.QueueDepth != 0 || rightSnapshot.ForwardedFrames != 0 || rightSnapshot.ForwardedBytes != 0 {
		t.Fatalf("right hub stored unavailable frame: %+v", rightSnapshot)
	}

	restarted := newTestHub(t, leftHub.config)
	if snapshot := restarted.Snapshot(); snapshot.PresenceActive != 0 || snapshot.RoutesActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("new hub restored federated state: %+v", snapshot)
	}
}

func TestHubFederatedPresenceExpiresWithoutRouteState(t *testing.T) {
	now := time.Unix(1_789_000_000, 0)
	hub := newTestHub(t, Config{
		MaxSessions:         1,
		MaxQueueDepth:       1,
		MaxFrameBytes:       16,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  64,
		PresenceTTL:         10 * time.Second,
	})
	if err := hub.AnnounceFederatedPresence("bob-peer", failingFederatedForwarder{}, now); err != nil {
		t.Fatalf("announce federated presence: %v", err)
	}
	if snapshot := hub.Snapshot(); snapshot.PresenceActive != 1 || snapshot.RoutesActive != 0 {
		t.Fatalf("unexpected federated presence snapshot: %+v", snapshot)
	}
	if removed := hub.SweepExpired(now.Add(11 * time.Second)); removed != 1 {
		t.Fatalf("removed federated presence = %d", removed)
	}
	if _, ok := hub.Lookup("bob-peer", now.Add(11*time.Second)); ok {
		t.Fatal("federated presence survived expiry")
	}
	if snapshot := hub.Snapshot(); snapshot.PresenceActive != 0 || snapshot.RoutesActive != 0 || snapshot.QueueDepth != 0 {
		t.Fatalf("expired federated presence left state: %+v", snapshot)
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

type liveFederatedForwarder struct {
	target     *Session
	targetPeer PeerID
	now        time.Time
}

func (forwarder liveFederatedForwarder) Forward(ctx context.Context, routeID RouteID, payload []byte, _ PeerID) error {
	err := forwarder.target.Rendezvous(routeID, forwarder.targetPeer, forwarder.now)
	if err != nil && !errors.Is(err, ErrRouteExists) {
		return err
	}
	return forwarder.target.Send(ctx, routeID, payload)
}

type failingFederatedForwarder struct{}

func (failingFederatedForwarder) Forward(context.Context, RouteID, []byte, PeerID) error {
	return ErrPeerUnavailable
}
