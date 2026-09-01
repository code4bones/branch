package admin

import "github.com/code4bones/branch/internal/relay"

// RelayStatusSource supplies a detached relay core snapshot.
type RelayStatusSource interface {
	Snapshot() relay.Snapshot
}

// RelayStatusProvider projects live relay counts into the protected admin
// status contract without making relay state durable or authoritative.
type RelayStatusProvider struct {
	base   StatusSnapshot
	source RelayStatusSource
}

// NewRelayStatusProvider creates an admin status provider for a relay source.
func NewRelayStatusProvider(base StatusSnapshot, source RelayStatusSource) *RelayStatusProvider {
	return &RelayStatusProvider{base: base, source: source}
}

// Snapshot returns base status with live relay session and queue counts.
func (provider *RelayStatusProvider) Snapshot() StatusSnapshot {
	snapshot := provider.base
	if provider.source == nil {
		snapshot.Readiness = ReadinessNotReady
		return snapshot
	}
	relaySnapshot := provider.source.Snapshot()
	snapshot.SessionsActive = relaySnapshot.SessionsActive
	snapshot.RoutesActive = relaySnapshot.RoutesActive
	snapshot.PresenceActive = relaySnapshot.PresenceActive
	snapshot.QueueDepth = relaySnapshot.QueueDepth
	return snapshot
}
