package wss

import (
	"errors"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
)

func TestStaticPeerRouterFederationSnapshotReportsConfiguredAndObservedPeers(t *testing.T) {
	now := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	router, err := NewStaticPeerRouter(StaticPeerRouterConfig{
		Peers: []FederationPeer{
			{Endpoint: "wss://relay02.undoo.ru:443/relay/v0", RelayPublicKey: testB64x32, ProfileMultihash: protocol.DevelopmentProfileMultihash},
			{Endpoint: "wss://relay04.undoo.ru:443/relay/v0", RelayPublicKey: testB64x32, ProfileMultihash: protocol.DevelopmentProfileMultihash},
		},
		LocalHub: hub,
		Now:      func() time.Time { return now },
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

	router.recordPeerObservation("wss://relay04.undoo.ru:443/relay/v0", "reachable", "lookup_ok", 1, now)
	snapshot = router.FederationSnapshot()
	var observed FederationPeerObservation
	for _, item := range snapshot {
		if item.State == "reachable" {
			observed = item
		}
	}
	if observed.PeerRef == "" || observed.State != "reachable" || observed.LastReason != "lookup_ok" || observed.LookupCount != 1 || observed.BridgeCount != 1 {
		t.Fatalf("observed snapshot = %+v", observed)
	}
	if !observed.FreshUntil.After(now) {
		t.Fatalf("fresh until = %s", observed.FreshUntil)
	}
}

func TestStaticPeerRouterRejectsUnpinnedOrUnsafeCandidates(t *testing.T) {
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("hub: %v", err)
	}

	tests := []struct {
		name   string
		peer   FederationPeer
		policy FederationEndpointPolicy
	}{
		{
			name: "missing relay key",
			peer: FederationPeer{Endpoint: "wss://relay.example.test:443/relay/v0", ProfileMultihash: protocol.DevelopmentProfileMultihash},
		},
		{
			name: "missing profile",
			peer: FederationPeer{Endpoint: "wss://relay.example.test:443/relay/v0", RelayPublicKey: testB64x32},
		},
		{
			name: "insecure ws without opt in",
			peer: FederationPeer{Endpoint: "ws://relay.example.test:80/relay/v0", RelayPublicKey: testB64x32, ProfileMultihash: protocol.DevelopmentProfileMultihash},
		},
		{
			name: "private address without opt in",
			peer: FederationPeer{Endpoint: "wss://127.0.0.1:443/relay/v0", RelayPublicKey: testB64x32, ProfileMultihash: protocol.DevelopmentProfileMultihash},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewStaticPeerRouter(StaticPeerRouterConfig{
				Peers:          []FederationPeer{test.peer},
				LocalHub:       hub,
				EndpointPolicy: test.policy,
			})
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("NewStaticPeerRouter error = %v, want ErrInvalidConfig", err)
			}
		})
	}
}

func TestStaticPeerRouterAllowsDevelopmentEndpointOnlyWithExplicitPolicy(t *testing.T) {
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	_, err = NewStaticPeerRouter(StaticPeerRouterConfig{
		Peers: []FederationPeer{{
			Endpoint:         "ws://127.0.0.1:8080/relay/v0",
			RelayPublicKey:   testB64x32,
			ProfileMultihash: protocol.DevelopmentProfileMultihash,
		}},
		LocalHub: hub,
		EndpointPolicy: FederationEndpointPolicy{
			AllowInsecureWS:       true,
			AllowPrivateAddresses: true,
		},
	})
	if err != nil {
		t.Fatalf("NewStaticPeerRouter development policy: %v", err)
	}
}

func TestVerifyFederationChallengeFailsClosedWithoutPin(t *testing.T) {
	if err := verifyFederationChallenge(nil, nil, nil, ""); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("verifyFederationChallenge error = %v, want ErrInvalidFrame", err)
	}
}
