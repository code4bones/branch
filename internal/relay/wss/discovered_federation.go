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
	// CarrierPassMinInterval bounds anonymous GitHub carrier refills. Zero
	// selects the safe GitHub default; other sources remain unpaced unless a
	// future profile defines its own policy.
	CarrierPassMinInterval time.Duration
	Observer               FederationObserver
}

// DiscoveredPeerRouter keeps a bounded process-local view of already validated
// public relay beacons. It is not a presence view, route map, or durable
// topology: entries expire with their signed beacons and disappear on restart.
type DiscoveredPeerRouter struct {
	source                 discovery.BootstrapBeaconLookupSource
	identity               FederationIdentity
	base                   *StaticPeerRouter
	now                    func() time.Time
	observer               FederationObserver
	carrierPassMinInterval time.Duration

	backoffMu       sync.Mutex
	backoff         map[string]time.Time
	carrierPassMu   sync.Mutex
	nextCarrierPass time.Time
	refreshMu       sync.Mutex
	viewMu          sync.Mutex
	view            federationDiscoveryView
	discoveryMu     sync.Mutex
	discoveryStatus FederationCarrierObservation
}

type federationDiscoveryView struct {
	localBeacon  string
	localExpires time.Time
	candidates   []federationCandidate
}

const federationRefreshInterval = time.Hour

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
	carrierPassMinInterval, err := githubCarrierPassMinInterval(config.Source, config.CarrierPassMinInterval)
	if err != nil {
		return nil, err
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
		source:                 config.Source,
		identity:               config.Identity,
		base:                   base,
		now:                    now,
		observer:               federationObserverOrNoop(config.Observer),
		carrierPassMinInterval: carrierPassMinInterval,
		backoff:                make(map[string]time.Time, maxFederationPeers),
	}, nil
}

func (*DiscoveredPeerRouter) ID() string { return "relay_discovery" }

// LookupFederatedPeer probes the bounded verified local view before requesting
// a paced carrier refill. A candidate's key/profile come solely from its
// validated signed beacon, never from client hints or carrier metadata.
func (router *DiscoveredPeerRouter) LookupFederatedPeer(ctx context.Context, peerID relay.PeerID, hints []FederationRouteHint, now time.Time) (relay.FederatedForwarder, bool) {
	_ = hints
	lookupStarted := router.now()
	localBeacon, candidates := router.discover(ctx, now)
	if localBeacon == "" {
		router.observe(ctx, FederationRouteUnavailable, "carrier_unavailable", router.now().Sub(lookupStarted))
		return nil, false
	}
	if forwarder, ok := router.probeFederatedPeer(ctx, peerID, localBeacon, candidates, now, lookupStarted); ok {
		return forwarder, true
	}
	if !router.candidatesExhausted(candidates, now) {
		router.observe(ctx, FederationRouteUnavailable, "no_candidate", router.now().Sub(lookupStarted))
		return nil, false
	}
	router.clearDiscoveryView()
	localBeacon, candidates = router.refresh(ctx, now, false)
	if localBeacon == "" {
		router.observe(ctx, FederationRouteUnavailable, "carrier_unavailable", router.now().Sub(lookupStarted))
		return nil, false
	}
	if forwarder, ok := router.probeFederatedPeer(ctx, peerID, localBeacon, candidates, now, lookupStarted); ok {
		return forwarder, true
	}
	router.observe(ctx, FederationRouteUnavailable, "no_candidate", router.now().Sub(lookupStarted))
	return nil, false
}

func (router *DiscoveredPeerRouter) probeFederatedPeer(ctx context.Context, peerID relay.PeerID, localBeacon string, candidates []federationCandidate, now time.Time, lookupStarted time.Time) (relay.FederatedForwarder, bool) {
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return nil, false
		}
		if router.backoffActive(candidate.identityKey, now) {
			router.observe(ctx, FederationCandidateRejected, "relay_backoff", 0)
			continue
		}
		candidateStarted := router.now()
		client, err := router.dial(ctx, candidate, localBeacon)
		if err != nil {
			router.recordCandidateObservation(candidate, "unreachable", "discovered_dial_failed", 0, now)
			router.recordBackoff(candidate, now)
			router.observe(ctx, FederationCandidateRejected, federationFailureReason(err), router.now().Sub(candidateStarted))
			continue
		}
		err = client.lookup(ctx, peerID)
		client.close()
		if err != nil {
			router.recordLookupFailure(candidate, err, now)
			router.observe(ctx, FederationCandidateRejected, federationFailureReason(err), router.now().Sub(candidateStarted))
			continue
		}
		router.clearBackoff(candidate.identityKey)
		router.recordCandidateObservation(candidate, "reachable", "discovered_lookup_ok", 1, now)
		router.observe(ctx, FederationRouteSelected, "success", router.now().Sub(lookupStarted))
		return &federatedWSSForwarder{
			router:         router.base,
			endpoint:       candidate.endpoint,
			relayPublicKey: append([]byte(nil), candidate.relayPublicKey...),
			peerID:         peerID,
			dial: func(callCtx context.Context, forwarded federationCandidate) (*federationClient, error) {
				return router.dial(callCtx, forwarded, localBeacon)
			},
			observer: router.observer,
		}, true
	}
	return nil, false
}

// recordLookupFailure keeps an unavailable peer distinct from an unavailable
// relay. A peer can legitimately announce just after a concurrent lookup; a
// relay-wide backoff in that case would suppress the next otherwise-valid
// retry for every peer on the candidate relay.
func (router *DiscoveredPeerRouter) recordLookupFailure(candidate federationCandidate, err error, now time.Time) {
	if errors.Is(err, relay.ErrPeerUnavailable) {
		router.recordCandidateObservation(candidate, "reachable", "peer_unavailable", 0, now)
		return
	}
	router.recordCandidateObservation(candidate, "unreachable", "lookup_failed", 0, now)
	router.recordBackoff(candidate, now)
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

// Seed performs one bounded startup refresh. Failure is observational: an
// unavailable carrier cannot prevent the relay itself from serving live local
// traffic.
func (router *DiscoveredPeerRouter) Seed(ctx context.Context) {
	router.refresh(ctx, router.now(), true)
}

// Run refreshes the process-local view at a bounded identity-jittered cadence.
// It owns no state outside the process and returns immediately when the node
// context is cancelled.
func (router *DiscoveredPeerRouter) Run(ctx context.Context) {
	timer := time.NewTimer(router.refreshDelay())
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			router.refresh(ctx, router.now(), true)
			timer.Reset(router.refreshDelay())
		}
	}
}

func (router *DiscoveredPeerRouter) refreshDelay() time.Duration {
	// Public relay keys are stable only for this node lifetime. Deriving a
	// bounded offset from the local key avoids synchronized hourly refreshes
	// without retaining an extra schedule or using carrier input.
	key := router.identity.PublicKey()
	var offset uint64
	for _, byteValue := range key[:8] {
		offset = offset<<8 | uint64(byteValue)
	}
	return federationRefreshInterval + time.Duration(offset%(uint64(5*time.Minute)))
}

func (router *DiscoveredPeerRouter) discover(ctx context.Context, now time.Time) (string, []federationCandidate) {
	if localBeacon, candidates := router.cachedDiscovery(now); localBeacon != "" {
		router.recordCarrierObservation("ready", "cache_ready", len(candidates), now)
		return localBeacon, candidates
	}
	return router.refresh(ctx, now, false)
}

func (router *DiscoveredPeerRouter) cachedDiscovery(now time.Time) (string, []federationCandidate) {
	router.viewMu.Lock()
	defer router.viewMu.Unlock()
	if router.view.localBeacon == "" || !router.view.localExpires.After(now) {
		router.view = federationDiscoveryView{}
		return "", nil
	}
	candidates := make([]federationCandidate, 0, len(router.view.candidates))
	for _, candidate := range router.view.candidates {
		if candidate.expiresAt.After(now) {
			candidates = append(candidates, cloneFederationCandidate(candidate))
		}
	}
	if len(candidates) == 0 {
		router.view = federationDiscoveryView{}
		return "", nil
	}
	router.view.candidates = candidates
	return router.view.localBeacon, append([]federationCandidate(nil), candidates...)
}

func (router *DiscoveredPeerRouter) clearDiscoveryView() {
	router.viewMu.Lock()
	router.view = federationDiscoveryView{}
	router.viewMu.Unlock()
}

func (router *DiscoveredPeerRouter) candidatesExhausted(candidates []federationCandidate, now time.Time) bool {
	if len(candidates) == 0 {
		return true
	}
	for _, candidate := range candidates {
		if !router.backoffActive(candidate.identityKey, now) {
			return false
		}
	}
	return true
}

func cloneFederationCandidate(candidate federationCandidate) federationCandidate {
	candidate.relayPublicKey = append([]byte(nil), candidate.relayPublicKey...)
	return candidate
}

func (router *DiscoveredPeerRouter) refresh(ctx context.Context, now time.Time, force bool) (string, []federationCandidate) {
	if !router.refreshMu.TryLock() {
		return router.cachedDiscovery(now)
	}
	defer router.refreshMu.Unlock()
	if !force {
		if localBeacon, candidates := router.cachedDiscovery(now); localBeacon != "" {
			return localBeacon, candidates
		}
	}
	started := router.now()
	router.observe(ctx, FederationCarrierLookupStarted, "", 0)
	if !router.reserveCarrierPass(now) {
		router.recordCarrierObservation("unavailable", "carrier_rate_limited", 0, now)
		router.observe(ctx, FederationCarrierLookupFailed, "rate_limited", router.now().Sub(started))
		return "", nil
	}
	observations, err := router.source.LookupBootstrapBeacons(ctx)
	if err != nil {
		router.recordCarrierObservation("unavailable", carrierLookupFailureReason(err), 0, now)
		router.observe(ctx, FederationCarrierLookupFailed, federationFailureReason(err), router.now().Sub(started))
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
	var localExpires time.Time
	candidates := make([]federationCandidate, 0, maxFederationPeers)
	for identityKey, beacon := range validated {
		if bytes.Equal(beacon.Envelope.Sender.PublicKey, localKey) {
			localBeacon = beacon.Wrapper
			localExpires = time.Unix(beacon.Payload.ExpiresAt, 0)
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
	if carrierState == "ready" {
		router.storeDiscoveryView(localBeacon, localExpires, candidates)
		router.observe(ctx, FederationCarrierLookupCompleted, "success", router.now().Sub(started))
	} else {
		router.observe(ctx, FederationCarrierLookupFailed, "carrier_unavailable", router.now().Sub(started))
	}
	return localBeacon, candidates
}

func (router *DiscoveredPeerRouter) storeDiscoveryView(localBeacon string, localExpires time.Time, candidates []federationCandidate) {
	if localBeacon == "" || len(candidates) == 0 || len(candidates) > maxFederationPeers {
		return
	}
	copyCandidates := make([]federationCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		copyCandidates = append(copyCandidates, cloneFederationCandidate(candidate))
	}
	router.viewMu.Lock()
	router.view = federationDiscoveryView{localBeacon: localBeacon, localExpires: localExpires, candidates: copyCandidates}
	router.viewMu.Unlock()
}

func federationObserverOrNoop(observer FederationObserver) FederationObserver {
	if observer == nil {
		return noopFederationObserver{}
	}
	return observer
}

func (router *DiscoveredPeerRouter) observe(ctx context.Context, kind FederationObservationKind, reason string, duration time.Duration) {
	router.observer.ObserveFederation(ctx, FederationObservation{Kind: kind, Reason: reason, Duration: duration})
}

func federationFailureReason(err error) string {
	switch {
	case bootstrapCarrierRateLimited(err):
		return "rate_limited"
	case errors.Is(err, relay.ErrPeerUnavailable):
		return "peer_unavailable"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	default:
		return "relay_unavailable"
	}
}

func githubCarrierPassMinInterval(source discovery.BootstrapBeaconLookupSource, configured time.Duration) (time.Duration, error) {
	if configured < 0 || (configured != 0 && (configured < 12*time.Second || configured > time.Minute)) {
		return 0, ErrInvalidConfig
	}
	if sourceID, ok := source.(discovery.BootstrapBeaconSourceID); !ok || sourceID.ID() != "github" {
		return 0, nil
	}
	if configured == 0 {
		return 12 * time.Second, nil
	}
	return configured, nil
}

func (router *DiscoveredPeerRouter) reserveCarrierPass(now time.Time) bool {
	if router.carrierPassMinInterval == 0 {
		return true
	}
	router.carrierPassMu.Lock()
	defer router.carrierPassMu.Unlock()
	if now.Before(router.nextCarrierPass) {
		return false
	}
	router.nextCarrierPass = now.Add(router.carrierPassMinInterval)
	return true
}

func bootstrapCarrierRateLimited(err error) bool {
	reason, ok := discovery.BootstrapBeaconLookupFailureReason(err)
	return ok && reason == "github_rate_limited"
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
