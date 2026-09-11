package wss

import (
	"sync"
	"time"

	"github.com/code4bones/branch/internal/relay"
)

const contactDiscoveryWindow = time.Minute

// contactDiscovery is process-local live routing metadata. It deliberately has
// no storage adapter, queue, result cache, or negative-result representation.
type contactDiscovery struct {
	mu        sync.Mutex
	byBranch  map[string]contactTarget
	bySession map[relay.SessionID]string
	lookups   map[relay.SessionID]contactRequestWindow
	probes    map[relay.SessionID][]time.Time
}

type contactTarget struct {
	sessionID relay.SessionID
	peerID    relay.PeerID
	conn      *connection
}

// contactRequestWindow maps a request ID to the relay-observed arrival time.
// Client expiry bounds the probe's usefulness, but must not let a requester
// shorten the relay's rolling anti-enumeration window.
type contactRequestWindow struct{ entries map[string]time.Time }

func newContactDiscovery() contactDiscovery {
	return contactDiscovery{byBranch: make(map[string]contactTarget), bySession: make(map[relay.SessionID]string), lookups: make(map[relay.SessionID]contactRequestWindow), probes: make(map[relay.SessionID][]time.Time)}
}

func (state *contactDiscovery) announce(sessionID relay.SessionID, branchID string, peerID relay.PeerID, conn *connection, discoverable bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.removeLocked(sessionID)
	if discoverable {
		state.byBranch[branchID] = contactTarget{sessionID: sessionID, peerID: peerID, conn: conn}
		state.bySession[sessionID] = branchID
	}
}

func (state *contactDiscovery) remove(sessionID relay.SessionID) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.removeLocked(sessionID)
}
func (state *contactDiscovery) removeLocked(sessionID relay.SessionID) {
	if branchID, ok := state.bySession[sessionID]; ok {
		delete(state.byBranch, branchID)
		delete(state.bySession, sessionID)
	}
	delete(state.lookups, sessionID)
	delete(state.probes, sessionID)
}

// reserve returns a target exactly once only when requester replay/rate and
// target probe limits are live-valid. Requester accounting is based solely on
// relay-observed arrival time; all state expires with the connection.
func (state *contactDiscovery) reserve(requester relay.SessionID, requestID, branchID string, now time.Time, _ time.Time) (contactTarget, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	window := state.lookups[requester]
	if window.entries == nil {
		window.entries = make(map[string]time.Time, 4)
	}
	cutoff := now.Add(-contactDiscoveryWindow)
	for id, observedAt := range window.entries {
		if !observedAt.After(cutoff) {
			delete(window.entries, id)
		}
	}
	if len(window.entries) >= 4 {
		return contactTarget{}, false
	}
	if _, duplicate := window.entries[requestID]; duplicate {
		return contactTarget{}, false
	}
	target, ok := state.byBranch[branchID]
	if !ok {
		return contactTarget{}, false
	}
	probes := state.probes[target.sessionID]
	probeCutoff := now.Add(-contactDiscoveryWindow)
	kept := probes[:0]
	for _, at := range probes {
		if at.After(probeCutoff) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= 4 {
		state.probes[target.sessionID] = kept
		return contactTarget{}, false
	}
	window.entries[requestID] = now
	state.lookups[requester] = window
	state.probes[target.sessionID] = append(kept, now)
	return target, true
}
