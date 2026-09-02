package wss

import (
	"testing"
	"time"

	"github.com/code4bones/branch/internal/relay"
)

func TestStaticPeerRouterFederationSnapshotReportsConfiguredAndObservedPeers(t *testing.T) {
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	router, err := NewStaticPeerRouter(StaticPeerRouterConfig{
		Endpoints: []string{
			"wss://relay02.undoo.ru:443/relay/v0",
			"wss://relay04.undoo.ru:443/relay/v0",
		},
		LocalHub: hub,
	})
	if err != nil {
		t.Fatalf("router: %v", err)
	}

	snapshot := router.FederationSnapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot len = %d", len(snapshot))
	}
	if snapshot[0].State != "configured" || snapshot[0].LookupCount != 0 {
		t.Fatalf("configured snapshot = %+v", snapshot[0])
	}

	now := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	router.recordPeerObservation("wss://relay04.undoo.ru:443/relay/v0", "reachable", "lookup_ok", 1, now)
	snapshot = router.FederationSnapshot()
	var observed FederationPeerObservation
	for _, item := range snapshot {
		if item.Endpoint == "wss://relay04.undoo.ru:443/relay/v0" {
			observed = item
		}
	}
	if observed.State != "reachable" || observed.LastReason != "lookup_ok" || observed.LookupCount != 1 || observed.BridgeCount != 1 {
		t.Fatalf("observed snapshot = %+v", observed)
	}
	if !observed.FreshUntil.After(now) {
		t.Fatalf("fresh until = %s", observed.FreshUntil)
	}
}
