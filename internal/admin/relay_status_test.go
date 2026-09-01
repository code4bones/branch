package admin

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/relay"
)

func TestRelayStatusProviderProjectsLiveRelayCounts(t *testing.T) {
	hub, err := relay.NewHub(relay.Config{
		MaxSessions:         2,
		MaxQueueDepth:       2,
		MaxFrameBytes:       8,
		MaxFramesPerSession: 4,
		MaxBytesPerSession:  16,
		PresenceTTL:         time.Second,
	})
	if err != nil {
		t.Fatalf("new relay hub: %v", err)
	}
	if _, err := hub.Attach("alice"); err != nil {
		t.Fatalf("attach alice: %v", err)
	}
	bob, err := hub.Attach("bob")
	if err != nil {
		t.Fatalf("attach bob: %v", err)
	}
	if err := hub.Pair("route-1", "alice", "bob"); err != nil {
		t.Fatalf("pair route: %v", err)
	}
	if err := bob.AnnouncePresence("bob-peer", time.Unix(1_789_000_000, 0)); err != nil {
		t.Fatalf("announce presence: %v", err)
	}

	provider := NewRelayStatusProvider(StatusSnapshot{
		ServiceName:      "branch-node",
		ServiceVersion:   "dev",
		Readiness:        ReadinessReady,
		ProtocolVersions: []string{"branch/connectivity/0"},
		Capabilities:     []string{"relay.forward.live/0"},
	}, hub)
	handler := NewHandler(provider)
	response := handler.Readiness()

	if response.StatusCode != StatusOK {
		t.Fatalf("status code = %d", response.StatusCode)
	}
	var snapshot StatusSnapshot
	if err := json.Unmarshal(response.Body, &snapshot); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if snapshot.SessionsActive != 2 || snapshot.RoutesActive != 1 || snapshot.PresenceActive != 1 || snapshot.QueueDepth != 0 {
		t.Fatalf("unexpected relay counts: %+v", snapshot)
	}
}
