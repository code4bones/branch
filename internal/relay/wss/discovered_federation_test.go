package wss

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	"github.com/code4bones/branch/internal/identity"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
)

type testBootstrapBeaconSource struct {
	calls        int
	observations []discovery.BootstrapBeaconCandidate
	err          error
}

func (source *testBootstrapBeaconSource) LookupBootstrapBeacons(context.Context) ([]discovery.BootstrapBeaconCandidate, error) {
	source.calls++
	if source.err != nil {
		return nil, source.err
	}
	return append([]discovery.BootstrapBeaconCandidate(nil), source.observations...), nil
}

func (source *testBootstrapBeaconSource) ID() string { return "github" }

func TestDiscoveredPeerRouterRecordsSafeCarrierLookupFailure(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	localIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate local identity: %v", err)
	}
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	router, err := NewDiscoveredPeerRouter(DiscoveredPeerRouterConfig{
		Source:   &testBootstrapBeaconSource{err: discovery.NewBootstrapBeaconLookupFailure("github_rate_limited", context.DeadlineExceeded)},
		Identity: localIdentity,
		LocalHub: hub,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	localBeacon, candidates := router.discover(context.Background(), now)
	if localBeacon != "" || len(candidates) != 0 {
		t.Fatalf("unexpected discovery result: local=%q candidates=%+v", localBeacon, candidates)
	}
	observation := router.FederationCarrierSnapshot()
	if observation == nil || observation.Carrier != "github" || observation.State != "unavailable" || observation.LastReason != "github_rate_limited" || observation.CandidateCount != 0 {
		t.Fatalf("unexpected carrier observation: %+v", observation)
	}
}

func TestDiscoveredPeerRouterDerivesEphemeralCandidatesFromSignedBeacons(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	localIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate local identity: %v", err)
	}
	remotePublicKey, remotePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate remote identity: %v", err)
	}
	localWrapper := testFederationBeacon(t, now, localIdentity.PublicKey(), localIdentity.Sign, "wss://local.example.test:443/relay/v0", 0)
	remoteWrapper := testFederationBeacon(t, now, remotePublicKey, func(input []byte) []byte { return ed25519.Sign(remotePrivateKey, input) }, "wss://remote.example.test:443/relay/v0", 1)
	source := &testBootstrapBeaconSource{observations: []discovery.BootstrapBeaconCandidate{
		{Wrapper: "BRANCH0.poison", Source: "carrier/poison"},
		{Wrapper: remoteWrapper, Source: "carrier/remote"},
		{Wrapper: localWrapper, Source: "carrier/local"},
	}}
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	router, err := NewDiscoveredPeerRouter(DiscoveredPeerRouterConfig{
		Source:   source,
		Identity: localIdentity,
		LocalHub: hub,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	localBeacon, candidates := router.discover(context.Background(), now)
	if source.calls != 1 {
		t.Fatalf("source calls = %d", source.calls)
	}
	if localBeacon != localWrapper || len(candidates) != 1 {
		t.Fatalf("discovery = local %q candidates %+v", localBeacon, candidates)
	}
	if candidates[0].endpoint != "wss://remote.example.test:443/relay/v0" || string(candidates[0].relayPublicKey) != string(remotePublicKey) {
		t.Fatalf("candidate = %+v", candidates[0])
	}
	_, _ = router.discover(context.Background(), now)
	if source.calls != 2 {
		t.Fatalf("source was cached; calls = %d", source.calls)
	}
}

func TestDiscoveredPeerRouterMergesRelaySequencesAndRejectsEquivocation(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	localIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate local identity: %v", err)
	}
	remotePublicKey, remotePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate remote identity: %v", err)
	}
	equivocatingPublicKey, equivocatingPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate equivocating identity: %v", err)
	}
	localWrapper := testFederationBeacon(t, now, localIdentity.PublicKey(), localIdentity.Sign, "wss://local.example.test:443/relay/v0", 0)
	oldWrapper := testFederationBeaconWithSequence(t, now, remotePublicKey, func(input []byte) []byte { return ed25519.Sign(remotePrivateKey, input) }, "wss://old.example.test:443/relay/v0", 0, 1)
	currentWrapper := testFederationBeaconWithSequence(t, now, remotePublicKey, func(input []byte) []byte { return ed25519.Sign(remotePrivateKey, input) }, "wss://current.example.test:443/relay/v0", 0, 2)
	equivocationLeft := testFederationBeaconWithSequence(t, now, equivocatingPublicKey, func(input []byte) []byte { return ed25519.Sign(equivocatingPrivateKey, input) }, "wss://left.example.test:443/relay/v0", 0, 1)
	equivocationRight := testFederationBeaconWithSequence(t, now, equivocatingPublicKey, func(input []byte) []byte { return ed25519.Sign(equivocatingPrivateKey, input) }, "wss://right.example.test:443/relay/v0", 0, 1)
	source := &testBootstrapBeaconSource{observations: []discovery.BootstrapBeaconCandidate{
		{Wrapper: localWrapper},
		{Wrapper: oldWrapper},
		{Wrapper: currentWrapper},
		{Wrapper: equivocationLeft},
		{Wrapper: equivocationRight},
	}}
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	router, err := NewDiscoveredPeerRouter(DiscoveredPeerRouterConfig{Source: source, Identity: localIdentity, LocalHub: hub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	_, candidates := router.discover(context.Background(), now)
	if len(candidates) != 1 || candidates[0].endpoint != "wss://current.example.test:443/relay/v0" {
		t.Fatalf("candidates = %+v", candidates)
	}
}

func TestDiscoveredPeerRouterCapsDistinctRelayIdentities(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	localIdentity, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate local identity: %v", err)
	}
	observations := []discovery.BootstrapBeaconCandidate{{Wrapper: testFederationBeacon(t, now, localIdentity.PublicKey(), localIdentity.Sign, "wss://local.example.test:443/relay/v0", 0)}}
	for index := 0; index < maxFederationPeers+1; index++ {
		publicKey, privateKey, keyErr := ed25519.GenerateKey(rand.Reader)
		if keyErr != nil {
			t.Fatalf("generate remote identity: %v", keyErr)
		}
		endpoint := "wss://relay" + string(rune('a'+index)) + ".example.test:443/relay/v0"
		observations = append(observations, discovery.BootstrapBeaconCandidate{Wrapper: testFederationBeacon(t, now, publicKey, func(input []byte) []byte { return ed25519.Sign(privateKey, input) }, endpoint, uint64(index))})
	}
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	router, err := NewDiscoveredPeerRouter(DiscoveredPeerRouterConfig{Source: &testBootstrapBeaconSource{observations: observations}, Identity: localIdentity, LocalHub: hub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	_, candidates := router.discover(context.Background(), now)
	if len(candidates) != maxFederationPeers {
		t.Fatalf("candidate count = %d", len(candidates))
	}
}

func TestDiscoveredFederationObservationsAreBoundedAndExpire(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	hub, err := relay.NewHub(relay.DefaultConfig())
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	router, err := NewStaticPeerRouter(StaticPeerRouterConfig{LocalHub: hub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	for index := 0; index < maxFederationPeers+1; index++ {
		router.recordPeerObservationUntil("wss://relay"+string(rune('a'+index))+".example.test:443/relay/v0", "unreachable", "test", 0, now, now.Add(time.Second))
	}
	observations := router.FederationSnapshot()
	if len(observations) != maxFederationPeers {
		t.Fatalf("observation count = %d", len(observations))
	}
	for _, observation := range observations {
		if observation.PeerRef == "" || observation.PeerRef == "wss://" {
			t.Fatalf("unsafe peer observation: %+v", observation)
		}
	}
	if stale := router.FederationSnapshot(); len(stale) != maxFederationPeers {
		t.Fatalf("unexpected early prune: %+v", stale)
	}
	router.now = func() time.Time { return now.Add(2 * time.Second) }
	if stale := router.FederationSnapshot(); len(stale) != 0 {
		t.Fatalf("stale observations = %+v", stale)
	}
}

func TestFederationRequestWindowRejectsDuplicateUntilExpiry(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	window := federationRequestWindow{entries: make(map[federationRequestKey]time.Time)}
	origin := relay.PeerID(base64URL(bytes.Repeat([]byte{7}, 32)))
	if !window.reserve(origin, base64URL(bytes.Repeat([]byte{8}, 16)), now) {
		t.Fatal("first federation request rejected")
	}
	if window.reserve(origin, base64URL(bytes.Repeat([]byte{8}, 16)), now) {
		t.Fatal("duplicate federation request accepted")
	}
	if !window.reserve(origin, base64URL(bytes.Repeat([]byte{8}, 16)), now.Add(federationRequestLifetime+time.Second)) {
		t.Fatal("expired federation request remained blocked")
	}
}

func TestFederationHelloAndAuthBindTheSameRelayKey(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	wrapper := testFederationBeacon(t, now, publicKey, func(input []byte) []byte { return ed25519.Sign(privateKey, input) }, "wss://relay.example.test:443/relay/v0", 0)
	helloRaw, err := json.Marshal(map[string]any{
		"type":            "HELLO",
		"client_nonce":    base64URL(bytes.Repeat([]byte{1}, 32)),
		"client_time":     now.Unix(),
		"requested_role":  protocol.RelayFederationLiveRole,
		"relay_beacon":    wrapper,
		"max_frame_bytes": 49152,
		"offers": []map[string]any{{
			"wire_version":          0,
			"protocol":              protocol.ProtocolID,
			"profile_multihash":     protocol.DevelopmentProfileMultihash,
			"capabilities":          []string{protocol.RelayForwardLiveRole, "route.relay.wss/0"},
			"required_capabilities": []string{protocol.RelayForwardLiveRole},
			"extensions":            []string{},
			"required_extensions":   []string{},
		}},
	})
	if err != nil {
		t.Fatalf("marshal hello: %v", err)
	}
	hello, err := decodeHello(helloRaw, now.Unix())
	if err != nil || string(hello.FederationPublicKey) != string(publicKey) {
		t.Fatalf("hello = %+v, err = %v", hello, err)
	}
	nonce := bytes.Repeat([]byte{2}, 32)
	relayNonce := bytes.Repeat([]byte{3}, 32)
	transcript := bytes.Repeat([]byte{4}, 32)
	authRaw, err := json.Marshal(map[string]any{
		"type":              "AUTH",
		"client_public_key": base64URL(publicKey),
		"client_nonce":      base64URL(nonce),
		"relay_nonce":       base64URL(relayNonce),
		"transcript_hash":   base64URL(transcript),
		"client_proof":      base64URL(ed25519.Sign(privateKey, proofInput(transcript))),
	})
	if err != nil {
		t.Fatalf("marshal auth: %v", err)
	}
	if _, err := validateAuth(authRaw, nonce, relayNonce, transcript, bytes.Repeat([]byte{9}, 32)); err == nil {
		t.Fatal("mismatched federation key accepted")
	}
	if peerID, err := validateAuth(authRaw, nonce, relayNonce, transcript, hello.FederationPublicKey); err != nil || peerID != relay.PeerID(base64URL(publicKey)) {
		t.Fatalf("auth peer = %q, err = %v", peerID, err)
	}
}

func testFederationBeacon(t *testing.T, now time.Time, publicKey ed25519.PublicKey, sign func([]byte) []byte, endpoint string, priority uint64) string {
	return testFederationBeaconWithSequence(t, now, publicKey, sign, endpoint, priority, 1)
}

func testFederationBeaconWithSequence(t *testing.T, now time.Time, publicKey ed25519.PublicKey, sign func([]byte) []byte, endpoint string, priority uint64, sequence uint64) string {
	t.Helper()
	wrapper, err := protocol.CreateBootstrapBeaconWrapper(protocol.BootstrapBeaconOptions{
		NowUnix:         now.Unix(),
		ExpiresAtUnix:   now.Add(time.Hour).Unix(),
		Sequence:        sequence,
		SenderPublicKey: publicKey,
		RelayEndpoints:  []protocol.BootstrapRelayEndpoint{{Transport: "wss", URI: endpoint, Priority: priority}},
		RelayCapabilities: []string{
			protocol.RelayFederationLiveRole,
			protocol.RelayForwardLiveRole,
			"route.relay.wss/0",
		},
		Sign: func(input []byte) ([]byte, error) { return sign(input), nil },
	})
	if err != nil {
		t.Fatalf("create federation beacon: %v", err)
	}
	return wrapper
}
