package wss

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/code4bones/branch/internal/discovery"
	"github.com/code4bones/branch/internal/relay"
	protocol "github.com/code4bones/branch/protocol/v0"
	"github.com/coder/websocket"
)

// FederationIdentity is the local relay identity used to bind a federation
// HELLO's beacon to its attachment AUTH proof.
type FederationIdentity interface {
	PublicKey() ed25519.PublicKey
	Sign([]byte) []byte
}

// DiscoveredPeerRouterConfig has no peer inventory. A source is queried only
// after a local lookup miss; all returned carrier observations remain untrusted
// until protocol-core validation succeeds.
type DiscoveredPeerRouterConfig struct {
	Source         discovery.BootstrapBeaconLookupSource
	Identity       FederationIdentity
	LocalHub       *relay.Hub
	EndpointPolicy FederationEndpointPolicy
	Random         io.Reader
	Now            func() time.Time
	MaxFrameBytes  int64
	DialTimeout    time.Duration
	WriteTimeout   time.Duration
}

// DiscoveredPeerRouter derives up to eight ephemeral WSS candidates from one
// carrier pass. It keeps neither a relay topology nor a durable candidate cache.
type DiscoveredPeerRouter struct {
	source   discovery.BootstrapBeaconLookupSource
	identity FederationIdentity
	base     *StaticPeerRouter
	now      func() time.Time

	backoffMu       sync.Mutex
	backoff         map[string]time.Time
	discoveryMu     sync.Mutex
	discoveryStatus FederationCarrierObservation
}

// FederationCarrierObservation is a short-lived, protected operator summary
// of one carrier pass. It contains no candidate endpoint, identity, route,
// session, or carrier response data.
type FederationCarrierObservation struct {
	Carrier        string
	State          string
	LastLookupAt   time.Time
	LastReason     string
	CandidateCount int
	FreshUntil     time.Time
}

func NewDiscoveredPeerRouter(config DiscoveredPeerRouterConfig) (*DiscoveredPeerRouter, error) {
	if config.Source == nil || config.Identity == nil || len(config.Identity.PublicKey()) != ed25519.PublicKeySize {
		return nil, ErrInvalidConfig
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	base, err := NewStaticPeerRouter(StaticPeerRouterConfig{
		LocalHub:       config.LocalHub,
		EndpointPolicy: config.EndpointPolicy,
		Random:         config.Random,
		Now:            now,
		MaxFrameBytes:  config.MaxFrameBytes,
		DialTimeout:    config.DialTimeout,
		WriteTimeout:   config.WriteTimeout,
	})
	if err != nil {
		return nil, err
	}
	return &DiscoveredPeerRouter{
		source:   config.Source,
		identity: config.Identity,
		base:     base,
		now:      now,
		backoff:  make(map[string]time.Time, maxFederationPeers),
	}, nil
}

func (*DiscoveredPeerRouter) ID() string { return "relay_discovery" }

// LookupFederatedPeer makes exactly one source call for this local miss. A
// candidate's key/profile come solely from its verified signed beacon, never
// from client hints or carrier metadata.
func (router *DiscoveredPeerRouter) LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) (relay.FederatedForwarder, bool) {
	_ = hints
	localBeacon, candidates := router.discover(ctx, now)
	if localBeacon == "" {
		return nil, false
	}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return nil, false
		}
		if router.backoffActive(candidate.identityKey, now) {
			continue
		}
		client, err := router.dial(ctx, candidate, localBeacon)
		if err != nil {
			router.recordCandidateObservation(candidate, "unreachable", "discovered_dial_failed", 0, now)
			router.recordBackoff(candidate, now)
			continue
		}
		err = client.lookup(ctx, peerID)
		client.close()
		if err != nil {
			router.recordCandidateObservation(candidate, "unreachable", "peer_unavailable", 0, now)
			router.recordBackoff(candidate, now)
			continue
		}
		router.clearBackoff(candidate.identityKey)
		router.recordCandidateObservation(candidate, "reachable", "discovered_lookup_ok", 1, now)
		return &federatedWSSForwarder{
			router:         router.base,
			endpoint:       candidate.endpoint,
			relayPublicKey: append([]byte(nil), candidate.relayPublicKey...),
			peerID:         peerID,
			dial: func(callCtx context.Context, forwarded federationCandidate) (*federationClient, error) {
				return router.dial(callCtx, forwarded, localBeacon)
			},
		}, true
	}
	return nil, false
}

// LookupIdentityContact asks only the bounded discovered relay candidates for
// exact signed records. The remote federation attachment consumes hop_limit=1
// locally and never starts discovery on behalf of this request.
func (router *DiscoveredPeerRouter) LookupIdentityContact(ctx context.Context, branchID string) ([]discovery.IdentityContactCandidate, error) {
	if err := protocol.ParseBranchID(branchID); err != nil {
		return nil, ErrInvalidFrame
	}
	now := router.now()
	localBeacon, candidates := router.discover(ctx, now)
	if localBeacon == "" {
		return nil, nil
	}
	records := make([]discovery.IdentityContactCandidate, 0, maxFederationResponses)
	for _, candidate := range candidates {
		if len(records) == maxFederationResponses {
			break
		}
		if err := ctx.Err(); err != nil {
			return records, err
		}
		if router.backoffActive(candidate.identityKey, now) {
			continue
		}
		client, err := router.dial(ctx, candidate, localBeacon)
		if err != nil {
			router.recordCandidateObservation(candidate, "unreachable", "identity_dial_failed", 0, now)
			router.recordBackoff(candidate, now)
			continue
		}
		wrappers, lookupErr := client.lookupFederatedIdentityContact(ctx, branchID)
		client.close()
		if lookupErr != nil {
			router.recordCandidateObservation(candidate, "unreachable", "identity_unavailable", 0, now)
			router.recordBackoff(candidate, now)
			continue
		}
		router.clearBackoff(candidate.identityKey)
		router.recordCandidateObservation(candidate, "reachable", "identity_lookup_ok", 0, now)
		for _, wrapper := range wrappers {
			records = append(records, discovery.IdentityContactCandidate{Wrapper: wrapper, Source: candidate.endpoint})
			if len(records) == maxFederationResponses {
				break
			}
		}
	}
	return records, nil
}

func (router *DiscoveredPeerRouter) FederationSnapshot() []FederationPeerObservation {
	return router.base.FederationSnapshot()
}

// FederationCarrierSnapshot returns the latest process-local carrier outcome
// while it remains fresh. It is observational only and cannot influence
// discovery or forwarding.
func (router *DiscoveredPeerRouter) FederationCarrierSnapshot() *FederationCarrierObservation {
	router.discoveryMu.Lock()
	defer router.discoveryMu.Unlock()
	if router.discoveryStatus.FreshUntil.IsZero() || !router.discoveryStatus.FreshUntil.After(router.now()) {
		router.discoveryStatus = FederationCarrierObservation{}
		return nil
	}
	observation := router.discoveryStatus
	return &observation
}

func (router *DiscoveredPeerRouter) discover(ctx context.Context, now time.Time) (string, []federationCandidate) {
	observations, err := router.source.LookupBootstrapBeacons(ctx)
	if err != nil {
		router.recordCarrierObservation("unavailable", carrierLookupFailureReason(err), 0, now)
		return "", nil
	}
	localKey := router.identity.PublicKey()
	validated := make(map[string]protocol.SignedBootstrapBeacon, maxFederationPeers)
	equivocating := make(map[string]struct{})
	for _, observation := range observations {
		result := protocol.ValidateBranchTextBootstrapBeacon(observation.Wrapper, protocol.BootstrapBeaconValidationOptions{NowUnix: now.Unix()})
		if !result.Accepted || result.Beacon == nil || !slices.Contains(result.Beacon.Payload.RelayCapabilities, protocol.RelayFederationLiveRole) {
			continue
		}
		identityKey := base64.RawURLEncoding.EncodeToString(result.Beacon.Envelope.Sender.PublicKey)
		if _, rejected := equivocating[identityKey]; rejected {
			continue
		}
		current, exists := validated[identityKey]
		if !exists || result.Beacon.Payload.Sequence > current.Payload.Sequence {
			validated[identityKey] = *result.Beacon
			continue
		}
		if result.Beacon.Payload.Sequence == current.Payload.Sequence && result.Beacon.Wrapper != current.Wrapper {
			delete(validated, identityKey)
			equivocating[identityKey] = struct{}{}
		}
	}
	localBeacon := ""
	candidates := make([]federationCandidate, 0, maxFederationPeers)
	for identityKey, beacon := range validated {
		if bytes.Equal(beacon.Envelope.Sender.PublicKey, localKey) {
			localBeacon = beacon.Wrapper
			continue
		}
		profile := firstSupportedProfile(beacon.Payload.ProfileMultihashes)
		if profile == "" {
			continue
		}
		for _, endpoint := range beacon.Payload.RelayEndpoints {
			if endpoint.Transport != "wss" {
				continue
			}
			cleaned, endpointErr := cleanFederationEndpoint(endpoint.URI, router.base.endpointPolicy)
			if endpointErr != nil {
				continue
			}
			candidates = append(candidates, federationCandidate{
				endpoint:         cleaned,
				relayPublicKey:   append([]byte(nil), beacon.Envelope.Sender.PublicKey...),
				profileMultihash: profile,
				priority:         int64(endpoint.Priority),
				identityKey:      identityKey,
				expiresAt:        time.Unix(beacon.Payload.ExpiresAt, 0),
			})
			break
		}
	}
	slices.SortFunc(candidates, func(left, right federationCandidate) int {
		if left.priority != right.priority {
			if left.priority < right.priority {
				return -1
			}
			return 1
		}
		return strings.Compare(left.identityKey, right.identityKey)
	})
	if len(candidates) > maxFederationPeers {
		candidates = candidates[:maxFederationPeers]
	}
	carrierState, carrierReason := "ready", "candidates_ready"
	if localBeacon == "" {
		carrierState, carrierReason = "unavailable", "local_beacon_missing"
	} else if len(candidates) == 0 {
		carrierState, carrierReason = "unavailable", "no_valid_candidates"
	}
	router.recordCarrierObservation(carrierState, carrierReason, len(candidates), now)
	return localBeacon, candidates
}

func (router *DiscoveredPeerRouter) recordCarrierObservation(state string, reason string, candidateCount int, now time.Time) {
	carrier := "carrier"
	if source, ok := router.source.(discovery.BootstrapBeaconSourceID); ok && validFederationCarrierID(source.ID()) {
		carrier = source.ID()
	}
	router.discoveryMu.Lock()
	defer router.discoveryMu.Unlock()
	router.discoveryStatus = FederationCarrierObservation{
		Carrier:        carrier,
		State:          state,
		LastLookupAt:   now.UTC(),
		LastReason:     reason,
		CandidateCount: candidateCount,
		FreshUntil:     now.Add(router.base.localHub.PresenceTTL()).UTC(),
	}
}

func carrierLookupFailureReason(err error) string {
	if reason, ok := discovery.BootstrapBeaconLookupFailureReason(err); ok && validFederationDiagnosticReason(reason) {
		return reason
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "carrier_timeout"
	}
	return "carrier_lookup_failed"
}

func validFederationCarrierID(value string) bool {
	if len(value) == 0 || len(value) > 32 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func validFederationDiagnosticReason(value string) bool {
	if len(value) == 0 || len(value) > 96 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func (router *DiscoveredPeerRouter) backoffActive(identityKey string, now time.Time) bool {
	router.backoffMu.Lock()
	defer router.backoffMu.Unlock()
	until, ok := router.backoff[identityKey]
	if !ok || !until.After(now) {
		delete(router.backoff, identityKey)
		return false
	}
	return true
}

func (router *DiscoveredPeerRouter) recordBackoff(candidate federationCandidate, now time.Time) {
	until := now.Add(30 * time.Second)
	if candidate.expiresAt.Before(until) {
		until = candidate.expiresAt
	}
	router.backoffMu.Lock()
	defer router.backoffMu.Unlock()
	if len(router.backoff) >= maxFederationPeers {
		for identityKey := range router.backoff {
			delete(router.backoff, identityKey)
			break
		}
	}
	router.backoff[candidate.identityKey] = until
}

func (router *DiscoveredPeerRouter) clearBackoff(identityKey string) {
	router.backoffMu.Lock()
	defer router.backoffMu.Unlock()
	delete(router.backoff, identityKey)
}

func (router *DiscoveredPeerRouter) recordCandidateObservation(candidate federationCandidate, state string, reason string, bridgeCount int, now time.Time) {
	freshUntil := candidate.expiresAt
	if state == "reachable" {
		presenceUntil := now.Add(router.base.localHub.PresenceTTL())
		if freshUntil.IsZero() || presenceUntil.Before(freshUntil) {
			freshUntil = presenceUntil
		}
	}
	router.base.recordPeerObservationUntil(candidate.endpoint, state, reason, bridgeCount, now, freshUntil)
}

func firstSupportedProfile(profiles []string) string {
	if slices.Contains(profiles, protocol.DevelopmentProfileMultihash) {
		return protocol.DevelopmentProfileMultihash
	}
	return ""
}

func (router *DiscoveredPeerRouter) dial(parent context.Context, candidate federationCandidate, localBeacon string) (*federationClient, error) {
	ctx, cancel := context.WithTimeout(parent, router.base.dialTimeout)
	defer cancel()
	httpClient, err := router.base.federationHTTPClient(ctx, candidate.endpoint)
	if err != nil {
		return nil, err
	}
	conn, _, err := websocket.Dial(ctx, candidate.endpoint, &websocket.DialOptions{HTTPClient: httpClient})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(router.base.maxFrameBytes)
	client := &federationClient{conn: &connection{conn: conn}, writeTimeout: router.base.writeTimeout, random: router.base.random, now: router.base.now, maxFrameBytes: router.base.maxFrameBytes, responses: make(chan map[string]any, maxFederationResponses), expectedRelayPublicKey: append([]byte(nil), candidate.relayPublicKey...), expectedProfile: candidate.profileMultihash, requestedRole: protocol.RelayFederationLiveRole, relayBeacon: localBeacon, clientPublicKey: append(ed25519.PublicKey(nil), router.identity.PublicKey()...), clientSign: router.identity.Sign}
	if err := client.attach(ctx); err != nil {
		client.close()
		return nil, err
	}
	return client, nil
}
